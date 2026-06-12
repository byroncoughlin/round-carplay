// DongleDriver.ts
import EventEmitter from 'events'
import { MessageHeader, HeaderBuildError, MessageType } from './messages/common.js'
import { PhoneType } from './messages/readable.js'
import { diagLog } from '../diagnosticsLog.js'
import {
  SendableMessage,
  SendNumber,
  FileAddress,
  SendOpen,
  SendBoolean,
  SendString,
  SendBoxSettings,
  SendCommand,
  SendFile,
  SendIconConfig,
  HeartBeat
} from './messages/sendable.js'

// Optional custom CarPlay OEM icon ("return to head unit" button). Drop a PNG
// named oem_icon.png next to the AppImage (e.g. /home/<user>/round-carplay/) to
// use it; if absent the dongle's default icon is shown.
const OEM_ICON_LABEL = 'R75/6'

const CONFIG_NUMBER = 1
const MAX_ERROR_COUNT = 5
const SEND_STATS_INTERVAL_MS = 5000
const SEND_SLOW_MS = 50
const READ_GAP_WARN_MS = 1000
const IDLE_SEND_STATS_MAX_COUNT = 4
const IDLE_SEND_STATS_MAX_BYTES = 128

const transferDataToBuffer = (data?: DataView | null): Buffer | null => {
  if (!data) return null
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

const messageTypeName = (type: MessageType): string => {
  const name = MessageType[type]
  if (name) return name
  return `0x${Number(type).toString(16)}`
}

export enum HandDriveType {
  LHD = 0,
  RHD = 1
}

export type PhoneTypeConfig = { frameInterval: number | null }
type PhoneTypeConfigMap = { [K in PhoneType]: PhoneTypeConfig }

export type DongleConfig = {
  androidWorkMode?: boolean
  width: number
  height: number
  fps: number
  dpi: number
  format: number
  iBoxVersion: number
  packetMax: number
  phoneWorkMode: number
  nightMode: boolean
  boxName: string
  hand: HandDriveType
  mediaDelay: number
  audioTransferMode: boolean
  wifiType: '2.4ghz' | '5ghz'
  micType: 'box' | 'os'
  phoneConfig: Partial<PhoneTypeConfigMap>
}

export const DEFAULT_CONFIG: DongleConfig = {
  width: 800,
  height: 480,
  fps: 60,
  dpi: 140,
  format: 5,
  iBoxVersion: 2,
  phoneWorkMode: 2,
  packetMax: 49152,
  boxName: 'nodePlay',
  nightMode: true,
  hand: HandDriveType.LHD,
  mediaDelay: 500,
  audioTransferMode: false,
  wifiType: '5ghz',
  micType: 'os',
  phoneConfig: {
    [PhoneType.CarPlay]: { frameInterval: 5000 },
    [PhoneType.AndroidAuto]: { frameInterval: null }
  }
}

export class DriverStateError extends Error {}

export class DongleDriver extends EventEmitter {
  private _heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private _device: USBDevice | null = null
  private _inEP: USBEndpoint | null = null
  private _outEP: USBEndpoint | null = null
  private errorCount = 0
  private _closing = false
  private _readLoopRunning = false
  private _readGeneration = 0
  private _wifiConnectTimeout: ReturnType<typeof setTimeout> | null = null
  private _sendChain: Promise<void> = Promise.resolve()
  private _sendGeneration = 0
  private _lastSendWarn = 0
  private _sendStatsWindowStart = 0
  private _lastSendStatsLog = 0
  private _sendStatsCount = 0
  private _sendStatsOk = 0
  private _sendStatsFailed = 0
  private _sendStatsSlow = 0
  private _sendStatsBytes = 0
  private _sendStatsMaxMs = 0
  private _sendStatsMaxType = ''
  private _lastReadAt = 0
  private _lastReadGapWarn = 0

  static knownDevices = [
    { vendorId: 0x1314, productId: 0x1520 },
    { vendorId: 0x1314, productId: 0x1521 }
  ]

  initialise = async (device: USBDevice) => {
    if (this._device) return

    try {
      this._device = device
      if (!device.opened) throw new DriverStateError('Device not opened')

      await device.selectConfiguration(CONFIG_NUMBER)
      const cfg = device.configuration
      if (!cfg) throw new DriverStateError('Device has no configuration')

      const { interfaceNumber, alternate } = cfg.interfaces[0]
      this._inEP = alternate.endpoints.find((e) => e.direction === 'in')!
      this._outEP = alternate.endpoints.find((e) => e.direction === 'out')!
      if (!this._inEP || !this._outEP) throw new DriverStateError('Endpoints missing')

      await device.claimInterface(interfaceNumber)
    } catch (err) {
      await this.close()
      throw err
    }
  }

  send = (msg: SendableMessage): Promise<boolean> => {
    const generation = this._sendGeneration
    const run = async (): Promise<boolean> => {
      const dev = this._device
      if (generation !== this._sendGeneration) return false
      if (!dev || !dev.opened || this._closing) return false

      const startedAt = Date.now()
      const typeName = messageTypeName(msg.type)
      let bytes = 0
      try {
        const buf = msg.serialise()
        bytes = buf.byteLength
        const view = new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength)
        const res = await dev.transferOut(this._outEP!.endpointNumber, view)
        const ok = res.status === 'ok'
        this.recordSend(typeName, bytes, Date.now() - startedAt, ok)
        return ok
      } catch (err) {
        this.recordSend(typeName, bytes, Date.now() - startedAt, false)
        if (!this._closing) {
          console.error('Send error', err)
          diagLog('dongle', 'send-error', { type: typeName, bytes, error: String(err) })
        }
        return false
      }
    }

    const result = this._sendChain.then(run, run)
    this._sendChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async readLoop() {
    const generation = this._readGeneration
    if (this._readLoopRunning) return
    this._readLoopRunning = true

    try {
      while (generation === this._readGeneration && this._device?.opened && !this._closing) {
        if (this.errorCount >= MAX_ERROR_COUNT) {
          await this.close()
          this.emit('failure')
          return
        }

        try {
          const dev = this._device
          const inEP = this._inEP
          if (!dev || !dev.opened || !inEP) break

          const headerBuf = transferDataToBuffer(
            (await dev.transferIn(inEP.endpointNumber, MessageHeader.dataLength))?.data
          )
          if (generation !== this._readGeneration || this._closing) break
          if (!headerBuf) throw new HeaderBuildError('Empty header')

          const header = MessageHeader.fromBuffer(headerBuf)
          let extra: Buffer | undefined
          if (header.length) {
            const dev = this._device
            const inEP = this._inEP
            if (!dev || !dev.opened || !inEP) break

            const extraBuf = transferDataToBuffer(
              (await dev.transferIn(inEP.endpointNumber, header.length))?.data
            )
            if (generation !== this._readGeneration || this._closing) break
            if (!extraBuf) throw new Error('Failed to read extra data')
            extra = extraBuf
          }

          const msg = header.toMessage(extra)
          this.errorCount = 0
          this.recordRead(header.type, header.length)
          if (msg) this.emit('message', msg)
        } catch (err) {
          if (generation !== this._readGeneration || this._closing) break
          console.error('readLoop error', err)
          diagLog('dongle', 'read-error', {
            error: String(err),
            count: this.errorCount + 1
          })
          this.errorCount++
        }
      }
    } finally {
      if (generation === this._readGeneration) {
        this._readLoopRunning = false
      }
    }
  }

  start = async (cfg: DongleConfig, oemIcon?: Buffer) => {
    if (!this._device) throw new DriverStateError('initialise() first')
    if (!this._device.opened) return

    this.errorCount = 0
    const messages: SendableMessage[] = [
      new SendNumber(cfg.dpi, FileAddress.DPI),
      new SendOpen(cfg),
      new SendBoolean(cfg.nightMode, FileAddress.NIGHT_MODE),
      new SendNumber(cfg.hand, FileAddress.HAND_DRIVE_MODE),
      new SendBoolean(true, FileAddress.CHARGE_MODE),
      new SendString(cfg.boxName, FileAddress.BOX_NAME),
      new SendBoxSettings(cfg),
      new SendCommand('wifiEnable'),
      new SendCommand(cfg.wifiType === '5ghz' ? 'wifi5g' : 'wifi24g'),
      new SendCommand(cfg.micType === 'box' ? 'boxMic' : 'mic'),
      new SendCommand(cfg.audioTransferMode ? 'audioTransferOn' : 'audioTransferOff')
    ]
    if (cfg.androidWorkMode)
      messages.push(new SendBoolean(cfg.androidWorkMode, FileAddress.ANDROID_WORK_MODE))

    // Custom OEM "return to head unit" icon — sent only if the main process
    // provided the PNG bytes (read from disk in CarplayService).
    if (oemIcon && oemIcon.length > 0) {
      messages.push(
        new SendFile(oemIcon, FileAddress.OEM_ICON),
        new SendFile(oemIcon, FileAddress.ICON_120),
        new SendFile(oemIcon, FileAddress.ICON_180),
        new SendFile(oemIcon, FileAddress.ICON_250),
        new SendIconConfig({ label: OEM_ICON_LABEL }),
      )
      console.log(`[carplay] sending custom OEM icon (${oemIcon.length} bytes)`)
    }

    const sent = await Promise.all(messages.map(this.send))
    if (sent.some((ok) => !ok)) {
      diagLog('dongle', 'startup-send-failed', { sent })
      throw new DriverStateError('Failed to send one or more startup messages')
    }
    if (this._wifiConnectTimeout) clearTimeout(this._wifiConnectTimeout)
    this._wifiConnectTimeout = setTimeout(() => {
      this._wifiConnectTimeout = null
      this.send(new SendCommand('wifiConnect'))
    }, 1000)

    this.readLoop()
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval)
    this._heartbeatInterval = setInterval(() => this.send(new HeartBeat()), 2000)
  }

  close = async () => {
    this._sendGeneration++
    this._sendChain = Promise.resolve()
    this._readGeneration++
    this._readLoopRunning = false

    this._closing = true
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval)
      this._heartbeatInterval = null
    }
    if (this._wifiConnectTimeout) {
      clearTimeout(this._wifiConnectTimeout)
      this._wifiConnectTimeout = null
    }
    if (!this._device) {
      this._closing = false
      return
    }

    if (process.platform === 'darwin') await new Promise((r) => setTimeout(r, 50))

    try {
      await this._device.close()
    } catch (err) {
      console.warn('device.close() failed', err)
    }

    this._device = null
    this._inEP = null
    this._outEP = null
    this._closing = false
  }

  private recordSend(type: string, bytes: number, elapsedMs: number, ok: boolean): void {
    const now = Date.now()
    if (!this._sendStatsWindowStart) {
      this._sendStatsWindowStart = now
      this._lastSendStatsLog = now
    }

    this._sendStatsCount++
    this._sendStatsBytes += bytes
    if (ok) this._sendStatsOk++
    else this._sendStatsFailed++
    if (elapsedMs > SEND_SLOW_MS) this._sendStatsSlow++
    if (elapsedMs > this._sendStatsMaxMs) {
      this._sendStatsMaxMs = elapsedMs
      this._sendStatsMaxType = type
    }

    if ((!ok || elapsedMs > SEND_SLOW_MS) && now - this._lastSendWarn >= 1000) {
      this._lastSendWarn = now
      diagLog('dongle', 'send-slow', { type, bytes, elapsedMs, ok })
    }

    if (now - this._lastSendStatsLog < SEND_STATS_INTERVAL_MS) return

    const interesting =
      this._sendStatsFailed > 0 ||
      this._sendStatsSlow > 0 ||
      this._sendStatsCount > IDLE_SEND_STATS_MAX_COUNT ||
      this._sendStatsBytes > IDLE_SEND_STATS_MAX_BYTES

    if (interesting) {
      diagLog('dongle', 'send-stats', {
        ms: now - this._sendStatsWindowStart,
        count: this._sendStatsCount,
        ok: this._sendStatsOk,
        failed: this._sendStatsFailed,
        slow: this._sendStatsSlow,
        bytes: this._sendStatsBytes,
        maxMs: this._sendStatsMaxMs,
        maxType: this._sendStatsMaxType
      })
    }

    this._sendStatsWindowStart = now
    this._lastSendStatsLog = now
    this._sendStatsCount = 0
    this._sendStatsOk = 0
    this._sendStatsFailed = 0
    this._sendStatsSlow = 0
    this._sendStatsBytes = 0
    this._sendStatsMaxMs = 0
    this._sendStatsMaxType = ''
  }

  private recordRead(type: MessageType, length: number): void {
    const now = Date.now()
    if (this._lastReadAt) {
      const gapMs = now - this._lastReadAt
      if (gapMs >= READ_GAP_WARN_MS && now - this._lastReadGapWarn >= 1000) {
        this._lastReadGapWarn = now
        diagLog('dongle', 'read-gap', {
          gapMs,
          type: messageTypeName(type),
          length
        })
      }
    }
    this._lastReadAt = now
  }
}

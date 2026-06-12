import { app, ipcMain, WebContents } from 'electron'
import { WebUSBDevice } from 'usb'
import {
  Plugged,
  Unplugged,
  VideoData,
  AudioData,
  MediaData,
  MediaType,
  Command,
  SendCommand,
  SendTouch,
  TouchAction,
  SendAudio,
  DongleDriver,
  DongleConfig,
  DEFAULT_CONFIG,
  decodeTypeMap,
  AudioCommand,
  PhoneType
} from './messages'
import fs from 'fs'
import path from 'path'
import usb from 'usb'
import { OEM_ICON_PNG } from './oemIcon'
import NodeMicrophone from './node/NodeMicrophone'
import { diagLog } from '../diagnosticsLog'

let dongleConnected = false

interface PersistedMediaPayload {
  type: MediaType
  media?: Record<string, any>
  base64Image?: string
}

type PersistedMediaFile = {
  timestamp: string
  payload: PersistedMediaPayload
}

type TouchPayload = {
  x: number
  y: number
  action: TouchAction
  queuedAt: number
}

type PendingMediaWrite = {
  file: string
  data: PersistedMediaFile
}

type ChunkSource = ArrayBuffer | ArrayBufferView

const VIDEO_STALL_WARN_MS = 1000
const TOUCH_FRAME_KICK_INTERVAL_MS = 100

const viewToArrayBuffer = (view: ArrayBufferView): ArrayBuffer => {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer as ArrayBuffer
  }
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

const chunkSourceByteLength = (data: ChunkSource): number =>
  data instanceof ArrayBuffer ? data.byteLength : data.byteLength

const chunkSourceToBuffer = (data: ChunkSource, offset: number, length: number): Buffer => {
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data, offset, length)
  }
  return Buffer.from(data.buffer as ArrayBuffer, data.byteOffset + offset, length)
}

function readMediaFile(filePath: string): PersistedMediaFile {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as PersistedMediaFile
  } catch {
    return {
      timestamp: '',
      payload: { type: MediaType.Data, media: {}, base64Image: undefined }
    }
  }
}

export class CarplayService {
  private driver = new DongleDriver()
  private webContents: WebContents | null = null
  private config: DongleConfig = DEFAULT_CONFIG
  private pairTimeout: NodeJS.Timeout | null = null
  private frameInterval: NodeJS.Timeout | null = null
  private frameKickTimer: NodeJS.Timeout | null = null
  private lastFrameKickAt = 0
  private activePhoneType: PhoneType | null = null
  private _mic: NodeMicrophone | null = null
  private started = false
  private startPromise: Promise<void> | null = null
  private stopping = false
  private shuttingDown = false
  private sessionGeneration = 0
  private audioInfoSent = false
  private lastResW = 0
  private lastResH = 0
  private lastVideoStatsLog = 0
  private videoStatsWindowStart = 0
  private videoStatsFrames = 0
  private videoStatsBytes = 0
  private videoStatsMaxGap = 0
  private videoStatsLastFrameAt = 0
  private videoStallTimer: NodeJS.Timeout | null = null
  private touchQueue: TouchPayload[] = []
  private touchSending = false
  private lastTouchWarn = 0
  private lastTouchStatsLog = 0
  private touchStatsWindowStart = 0
  private touchStatsReceived = 0
  private touchStatsSent = 0
  private touchStatsOk = 0
  private touchStatsFailed = 0
  private touchStatsCoalesced = 0
  private touchStatsSlow = 0
  private touchStatsMaxAgeMs = 0
  private touchStatsMaxQueueDepth = 0
  private touchStatsLastAction: TouchAction | null = null
  private touchVideoPendingSentAt: number[] = []
  private touchVideoLatencyWindowStart = 0
  private touchVideoLatencyLastLog = 0
  private touchVideoLatencySamples: number[] = []
  private touchVideoLatencySumMs = 0
  private touchVideoLatencyMaxMs = 0
  private autoStartTimer: NodeJS.Timeout | null = null
  private mediaPayloadCache: PersistedMediaPayload | null = null
  private mediaWriteTimer: NodeJS.Timeout | null = null
  private pendingMediaWrite: PendingMediaWrite | null = null
  private mediaWriteInFlight = false

  constructor() {
    this.driver.on('message', (msg) => {
      if (!this.webContents) return

      if (msg instanceof Plugged) {
        this.clearTimeouts()
        this.activePhoneType = msg.phoneType
        diagLog('carplay', 'plugged', { phoneType: msg.phoneType, wifi: msg.wifi })
        this.webContents.send('carplay-event', { type: 'plugged' })

        if (!this.started) {
          console.log('[CarplayService] Auto-starting CarPlay after Plugged event')
          this.start().catch(console.error)
        }
      } else if (msg instanceof Unplugged) {
        this.handlePhoneUnplugged().catch((err) =>
          console.warn('[CarplayService] phone unplug recovery failed', err)
        )
      } else if (msg instanceof VideoData) {
        this.clearPairTimeout()
        this.ensureFrameInterval()
        // announce the resolution once / on change — not before every frame
        // (this used to be 60 extra IPC messages per second)
        if (msg.width !== this.lastResW || msg.height !== this.lastResH) {
          this.lastResW = msg.width
          this.lastResH = msg.height
          diagLog('carplay', 'resolution', { width: msg.width, height: msg.height })
          this.webContents.send('carplay-event', {
            type: 'resolution',
            payload: { width: msg.width, height: msg.height }
          })
        }
        // Send the exact dongle video body, including its 20-byte metadata
        // header. Render.worker strips that header before decoding. Using
        // `.buffer` from a Buffer subarray can leak unrelated backing bytes.
        this.recordVideoFrame(msg.rawData.byteLength, msg.width, msg.height)
        this.sendChunked('carplay-video-chunk', msg.rawData, 512 * 1024)
      } else if (msg instanceof AudioData) {
        this.clearPairTimeout()
        if (msg.data) {
          this.sendChunked(
            'carplay-audio-chunk',
            msg.data,
            64 * 1024,
            {
              command: msg.command,
              decodeType: msg.decodeType,
              volume: msg.volume,
              volumeDuration: msg.volumeDuration,
              audioType: msg.audioType
            }
          )
          if (!this.audioInfoSent) {
            const meta = decodeTypeMap[msg.decodeType]
            if (meta) {
              this.webContents.send('carplay-event', {
                type: 'audioInfo',
                payload: {
                  codec: meta.format ?? meta.mimeType,
                  sampleRate: meta.frequency,
                  channels: meta.channel,
                  bitDepth: meta.bitDepth
                }
              })
              this.audioInfoSent = true
            }
          }
        } else if (msg.command != null) {
          console.debug('[CarplayService] Received audio command:', msg.command)
          if (
            msg.command === AudioCommand.AudioSiriStart ||
            msg.command === AudioCommand.AudioPhonecallStart
          ) {
            if (this.config.audioTransferMode) {
              console.debug(
                '[CarplayService] Skipping microphone start because audioTransferMode is enabled'
              )
              return
            }
            if (!this._mic) {
              console.debug('[CarplayService] Initializing microphone')
              this._mic = new NodeMicrophone()
              this._mic.on('data', (data: Buffer) => {
                const pcm = data.subarray(0, data.byteLength - (data.byteLength % 2))
                this.driver.send(new SendAudio(new Int16Array(viewToArrayBuffer(pcm))))
              })
            }
            this._mic.start()
          } else if (
            msg.command === AudioCommand.AudioSiriStop ||
            msg.command === AudioCommand.AudioPhonecallStop
          ) {
            this._mic?.stop()
          }
        }
      } else if (msg instanceof MediaData) {
        this.clearPairTimeout()
        this.webContents!.send('carplay-event', { type: 'media', payload: msg })
        if (!msg.payload) return

        const file = path.join(app.getPath('userData'), 'mediaData.json')
        const existingPayload = this.getMediaPayloadCache(file)
        const newPayload: PersistedMediaPayload = {
          type: msg.payload.type
        }
        if (msg.payload.type === MediaType.Data && msg.payload.media) {
          newPayload.media = {
            ...existingPayload.media,
            ...msg.payload.media
          }
          if (existingPayload.base64Image) {
            newPayload.base64Image = existingPayload.base64Image
          }
        } else if (msg.payload.type === MediaType.AlbumCover && msg.payload.base64Image) {
          newPayload.base64Image = msg.payload.base64Image
          if (existingPayload.media) {
            newPayload.media = existingPayload.media
          }
        } else {
          newPayload.media = existingPayload.media
          newPayload.base64Image = existingPayload.base64Image
        }
        this.mediaPayloadCache = newPayload
        const out = {
          timestamp: new Date().toISOString(),
          payload: newPayload
        }
        this.scheduleMediaFileWrite(file, out)
      } else if (msg instanceof Command) {
        this.webContents.send('carplay-event', { type: 'command', message: msg })
      }
    })

    this.driver.on('failure', () => {
      diagLog('carplay', 'driver-failure')
      this.webContents?.send('carplay-event', { type: 'failure' })
      this.handleDriverFailure().catch((err) =>
        console.warn('[CarplayService] driver failure recovery failed', err)
      )
    })

    ipcMain.handle('carplay-start', async () => {
      // a (re)loaded renderer needs the resolution event even if the service
      // is already streaming — forget the cache so the next frame resends it
      this.lastResW = 0
      this.lastResH = 0
      return this.start()
    })
    ipcMain.handle('carplay-stop', async () => this.stop())
    ipcMain.handle('carplay-sendframe', async () => this.driver.send(new SendCommand('frame')))
    ipcMain.on('carplay-touch', (_, data) => {
      this.enqueueTouch(data)
    })
    ipcMain.on('carplay-key-command', (_, command) => {
      this.driver.send(new SendCommand(command))
    })
  }

  public attachRenderer(webContents: WebContents) {
    this.webContents = webContents
    this.lastResW = 0
    this.lastResH = 0
    if (dongleConnected) this.scheduleAutoStartIfNeeded(500)
  }

  public markDongleConnected(connected: boolean) {
    dongleConnected = connected
  }

  public isActive(): boolean {
    return this.started || this.startPromise !== null
  }

  public async autoStartIfNeeded() {
    if (this.shuttingDown) {
      console.log('[CarplayService] Skipping autoStartIfNeeded – shutting down')
      return
    }
    if (!this.webContents || this.webContents.isDestroyed()) {
      console.log('[CarplayService] Deferring autoStartIfNeeded – renderer not attached')
      diagLog('carplay', 'autostart-deferred-no-renderer')
      return
    }
    if (this.stopping) {
      console.log('[CarplayService] Deferring autoStartIfNeeded – stop in progress')
      diagLog('carplay', 'autostart-deferred-stopping')
      this.scheduleAutoStartIfNeeded(250)
      return
    }
    if (!this.started && !this.startPromise && dongleConnected) {
      console.log('[CarplayService] AutoStartIfNeeded → calling start()')
      await this.start()
    }
  }

  public scheduleAutoStartIfNeeded(delayMs = 750): void {
    this.clearAutoStartTimer()
    this.autoStartTimer = setTimeout(() => {
      this.autoStartTimer = null
      this.autoStartIfNeeded().catch((err) =>
        console.warn('[CarplayService] scheduled autoStartIfNeeded failed', err)
      )
    }, delayMs)
  }

  private async start() {
    if (this.started) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async startInternal() {
    const generation = ++this.sessionGeneration
    if (!this.webContents || this.webContents.isDestroyed()) {
      console.warn('[CarplayService] start() requested before renderer attach')
      diagLog('carplay', 'start-no-renderer')
      return
    }

    try {
      const configPath = path.join(app.getPath('userData'), 'config.json')
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      this.config = { ...this.config, ...userConfig }
    } catch {
      // fallback to DEFAULT_CONFIG
    }

    console.debug('[CarplayService] audioTransferMode:', this.config.audioTransferMode)

    const device = usb
      .getDeviceList()
      .find(
        (d) =>
          d.deviceDescriptor.idVendor === 0x1314 &&
          [0x1520, 0x1521].includes(d.deviceDescriptor.idProduct)
      )
    if (!device) {
      console.warn('[CarplayService] No dongle found during start()')
      diagLog('carplay', 'start-no-dongle')
      dongleConnected = false
      return
    }

    try {
      const webUsbDevice = await WebUSBDevice.createInstance(device)
      await webUsbDevice.open()
      await this.driver.initialise(webUsbDevice)
      await this.driver.start(this.config, OEM_ICON_PNG)
      if (
        generation !== this.sessionGeneration ||
        this.stopping ||
        this.shuttingDown ||
        !dongleConnected
      ) {
        console.log('[CarplayService] start() became stale; closing driver')
        diagLog('carplay', 'start-stale-close')
        await this.driver.close()
        return
      }
      this.pairTimeout = setTimeout(() => {
        this.driver.send(new SendCommand('wifiPair'))
      }, 15000)
      this.started = true
      this.audioInfoSent = false
      // forget the cached resolution so the next stream re-announces it (the
      // renderer flips receivingVideo back on from that event)
      this.lastResW = 0
      this.lastResH = 0
      this.resetVideoStats()
      console.log('[CarplayService] CarPlay started')
      diagLog('carplay', 'started', {
        width: this.config.width,
        height: this.config.height,
        fps: this.config.fps,
        backdropEnabled: (this.config as any).backdropEnabled,
        ambientFillEnabled: (this.config as any).ambientFillEnabled,
        diagnosticPlainCarplay: (this.config as any).diagnosticPlainCarplay,
        wifiType: this.config.wifiType
      })
    } catch (err) {
      console.error('[CarplayService] Error during start()', err)
      diagLog('carplay', 'start-error', { error: String(err) })
      this.started = false
      this.audioInfoSent = false
      this.lastResW = 0
      this.lastResH = 0
      try {
        await this.driver.close()
      } catch (closeErr) {
        console.warn('[CarplayService] driver.close() after start error failed', closeErr)
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.stopping) return
    if (!this.started && !this.startPromise) return
    this.stopping = true
    this.sessionGeneration++
    this.clearTimeouts()
    this.clearTouchQueue()
    diagLog('carplay', 'stopping')
    try {
      await this.driver.close()
    } catch (err) {
      console.warn('[CarplayService] driver.close() failed', err)
    }
    try {
      this._mic?.stop()
    } catch (err) {
      console.warn('[CarplayService] mic.stop() failed', err)
    }
    this.started = false
    this.audioInfoSent = false
    this.lastResW = 0
    this.lastResH = 0
    this.activePhoneType = null
    this.resetVideoStats()
    this.stopping = false
    console.log('[CarplayService] CarPlay stopped')
    diagLog('carplay', 'stopped')
  }

  private async handlePhoneUnplugged(): Promise<void> {
    console.warn('[CarplayService] Dongle sent Unplugged message')
    diagLog('carplay', 'phone-unplugged')
    this.webContents?.send('carplay-event', { type: 'phone-unplugged' })
    await this.stop()

    const devicePresent = this.isDonglePresent()
    dongleConnected = devicePresent
    if (!devicePresent || this.shuttingDown) return

    console.log('[CarplayService] Dongle still present after phone unplug; restarting CarPlay')
    diagLog('carplay', 'phone-unplugged-restart-scheduled')
    setTimeout(() => {
      this.autoStartIfNeeded().catch((err) =>
        console.warn('[CarplayService] phone unplug restart failed', err)
      )
    }, 1500)
  }

  private async handleDriverFailure(): Promise<void> {
    console.warn('[CarplayService] Dongle driver reported failure')
    diagLog('carplay', 'driver-failure-handling')
    await this.stop()

    const devicePresent = this.isDonglePresent()
    dongleConnected = devicePresent
    if (!devicePresent || this.shuttingDown) return

    console.log('[CarplayService] Dongle still present after driver failure; restarting CarPlay')
    diagLog('carplay', 'driver-failure-restart-scheduled')
    setTimeout(() => {
      this.autoStartIfNeeded().catch((err) =>
        console.warn('[CarplayService] driver failure restart failed', err)
      )
    }, 1500)
  }

  private isDonglePresent(): boolean {
    return usb
      .getDeviceList()
      .some(
        (d) =>
          d.deviceDescriptor.idVendor === 0x1314 &&
          [0x1520, 0x1521].includes(d.deviceDescriptor.idProduct)
      )
  }

  private enqueueTouch(data: Partial<TouchPayload>): void {
    const action = data.action
    if (
      action !== TouchAction.Down &&
      action !== TouchAction.Move &&
      action !== TouchAction.Up
    ) {
      return
    }

    const x = Number(data.x)
    const y = Number(data.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return

    const touch = { x, y, action, queuedAt: Date.now() }
    this.touchStatsReceived++
    this.touchStatsLastAction = action
    if (action === TouchAction.Move) {
      const lastIndex = this.touchQueue.length - 1
      if (lastIndex >= 0 && this.touchQueue[lastIndex].action === TouchAction.Move) {
        this.touchQueue[lastIndex] = touch
        this.touchStatsCoalesced++
      } else {
        this.touchQueue.push(touch)
      }
    } else {
      this.touchQueue.push(touch)
    }
    this.touchStatsMaxQueueDepth = Math.max(this.touchStatsMaxQueueDepth, this.touchQueue.length)
    this.maybeLogTouchStats()

    this.flushTouchQueue().catch((err) =>
      console.warn('[CarplayService] touch queue flush failed', err)
    )
  }

  private async flushTouchQueue(): Promise<void> {
    if (this.touchSending) return

    const touch = this.touchQueue.shift()
    if (!touch) return

    this.touchSending = true
    const startedAt = Date.now()
    const ageMs = startedAt - touch.queuedAt
    this.touchStatsMaxAgeMs = Math.max(this.touchStatsMaxAgeMs, ageMs)
    try {
      const ok = await this.driver.send(new SendTouch(touch.x, touch.y, touch.action))
      const elapsed = Date.now() - startedAt
      this.touchStatsSent++
      if (ok) {
        this.touchStatsOk++
        this.recordTouchSentForVideoLatency(Date.now())
        this.requestTouchFrameKick()
      } else {
        this.touchStatsFailed++
      }
      if (elapsed > 50 || ageMs > 50) this.touchStatsSlow++
      if (!ok || elapsed > 50 || ageMs > 50) {
        const now = Date.now()
        if (now - this.lastTouchWarn > 1000) {
          this.lastTouchWarn = now
          console.warn(
            `[CarplayService] slow touch send: ok=${ok} elapsed=${elapsed}ms age=${ageMs}ms queued=${this.touchQueue.length}`
          )
          diagLog('touch', 'slow-send', {
            ok,
            elapsed,
            ageMs,
            queued: this.touchQueue.length,
            action: touch.action
          })
        }
      }
    } finally {
      this.touchSending = false
      this.maybeLogTouchStats()
    }

    if (this.touchQueue.length) {
      this.flushTouchQueue().catch((err) =>
        console.warn('[CarplayService] touch queue flush failed', err)
      )
    }
  }

  private clearTouchQueue(): void {
    this.touchQueue = []
  }

  private resetVideoStats(): void {
    this.clearVideoStallTimer()
    this.lastVideoStatsLog = 0
    this.videoStatsWindowStart = 0
    this.videoStatsFrames = 0
    this.videoStatsBytes = 0
    this.videoStatsMaxGap = 0
    this.videoStatsLastFrameAt = 0
    this.resetTouchVideoLatency()
  }

  private touchActionName(action: TouchAction | null): string | null {
    if (action === TouchAction.Down) return 'down'
    if (action === TouchAction.Move) return 'move'
    if (action === TouchAction.Up) return 'up'
    return null
  }

  private maybeLogTouchStats(): void {
    const now = Date.now()
    if (!this.touchStatsWindowStart) {
      this.touchStatsWindowStart = now
      this.lastTouchStatsLog = now
    }
    if (now - this.lastTouchStatsLog < 1000) return
    if (!this.touchStatsReceived && !this.touchStatsSent) return

    diagLog('touch', 'stats', {
      ms: now - this.touchStatsWindowStart,
      received: this.touchStatsReceived,
      sent: this.touchStatsSent,
      ok: this.touchStatsOk,
      failed: this.touchStatsFailed,
      coalesced: this.touchStatsCoalesced,
      slow: this.touchStatsSlow,
      queued: this.touchQueue.length,
      maxQueueDepth: this.touchStatsMaxQueueDepth,
      maxAgeMs: this.touchStatsMaxAgeMs,
      sending: this.touchSending,
      lastAction: this.touchActionName(this.touchStatsLastAction)
    })

    this.lastTouchStatsLog = now
    this.touchStatsWindowStart = now
    this.touchStatsReceived = 0
    this.touchStatsSent = 0
    this.touchStatsOk = 0
    this.touchStatsFailed = 0
    this.touchStatsCoalesced = 0
    this.touchStatsSlow = 0
    this.touchStatsMaxAgeMs = 0
    this.touchStatsMaxQueueDepth = this.touchQueue.length
    this.touchStatsLastAction = null
  }

  private clearTimeouts() {
    this.clearAutoStartTimer()
    this.clearPairTimeout()
    this.clearFrameInterval()
  }

  private getMediaPayloadCache(file: string): PersistedMediaPayload {
    if (!this.mediaPayloadCache) {
      this.mediaPayloadCache = readMediaFile(file).payload
    }
    return this.mediaPayloadCache
  }

  private scheduleMediaFileWrite(file: string, data: PersistedMediaFile, delayMs = 250): void {
    this.pendingMediaWrite = { file, data }
    if (this.mediaWriteTimer) clearTimeout(this.mediaWriteTimer)
    this.mediaWriteTimer = setTimeout(() => {
      this.mediaWriteTimer = null
      this.flushMediaFileWrite().catch((err) =>
        diagLog('media', 'write-error', { error: String(err) })
      )
    }, delayMs)
  }

  private async flushMediaFileWrite(): Promise<void> {
    if (this.mediaWriteInFlight) return
    const pending = this.pendingMediaWrite
    if (!pending) return

    this.pendingMediaWrite = null
    this.mediaWriteInFlight = true
    const startedAt = Date.now()
    try {
      await fs.promises.writeFile(pending.file, JSON.stringify(pending.data, null, 2), 'utf8')
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs > 50) {
        diagLog('media', 'write-slow', { elapsedMs })
      }
    } finally {
      this.mediaWriteInFlight = false
      const nextPending = this.pendingMediaWrite as PendingMediaWrite | null
      if (nextPending && !this.mediaWriteTimer) {
        this.scheduleMediaFileWrite(nextPending.file, nextPending.data, 0)
      }
    }
  }

  private recordVideoFrame(bytes: number, width: number, height: number): void {
    const now = Date.now()
    this.recordTouchVideoLatencies(now)
    if (!this.videoStatsWindowStart) {
      this.videoStatsWindowStart = now
      this.lastVideoStatsLog = now
    }
    if (this.videoStatsLastFrameAt) {
      this.videoStatsMaxGap = Math.max(this.videoStatsMaxGap, now - this.videoStatsLastFrameAt)
    }
    this.videoStatsLastFrameAt = now
    this.scheduleVideoStallWatch(width, height)
    this.videoStatsFrames++
    this.videoStatsBytes += bytes

    if (now - this.lastVideoStatsLog < 1000) return

    const ms = now - this.videoStatsWindowStart
    diagLog('video', 'stats', {
      ms,
      frames: this.videoStatsFrames,
      fps: ms > 0 ? Math.round((this.videoStatsFrames * 1000 * 10) / ms) / 10 : 0,
      bytes: this.videoStatsBytes,
      kbps: ms > 0 ? Math.round((this.videoStatsBytes * 8) / ms) : 0,
      maxGap: this.videoStatsMaxGap,
      width,
      height
    })

    this.lastVideoStatsLog = now
    this.videoStatsWindowStart = now
    this.videoStatsFrames = 0
    this.videoStatsBytes = 0
    this.videoStatsMaxGap = 0
  }

  private recordTouchSentForVideoLatency(sentAt: number): void {
    this.touchVideoPendingSentAt.push(sentAt)
    if (this.touchVideoPendingSentAt.length > 1000) {
      this.touchVideoPendingSentAt.splice(0, this.touchVideoPendingSentAt.length - 1000)
    }
  }

  private recordTouchVideoLatencies(videoAt: number): void {
    if (!this.touchVideoLatencyWindowStart) {
      this.touchVideoLatencyWindowStart = videoAt
      this.touchVideoLatencyLastLog = videoAt
    }

    if (this.touchVideoPendingSentAt.length) {
      const pending = this.touchVideoPendingSentAt
      this.touchVideoPendingSentAt = []
      for (const sentAt of pending) {
        const latencyMs = Math.max(0, videoAt - sentAt)
        this.touchVideoLatencySamples.push(latencyMs)
        this.touchVideoLatencySumMs += latencyMs
        this.touchVideoLatencyMaxMs = Math.max(this.touchVideoLatencyMaxMs, latencyMs)
      }
    }

    if (videoAt - this.touchVideoLatencyLastLog < 1000) return
    if (!this.touchVideoLatencySamples.length) return

    const sorted = [...this.touchVideoLatencySamples].sort((a, b) => a - b)
    const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))
    const count = sorted.length
    diagLog('latency', 'touch-to-video', {
      ms: videoAt - this.touchVideoLatencyWindowStart,
      count,
      avgMs: Math.round(this.touchVideoLatencySumMs / count),
      p95Ms: Math.round(sorted[p95Index]),
      maxMs: Math.round(this.touchVideoLatencyMaxMs),
      pending: this.touchVideoPendingSentAt.length
    })

    this.touchVideoLatencyWindowStart = videoAt
    this.touchVideoLatencyLastLog = videoAt
    this.touchVideoLatencySamples = []
    this.touchVideoLatencySumMs = 0
    this.touchVideoLatencyMaxMs = 0
  }

  private resetTouchVideoLatency(): void {
    this.touchVideoPendingSentAt = []
    this.touchVideoLatencyWindowStart = 0
    this.touchVideoLatencyLastLog = 0
    this.touchVideoLatencySamples = []
    this.touchVideoLatencySumMs = 0
    this.touchVideoLatencyMaxMs = 0
  }

  private scheduleVideoStallWatch(width: number, height: number): void {
    this.clearVideoStallTimer()
    this.videoStallTimer = setTimeout(() => {
      this.videoStallTimer = null
      if (!this.started || !this.videoStatsLastFrameAt) return

      const elapsedMs = Date.now() - this.videoStatsLastFrameAt
      if (elapsedMs < VIDEO_STALL_WARN_MS) {
        this.scheduleVideoStallWatch(width, height)
        return
      }

      diagLog('video', 'stall', {
        elapsedMs,
        width,
        height
      })
      this.scheduleVideoStallWatch(width, height)
    }, VIDEO_STALL_WARN_MS)
  }

  private clearAutoStartTimer() {
    if (this.autoStartTimer) {
      clearTimeout(this.autoStartTimer)
      this.autoStartTimer = null
    }
  }

  private clearPairTimeout() {
    if (this.pairTimeout) {
      clearTimeout(this.pairTimeout)
      this.pairTimeout = null
    }
  }

  private clearFrameInterval() {
    if (this.frameInterval) {
      clearInterval(this.frameInterval)
      this.frameInterval = null
    }
    if (this.frameKickTimer) {
      clearTimeout(this.frameKickTimer)
      this.frameKickTimer = null
    }
  }

  private ensureFrameInterval(): void {
    if (this.frameInterval || this.activePhoneType == null) return

    const intervalMs = this.config.phoneConfig?.[this.activePhoneType]?.frameInterval
    if (!intervalMs || intervalMs <= 0) return

    this.frameInterval = setInterval(
      () => void this.driver.send(new SendCommand('frame')),
      intervalMs
    )
    diagLog('carplay', 'frame-interval-started', {
      phoneType: this.activePhoneType,
      intervalMs
    })
  }

  private sendFrameKick(): void {
    this.lastFrameKickAt = Date.now()
    void this.driver.send(new SendCommand('frame'))
  }

  private requestTouchFrameKick(): void {
    if ((this.config as DongleConfig & { diagnosticTouchFrameKick?: boolean }).diagnosticTouchFrameKick !== true) return
    if (!this.started || !this.videoStatsLastFrameAt) return

    const now = Date.now()
    const waitMs = TOUCH_FRAME_KICK_INTERVAL_MS - (now - this.lastFrameKickAt)
    if (waitMs <= 0) {
      this.sendFrameKick()
      return
    }
    if (this.frameKickTimer) return

    this.frameKickTimer = setTimeout(() => {
      this.frameKickTimer = null
      this.sendFrameKick()
    }, waitMs)
  }

  private clearVideoStallTimer() {
    if (this.videoStallTimer) {
      clearTimeout(this.videoStallTimer)
      this.videoStallTimer = null
    }
  }

  private sendChunked(
    channel: string,
    data?: ChunkSource,
    chunkSize = 512 * 1024,
    extra: Record<string, any> = {}
  ) {
    if (!this.webContents || !data) return
    let offset = 0
    const total = chunkSourceByteLength(data)
    const id = Math.random().toString(36).slice(2)
    const sentAt = Date.now()

    while (offset < total) {
      const end = Math.min(offset + chunkSize, total)
      const chunk = chunkSourceToBuffer(data, offset, end - offset)
      this.webContents.send(channel, {
        id,
        offset,
        total,
        sentAt,
        isLast: end >= total,
        chunk,
        ...extra
      })
      offset = end
    }
  }
}

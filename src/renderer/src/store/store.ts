import { create } from 'zustand'
import { ExtraConfig } from '../../../main/Globals'
import { io } from 'socket.io-client'
import { useDataLog } from './dataLog'
import type { MetricKey } from './dataLog'

function toF(c: number): number { return c * 9 / 5 + 32 }
function toFt(m: number): number { return m * 3.28084 }
function toMph(kmh: number): number { return kmh * 0.621371 }

function log(key: MetricKey, val: number | null | undefined) {
  if (val === null || val === undefined || !isFinite(val)) return
  useDataLog.getState().addPoint(key, val)
}

const URL = 'http://localhost:4000'

// GPS Sky View — per-satellite troubleshooting snapshot (from gps.py GSV/GSA),
// updated ~once per second. Drives the sky plot + signal bars + status panel.
export interface GpsSat {
  prn: number
  el: number | null    // elevation 0-90°
  az: number | null    // azimuth 0-360° (0 = true north)
  snr: number | null   // carrier-to-noise, dB-Hz (~0 weak .. 50 strong)
  used: boolean        // included in the position fix
}
export interface GpsSky {
  fixType: 0 | 2 | 3   // 0 = no fix, 2 = 2D, 3 = 3D
  satsUsed: number
  satsInView: number
  hdop: number | null
  pdop: number | null
  lat: number | null
  lon: number | null
  sats: GpsSat[]
  ttff: number | null       // seconds to first fix (frozen once fixed)
  acquiring: number | null  // seconds elapsed while still searching (live), null once fixed
}

// Socket.IO Setup
const socket = io(URL, {
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 2000,
})

socket.on('connect_error', (err) => {
  console.warn('Socket.IO connect_error:', err.message)
})

// Carplay Store
export interface CarplayStore {
  // App-Einstellungen
  settings: ExtraConfig | null
  saveSettings: (settings: ExtraConfig) => void
  getSettings: () => void
  stream: (stream: any) => void
  resetInfo: () => void

  // Display-Resolution
  negotiatedWidth: number | null
  negotiatedHeight: number | null

  // USB Device Info
  serial: string | null
  manufacturer: string | null
  product: string | null
  fwVersion: string | null

  // Audio-Metadata
  audioCodec: string | null
  audioSampleRate: number | null
  audioChannels: number | null
  audioBitDepth: number | null

  // PCM-Data for FFT
  audioPcmData: Float32Array | null
  setPcmData: (data: Float32Array) => void

  // Setter
  setDeviceInfo: (info: {
    serial: string
    manufacturer: string
    product: string
    fwVersion: string
  }) => void
  setNegotiatedResolution: (width: number, height: number) => void
  setAudioInfo: (info: {
    codec: string
    sampleRate: number
    channels: number
    bitDepth: number
  }) => void

  // Sensor data
  gpsSpeed: number | null    // km/h
  heading: number | null     // degrees 0-360
  altitude: number | null    // meters
  gpsFix: boolean | null     // true = sat fix; false = acquiring; null = no GPS data yet
  gpsSats: number            // satellites in use
  leanAngle: number | null   // degrees, positive = right lean
  chtLeft: number | null     // celsius, left cylinder head
  chtRight: number | null    // celsius, right cylinder head
  ambientTemp: number | null // celsius
  gForceX: number | null     // G, lateral (positive = right)
  gForceY: number | null     // G, longitudinal (positive = forward)
  pitchAngle: number | null  // degrees, positive = nose up
  piTemp: number | null      // celsius, Raspberry Pi CPU temperature
  gpsSky: GpsSky | null      // satellite sky-view snapshot (GPS troubleshooting)

  // Session peak-hold — accumulated continuously in the socket handlers (NOT
  // only while a graph is open) so the live panels can show "max lean 41°" /
  // "peak G 0.6" / hottest cylinder for the whole ride. Reset via the buttons.
  imuPeak: { leanL: number; leanR: number; g: number }  // deg left, deg right, G
  chtPeak: { left: number; right: number }              // hottest °C seen each head
  resetImuPeak: () => void
  resetChtPeak: () => void
}

export const useCarplayStore = create<CarplayStore>((set) => ({
  settings: null,
  gpsSpeed: null,
  heading: null,
  altitude: null,
  gpsFix: null,
  gpsSats: 0,
  leanAngle: null,
  chtLeft: null,
  gForceX: null,
  gForceY: null,
  pitchAngle: null,
  chtRight: null,
  ambientTemp: null,
  piTemp: null,
  gpsSky: null,
  imuPeak: { leanL: 0, leanR: 0, g: 0 },
  chtPeak: { left: 0, right: 0 },
  resetImuPeak: () => set({ imuPeak: { leanL: 0, leanR: 0, g: 0 } }),
  resetChtPeak: () => set({ chtPeak: { left: 0, right: 0 } }),
  saveSettings: (settings) => {
    set({ settings })
    socket.emit('saveSettings', settings)
  },
  getSettings: () => {
    socket.emit('getSettings')
  },
  stream: (stream) => {
    socket.emit('stream', stream)
  },

  // Reset all stored info
  resetInfo: () =>
    set({
      negotiatedWidth: null,
      negotiatedHeight: null,
      serial: null,
      manufacturer: null,
      product: null,
      fwVersion: null,
      audioCodec: null,
      audioSampleRate: null,
      audioChannels: null,
      audioBitDepth: null,
      audioPcmData: null,
    }),

  negotiatedWidth: null,
  negotiatedHeight: null,
  serial: null,
  manufacturer: null,
  product: null,
  fwVersion: null,

  audioCodec: null,
  audioSampleRate: null,
  audioChannels: null,
  audioBitDepth: null,

  audioPcmData: null,
  setPcmData: (data) => set({ audioPcmData: data }),

  setDeviceInfo: ({ serial, manufacturer, product, fwVersion }) =>
    set({ serial, manufacturer, product, fwVersion }),

  setNegotiatedResolution: (width, height) =>
    set({ negotiatedWidth: width, negotiatedHeight: height }),

  setAudioInfo: ({ codec, sampleRate, channels, bitDepth }) =>
    set({
      audioCodec: codec,
      audioSampleRate: sampleRate,
      audioChannels: channels,
      audioBitDepth: bitDepth,
    }),
}))

// Status store
export interface StatusStore {
  reverse: boolean
  lights: boolean

  // Dongle- und Streaming-Status
  isDongleConnected: boolean
  isStreaming: boolean
  cameraFound: boolean
  showDiagnostics: boolean
  activeGraph: MetricKey | null
  homeMode: boolean   // true = idle clock/home view; false = CarPlay view

  setCameraFound: (found: boolean) => void
  setDongleConnected: (connected: boolean) => void
  setStreaming: (streaming: boolean) => void
  setReverse: (reverse: boolean) => void
  setLights: (lights: boolean) => void
  setShowDiagnostics: (show: boolean) => void
  setActiveGraph: (key: MetricKey | null) => void
  setHomeMode: (home: boolean) => void
}

export const useStatusStore = create<StatusStore>((set) => ({
  reverse: false,
  lights: false,
  isDongleConnected: false,
  isStreaming: false,
  cameraFound: false,
  showDiagnostics: false,
  activeGraph: null,
  homeMode: true,

  setCameraFound: (found) => set({ cameraFound: found }),
  setDongleConnected: (connected) => set({ isDongleConnected: connected }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setReverse: (reverse) => set({ reverse }),
  setLights: (lights) => set({ lights }),
  setShowDiagnostics: (show) => set({ showDiagnostics: show }),
  setActiveGraph: (key) => set({ activeGraph: key }),
  setHomeMode: (home) => set({ homeMode: home }),
}))

// Socket.IO Event-Handler
socket.on('settings', (settings: ExtraConfig) => {
  useCarplayStore.setState({ settings })
})

socket.on('reverse', (reverse: boolean) => {
  useStatusStore.setState({ reverse })
})
socket.on('dongle-status', (connected: boolean) => {
  useStatusStore.setState({ isDongleConnected: connected })
})
socket.on('stream-status', (streaming: boolean) => {
  useStatusStore.setState({ isStreaming: streaming })
})
socket.on('camera-found', (found: boolean) => {
  useStatusStore.setState({ cameraFound: found })
})

socket.on('gps', (data: { speed: number; heading: number; altitude: number }) => {
  useCarplayStore.setState({ gpsSpeed: data.speed, heading: data.heading, altitude: data.altitude })
  log('speed',    toMph(data.speed))
  log('heading',  data.heading)
  log('altitude', toFt(data.altitude))
})
socket.on('gps-status', (data: { fix: boolean; sats: number }) => {
  useCarplayStore.setState({ gpsFix: data.fix, gpsSats: data.sats })
})
socket.on('gps-sky', (data: GpsSky) => {
  useCarplayStore.setState({ gpsSky: data })
})
socket.on('lean', (angle: number) => {
  useCarplayStore.setState({ leanAngle: angle })
  setTimeout(() => {
    const off = useCarplayStore.getState().settings?.leanOffset ?? 0
    const cal = angle - off
    log('leanAngle', cal)   // log calibrated value (matches display)
    // Peak-hold: leanR = max right (cal > 0), leanL = max left magnitude (cal < 0)
    const p = useCarplayStore.getState().imuPeak
    const leanR = cal > p.leanR ? cal : p.leanR
    const leanL = -cal > p.leanL ? -cal : p.leanL
    if (leanR !== p.leanR || leanL !== p.leanL)
      useCarplayStore.setState({ imuPeak: { ...p, leanR, leanL } })
  }, 0)
})
socket.on('cht', (data: { left: number | null; right: number | null }) => {
  useCarplayStore.setState({ chtLeft: data.left, chtRight: data.right })
  if (data.left  !== null) log('chtLeft',  data.left)
  if (data.right !== null) log('chtRight', data.right)
  // Peak-hold: hottest each head has reached this ride.
  const p = useCarplayStore.getState().chtPeak
  const left  = data.left  !== null && data.left  > p.left  ? data.left  : p.left
  const right = data.right !== null && data.right > p.right ? data.right : p.right
  if (left !== p.left || right !== p.right)
    useCarplayStore.setState({ chtPeak: { left, right } })
})
socket.on('ambient', (temp: number) => {
  useCarplayStore.setState({ ambientTemp: temp })
  log('ambientTemp', toF(temp))
})
socket.on('pi-temp', (data: { cpu: number }) => {
  useCarplayStore.setState({ piTemp: data.cpu })
  log('piTemp', data.cpu)
})
socket.on('gforce', (data: { x: number; y: number }) => {
  useCarplayStore.setState({ gForceX: data.x, gForceY: data.y })
  const g = Math.sqrt((data.x ?? 0) ** 2 + (data.y ?? 0) ** 2)
  log('gForce', g)
  const p = useCarplayStore.getState().imuPeak
  if (g > p.g) useCarplayStore.setState({ imuPeak: { ...p, g } })
})
socket.on('pitch', (angle: number) => {
  useCarplayStore.setState({ pitchAngle: angle })
  setTimeout(() => {
    const off = useCarplayStore.getState().settings?.pitchOffset ?? 0
    log('pitchAngle', angle - off)   // log calibrated value (matches display)
  }, 0)
})

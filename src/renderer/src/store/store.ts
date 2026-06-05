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
socket.on('lean', (angle: number) => {
  useCarplayStore.setState({ leanAngle: angle })
  setTimeout(() => {
    const off = useCarplayStore.getState().settings?.leanOffset ?? 0
    log('leanAngle', angle - off)   // log calibrated value (matches display)
  }, 0)
})
socket.on('cht', (data: { left: number | null; right: number | null }) => {
  useCarplayStore.setState({ chtLeft: data.left, chtRight: data.right })
  if (data.left  !== null) log('chtLeft',  data.left)
  if (data.right !== null) log('chtRight', data.right)
})
socket.on('ambient', (temp: number) => {
  useCarplayStore.setState({ ambientTemp: temp })
  log('ambientTemp', toF(temp))
})
socket.on('gforce', (data: { x: number; y: number }) => {
  useCarplayStore.setState({ gForceX: data.x, gForceY: data.y })
  log('gForce', Math.sqrt((data.x ?? 0) ** 2 + (data.y ?? 0) ** 2))
})
socket.on('pitch', (angle: number) => {
  useCarplayStore.setState({ pitchAngle: angle })
  setTimeout(() => {
    const off = useCarplayStore.getState().settings?.pitchOffset ?? 0
    log('pitchAngle', angle - off)   // log calibrated value (matches display)
  }, 0)
})

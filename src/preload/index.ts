import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { ExtraConfig } from '../main/Globals'

type ApiCallback<T = any> = (event: IpcRendererEvent, ...args: T[]) => void

let usbEventQueue: [IpcRendererEvent, ...any[]][] = []
let usbEventHandlers: ApiCallback<any>[] = []

ipcRenderer.on('usb-event', (event, ...args) => {
  if (usbEventHandlers.length) {
    usbEventHandlers.forEach((h) => h(event, ...args))
  } else {
    usbEventQueue.push([event, ...args])
  }
})

type ChunkHandler = (payload: any) => void

let videoChunkHandler: ChunkHandler | null = null

let audioChunkHandler: ChunkHandler | null = null

ipcRenderer.on('carplay-video-chunk', (_event, payload) => {
  if (videoChunkHandler) {
    videoChunkHandler(payload)
  }
})

ipcRenderer.on('carplay-audio-chunk', (_event, payload) => {
  if (audioChunkHandler) {
    audioChunkHandler(payload)
  }
})

const api = {
  quit: () => ipcRenderer.invoke('quit'),
  systemStats: () => ipcRenderer.invoke('system-stats'),
  diagnostics: {
    log: (message: string, data?: unknown) => ipcRenderer.send('renderer-diagnostics', { message, data })
  },

  onUSBResetStatus: (callback: ApiCallback<any>) => {
    ipcRenderer.on('usb-reset-start', callback)
    ipcRenderer.on('usb-reset-done', callback)
    return () => {
      ipcRenderer.removeListener('usb-reset-start', callback)
      ipcRenderer.removeListener('usb-reset-done', callback)
    }
  },

  usb: {
    forceReset: () => ipcRenderer.invoke('usb-force-reset'),
    detectDongle: () => ipcRenderer.invoke('usb-detect-dongle'),
    getDeviceInfo: () => ipcRenderer.invoke('carplay:usbDevice'),
    getLastEvent: () => ipcRenderer.invoke('usb-last-event'),
    getSysdefaultPrettyName: () => ipcRenderer.invoke('get-sysdefault-mic-label'),
    listenForEvents: (callback: ApiCallback<any>) => {
      usbEventHandlers.push(callback)
      usbEventQueue.forEach(([evt, ...args]) => callback(evt, ...args))
      usbEventQueue = []
    },
    unlistenForEvents: (callback: ApiCallback<any>) => {
      usbEventHandlers = usbEventHandlers.filter((cb) => cb !== callback)
    }
  },

  settings: {
    get: () => ipcRenderer.invoke('getSettings'),
    save: (settings: ExtraConfig) => ipcRenderer.invoke('save-settings', settings),
    onUpdate: (callback: ApiCallback<ExtraConfig>) => ipcRenderer.on('settings', callback),
    offUpdate: (callback: ApiCallback<ExtraConfig>) =>
      ipcRenderer.removeListener('settings', callback)
  },

  ipc: {
    start: () => ipcRenderer.invoke('carplay-start'),
    stop: () => ipcRenderer.invoke('carplay-stop'),
    sendFrame: () => ipcRenderer.invoke('carplay-sendframe'),
    sendTouch: (x: number, y: number, action: number) =>
      ipcRenderer.send('carplay-touch', { x, y, action }),
    sendKeyCommand: (key: string) => ipcRenderer.send('carplay-key-command', key),
    onEvent: (callback: ApiCallback<any>) => ipcRenderer.on('carplay-event', callback),
    offEvent: (callback: ApiCallback<any>) => ipcRenderer.removeListener('carplay-event', callback),

    onVideoChunk: (handler: ChunkHandler) => {
      videoChunkHandler = handler
    },
    offVideoChunk: (handler: ChunkHandler) => {
      if (videoChunkHandler === handler) videoChunkHandler = null
    },
    onAudioChunk: (handler: ChunkHandler) => {
      audioChunkHandler = handler
    },
    offAudioChunk: (handler: ChunkHandler) => {
      if (audioChunkHandler === handler) audioChunkHandler = null
    }
  }
}

contextBridge.exposeInMainWorld('carplay', api)

declare global {
  interface Window {
    carplay: typeof api
  }
}

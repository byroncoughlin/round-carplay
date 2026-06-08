// DEMO-ONLY browser stubs for the Electron preload bridge.
//
// In the real app, the preload exposes window.carplay / window.electron over
// IPC. In the browser none of that exists, so we install harmless no-op stubs
// before the React tree mounts. The CarPlay video pipeline simply stays idle
// (no dongle), which is expected — the demo showcases the sensor dashboard.

const noop = () => {}
const asyncNoop = async () => undefined

const carplay = {
  quit: asyncNoop,
  onUSBResetStatus: noop,
  usb: {
    forceReset: asyncNoop,
    detectDongle: asyncNoop,
    getDeviceInfo: async () => null,
    getLastEvent: async () => null,
    getSysdefaultPrettyName: async () => 'Demo',
    listenForEvents: noop,
    unlistenForEvents: noop,
  },
  settings: {
    get: asyncNoop,
    save: asyncNoop,
    onUpdate: noop,
  },
  ipc: {
    start: asyncNoop,
    stop: asyncNoop,
    sendFrame: asyncNoop,
    sendTouch: noop,
    sendKeyCommand: noop,
    onEvent: noop,
    onVideoChunk: noop,
    onAudioChunk: noop,
  },
}

const electron = {
  ipcRenderer: {
    on: noop,
    once: noop,
    send: noop,
    invoke: asyncNoop,
    removeListener: noop,
    removeAllListeners: noop,
  },
  process: { platform: 'web' },
}

const w = window as any
w.carplay = carplay
w.electron = electron
w.api = {}
w.electronAPI = {}

export {}

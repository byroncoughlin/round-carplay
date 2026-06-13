// ───────────────────────────────────────────────────────────────────────────
// DEMO-ONLY fake socket.io client.
//
// The web build (vite.web.config.ts) aliases 'socket.io-client' to this module,
// so store.ts's `io(URL)` returns this fake socket instead of dialing the Pi's
// localhost:4000 bridge. All of store.ts's real `socket.on(...)` handlers
// (peak-hold, data-log, unit conversions) are reused verbatim — we just feed
// them a synthetic ride so the dashboard looks alive on the website.
// ───────────────────────────────────────────────────────────────────────────

type Handler = (...args: any[]) => void

// A valid ExtraConfig (mirrors main/index.ts loadConfig defaults) so the
// renderer leaves its "waiting for settings" state and renders fully.
const SETTINGS = {
  // DongleConfig
  width: 800, height: 480, fps: 60, dpi: 140, format: 5, iBoxVersion: 2,
  phoneWorkMode: 2, packetMax: 49152, boxName: 'nodePlay', nightMode: true,
  hand: 0, mediaDelay: 500, audioTransferMode: false, wifiType: '5ghz',
  micType: 'os', phoneConfig: {},
  // ExtraConfig extras
  kiosk: true, camera: '', microphone: '', audioVolume: 1, navVolume: 0.5,
  leanOffset: 0, pitchOffset: 0, backdropEnabled: true,
  // The Pi keeps the center square unclipped for video-compositor performance.
  // The demo has no live video, so round the square (gives graphs rounded
  // corners to match the original prototype). Pi config is unaffected.
  diagnosticRoundedCarplayClip: true,
  bindings: {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    selectUp: 'KeyB', selectDown: 'Space', back: 'Backspace', home: 'KeyH',
    play: 'KeyP', pause: 'KeyO', next: 'KeyM', prev: 'KeyN',
  },
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// A fixed satellite constellation for the GPS Sky View (deterministic so the
// plot is stable; SNR wobbles slightly with time for a "live" feel).
const SAT_BASE = [
  { prn: 5,  el: 71, az: 42,  snr: 44, used: true },
  { prn: 12, el: 58, az: 310, snr: 41, used: true },
  { prn: 20, el: 49, az: 128, snr: 39, used: true },
  { prn: 25, el: 44, az: 205, snr: 38, used: true },
  { prn: 2,  el: 33, az: 95,  snr: 35, used: true },
  { prn: 29, el: 28, az: 260, snr: 33, used: true },
  { prn: 15, el: 21, az: 18,  snr: 30, used: true },
  { prn: 6,  el: 17, az: 168, snr: 27, used: true },
  { prn: 31, el: 12, az: 305, snr: 22, used: false },
  { prn: 18, el: 9,  az: 78,  snr: 18, used: false },
  { prn: 24, el: 6,  az: 220, snr: 14, used: false },
]

class FakeSocket {
  private handlers = new Map<string, Handler[]>()
  private t = 0                 // virtual ride time, seconds
  private prevSpeedKmh = 0
  private started = false

  constructor() {
    // store.ts registers all its `.on(...)` handlers synchronously right after
    // io() returns. Defer the first emit so those registrations exist.
    setTimeout(() => this.start(), 0)
  }

  on(event: string, cb: Handler) {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
    return this
  }
  off(event: string, cb?: Handler) {
    if (!cb) { this.handlers.delete(event); return this }
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== cb))
    return this
  }
  // Outgoing emits (saveSettings/getSettings/stream) are no-ops in the demo.
  emit() { return this }
  connect() { return this }
  disconnect() { return this }
  removeAllListeners() { this.handlers.clear(); return this }

  private fire(event: string, ...args: any[]) {
    ;(this.handlers.get(event) ?? []).forEach((h) => {
      try { h(...args) } catch (e) { console.warn('[demo] handler error', event, e) }
    })
  }

  private start() {
    if (this.started) return
    this.started = true

    // One-time status so the UI shows a connected/streaming state. `stream-status:
    // true` is what lets BackdropGlow render the ambient round fill (it's gated on
    // isStreaming) — the demo feeds it the static CarPlay map as the "video frame".
    this.fire('settings', SETTINGS)
    this.fire('dongle-status', true)
    this.fire('stream-status', true)
    this.fire('camera-found', false)
    this.fire('gps-status', { fix: true, sats: 8 })

    const DT = 0.05 // 20 Hz
    let slow = 0
    setInterval(() => {
      this.t += DT
      const t = this.t
      this.fastTick(t, DT)
      slow += DT
      if (slow >= 1) { slow = 0; this.slowTick(t) }
    }, DT * 1000)
  }

  // 20 Hz: attitude + g-force (smooth, drives lean/pitch/G panels + graphs).
  private fastTick(t: number, dt: number) {
    // Lean: layered sines sweep through gentle and aggressive corners (±~36°).
    const lean = 28 * Math.sin(t / 6.5) + 8 * Math.sin(t / 2.1)
    // Pitch: rolling hills, plus a nose-dive when decelerating hard.
    const speedKmh = this.speedAt(t)
    const accel = (speedKmh - this.prevSpeedKmh) / dt / 3.6 // m/s²
    this.prevSpeedKmh = speedKmh
    const pitch = 5 * Math.sin(t / 17) - clamp(accel, -4, 4) * 1.1
    // G-force: lateral tracks lean; longitudinal tracks accel/brake.
    const gx = (lean / 45) * 0.95 + 0.03 * Math.sin(t * 3)
    const gy = clamp(accel / 9.81, -1.3, 1.3)

    this.fire('lean', lean)
    this.fire('pitch', pitch)
    this.fire('gforce', { x: gx, y: gy })
  }

  // 1 Hz: GPS, engine temps, ambient, Pi temp, sky view.
  private slowTick(t: number) {
    const speedKmh = this.speedAt(t)
    const heading = (180 + 70 * Math.sin(t / 21) + 360) % 360
    const altitude = 320 + 150 * Math.sin(t / 26) // meters
    this.fire('gps', { speed: speedKmh, heading, altitude })

    // Engine warms 40→~165°C over the first ~45s, then breathes with load.
    const warm = clamp(t / 45, 0, 1)
    const base = 40 + warm * 125
    const load = speedKmh * 0.18
    const chtLeft = clamp(base + load + 10 * Math.sin(t / 9), 30, 250)
    const chtRight = clamp(base + load + 10 * Math.sin(t / 9 + 0.7) + 5, 30, 250)
    this.fire('cht', { left: chtLeft, right: chtRight })

    this.fire('ambient', 21 + 2 * Math.sin(t / 60))
    this.fire('pi-temp', { cpu: 54 + 4 * Math.sin(t / 30) })

    const sats = SAT_BASE.map((s) => ({
      ...s,
      snr: s.snr === null ? null : clamp(s.snr + 2 * Math.sin(t / 5 + s.prn), 0, 50),
    }))
    this.fire('gps-sky', {
      fixType: 3, satsUsed: 8, satsInView: sats.length,
      hdop: 0.8, pdop: 1.4, lat: 47.6097, lon: -122.3331,
      sats, ttff: 32, acquiring: null,
    })
  }

  // Cruise with curves and a periodic braking event.
  private speedAt(t: number) {
    const cruise = 72 + 38 * Math.sin(t / 14)
    const brake = 28 * Math.max(0, Math.sin(t / 19 - 1)) ** 3
    return clamp(cruise - brake, 0, 135)
  }
}

let singleton: FakeSocket | null = null

export function io(): FakeSocket {
  if (!singleton) singleton = new FakeSocket()
  return singleton
}

export default { io }

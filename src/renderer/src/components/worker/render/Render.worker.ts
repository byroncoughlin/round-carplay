import { getDecoderConfig, getNaluFromStream, NaluTypes } from './lib/utils'
import { InitEvent, WorkerEvent } from './RenderEvents'
import { WebGL2Renderer } from './WebGL2Renderer'
import { WebGLRenderer } from './WebGLRenderer'
import { WebGPURenderer } from './WebGPURenderer'

export interface FrameRenderer {
  draw(data: VideoFrame): void
}

const scope = self as unknown as Worker

// --- Ambient "blurred fill" backdrop -------------------------------------------
// Emit a small, throttled snapshot of the live frame so the main thread can
// paint a blurred, scaled-up copy behind the gauges (fills the round display).
// Heavily downscaled — the blur hides it and it keeps the Pi cheap. Toggled at
// runtime from the renderer (Settings → BACKDROP) via a 'set-backdrop' message.
const BACKDROP_INTERVAL_MS = 1000  // ~1 fps — color wash, not live video
const BACKDROP_WIDTH = 32          // px; height scaled to keep aspect. Tiny on
                                   // purpose: the ~16x upscale is most of the blur,
                                   // and the smaller frame is cheaper to resize/draw.
const MAX_DECODE_QUEUE_FOR_DELTA = 2
const MAX_DECODE_QUEUE_BEFORE_RESET = 10
const DECODER_BACKLOG_LOG_MS = 1000
const MAX_VIDEO_FRAME_AGE_MS = 500
const STALE_VIDEO_LOG_MS = 1000

type VideoPortMessage = ArrayBuffer | { buffer?: ArrayBuffer; sentAt?: number }

export class RendererWorker {
  private readonly vendorHeaderSize = 20
  private renderer: FrameRenderer | null = null
  private videoPort: MessagePort | null = null
  private canvas: OffscreenCanvas | null = null
  private startTime: number | null = null
  private frameCount = 0
  private fps = 0
  private decoder: VideoDecoder
  private isConfigured = false
  private lastSPS: Uint8Array | null = null
  private useHardware = false
  private forceHardwareDecode = false
  private awaitingValidKeyframe = true
  private hardwareAccelerationTested = false
  private selectedRenderer: string | null = null
  private lastBackdropTime = 0
  private backdropEnabled = false
  private backdropCanvas: OffscreenCanvas | null = null
  private backdropCtx: OffscreenCanvasRenderingContext2D | null = null
  private droppedDecoderFrames = 0
  private decoderBacklogResets = 0
  private maxDecodeQueue = 0
  private lastDecoderBacklogLog = 0
  private staleVideoDrops = 0
  private maxStaleVideoAge = 0
  private lastStaleVideoLog = 0

  setBackdrop = (enabled: boolean) => {
    this.backdropEnabled = enabled
  }

  constructor() {
    this.decoder = new VideoDecoder({
      output: this.onVideoDecoderOutput,
      error: this.onVideoDecoderOutputError
    })
  }

  private onVideoDecoderOutput = (frame: VideoFrame) => {
    if (this.startTime == null) {
      this.startTime = performance.now()
    } else {
      const elapsed = (performance.now() - this.startTime) / 1000
      this.fps = ++this.frameCount / elapsed
    }

    if (!this.renderer) {
      frame.close()
      return
    }

    // Draw the instant a frame decodes — no requestAnimationFrame wait. The
    // compositor samples the latest canvas commit on its own vsync, so pacing
    // here only added latency: frames arrive every ~16.9ms while vsync is
    // 16.7ms, so an aligned draw drifts past the boundary every few frames,
    // waits two vsyncs, and gets overwritten — measured ~49fps shown of 60
    // received, as a rhythmic judder. Immediate draw shows every frame.
    this.renderer.draw(frame)

    // Ambient backdrop tap — copy from the just-drawn GL canvas (GPU→GPU)
    // instead of converting the software VideoFrame on this thread, which
    // stalled decode for up to ~7ms every sample (a visible 5Hz hitch).
    // Same-task readback is safe: the GL backbuffer persists until this task
    // ends. Best-effort — any failure is swallowed so video is never hurt.
    const now = performance.now()
    if (this.backdropEnabled && this.canvas && now - this.lastBackdropTime >= BACKDROP_INTERVAL_MS) {
      this.lastBackdropTime = now
      try {
        const cw = this.canvas.width || 1
        const th = Math.max(1, Math.round(BACKDROP_WIDTH * ((this.canvas.height || 1) / cw)))
        if (!this.backdropCanvas || this.backdropCanvas.width !== BACKDROP_WIDTH || this.backdropCanvas.height !== th) {
          this.backdropCanvas = new OffscreenCanvas(BACKDROP_WIDTH, th)
          this.backdropCtx = this.backdropCanvas.getContext('2d')
        }
        if (this.backdropCtx) {
          this.backdropCtx.drawImage(this.canvas, 0, 0, BACKDROP_WIDTH, th)
          const bmp = this.backdropCanvas.transferToImageBitmap()
          scope.postMessage({ type: 'backdrop-frame', bitmap: bmp }, [bmp])
        }
      } catch {
        /* canvas not readable this tick — skip this snapshot */
      }
    }
  }

  private onVideoDecoderOutputError = (err: Error) => {
    console.error(`[RENDER.WORKER] Decoder error`, err)
  }

  private reportDecoderBacklog(action: 'drop-delta' | 'reset', queueSize: number, key: boolean) {
    const now = performance.now()
    this.maxDecodeQueue = Math.max(this.maxDecodeQueue, queueSize)
    if (action === 'drop-delta') this.droppedDecoderFrames++
    else this.decoderBacklogResets++

    if (now - this.lastDecoderBacklogLog < DECODER_BACKLOG_LOG_MS) return

    scope.postMessage({
      type: 'render-diagnostics',
      message: 'decoder-backlog',
      data: {
        action,
        queueSize,
        maxQueue: this.maxDecodeQueue,
        droppedDeltaFrames: this.droppedDecoderFrames,
        resets: this.decoderBacklogResets,
        key
      }
    })
    this.lastDecoderBacklogLog = now
    this.droppedDecoderFrames = 0
    this.decoderBacklogResets = 0
    this.maxDecodeQueue = 0
  }

  private reportStaleVideoDrop(ageMs: number) {
    const now = performance.now()
    this.staleVideoDrops++
    this.maxStaleVideoAge = Math.max(this.maxStaleVideoAge, ageMs)

    if (now - this.lastStaleVideoLog < STALE_VIDEO_LOG_MS) return

    scope.postMessage({
      type: 'render-diagnostics',
      message: 'stale-video-drop',
      data: {
        dropped: this.staleVideoDrops,
        ageMs,
        maxAgeMs: this.maxStaleVideoAge
      }
    })
    this.lastStaleVideoLog = now
    this.staleVideoDrops = 0
    this.maxStaleVideoAge = 0
  }

  init = async (event: InitEvent & { platform?: string }) => {
    this.useHardware = event.useHardware
    this.forceHardwareDecode = event.forceHardwareDecode === true
    this.canvas = event.canvas

    this.videoPort = event.videoPort
    this.videoPort.onmessage = (ev: MessageEvent<VideoPortMessage>) => {
      const data = ev.data
      if (data instanceof ArrayBuffer) {
        this.processRaw(data)
      } else if (data?.buffer instanceof ArrayBuffer) {
        this.processRaw(data.buffer, data.sentAt)
      }
    }
    this.videoPort.start()

    if (event.reportFps) {
      setInterval(() => {
        if (this.decoder.state === 'configured') {
          console.debug(`[RENDER.WORKER] FPS: ${this.fps.toFixed(2)}`)
        }
      }, 5000)
    }

    await this.evaluateRendererCapabilities()

    if (this.selectedRenderer === 'webgl2') {
      this.renderer = new WebGL2Renderer(event.canvas)
    } else if (this.selectedRenderer === 'webgl') {
      this.renderer = new WebGLRenderer(event.canvas)
    } else if (this.selectedRenderer === 'webgpu') {
      this.renderer = new WebGPURenderer(event.canvas)
    }

    if (!this.renderer) {
      console.warn('[RENDER.WORKER] No valid renderer selected, cannot proceed.')
      return
    }

    self.postMessage({ type: 'render-ready' })
    console.debug('[RENDER.WORKER] render-ready')
  }

  private async evaluateRendererCapabilities() {
    if (this.hardwareAccelerationTested) return

    console.debug('[RENDER.WORKER] Starting hardware acceleration tests...')

    const platform = navigator.platform.toLowerCase()
    const isMac = platform.startsWith('mac')
    const isLinux = platform.includes('linux')

    const rendererPriority = isMac ? ['webgpu', 'webgl2', 'webgl'] : ['webgl2', 'webgl', 'webgpu']

    const results: Record<string, { hw: boolean; sw: boolean; available: boolean }> = {}
    for (const r of rendererPriority) {
      results[r] = await this.isRendererSupported(r)
      console.debug(
        `[RENDER.WORKER] ${r.toUpperCase()}: available=${results[r].available}, ` +
          `hw=${results[r].hw}, sw=${results[r].sw}`
      )
    }

    // Normal Linux path stays software-first because that has been stable on
    // the Pi. The diagnostic flag lets us force a hardware-first A/B while
    // still falling back if the browser rejects hardware decode.
    const selectOrder: ('hw' | 'sw')[] = this.forceHardwareDecode
      ? ['hw', 'sw']
      : isLinux
        ? ['sw', 'hw']
        : ['hw', 'sw']

    for (const mode of selectOrder) {
      for (const r of rendererPriority) {
        const caps = results[r]
        if (caps.available && caps[mode]) {
          this.selectedRenderer = r
          this.useHardware = mode === 'hw'
          this.hardwareAccelerationTested = true
          console.debug(
            `[RENDER.WORKER] Selected renderer: ${r} (` +
              `${mode === 'hw' ? 'hardware' : 'software'})`
          )
          scope.postMessage({
            type: 'render-diagnostics',
            message: 'decoder-selection',
            data: {
              renderer: r,
              decodeMode: mode === 'hw' ? 'hardware' : 'software',
              forceHardwareDecode: this.forceHardwareDecode,
              platform,
              isLinux,
              caps: results
            }
          })
          return
        }
      }
    }

    console.warn('[RENDER.WORKER] No suitable renderer found')
    scope.postMessage({
      type: 'render-diagnostics',
      message: 'decoder-selection',
      data: {
        renderer: null,
        decodeMode: null,
        forceHardwareDecode: this.forceHardwareDecode,
        platform,
        isLinux,
        caps: results
      }
    })
  }

  private async isRendererSupported(
    renderer: string
  ): Promise<{ hw: boolean; sw: boolean; available: boolean }> {
    const canvas = new OffscreenCanvas(1, 1)
    let context: WebGLRenderingContext | WebGL2RenderingContext | GPUCanvasContext | null = null

    if (renderer === 'webgl2') {
      context = canvas.getContext('webgl2')
    } else if (renderer === 'webgl') {
      context = canvas.getContext('webgl')
    } else if (renderer === 'webgpu') {
      try {
        context = canvas.getContext('webgpu')
      } catch (e) {
        context = null
      }
    }

    if (!context) {
      return { hw: false, sw: false, available: false }
    }

    let hwSupported = false
    let swSupported = false

    const hwConfig: VideoDecoderConfig = {
      codec: 'avc1.64002A',
      hardwareAcceleration: 'prefer-hardware'
    }
    try {
      const hwSupportedResult = await VideoDecoder.isConfigSupported(hwConfig)
      hwSupported = !!hwSupportedResult.supported
    } catch (e) {
      console.warn(`[RENDER.WORKER] Error testing ${renderer} hardware:`, e)
    }

    const swConfig: VideoDecoderConfig = {
      codec: 'avc1.64002A',
      hardwareAcceleration: 'prefer-software'
    }
    try {
      const swSupportedResult = await VideoDecoder.isConfigSupported(swConfig)
      swSupported = !!swSupportedResult.supported
    } catch (e) {
      console.warn(`[RENDER.WORKER] Error testing ${renderer} software:`, e)
    }

    context = null

    return { hw: hwSupported, sw: swSupported, available: true }
  }

  private async configureDecoder(config: VideoDecoderConfig) {
    const accel = this.useHardware ? 'prefer-hardware' : 'prefer-software'
    const cfg: VideoDecoderConfig = {
      ...structuredClone(config),
      hardwareAcceleration: accel,
      // live interactive stream: never let the decoder buffer frames for
      // reordering — output each frame as soon as it decodes
      optimizeForLatency: true
    }

    try {
      console.debug('[RENDER.WORKER] Configuring decoder with:', cfg)
      this.decoder.configure(cfg)
      scope.postMessage({
        type: 'render-diagnostics',
        message: 'decoder-config',
        data: {
          codec: cfg.codec,
          hardwareAcceleration: cfg.hardwareAcceleration,
          optimizeForLatency: cfg.optimizeForLatency,
          forceHardwareDecode: this.forceHardwareDecode,
          renderer: this.selectedRenderer
        }
      })
      this.isConfigured = true
      return true
    } catch (err) {
      console.warn(`[RENDER.WORKER] Config ${accel} error`, err)
      scope.postMessage({
        type: 'render-diagnostics',
        message: 'decoder-config-error',
        data: {
          codec: cfg.codec,
          hardwareAcceleration: cfg.hardwareAcceleration,
          forceHardwareDecode: this.forceHardwareDecode,
          renderer: this.selectedRenderer,
          error: String(err)
        }
      })
      return false
    }
  }

  // Cheap Annex B keyframe check: walk start codes and stop at the first VCL
  // NALU (IDR=5 → key, non-IDR=1 → delta). The library isKeyFrame() walks the
  // ENTIRE buffer through a Bitstream wrapper looking for an IDR — for every
  // delta frame (i.e. almost all of them) that's a full scan, twice per frame
  // counting the SPS hunt. VCL NALUs sit right after the parameter sets, so
  // this exits within the first few hundred bytes.
  private static isKeyFrameFast(data: Uint8Array): boolean {
    const n = data.length
    for (let i = 0; i + 3 < n; i++) {
      if (data[i] !== 0 || data[i + 1] !== 0) continue
      let off = 0
      if (data[i + 2] === 1) off = 3
      else if (data[i + 2] === 0 && data[i + 3] === 1) off = 4
      if (!off || i + off >= n) continue
      const type = data[i + off] & 0x1f
      if (type === NaluTypes.IDR) return true
      if (type === NaluTypes.NDR) return false
      i += off // skip past the start code; loop's i++ steps onto the NALU body
    }
    return false
  }

  private async processRaw(buffer: ArrayBuffer, sentAt?: number) {
    if (!buffer.byteLength) return

    if (typeof sentAt === 'number' && Number.isFinite(sentAt)) {
      const ageMs = Date.now() - sentAt
      if (ageMs > MAX_VIDEO_FRAME_AGE_MS) {
        this.reportStaleVideoDrop(ageMs)
        return
      }
    }

    const data = new Uint8Array(buffer)
    const videoData =
      data.length > this.vendorHeaderSize ? data.subarray(this.vendorHeaderSize) : data

    const key = RendererWorker.isKeyFrameFast(videoData)
    const now = performance.now()

    if (!this.isConfigured || key) {
      // Only hunt for SPS while configuring or on keyframes. The keyframe path
      // lets a backlog reset recover with the freshest stream config.
      const sps = getNaluFromStream(videoData, NaluTypes.SPS)
      if (sps) {
        console.debug('[RENDER.WORKER] SPS detected, length:', sps.rawNalu?.length)
        this.lastSPS = sps.rawNalu
      }
    }

    const queueSize = this.decoder.decodeQueueSize
    if (this.isConfigured && queueSize >= MAX_DECODE_QUEUE_BEFORE_RESET) {
      this.reportDecoderBacklog('reset', queueSize, key)
      try {
        this.decoder.reset()
      } catch (e) {
        console.warn('[RENDER.WORKER] Decoder reset after backlog failed', e)
      }
      this.isConfigured = false
      this.awaitingValidKeyframe = true
    }

    if (this.awaitingValidKeyframe && !key) {
      console.debug('[RENDER.WORKER] Ignoring delta while awaiting keyframe...')
      return
    }

    if (key && this.lastSPS && !this.isConfigured) {
      console.debug('[RENDER.WORKER] First keyframe detected, attempting decoder config...')
      const config = getDecoderConfig(this.lastSPS)
      if (config && (await this.configureDecoder(config))) {
        try {
          const chunk = new EncodedVideoChunk({
            type: 'key',
            timestamp: now,
            data: videoData
          })
          this.decoder.decode(chunk)
          console.debug('[RENDER.WORKER] SPS+IDR sent')
          this.awaitingValidKeyframe = false
          return
        } catch (e) {
          console.warn('[RENDER.WORKER] Failed to decode first keyframe', e)
          return
        }
      }
    }

    if (!this.isConfigured || this.awaitingValidKeyframe) return

    if (!key && this.decoder.decodeQueueSize > MAX_DECODE_QUEUE_FOR_DELTA) {
      this.reportDecoderBacklog('drop-delta', this.decoder.decodeQueueSize, key)
      return
    }

    const chunk = new EncodedVideoChunk({
      type: key ? 'key' : 'delta',
      timestamp: now,
      data: videoData
    })

    try {
      this.decoder.decode(chunk)
    } catch (e) {
      console.error('[RENDER.WORKER] Error during decoding:', e)
    }
  }
}

const worker = new RendererWorker()
scope.addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
  if (event.data.type === 'init') {
    worker.init(event.data as InitEvent & { platform?: string })
  } else if ((event.data as any).type === 'set-backdrop') {
    worker.setBackdrop((event.data as any).enabled)
  }
})

export {}

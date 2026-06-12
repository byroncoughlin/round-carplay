import { useEffect, useRef } from 'react'
import { useBackdrop } from '../store/backdrop'
import { useCarplayStore, useStatusStore } from '../store/store'

// Blurred "ambient fill" backdrop — paints a scaled-up, heavily-blurred copy of
// the live CarPlay frame across the whole round display so the dead space around
// the center square (where the gauges live) bleeds the on-screen color instead
// of sitting on black. Same trick used to letterbox vertical video.
//
// The render worker feeds a tiny ImageBitmap (~1fps) into the backdrop store.
// Rather than hard-cutting to each frame (which makes the glow jump on colorful
// scrolling), we blend each new frame partway onto the previous one — the color
// eases toward the current scene instead of snapping. Lower FLOW = slower/dreamier.
const FLOW = 0.55 // 0..1 — fraction of the new frame mixed in per sample

// PERF: the soft "dreamy" look used to come from CSS filters on the full
// ~800px layer. The Pi can make that expensive, so all blur/color work happens
// while drawing into this tiny canvas. The big upscale supplies the softness.
const SRC_BLUR = 7 // px, applied in canvas space before upscaling

export default function BackdropGlow() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hasContentRef = useRef(false)
  const isStreaming = useStatusStore((s) => s.isStreaming)
  const homeMode = useStatusStore((s) => s.homeMode)
  // BACKDROP setting is opt-in. When off, the layer is removed entirely.
  const enabled = useCarplayStore((s) => s.settings?.backdropEnabled === true)
  const visible = enabled && isStreaming && !homeMode

  useEffect(() => {
    const draw = (bmp: ImageBitmap | null) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const W = canvas.width
      const H = canvas.height
      if (!bmp) {
        ctx.clearRect(0, 0, W, H)
        hasContentRef.current = false
        return
      }
      // cover-fit (fill the square, crop overflow) so the blurred scene roughly
      // lines up with the sharp center square's framing
      const s = Math.max(W / bmp.width, H / bmp.height)
      const dw = bmp.width * s
      const dh = bmp.height * s
      const dx = (W - dw) / 2
      const dy = (H - dh) / 2
      // Filter cheaply at canvas resolution instead of on the full display layer.
      ctx.filter = `blur(${SRC_BLUR}px) saturate(1.5) brightness(0.92)`
      if (!hasContentRef.current) {
        // first frame: paint fully so we don't ramp up from transparent
        ctx.globalAlpha = 1
        ctx.clearRect(0, 0, W, H)
        ctx.drawImage(bmp, dx, dy, dw, dh)
        hasContentRef.current = true
      } else {
        // temporal crossfade: ease the existing backdrop toward the new frame
        ctx.globalAlpha = FLOW
        ctx.drawImage(bmp, dx, dy, dw, dh)
      }
      ctx.globalAlpha = 1
      ctx.filter = 'none'
    }

    draw(useBackdrop.getState().frame)
    const unsub = useBackdrop.subscribe((state) => draw(state.frame))
    return unsub
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={96}
      height={96}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        // Hidden/off → removed from compositing entirely (no blur cost).
        display: visible ? 'block' : 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.5s ease',
        // Keep the compositor layer unfiltered; filtering the full-screen layer
        // was one of the easiest ways to make CarPlay video/touch feel sticky.
        transform: 'scale(1.32)',
        pointerEvents: 'none',
      }}
    />
  )
}

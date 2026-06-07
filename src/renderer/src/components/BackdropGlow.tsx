import { useEffect, useRef } from 'react'
import { useBackdrop } from '../store/backdrop'
import { useCarplayStore, useStatusStore } from '../store/store'

// Blurred "ambient fill" backdrop — paints a scaled-up, heavily-blurred copy of
// the live CarPlay frame across the whole round display so the dead space around
// the center square (where the gauges live) bleeds the on-screen color instead
// of sitting on black. Same trick used to letterbox vertical video.
//
// The render worker feeds a tiny ImageBitmap (~10fps) into the backdrop store.
// Rather than hard-cutting to each frame (which makes the glow jump on colorful
// scrolling), we blend each new frame partway onto the previous one — the color
// eases toward the current scene instead of snapping. Lower FLOW = slower/dreamier.
const FLOW = 0.3 // 0..1 — fraction of the new frame mixed in per sample

export default function BackdropGlow() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hasContentRef = useRef(false)
  const isStreaming = useStatusStore((s) => s.isStreaming)
  const homeMode = useStatusStore((s) => s.homeMode)
  // BACKDROP setting (default on). When off, the layer is removed entirely.
  const enabled = useCarplayStore((s) => s.settings?.backdropEnabled !== false)
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
    }

    draw(useBackdrop.getState().frame)
    const unsub = useBackdrop.subscribe((state) => draw(state.frame))
    return unsub
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={192}
      height={192}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        // off → removed from compositing entirely (no blur cost); on → fade
        display: enabled ? 'block' : 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.5s ease',
        // "dreamy" look: heavy blur + slight overscale for a smooth ambient halo
        filter: 'blur(56px) saturate(1.5) brightness(0.92)',
        transform: 'scale(1.32)',
        pointerEvents: 'none',
      }}
    />
  )
}

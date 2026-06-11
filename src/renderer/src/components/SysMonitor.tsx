import { useEffect, useRef, useState } from 'react'

// Hidden, on-demand Pi monitor. Opens on a TWO-FINGER press-and-hold (~1s):
// there's no visible button, and two fingers never collide with the single-tap
// gauges. Costs nothing while closed — just two passive pointer listeners, no
// polling, no IPC. While open it asks the main process for /proc stats once a
// second; closing it stops everything.

interface Stats {
  cpu?: number
  cores?: number[]
  memUsedMb?: number | null
  memTotalMb?: number | null
  memPct?: number | null
  swapUsedMb?: number | null
  tempC?: number | null
  load?: number[] | null
  uptime?: number | null
  error?: string
}

const HOLD_MS = 1000

const heat = (v: number, warm: number, hot: number) =>
  v >= hot ? '#ef5350' : v >= warm ? '#ffca28' : '#66bb6a'

const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function SysMonitor() {
  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const openRef = useRef(false)
  openRef.current = open

  // ── two-finger long-press to open ──────────────────────────────────────────
  useEffect(() => {
    // inert when the bridge isn't there (e.g. the public web demo)
    if (typeof window.carplay?.systemStats !== 'function') return
    const active = new Set<number>()
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
    const down = (e: PointerEvent) => {
      active.add(e.pointerId)
      if (active.size === 2 && !timer && !openRef.current) {
        timer = setTimeout(() => { if (active.size >= 2) setOpen(true) }, HOLD_MS)
      }
    }
    const up = (e: PointerEvent) => { active.delete(e.pointerId); if (active.size < 2) clear() }
    window.addEventListener('pointerdown', down, { passive: true })
    window.addEventListener('pointerup', up, { passive: true })
    window.addEventListener('pointercancel', up, { passive: true })
    return () => {
      clear()
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  // ── poll only while open ───────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    let alive = true
    const tick = async () => {
      try {
        const s = await window.carplay.systemStats()
        if (alive) setStats(s)
      } catch { /* ignore a dropped sample */ }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { alive = false; clearInterval(id) }
  }, [open])

  if (!open) return null

  const s = stats
  const row = (label: string, value: string, color?: string): React.JSX.Element => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
      <span style={{ color: '#8b9096', fontSize: 11, letterSpacing: 1 }}>{label}</span>
      <span className="mono" style={{ color: color ?? '#e8eaed', fontSize: 15, fontWeight: 700, fontFamily: 'monospace' }}>{value}</span>
    </div>
  )

  return (
    <div
      onPointerDown={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(0,0,0,0.92)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          width: 320, maxWidth: '76vmin',
          background: '#121316', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 18, padding: '18px 20px 16px',
          boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#ffca28', fontSize: 12, fontWeight: 800, letterSpacing: 2 }}>PI MONITOR</span>
          <button
            onPointerDown={(e) => { e.stopPropagation(); setOpen(false) }}
            style={{ background: 'none', border: 'none', color: '#8b9096', fontSize: 20, lineHeight: 1, cursor: 'pointer' }}
          >✕</button>
        </div>

        {!s || s.error ? (
          <div style={{ color: '#8b9096', fontSize: 13, padding: '8px 0' }}>
            {s?.error ? 'stats unavailable' : 'reading…'}
          </div>
        ) : (
          <>
            {/* CPU */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ color: '#8b9096', fontSize: 11, letterSpacing: 1 }}>CPU</span>
                <span className="mono" style={{ fontFamily: 'monospace', fontSize: 30, fontWeight: 800, color: heat(s.cpu ?? 0, 60, 85) }}>
                  {s.cpu ?? '--'}<span style={{ fontSize: 14, color: '#8b9096' }}>%</span>
                </span>
              </div>
              {s.cores && s.cores.length > 0 && (
                <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                  {s.cores.map((c, i) => (
                    <div key={i} style={{ flex: 1, height: 26, background: '#1e2125', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${c}%`, background: heat(c, 60, 85) }} />
                      <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontFamily: 'monospace', color: '#cfd3d8' }}>{c}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />

            {row('RAM',
              s.memUsedMb != null && s.memTotalMb != null ? `${s.memUsedMb} / ${s.memTotalMb} MB · ${s.memPct}%` : '--',
              s.memPct != null ? heat(s.memPct, 75, 90) : undefined)}
            {row('SWAP (zram)', s.swapUsedMb != null ? `${s.swapUsedMb} MB` : '--',
              s.swapUsedMb != null && s.swapUsedMb > 80 ? '#ffca28' : undefined)}
            {row('CPU TEMP', s.tempC != null ? `${s.tempC.toFixed(1)} °C` : '--',
              s.tempC != null ? heat(s.tempC, 70, 80) : undefined)}
            {row('LOAD', s.load ? s.load.map((l) => l.toFixed(2)).join('  ') : '--')}
            {row('UPTIME', s.uptime != null ? fmtUptime(s.uptime) : '--')}
          </>
        )}

        <div style={{ color: '#5b6066', fontSize: 10, textAlign: 'center', marginTop: 2 }}>
          tap anywhere to close · two-finger hold to reopen
        </div>
      </div>
    </div>
  )
}

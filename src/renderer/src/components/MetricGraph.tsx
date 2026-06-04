import { useRef, useState, useEffect } from 'react'
import { useDataLog, METRIC_CONFIG, MetricKey } from '../store/dataLog'

const WINDOW_MS  = 5 * 60 * 1000
const MAX_AGE_MS = 8 * 60 * 60 * 1000

// Chart SVG coordinate space
const SVG_W = 565
const SVG_H = 420
const CX    = 46    // left margin for y-axis labels
const CW    = SVG_W - CX - 10   // 509
const CY    = 10
const CH    = 358   // chart height (leaves 52 for x labels + scroll bar)

interface Props {
  metricKey: MetricKey
  onClose: () => void
}

export default function MetricGraph({ metricKey, onClose }: Props) {
  const data        = useDataLog(s => s.data[metricKey])
  const clearMetric = useDataLog(s => s.clearMetric)
  const cfg         = METRIC_CONFIG[metricKey]

  const [nowMs,        setNowMs]        = useState(() => Date.now())
  const [viewOffset,   setViewOffset]   = useState(0)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const panRef = useRef<{ active: boolean; startX: number; startOff: number }>({
    active: false, startX: 0, startOff: 0,
  })

  const windowEnd   = nowMs - viewOffset
  const windowStart = windowEnd - WINDOW_MS

  const visible = data.filter(p => p.ts >= windowStart - 5000 && p.ts <= windowEnd + 5000)

  const vals   = visible.map(p => p.val)
  const rawMin = vals.length ? Math.min(...vals) : 0
  const rawMax = vals.length ? Math.max(...vals) : 1
  const pad    = (rawMax - rawMin) * 0.15 || 5
  const yMin   = rawMin - pad
  const yMax   = rawMax + pad

  const xFor = (ts: number) => CX + ((ts - windowStart) / WINDOW_MS) * CW
  const yFor = (v: number)  => CY + CH - ((v - yMin) / (yMax - yMin)) * CH

  let linePath = ''
  let areaPath = ''
  if (visible.length > 1) {
    const pts = visible.map(p => ({ x: xFor(p.ts), y: yFor(p.val) }))
    linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    areaPath =
      `M${pts[0].x.toFixed(1)},${CY + CH} ` +
      pts.map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
      ` L${pts[pts.length - 1].x.toFixed(1)},${CY + CH} Z`
  }

  const yTicks   = [0, 0.25, 0.5, 0.75, 1].map(f => yMin + f * (yMax - yMin))
  const minMs    = 60 * 1000
  const firstMin = Math.ceil(windowStart / minMs) * minMs
  const xLabels: { x: number; label: string }[] = []
  for (let t = firstMin; t <= windowEnd; t += minMs) {
    const x = xFor(t)
    if (x >= CX && x <= CX + CW) {
      const d = new Date(t)
      xLabels.push({ x, label: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` })
    }
  }

  const isLive  = viewOffset < 3000
  const current = data.length ? data[data.length - 1].val : null
  const visMin  = vals.length ? Math.min(...vals) : null
  const visMax  = vals.length ? Math.max(...vals) : null

  const onPtrDown = (e: React.PointerEvent<SVGSVGElement>) => {
    panRef.current = { active: true, startX: e.clientX, startOff: viewOffset }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onPtrMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!panRef.current.active) return
    const dx   = e.clientX - panRef.current.startX
    const msPx = WINDOW_MS / CW
    // natural drag: finger right → content moves right → older data (increase offset)
    setViewOffset(Math.max(0, Math.min(MAX_AGE_MS - WINDOW_MS, panRef.current.startOff + dx * msPx)))
  }
  const onPtrUp = () => { panRef.current.active = false }

  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: 'rgba(0,0,0,0.97)',
      zIndex: 300,
      display: 'flex',
      flexDirection: 'column',
      userSelect: 'none',
    }}>

      {/* ── TOP ROW: label / live status + buttons ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px 0',
        flexShrink: 0,
      }}>
        {/* Label + live/time badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontSize: 12, fontWeight: 800, letterSpacing: 3,
            color: cfg.color, fontFamily: 'monospace',
          }}>{cfg.label}</span>
          {isLive
            ? <span style={{ fontSize: 11, color: '#4fc3f7', fontWeight: 700, letterSpacing: 2, fontFamily: 'monospace' }}>● LIVE</span>
            : <span style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>{Math.round(viewOffset / 60000)}m ago</span>
          }
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {confirmReset ? (
            <>
              <button onClick={() => setConfirmReset(false)} style={actionBtn('#2a2a2a', '#aaa')}>CANCEL</button>
              <button
                onClick={() => { clearMetric(metricKey); setConfirmReset(false) }}
                style={actionBtn('#5c1010', '#ff6b6b')}
              >CONFIRM</button>
            </>
          ) : (
            <button onClick={() => setConfirmReset(true)} style={actionBtn('#2a0808', '#ff6b6b')}>
              RESET
            </button>
          )}
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>
      </div>

      {/* ── CURRENT VALUE — big ── */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        padding: '4px 14px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
      }}>
        {/* Huge number */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{
            fontSize: 84, fontWeight: 900, color: 'white',
            lineHeight: 0.88, fontFamily: 'monospace', letterSpacing: -3,
          }}>
            {current !== null ? cfg.fmtVal(current) : '--'}
          </span>
          <span style={{ fontSize: 20, fontWeight: 600, color: '#555', fontFamily: 'monospace' }}>
            {cfg.unit}
          </span>
        </div>

        {/* Min / max / count */}
        <div style={{ fontSize: 12, color: '#666', fontFamily: 'monospace', textAlign: 'right', lineHeight: 1.6 }}>
          {visMin !== null && <div><span style={{ color: '#888' }}>MIN </span>{cfg.fmtVal(visMin)}</div>}
          {visMax !== null && <div><span style={{ color: '#888' }}>MAX </span>{cfg.fmtVal(visMax)}</div>}
          <div style={{ fontSize: 10, color: '#444', marginTop: 2 }}>{data.length} pts · drag ← →</div>
        </div>
      </div>

      {/* ── CHART ── */}
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        style={{ flex: 1, display: 'block', cursor: 'ew-resize', touchAction: 'none' }}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPtrDown}
        onPointerMove={onPtrMove}
        onPointerUp={onPtrUp}
        onPointerLeave={onPtrUp}
      >
        <defs>
          <clipPath id={`mg-clip-${metricKey}`}>
            <rect x={CX} y={CY} width={CW} height={CH} />
          </clipPath>
          <linearGradient id={`mg-grad-${metricKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={cfg.color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={cfg.color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        <rect x={CX} y={CY} width={CW} height={CH} fill="#080808" rx={4} />

        {yTicks.map((v, i) => {
          const y = yFor(v)
          return (
            <g key={i}>
              <line x1={CX} y1={y} x2={CX + CW} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
              <text x={CX - 4} y={y + 4} textAnchor="end"
                fill="rgba(255,255,255,0.3)" fontSize={9} fontFamily="monospace">
                {cfg.fmtVal(v)}
              </text>
            </g>
          )
        })}

        {xLabels.map(({ x, label }) => (
          <g key={label}>
            <line x1={x} y1={CY} x2={x} y2={CY + CH} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
            <text x={x} y={CY + CH + 14} textAnchor="middle"
              fill="rgba(255,255,255,0.3)" fontSize={9} fontFamily="monospace">
              {label}
            </text>
          </g>
        ))}

        {areaPath && (
          <path d={areaPath} fill={`url(#mg-grad-${metricKey})`} clipPath={`url(#mg-clip-${metricKey})`} />
        )}
        {linePath && (
          <path d={linePath} fill="none" stroke={cfg.color} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#mg-clip-${metricKey})`} />
        )}

        {visible.length < 2 && (
          <text x={CX + CW / 2} y={CY + CH / 2 + 5} textAnchor="middle"
            fill="rgba(255,255,255,0.15)" fontSize={13} fontFamily="monospace">
            NO DATA IN WINDOW
          </text>
        )}

        <rect x={CX} y={CY} width={CW} height={CH}
          fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={0.5} rx={4} />

        {/* Scroll position indicator */}
        {data.length > 0 && (() => {
          const totalRange = Math.max(data[data.length - 1].ts - data[0].ts, WINDOW_MS)
          const barW   = Math.max(24, CW * (WINDOW_MS / totalRange))
          const maxOff = Math.max(0, totalRange - WINDOW_MS)
          const barX   = CX + CW - (viewOffset / Math.max(1, maxOff)) * (CW - barW) - barW
          return (
            <>
              <rect x={CX} y={CY + CH + 26} width={CW} height={4} fill="rgba(255,255,255,0.05)" rx={2} />
              <rect x={barX} y={CY + CH + 26} width={barW} height={4} fill={cfg.color} rx={2} opacity={0.45} />
            </>
          )
        })()}
      </svg>
    </div>
  )
}

// ── Shared button styles ──────────────────────────────────────────────────────

const actionBtn = (bg: string, fg: string): React.CSSProperties => ({
  background: bg,
  border: `2px solid ${fg}55`,
  color: fg,
  borderRadius: 14,
  height: 52,
  minWidth: 96,
  padding: '0 20px',
  fontSize: 14,
  fontWeight: 800,
  letterSpacing: 2,
  cursor: 'pointer',
  fontFamily: 'monospace',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
})

const closeBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.07)',
  border: '2px solid rgba(255,255,255,0.22)',
  color: 'white',
  borderRadius: '50%',
  width: 52,
  height: 52,
  fontSize: 20,
  fontWeight: 700,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  flexShrink: 0,
}

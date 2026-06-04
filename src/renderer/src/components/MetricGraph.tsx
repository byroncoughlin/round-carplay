import { useRef, useState, useEffect } from 'react'
import { useDataLog, METRIC_CONFIG, MetricKey } from '../store/dataLog'

const WINDOW_MS  = 5 * 60 * 1000       // 5 min visible window
const MAX_AGE_MS = 8 * 60 * 60 * 1000  // 8 h max scroll

// SVG coordinate space (matches center-square aspect: 565 wide)
const SVG_W   = 565
const SVG_H   = 370
const CX      = 44   // left margin for y-axis labels
const CW      = SVG_W - CX - 10  // chart width  (511)
const CY      = 10   // chart top
const CH      = 300  // chart height (leaves 60 for axis + footer)

interface Props {
  metricKey: MetricKey
  onClose: () => void
}

export default function MetricGraph({ metricKey, onClose }: Props) {
  const data        = useDataLog(s => s.data[metricKey])
  const clearMetric = useDataLog(s => s.clearMetric)
  const cfg         = METRIC_CONFIG[metricKey]

  const [nowMs,        setNowMs]        = useState(() => Date.now())
  const [viewOffset,   setViewOffset]   = useState(0)   // ms back from now for right edge
  const [confirmReset, setConfirmReset] = useState(false)

  // Tick "now" every second to scroll the live view
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const panRef = useRef<{ active: boolean; startX: number; startOff: number }>({
    active: false, startX: 0, startOff: 0,
  })

  const windowEnd   = nowMs - viewOffset
  const windowStart = windowEnd - WINDOW_MS

  // Points in (and slightly beyond) the visible window for line continuity
  const visible = data.filter(p => p.ts >= windowStart - 5000 && p.ts <= windowEnd + 5000)

  // Y scale
  const vals    = visible.map(p => p.val)
  const rawMin  = vals.length ? Math.min(...vals) : 0
  const rawMax  = vals.length ? Math.max(...vals) : 1
  const pad     = (rawMax - rawMin) * 0.15 || 5
  const yMin    = rawMin - pad
  const yMax    = rawMax + pad

  const xFor = (ts: number) => CX + ((ts - windowStart) / WINDOW_MS) * CW
  const yFor = (v: number)  => CY + CH - ((v - yMin) / (yMax - yMin)) * CH

  // Line + area paths
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

  // Y-axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => yMin + f * (yMax - yMin))

  // X-axis minute labels
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

  const isLive     = viewOffset < 3000
  const current    = data.length ? data[data.length - 1].val : null
  const visMin     = vals.length ? Math.min(...vals) : null
  const visMax     = vals.length ? Math.max(...vals) : null

  // Pointer pan
  const onPtrDown = (e: React.PointerEvent<SVGSVGElement>) => {
    panRef.current = { active: true, startX: e.clientX, startOff: viewOffset }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onPtrMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!panRef.current.active) return
    const dx      = e.clientX - panRef.current.startX
    const msPerPx = WINDOW_MS / CW
    const next    = Math.max(0, Math.min(MAX_AGE_MS - WINDOW_MS, panRef.current.startOff - dx * msPerPx))
    setViewOffset(next)
  }
  const onPtrUp   = () => { panRef.current.active = false }

  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.97)',
        zIndex: 300,
        display: 'flex',
        flexDirection: 'column',
        userSelect: 'none',
        borderRadius: 0,
      }}
    >
      {/* ── HEADER ── */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        padding: '12px 16px 6px',
        borderBottom: '1px solid rgba(255,255,255,0.09)',
        flexShrink: 0,
      }}>
        {/* Left: label + current value */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 3,
            color: cfg.color, fontFamily: 'monospace', marginBottom: 2,
          }}>
            {cfg.label}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ fontSize: 46, fontWeight: 800, color: 'white', lineHeight: 1, fontFamily: 'monospace' }}>
              {current !== null ? cfg.fmtVal(current) : '--'}
            </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#555', fontFamily: 'monospace' }}>
              {cfg.unit}
            </span>
          </div>
          {isLive
            ? <div style={{ fontSize: 10, color: '#4fc3f7', fontWeight: 700, letterSpacing: 2, fontFamily: 'monospace', marginTop: 2 }}>● LIVE</div>
            : <div style={{ fontSize: 10, color: '#666', fontFamily: 'monospace', marginTop: 2 }}>{Math.round(viewOffset / 60000)}m ago</div>
          }
        </div>

        {/* Right: stats + buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {confirmReset ? (
              <>
                <button onClick={() => setConfirmReset(false)} style={btnStyle('#555', '#aaa')}>CANCEL</button>
                <button onClick={() => { clearMetric(metricKey); setConfirmReset(false) }} style={btnStyle('#7f1d1d', '#ff6b6b')}>CONFIRM</button>
              </>
            ) : (
              <button onClick={() => setConfirmReset(true)} style={btnStyle('#2a0a0a', '#ff6b6b')}>RESET</button>
            )}
            <button onClick={onClose} style={btnStyle('#1a1a1a', '#ccc')}>✕</button>
          </div>
          {visMin !== null && visMax !== null && (
            <div style={{ fontSize: 10, color: '#555', fontFamily: 'monospace', textAlign: 'right' }}>
              <span style={{ color: '#888' }}>MIN </span>{cfg.fmtVal(visMin)}
              <span style={{ color: '#888', marginLeft: 8 }}>MAX </span>{cfg.fmtVal(visMax)}
            </div>
          )}
          <div style={{ fontSize: 9, color: '#444', fontFamily: 'monospace' }}>
            {data.length} pts · drag ← →
          </div>
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
            <stop offset="0%"   stopColor={cfg.color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={cfg.color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Chart background */}
        <rect x={CX} y={CY} width={CW} height={CH} fill="#080808" rx={4} />

        {/* Y-axis grid + labels */}
        {yTicks.map((v, i) => {
          const y = yFor(v)
          return (
            <g key={i}>
              <line x1={CX} y1={y} x2={CX + CW} y2={y}
                stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
              <text x={CX - 4} y={y + 4} textAnchor="end"
                fill="rgba(255,255,255,0.3)" fontSize={9} fontFamily="monospace">
                {cfg.fmtVal(v)}
              </text>
            </g>
          )
        })}

        {/* X-axis time grid + labels */}
        {xLabels.map(({ x, label }) => (
          <g key={label}>
            <line x1={x} y1={CY} x2={x} y2={CY + CH}
              stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
            <text x={x} y={CY + CH + 14} textAnchor="middle"
              fill="rgba(255,255,255,0.3)" fontSize={9} fontFamily="monospace">
              {label}
            </text>
          </g>
        ))}

        {/* Area fill */}
        {areaPath && (
          <path d={areaPath} fill={`url(#mg-grad-${metricKey})`}
            clipPath={`url(#mg-clip-${metricKey})`} />
        )}

        {/* Line */}
        {linePath && (
          <path d={linePath} fill="none" stroke={cfg.color} strokeWidth={1.8}
            strokeLinejoin="round" strokeLinecap="round"
            clipPath={`url(#mg-clip-${metricKey})`} />
        )}

        {/* No data */}
        {visible.length < 2 && (
          <text x={CX + CW / 2} y={CY + CH / 2 + 5}
            textAnchor="middle" fill="rgba(255,255,255,0.18)"
            fontSize={13} fontFamily="monospace">NO DATA IN WINDOW</text>
        )}

        {/* Border */}
        <rect x={CX} y={CY} width={CW} height={CH}
          fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} rx={4} />

        {/* Scroll position indicator (thin bar at bottom of chart) */}
        {data.length > 0 && (
          (() => {
            const totalRange = Math.max(
              data[data.length - 1].ts - data[0].ts,
              WINDOW_MS
            )
            const barW   = Math.max(20, CW * (WINDOW_MS / totalRange))
            const maxOff = Math.max(0, totalRange - WINDOW_MS)
            const barX   = CX + CW - (viewOffset / Math.max(1, maxOff)) * (CW - barW) - barW
            return (
              <>
                <rect x={CX} y={CY + CH + 22} width={CW} height={3} fill="rgba(255,255,255,0.05)" rx={1.5} />
                <rect x={barX} y={CY + CH + 22} width={barW} height={3} fill={cfg.color} rx={1.5} opacity={0.5} />
              </>
            )
          })()
        )}
      </svg>
    </div>
  )
}

function btnStyle(bg: string, fg: string): React.CSSProperties {
  return {
    background: bg,
    border: `1px solid ${fg}44`,
    color: fg,
    borderRadius: 7,
    padding: '5px 12px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1.5,
    cursor: 'pointer',
    fontFamily: 'monospace',
  }
}

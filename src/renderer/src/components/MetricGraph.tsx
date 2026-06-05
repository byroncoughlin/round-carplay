import { useRef, useState, useEffect } from 'react'
import { useDataLog, METRIC_CONFIG, MetricKey } from '../store/dataLog'

const WINDOW_MS  = 5 * 60 * 1000
const MAX_AGE_MS = 8 * 60 * 60 * 1000

// Some metrics open a stacked split view instead of a single chart.
// Tapping AMBIENT shows cabin/ambient temp on top and the Pi CPU temp below,
// each with its own live chart — two temperatures, two graphs, one screen.
const SPLIT: Partial<Record<MetricKey, MetricKey[]>> = {
  ambientTemp: ['ambientTemp', 'piTemp'],
}

interface Props {
  metricKey: MetricKey
  onClose: () => void
}

export default function MetricGraph({ metricKey, onClose }: Props) {
  const keys    = SPLIT[metricKey] ?? [metricKey]
  const compact = keys.length > 1

  const [nowMs,       setNowMs]       = useState(() => Date.now())
  const [confirmQuit, setConfirmQuit] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Close button: short tap closes the graph; press-and-hold opens a quit prompt
  // (the only way to quit the app when only the graph buttons are reachable).
  const holdRef = useRef<{ t: ReturnType<typeof setTimeout> | null; fired: boolean }>({ t: null, fired: false })
  const closeHoldStart = () => {
    holdRef.current.fired = false
    holdRef.current.t = setTimeout(() => { holdRef.current.fired = true; setConfirmQuit(true) }, 800)
  }
  const closeHoldEnd = () => {
    if (holdRef.current.t) clearTimeout(holdRef.current.t)
    if (!holdRef.current.fired) onClose()   // it was a tap → close the graph
    holdRef.current.fired = false
  }
  const closeHoldCancel = () => { if (holdRef.current.t) clearTimeout(holdRef.current.t) }

  return (
    <div style={{
      // Definite viewport-based size (the 565/800 center square) + 1px bleed on
      // every side. We can't use inset:-1 / height:100% here: the center square's
      // percentage-height chain collapses, so the absolute parent has no definite
      // height and the chart SVG (flex:1) computes to 0px — the graph never shows.
      position: 'absolute', top: -1, left: -1,
      width:  'calc(min(100vw, 100vh) * 0.70625 + 2px)',
      height: 'calc(min(100vw, 100vh) * 0.70625 + 2px)',
      background: '#000',
      zIndex: 1400,
      display: 'flex',
      flexDirection: 'column',
      userSelect: 'none',
    }}>
      {/* Floating close button — shared across panes, top-right corner */}
      <button
        onPointerDown={closeHoldStart}
        onPointerUp={closeHoldEnd}
        onPointerLeave={closeHoldCancel}
        style={{ ...closeBtn, position: 'absolute', top: 10, right: 12, zIndex: 20 }}
        title="tap to close · hold to quit app"
      >✕</button>

      {keys.map((k, i) => (
        <Pane
          key={k}
          metricKey={k}
          nowMs={nowMs}
          compact={compact}
          first={i === 0}
        />
      ))}

      {/* Hold-✕-to-quit confirmation */}
      {confirmQuit && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 500,
          background: 'rgba(0,0,0,0.94)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <div style={{ color: 'white', fontSize: 26, fontWeight: 800, fontFamily: 'sans-serif', letterSpacing: 0.5 }}>
            Quit motoCarPlay?
          </div>
          <div style={{ color: '#888', fontSize: 12, fontFamily: 'monospace', marginBottom: 18 }}>
            this closes the dashboard app
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            <button onClick={() => setConfirmQuit(false)} style={actionBtn('#2a2a2a', '#ccc')}>CANCEL</button>
            <button onClick={() => window.carplay.quit()} style={actionBtn('#5c1010', '#ff6b6b')}>QUIT</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── One metric's header + value + chart. Self-contained: owns its own pan
//    offset and reset state so split panes scroll/reset independently. ────────
interface PaneProps {
  metricKey: MetricKey
  nowMs: number
  compact: boolean
  first: boolean
}

function Pane({ metricKey, nowMs, compact, first }: PaneProps) {
  const data        = useDataLog(s => s.data[metricKey])
  const clearMetric = useDataLog(s => s.clearMetric)
  const cfg         = METRIC_CONFIG[metricKey]

  const [viewOffset,   setViewOffset]   = useState(0)
  const [confirmReset, setConfirmReset] = useState(false)

  const panRef = useRef<{ active: boolean; startX: number; startOff: number }>({
    active: false, startX: 0, startOff: 0,
  })

  // Chart SVG coordinate space — wider/shorter aspect when compact (stacked).
  const SVG_W = 565
  const CX    = 46                 // left margin for y-axis labels
  const CW    = SVG_W - CX - 10     // 509
  const CY    = 8
  const CH    = compact ? 168 : 358
  const SVG_H = CY + CH + (compact ? 30 : 62)

  const windowEnd   = nowMs - viewOffset
  const windowStart = windowEnd - WINDOW_MS

  const visible = data.filter(p => p.ts >= windowStart - 5000 && p.ts <= windowEnd + 5000)

  const vals   = visible.map(p => p.val)
  const rawMin = vals.length ? Math.min(...vals) : 0
  const rawMax = vals.length ? Math.max(...vals) : 1
  const center = (rawMax + rawMin) / 2
  const span   = Math.max(rawMax - rawMin, cfg.minRange)
  const pad    = span * 0.15
  const yMin   = center - span / 2 - pad
  const yMax   = center + span / 2 + pad

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

  const yTicks   = [0, 0.5, 1].map(f => yMin + f * (yMax - yMin))
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

  // Risk-band (traffic-light) coloring for metrics that define zones (Pi temp).
  const zones      = cfg.zones
  const zoneOf     = (v: number) => zones?.find(z => v <= z.max) ?? zones?.[zones.length - 1]
  const valueColor = zones && current !== null ? (zoneOf(current)?.color ?? cfg.color) : 'white'

  const onPtrDown = (e: React.PointerEvent<SVGSVGElement>) => {
    panRef.current = { active: true, startX: e.clientX, startOff: viewOffset }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onPtrMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!panRef.current.active) return
    const dx   = e.clientX - panRef.current.startX
    const msPx = WINDOW_MS / CW
    setViewOffset(Math.max(0, Math.min(MAX_AGE_MS - WINDOW_MS, panRef.current.startOff + dx * msPx)))
  }
  const onPtrUp = () => { panRef.current.active = false }

  const valSize = compact ? 46 : 84

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      borderTop: first ? 'none' : '1px solid rgba(255,255,255,0.1)',
    }}>
      {/* ── TOP ROW: label / live status + reset ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        // reserve top-right room for the floating close button on the first pane
        padding: first ? '12px 70px 0 14px' : '8px 14px 0',
        flexShrink: 0,
      }}>
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

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {confirmReset ? (
            <>
              <button onClick={() => setConfirmReset(false)} style={actionBtn('#2a2a2a', '#aaa', compact)}>CANCEL</button>
              <button
                onClick={() => { clearMetric(metricKey); setConfirmReset(false) }}
                style={actionBtn('#5c1010', '#ff6b6b', compact)}
              >CONFIRM</button>
            </>
          ) : (
            <button onClick={() => setConfirmReset(true)} style={actionBtn('#2a0808', '#ff6b6b', compact)}>
              RESET
            </button>
          )}
        </div>
      </div>

      {/* ── CURRENT VALUE ── */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        padding: compact ? '2px 14px 4px' : '4px 14px 8px',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{
            fontSize: valSize, fontWeight: 900, color: valueColor,
            lineHeight: 0.88, fontFamily: 'monospace', letterSpacing: -3,
          }}>
            {current !== null ? cfg.fmtVal(current) : '--'}
          </span>
          <span style={{ fontSize: compact ? 16 : 20, fontWeight: 600, color: '#555', fontFamily: 'monospace' }}>
            {cfg.unit}
          </span>
        </div>

        <div style={{ fontSize: 12, color: '#666', fontFamily: 'monospace', textAlign: 'right', lineHeight: 1.6 }}>
          {visMin !== null && <div><span style={{ color: '#888' }}>MIN </span>{cfg.fmtVal(visMin)}</div>}
          {visMax !== null && <div><span style={{ color: '#888' }}>MAX </span>{cfg.fmtVal(visMax)}</div>}
          {!compact && <div style={{ fontSize: 10, color: '#444', marginTop: 2 }}>{data.length} pts · drag ← →</div>}
        </div>
      </div>

      {/* ── CHART ── */}
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        style={{ flex: 1, minHeight: 0, display: 'block', cursor: 'ew-resize', touchAction: 'none' }}
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
          {zones && areaPath && (
            <clipPath id={`mg-area-${metricKey}`}>
              <path d={areaPath} />
            </clipPath>
          )}
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

        {/* Area fill — risk-band coloring when zones defined, else flat gradient */}
        {areaPath && zones && (
          <g clipPath={`url(#mg-clip-${metricKey})`}>
            <g clipPath={`url(#mg-area-${metricKey})`}>
              {zones.map((z, i) => {
                const lo   = i === 0 ? yMin : zones[i - 1].max   // band spans (lo, max]
                const vTop = Math.min(z.max, yMax)
                const vBot = Math.max(lo, yMin)
                if (vTop <= vBot) return null                    // band not in view
                const yT = yFor(vTop)
                return <rect key={i} x={CX} width={CW} y={yT} height={yFor(vBot) - yT}
                  fill={z.color} opacity={0.3} />
              })}
            </g>
          </g>
        )}
        {areaPath && !zones && (
          <path d={areaPath} fill={`url(#mg-grad-${metricKey})`} clipPath={`url(#mg-clip-${metricKey})`} />
        )}

        {/* Threshold guide lines at each zone boundary (e.g. 70°, 80°) */}
        {zones && zones.slice(0, -1).map((z, i) => {
          if (z.max <= yMin || z.max >= yMax) return null
          const y = yFor(z.max)
          return (
            <g key={`thr-${i}`}>
              <line x1={CX} y1={y} x2={CX + CW} y2={y}
                stroke={z.color} strokeWidth={1} strokeDasharray="4 4" opacity={0.55} />
              <text x={CX + CW - 4} y={y - 4} textAnchor="end"
                fill={z.color} fontSize={9} fontFamily="monospace" opacity={0.85}>
                {zones[i + 1].label} {cfg.fmtVal(z.max)}°
              </text>
            </g>
          )
        })}

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
              <rect x={CX} y={CY + CH + 22} width={CW} height={4} fill="rgba(255,255,255,0.05)" rx={2} />
              <rect x={barX} y={CY + CH + 22} width={barW} height={4} fill={cfg.color} rx={2} opacity={0.45} />
            </>
          )
        })()}
      </svg>
    </div>
  )
}

// ── Shared button styles ──────────────────────────────────────────────────────

const actionBtn = (bg: string, fg: string, compact = false): React.CSSProperties => ({
  background: bg,
  border: `2px solid ${fg}55`,
  color: fg,
  borderRadius: 16,
  height: compact ? 50 : 64,
  minWidth: compact ? 96 : 116,
  padding: compact ? '0 18px' : '0 26px',
  fontSize: compact ? 13 : 15,
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
  width: 56,
  height: 56,
  fontSize: 22,
  fontWeight: 700,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  flexShrink: 0,
}

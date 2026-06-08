import { useCarplayStore } from '../store/store'
import type { GpsSat } from '../store/store'

// ── color / quality helpers ──────────────────────────────────────────────────
// Signal strength (C/No, dB-Hz): grey = no signal, ramps orange→amber→green.
function snrColor(snr: number | null): string {
  if (snr === null || snr <= 0) return '#555'
  if (snr < 15) return '#ff7043'
  if (snr < 25) return '#ffca28'
  if (snr < 35) return '#9ccc65'
  return '#4caf50'
}

// Horizontal dilution of precision → plain-English fix quality.
function hdopQuality(hdop: number | null): { label: string; color: string } {
  if (hdop === null) return { label: '—',         color: '#888' }
  if (hdop < 1)      return { label: 'EXCELLENT',  color: '#4caf50' }
  if (hdop < 2)      return { label: 'GOOD',       color: '#9ccc65' }
  if (hdop < 5)      return { label: 'MODERATE',   color: '#ffca28' }
  if (hdop < 10)     return { label: 'FAIR',       color: '#ff7043' }
  return { label: 'POOR', color: '#ef5350' }
}

function fixBadge(fixType: 0 | 2 | 3): { label: string; color: string } {
  if (fixType === 3) return { label: '3D FIX', color: '#4caf50' }
  if (fixType === 2) return { label: '2D FIX', color: '#ffca28' }
  return { label: 'NO FIX', color: '#ef5350' }
}

// Seconds → compact clock: "23s" under a minute, "1:35" above.
function fmtSecs(s: number): string {
  const t = Math.round(s)
  if (t < 60) return `${t}s`
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

// ── sky plot: polar projection of the sky dome ───────────────────────────────
// center = straight overhead (elevation 90°), outer ring = horizon (elevation 0°),
// angle = compass azimuth (0° = true north, at the top). This is the classic
// GPS-Test radar: it shows *where* in the sky each satellite sits, so a blocked
// horizon (hill, building, tank bag) is obvious at a glance.
const R = 92
const CX = 100
const CY = 100
function satXY(el: number, az: number): { x: number; y: number } {
  const r = ((90 - el) / 90) * R
  const a = (az * Math.PI) / 180
  return { x: CX + r * Math.sin(a), y: CY - r * Math.cos(a) }
}

function SkyPlot({ sats, acquiring }: { sats: GpsSat[]; acquiring: boolean }) {
  const ring = (el: number) => ((90 - el) / 90) * R
  const plotted = sats.filter(s => s.el !== null && s.az !== null)
  return (
    <svg viewBox="0 0 200 212" style={{ height: '100%', display: 'block' }}
      preserveAspectRatio="xMidYMid meet">
      {/* elevation rings: horizon (0°), 30°, 60° */}
      {[0, 30, 60].map(el => (
        <circle key={el} cx={CX} cy={CY} r={ring(el)}
          fill={el === 0 ? '#0c0c0c' : 'none'}
          stroke="rgba(255,255,255,0.13)" strokeWidth={el === 0 ? 1.2 : 0.8} />
      ))}
      {/* N–S / E–W crosshair */}
      <line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="rgba(255,255,255,0.08)" strokeWidth={0.8} />
      <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="rgba(255,255,255,0.08)" strokeWidth={0.8} />

      {/* acquiring sweep — a rotating wedge while there's no fix */}
      {acquiring && (
        <g>
          <defs>
            <linearGradient id="gps-sweep" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor="#4fc3f7" stopOpacity="0" />
              <stop offset="100%" stopColor="#4fc3f7" stopOpacity="0.33" />
            </linearGradient>
          </defs>
          <path d={`M${CX},${CY} L${CX + R},${CY} A${R},${R} 0 0 0 ${CX + R * Math.cos(-0.5)},${CY + R * Math.sin(-0.5)} Z`}
            fill="url(#gps-sweep)">
            <animateTransform attributeName="transform" type="rotate"
              from={`0 ${CX} ${CY}`} to={`360 ${CX} ${CY}`} dur="3s" repeatCount="indefinite" />
          </path>
        </g>
      )}

      {/* compass labels */}
      {[['N', CX, 11], ['S', CX, 196], ['E', 192, CY + 3], ['W', 8, CY + 3]].map(([t, x, y]) => (
        <text key={t as string} x={x as number} y={y as number} textAnchor="middle"
          fill="rgba(255,255,255,0.45)" fontSize={11} fontWeight="bold" fontFamily="monospace">{t}</text>
      ))}

      {/* satellites */}
      {plotted.map(s => {
        const { x, y } = satXY(s.el as number, s.az as number)
        const c = snrColor(s.snr)
        return (
          <g key={s.prn}>
            <circle cx={x} cy={y} r={6}
              fill={s.used ? c : '#161616'}
              stroke={s.used ? 'rgba(255,255,255,0.85)' : c}
              strokeWidth={s.used ? 1 : 1.5} />
            <text x={x} y={y + 15} textAnchor="middle"
              fill="rgba(255,255,255,0.65)" fontSize={8} fontWeight={600} fontFamily="monospace">{s.prn}</text>
          </g>
        )
      })}

      {plotted.length === 0 && (
        <text x={CX} y={CY + 4} textAnchor="middle"
          fill="rgba(255,255,255,0.5)" fontSize={12} fontWeight={600} letterSpacing={1} fontFamily="monospace">SEARCHING…</text>
      )}
    </svg>
  )
}

// ── signal bars: SNR per satellite, strongest first ──────────────────────────
function SignalBars({ sats }: { sats: GpsSat[] }) {
  const ordered = [...sats].sort((a, b) => (b.snr ?? 0) - (a.snr ?? 0)).slice(0, 12)
  if (ordered.length === 0) return null
  const W = 280, H = 64, maxSnr = 50
  const slot = W / ordered.length
  const bw = Math.min(18, slot - 4)
  const yFor = (snr: number) => H - (Math.min(snr, maxSnr) / maxSnr) * H
  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} style={{ width: '100%', display: 'block' }}
      preserveAspectRatio="xMidYMid meet">
      {/* dB-Hz reference grid: 20 (marginal) · 30 · 40 (strong) */}
      {[20, 30, 40].map(db => (
        <g key={db}>
          <line x1={0} y1={yFor(db)} x2={W} y2={yFor(db)}
            stroke="rgba(255,255,255,0.10)" strokeWidth={0.75} strokeDasharray="3 3" />
          <text x={1} y={yFor(db) - 1.5} fill="rgba(255,255,255,0.5)"
            fontSize={8} fontWeight={600} fontFamily="monospace">{db}</text>
        </g>
      ))}
      {ordered.map((s, i) => {
        const snr = s.snr ?? 0
        const h = Math.max(2, (Math.min(snr, maxSnr) / maxSnr) * H)
        const x = i * slot + (slot - bw) / 2
        const c = snrColor(s.snr)
        return (
          <g key={s.prn}>
            <rect x={x} y={H - h} width={bw} height={h} rx={2}
              fill={c} opacity={s.used ? 1 : 0.4} />
            <text x={x + bw / 2} y={H + 11} textAnchor="middle"
              fill="rgba(255,255,255,0.65)" fontSize={9} fontWeight={600} fontFamily="monospace">{s.prn}</text>
          </g>
        )
      })}
    </svg>
  )
}

// ── panel ─────────────────────────────────────────────────────────────────────
export default function GpsSkyPanel() {
  const sky     = useCarplayStore(s => s.gpsSky)
  const gpsFix  = useCarplayStore(s => s.gpsFix)
  const gpsSats = useCarplayStore(s => s.gpsSats)

  // No sky data yet — receiver not plugged in or still booting.
  if (!sky) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', fontFamily: 'monospace' }}>
          <div style={{ color: '#888', fontSize: 14, fontWeight: 800, letterSpacing: 2 }}>
            {gpsFix === null ? 'NO GPS RECEIVER' : 'WAITING FOR SATELLITES…'}
          </div>
          <div style={{ color: '#555', fontSize: 11, marginTop: 6 }}>
            {gpsFix === null ? 'check the USB GPS connection' : `${gpsSats} sat${gpsSats === 1 ? '' : 's'} so far`}
          </div>
        </div>
      </div>
    )
  }

  const badge = fixBadge(sky.fixType)
  const q     = hdopQuality(sky.hdop)
  const noFix = sky.fixType === 0

  // Bigger, bolder, brighter than before — these are the at-a-glance readouts.
  const stat = (label: string, value: string, color = 'white') => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
      <span style={{ color: '#dcdcdc', fontSize: 14, fontWeight: 800, letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color, fontSize: 17, fontWeight: 900, fontFamily: 'monospace' }}>{value}</span>
    </div>
  )

  // Time-to-first-fix row: counts up amber while searching, freezes green on fix.
  const ttffRow = noFix
    ? (sky.acquiring != null ? stat('ACQUIRING', fmtSecs(sky.acquiring), '#ffca28') : null)
    : (sky.ttff != null      ? stat('TTFF',      fmtSecs(sky.ttff),      '#4caf50') : null)

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', gap: 8,
      padding: '8px 12px 6px 10px', fontFamily: 'sans-serif',
    }}>
      {/* LEFT — sky plot */}
      <div style={{ flex: '0 0 45%', minWidth: 0, display: 'flex', justifyContent: 'center' }}>
        <SkyPlot sats={sky.sats} acquiring={noFix} />
      </div>

      {/* RIGHT — status + signal bars */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Header zone — fixed height so the badge + everything below it clears
            the floating ✕ close button at the graph's top-right corner. */}
        <div style={{ height: 62, display: 'flex', alignItems: 'center', paddingRight: 64 }}>
          <span style={{
            display: 'inline-block', padding: '5px 14px', borderRadius: 9,
            background: `${badge.color}22`, border: `1.5px solid ${badge.color}`,
            color: badge.color, fontSize: 18, fontWeight: 900, letterSpacing: 1, fontFamily: 'monospace',
          }}>{badge.label}</span>
        </div>

        {/* stats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ttffRow}
          {stat('SATS', `${sky.satsUsed} used · ${sky.satsInView} in view`)}
          {stat('HDOP', sky.hdop !== null ? `${sky.hdop.toFixed(1)} ${q.label}` : '—', q.color)}
          {stat('POS', sky.lat !== null && sky.lon !== null
            ? `${sky.lat.toFixed(4)}, ${sky.lon.toFixed(4)}` : 'no fix',
            sky.lat !== null ? '#ddd' : '#777')}
        </div>

        {/* signal bars */}
        <div style={{ marginTop: 'auto' }}>
          <div style={{ color: '#aaa', fontSize: 11, fontWeight: 800, letterSpacing: 2, fontFamily: 'monospace', marginBottom: 2 }}>
            SIGNAL (dB-Hz)
          </div>
          <SignalBars sats={sky.sats} />
        </div>
      </div>
    </div>
  )
}

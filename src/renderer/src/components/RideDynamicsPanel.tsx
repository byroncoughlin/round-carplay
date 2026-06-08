import { useCarplayStore } from '../store/store'
import ResetMaxButton from './ResetMaxButton'

// ── color helpers ─────────────────────────────────────────────────────────────
// Lean: easy lean green, spirited amber, knee-down red. Tuned for a road bike.
function leanColor(absLean: number): string {
  if (absLean < 15) return '#66bb6a'
  if (absLean < 30) return '#9ccc65'
  if (absLean < 40) return '#ffca28'
  return '#ef5350'
}
// G: gentle green, hard amber, at-the-limit red (matches LeanAngle gauge).
function gColor(g: number): string {
  if (g < 0.5) return '#66bb6a'
  if (g < 1.0) return '#ffca28'
  return '#ef5350'
}

const REF = '#ffd700'  // aviation gold for the fixed reference

// ── attitude indicator: circular horizon that banks with lean, pitches with
//    pitch; a fixed roll scale with a live pointer + peak-hold marks. ──────────
function Attitude({ lean, pitch, maxL, maxR }: {
  lean: number; pitch: number; maxL: number; maxR: number
}) {
  const R = 70, cx = 84, cy = 90
  const PITCH_SCALE = 2.2
  const horizonY = cy + pitch * PITCH_SCALE
  const rot = `rotate(${lean}, ${cx}, ${horizonY})`

  // point on the rim at a given bank angle (0° = top of circle)
  const rim = (deg: number, r = R) => {
    const a = (deg * Math.PI) / 180
    return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) }
  }
  const ticks = [-45, -30, -15, 0, 15, 30, 45]
  const absLean = Math.abs(Math.round(lean))
  const side = lean > 0.5 ? 'R' : lean < -0.5 ? 'L' : ''

  return (
    <svg viewBox="0 0 168 210" style={{ height: '100%', display: 'block' }} preserveAspectRatio="xMidYMid meet">
      <defs>
        <clipPath id="rd-ai"><circle cx={cx} cy={cy} r={R} /></clipPath>
        <linearGradient id="rd-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2b6cb0" /><stop offset="100%" stopColor="#1a3a5c" />
        </linearGradient>
      </defs>

      {/* rotating sky / ground */}
      <g clipPath="url(#rd-ai)">
        <g transform={rot}>
          <rect x={cx - 3 * R} y={horizonY - 3 * R} width={6 * R} height={3 * R} fill="url(#rd-sky)" />
          <rect x={cx - 3 * R} y={horizonY} width={6 * R} height={3 * R} fill="#5c3412" />
          <line x1={cx - 3 * R} y1={horizonY} x2={cx + 3 * R} y2={horizonY} stroke="#fff" strokeWidth={2} opacity={0.9} />
          {/* pitch ladder */}
          {[-10, 10].map(p => (
            <line key={p} x1={cx - 22} y1={horizonY - p * PITCH_SCALE} x2={cx + 22} y2={horizonY - p * PITCH_SCALE}
              stroke="#fff" strokeWidth={1} opacity={0.45} />
          ))}
        </g>
      </g>
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={1.5} />

      {/* roll scale ticks */}
      {ticks.map(d => {
        const o = rim(d, R + 1), i = rim(d, d === 0 ? R - 9 : R - 6)
        return <line key={d} x1={o.x} y1={o.y} x2={i.x} y2={i.y}
          stroke="rgba(255,255,255,0.6)" strokeWidth={d === 0 ? 2 : 1.2} />
      })}

      {/* peak-hold marks (max left / max right lean this ride) */}
      {maxL > 1 && (() => { const p = rim(-maxL, R + 1); const q = rim(-maxL, R - 9); return (
        <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#ff8a65" strokeWidth={2.4} strokeLinecap="round" />
      ) })()}
      {maxR > 1 && (() => { const p = rim(maxR, R + 1); const q = rim(maxR, R - 9); return (
        <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#ff8a65" strokeWidth={2.4} strokeLinecap="round" />
      ) })()}

      {/* live roll pointer (triangle riding the rim at current lean) */}
      {(() => { const t = rim(lean, R - 2); return (
        <polygon points={`${t.x},${t.y} ${t.x - 5},${t.y - 9} ${t.x + 5},${t.y - 9}`}
          fill={leanColor(absLean)} transform={`rotate(${lean}, ${t.x}, ${t.y})`} />
      ) })()}

      {/* fixed aircraft reference */}
      <line x1={cx - 30} y1={cy} x2={cx - 9} y2={cy} stroke={REF} strokeWidth={3} strokeLinecap="round" />
      <line x1={cx + 9} y1={cy} x2={cx + 30} y2={cy} stroke={REF} strokeWidth={3} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={2.6} fill={REF} />

      {/* lean readout under the dial */}
      <text x={cx} y={190} textAnchor="middle" fill={leanColor(absLean)}
        fontSize={34} fontWeight="900" fontFamily="monospace">{absLean}°{side}</text>
      <text x={cx} y={205} textAnchor="middle" fill="#cfcfcf"
        fontSize={12} fontWeight={800} letterSpacing={3} fontFamily="monospace">LEAN</text>
    </svg>
  )
}

// ── G traction circle: a g-g dot (lateral × longitudinal) with peak ring ──────
function GCircle({ gx, gy, gMax }: { gx: number; gy: number; gMax: number }) {
  const cx = 75, cy = 88, R = 58
  const LIMIT = 1.2                 // outer ring = 1.2 G
  const scale = R / LIMIT
  const clamp = (v: number) => Math.max(-R, Math.min(R, v * scale))
  const dx = clamp(gx)
  const dy = clamp(gy)              // +forward (accel) plotted downward
  const total = Math.sqrt(gx ** 2 + gy ** 2)
  const peakR = Math.min(R, gMax * scale)

  return (
    <svg viewBox="0 0 150 210" style={{ height: '100%', display: 'block' }} preserveAspectRatio="xMidYMid meet">
      {/* rings */}
      <circle cx={cx} cy={cy} r={R} fill="#0c0c0c" stroke="rgba(255,255,255,0.2)" strokeWidth={1.2} />
      <circle cx={cx} cy={cy} r={R * 0.5} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={0.8} strokeDasharray="3 3" />
      {/* crosshair */}
      <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke="rgba(255,255,255,0.12)" strokeWidth={0.8} />
      <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} stroke="rgba(255,255,255,0.12)" strokeWidth={0.8} />
      {/* axis labels */}
      <text x={cx} y={cy - R - 4} textAnchor="middle" fill="rgba(255,255,255,0.55)" fontSize={9} fontWeight={700} fontFamily="monospace">BRAKE</text>
      <text x={cx} y={cy + R + 12} textAnchor="middle" fill="rgba(255,255,255,0.55)" fontSize={9} fontWeight={700} fontFamily="monospace">ACCEL</text>

      {/* peak-hold ring */}
      {gMax > 0.05 && <circle cx={cx} cy={cy} r={peakR} fill="none" stroke="#ffb300" strokeWidth={1.2} strokeDasharray="2 2" opacity={0.7} />}

      {/* live dot + trail to center */}
      <line x1={cx} y1={cy} x2={cx + dx} y2={cy + dy} stroke={gColor(total)} strokeWidth={1.5} opacity={0.5} />
      <circle cx={cx + dx} cy={cy + dy} r={6} fill={gColor(total)} stroke="#fff" strokeWidth={1.2} />

      {/* readouts under the circle */}
      <text x={cx} y={186} textAnchor="middle" fill={gColor(total)} fontSize={30} fontWeight="900" fontFamily="monospace">{total.toFixed(2)}</text>
      <text x={cx} y={203} textAnchor="middle" fill="#cfcfcf" fontSize={12} fontWeight={800} letterSpacing={2} fontFamily="monospace">G-FORCE</text>
    </svg>
  )
}

export default function RideDynamicsPanel() {
  const lean        = useCarplayStore(s => s.leanAngle)
  const pitch       = useCarplayStore(s => s.pitchAngle)
  const gx          = useCarplayStore(s => s.gForceX)
  const gy          = useCarplayStore(s => s.gForceY)
  const leanOffset  = useCarplayStore(s => s.settings?.leanOffset ?? 0)
  const pitchOffset = useCarplayStore(s => s.settings?.pitchOffset ?? 0)
  const peak        = useCarplayStore(s => s.imuPeak)
  const resetPeak   = useCarplayStore(s => s.resetImuPeak)

  if (lean === null && gx === null) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#888', fontSize: 14, fontWeight: 800, letterSpacing: 2, fontFamily: 'monospace' }}>
          NO IMU DATA
        </div>
      </div>
    )
  }

  const leanVal  = lean  !== null ? lean  - leanOffset  : 0
  const pitchVal = pitch !== null ? pitch - pitchOffset : 0
  const gxV = gx ?? 0, gyV = gy ?? 0
  const absPitch = Math.abs(Math.round(pitchVal))
  const pitchDir = pitchVal > 0.5 ? '▲' : pitchVal < -0.5 ? '▼' : ''

  const stat = (label: string, value: string, color = '#fff') => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
      <span style={{ color: '#dcdcdc', fontSize: 14, fontWeight: 800, letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color, fontSize: 17, fontWeight: 900, fontFamily: 'monospace' }}>{value}</span>
    </div>
  )

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 6, padding: '6px 12px 4px 8px', fontFamily: 'sans-serif' }}>
      {/* LEFT — attitude indicator */}
      <div style={{ flex: '0 0 33%', minWidth: 0, display: 'flex', justifyContent: 'center' }}>
        <Attitude lean={leanVal} pitch={pitchVal} maxL={peak.leanL} maxR={peak.leanR} />
      </div>

      {/* MIDDLE — G traction circle */}
      <div style={{ flex: '0 0 30%', minWidth: 0, display: 'flex', justifyContent: 'center' }}>
        <GCircle gx={gxV} gy={gyV} gMax={peak.g} />
      </div>

      {/* RIGHT — stat readouts (top padding clears the floating ✕) */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 9, paddingTop: 50, paddingRight: 2 }}>
        {stat('MAX L', `${Math.round(peak.leanL)}°`, '#ff8a65')}
        {stat('MAX R', `${Math.round(peak.leanR)}°`, '#ff8a65')}
        {stat('PITCH', pitch !== null ? (absPitch === 0 ? '0°' : `${pitchDir}${absPitch}°`) : '—', '#80cbc4')}
        {stat('PEAK G', peak.g > 0.05 ? peak.g.toFixed(2) : '—', '#ffb300')}
        <div style={{ marginTop: 4, alignSelf: 'flex-end' }}>
          <ResetMaxButton onReset={resetPeak} width={132} />
        </div>
      </div>
    </div>
  )
}

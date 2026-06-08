import { useCarplayStore } from '../store/store'
import { useStableValue } from '../utils/smoothing'

// Same thresholds/colors as CHTGauge.tempColor + dataLog CHT_ZONES.
function chtZone(t: number): { label: string; color: string } {
  if (t < 80)  return { label: 'COLD',   color: '#4fc3f7' }
  if (t < 160) return { label: 'NORMAL', color: '#66bb6a' }
  if (t < 220) return { label: 'WARM',   color: '#ffca28' }
  return { label: 'HOT', color: '#ef5350' }
}

// ── one finned cylinder, drawn pointing outward, glowing by heat zone ─────────
// `dir` -1 points left, +1 points right (boxer layout). Glow intensity scales
// with how hot the head is, so a hot cylinder visibly blooms.
function Cylinder({ temp, dir }: { temp: number | null; dir: -1 | 1 }) {
  const has = temp !== null
  const t = temp ?? 0
  const { color } = has ? chtZone(t) : { color: '#3a3a3a' }
  const glow = has ? Math.max(0, Math.min(1, (t - 40) / 200)) : 0   // 40°→0  240°→1
  // base geometry drawn pointing RIGHT in a 130×96 box, flipped for left
  const fid = `cyl-glow-${dir === 1 ? 'r' : 'l'}`
  return (
    <svg viewBox="0 0 130 96" width="100%" height="96" preserveAspectRatio="xMidYMid meet"
      style={{ transform: dir === -1 ? 'scaleX(-1)' : undefined }}>
      <defs>
        <filter id={fid} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      {/* glow halo behind (opacity tracks heat) */}
      {has && glow > 0.02 && (
        <g filter={`url(#${fid})`} opacity={0.25 + glow * 0.6}>
          <rect x={28} y={26} width={86} height={44} rx={10} fill={color} />
        </g>
      )}
      {/* crankcase stub */}
      <rect x={2} y={34} width={26} height={28} rx={4} fill="#2a2a2a" stroke="#444" strokeWidth={1} />
      {/* finned barrel */}
      {[0, 1, 2, 3, 4].map(i => (
        <rect key={i} x={30 + i * 14} y={24} width={9} height={48} rx={2}
          fill={has ? color : '#333'} opacity={has ? 0.55 + glow * 0.35 : 0.5} />
      ))}
      {/* head block */}
      <rect x={100} y={20} width={20} height={56} rx={6} fill={has ? color : '#3a3a3a'} opacity={has ? 0.85 : 0.6} />
      {/* spark plug */}
      <circle cx={123} cy={48} r={3.4} fill="#888" />
    </svg>
  )
}

function reading(label: string, temp: number | null, peak: number) {
  const has = temp !== null
  const z = has ? chtZone(temp!) : { label: '—', color: '#777' }
  return { label, has, temp, z, peak }
}

export default function CylinderHeadsPanel() {
  const rawL = useCarplayStore(s => s.chtLeft)
  const rawR = useCarplayStore(s => s.chtRight)
  // Smooth like the gauges (reject >3°C single-frame spikes).
  const left  = useStableValue(rawL, 3, 3000)
  const right = useStableValue(rawR, 3, 3000)
  const peak  = useCarplayStore(s => s.chtPeak)
  const resetPeak = useCarplayStore(s => s.resetChtPeak)

  if (rawL === null && rawR === null) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#888', fontSize: 14, fontWeight: 800, letterSpacing: 2, fontFamily: 'monospace' }}>
          NO CYLINDER-HEAD DATA
        </div>
      </div>
    )
  }

  const L = reading('L', left, peak.left)
  const R = reading('R', right, peak.right)
  const bothHave = left !== null && right !== null
  const delta = bothHave ? Math.abs(Math.round(left! - right!)) : null
  // ΔT context: small spread is normal on a boxer; a big spread flags trouble.
  const deltaColor = delta === null ? '#777' : delta < 20 ? '#9ccc65' : delta < 40 ? '#ffca28' : '#ef5350'

  const side = (s: typeof L, dir: -1 | 1) => (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <div style={{ color: '#dcdcdc', fontSize: 14, fontWeight: 900, letterSpacing: 3, fontFamily: 'monospace' }}>
        {s.label} HEAD
      </div>
      <Cylinder temp={s.temp} dir={dir} />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
        <span style={{ color: s.has ? s.z.color : '#fff', fontSize: 40, fontWeight: 900, fontFamily: 'monospace', lineHeight: 1 }}>
          {s.has ? Math.round(s.temp!) : '--'}
        </span>
        <span style={{ color: '#bbb', fontSize: 16, fontWeight: 700, fontFamily: 'monospace' }}>°C</span>
      </div>
      <div style={{ color: s.has ? s.z.color : '#777', fontSize: 14, fontWeight: 800, letterSpacing: 2, fontFamily: 'monospace' }}>
        {s.z.label}
      </div>
      <div style={{ color: '#aaa', fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>
        {s.peak > 0 ? `MAX ${Math.round(s.peak)}°` : ''}
      </div>
    </div>
  )

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px 4px', fontFamily: 'sans-serif' }}>
      {side(L, -1)}

      {/* CENTER — engine + ΔT (narrow; clears the floating ✕ which is up-right) */}
      <div style={{ flex: '0 0 96px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, paddingTop: 24 }}>
        <span style={{ color: '#888', fontSize: 11, fontWeight: 800, letterSpacing: 2, fontFamily: 'monospace' }}>◄ BOXER ►</span>
        <span style={{ color: '#888', fontSize: 12, fontWeight: 800, letterSpacing: 2, fontFamily: 'monospace', marginTop: 4 }}>ΔT</span>
        <span style={{ color: deltaColor, fontSize: 30, fontWeight: 900, fontFamily: 'monospace', lineHeight: 1 }}>
          {delta !== null ? `${delta}°` : '—'}
        </span>
        <div onClick={resetPeak} style={{
          marginTop: 6, cursor: 'pointer', color: '#ff6b6b', fontSize: 11, fontWeight: 800,
          letterSpacing: 1, fontFamily: 'monospace', border: '1.5px solid #ff6b6b55', borderRadius: 8, padding: '3px 8px',
        }}>RESET PK</div>
      </div>

      {side(R, 1)}
    </div>
  )
}

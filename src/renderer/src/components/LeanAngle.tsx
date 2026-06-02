import { useCarplayStore } from '../store/store'

const W           = 565
const H           = 117
const CX          = W / 2
const PITCH_SCALE = 2.5      // px per degree of pitch
const ROLL_R      = 50       // radius of roll arc from top-center
const REF_Y       = H / 2   // fixed aircraft reference at vertical center

const SKY    = '#1e3d5c'
const GROUND = '#5c3412'
const REF    = '#ffd700'     // classic aviation gold

function d2r(deg: number) { return (deg * Math.PI) / 180 }

// Arc path centered on (CX, 0) — the top center
function rollArcPath(r: number, fromDeg: number, toDeg: number) {
  const pts: string[] = []
  for (let a = fromDeg; a <= toDeg; a += 2) {
    const x = CX + r * Math.sin(d2r(a))
    const y = r * (1 - Math.cos(d2r(a)))
    pts.push(`${a === fromDeg ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
  }
  return pts.join(' ')
}

const ROLL_TICKS = [10, 20, 30, 45]

export default function LeanAngle() {
  const lean  = useCarplayStore(s => s.leanAngle)
  const pitch = useCarplayStore(s => s.pitchAngle)
  const altM  = useCarplayStore(s => s.altitude)
  const gx    = useCarplayStore(s => s.gForceX)
  const gy    = useCarplayStore(s => s.gForceY)

  const leanVal  = lean  ?? 0
  const pitchVal = pitch ?? 0
  const hasData  = lean !== null

  const absLean  = Math.abs(Math.round(leanVal))
  const side     = leanVal > 0.5 ? 'R' : leanVal < -0.5 ? 'L' : ''
  const absPitch = Math.abs(Math.round(pitchVal))
  const pitchDir = pitchVal > 0.5 ? '▲' : pitchVal < -0.5 ? '▼' : ''

  const altFt = altM !== null ? Math.round(altM * 3.28084).toLocaleString() : '--'
  const g     = gx !== null && gy !== null
    ? Math.sqrt(gx ** 2 + gy ** 2).toFixed(1) : '--'
  const gNum  = parseFloat(g)
  const gColor = isNaN(gNum) ? '#444'
    : gNum < 0.3 ? '#61dafb' : gNum < 0.7 ? '#66bb6a' : gNum < 1.1 ? '#ffca28' : '#ef5350'

  // Horizon position: drops when nose up (pitch > 0)
  const horizonY = REF_Y + pitchVal * PITCH_SCALE

  // Rotation around the (possibly pitch-shifted) horizon center
  const rot = `rotate(${leanVal}, ${CX}, ${horizonY})`

  // Pitch ladder lines (in rotating frame, relative to horizonY)
  const pitchLines = [-15, -10, -5, 5, 10, 15].map(p => ({
    y:     horizonY - p * PITCH_SCALE,
    len:   Math.abs(p) % 10 === 0 ? 90 : 55,
    label: Math.abs(p) % 10 === 0 ? Math.abs(p) : null,
  }))

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <clipPath id="ai-clip">
            <rect x={0} y={0} width={W} height={H} />
          </clipPath>
        </defs>

        {/* ── ROTATING BACKGROUND ── */}
        <g clipPath="url(#ai-clip)">
          <g transform={rot}>
            {/* Sky */}
            <rect x={-W} y={-3 * H} width={3 * W} height={3 * H + horizonY} fill={SKY} />
            {/* Ground */}
            <rect x={-W} y={horizonY} width={3 * W} height={3 * H} fill={GROUND} />
            {/* Horizon line */}
            <line x1={-W} y1={horizonY} x2={3 * W} y2={horizonY}
              stroke="white" strokeWidth={2} opacity={0.85} />
            {/* Pitch ladder */}
            {pitchLines.map(({ y, len, label }) => (
              <g key={y}>
                <line x1={CX - len / 2} y1={y} x2={CX + len / 2} y2={y}
                  stroke="white" strokeWidth={1} opacity={0.5} />
                {label && (
                  <>
                    <text x={CX - len / 2 - 5} y={y + 3.5}
                      textAnchor="end" fill="white" fontSize={8}
                      fontFamily="sans-serif" opacity={0.55}>{label}</text>
                    <text x={CX + len / 2 + 5} y={y + 3.5}
                      textAnchor="start" fill="white" fontSize={8}
                      fontFamily="sans-serif" opacity={0.55}>{label}</text>
                  </>
                )}
              </g>
            ))}
          </g>
        </g>

        {/* ── FIXED AIRCRAFT REFERENCE ── */}
        {/* Left wing */}
        <line x1={CX - 55} y1={REF_Y} x2={CX - 12} y2={REF_Y}
          stroke={REF} strokeWidth={3} strokeLinecap="round" />
        <line x1={CX - 55} y1={REF_Y} x2={CX - 55} y2={REF_Y + 7}
          stroke={REF} strokeWidth={3} strokeLinecap="round" />
        {/* Right wing */}
        <line x1={CX + 12} y1={REF_Y} x2={CX + 55} y2={REF_Y}
          stroke={REF} strokeWidth={3} strokeLinecap="round" />
        <line x1={CX + 55} y1={REF_Y} x2={CX + 55} y2={REF_Y + 7}
          stroke={REF} strokeWidth={3} strokeLinecap="round" />
        {/* Center circle + dot */}
        <circle cx={CX} cy={REF_Y} r={5} fill="none" stroke={REF} strokeWidth={2.5} />
        <circle cx={CX} cy={REF_Y} r={2} fill={REF} />

        {/* ── ROLL ARC (fixed) ── */}
        <path d={rollArcPath(ROLL_R, -50, 50)}
          fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth={1} />

        {/* Roll tick marks */}
        {ROLL_TICKS.flatMap(a => [-a, a]).map(a => {
          const major = Math.abs(a) >= 30
          const outerR = ROLL_R
          const innerR = ROLL_R - (major ? 10 : 6)
          const ox = CX + outerR * Math.sin(d2r(a))
          const oy = outerR * (1 - Math.cos(d2r(a)))
          const ix = CX + innerR * Math.sin(d2r(a))
          const iy = innerR * (1 - Math.cos(d2r(a)))
          return (
            <line key={a} x1={ox} y1={oy} x2={ix} y2={iy}
              stroke="rgba(255,255,255,0.5)"
              strokeWidth={major ? 1.5 : 1} />
          )
        })}

        {/* ── ROLL POINTER (rotates around top-center with lean) ── */}
        <g transform={`rotate(${leanVal}, ${CX}, 0)`}>
          <polygon
            points={`${CX},${ROLL_R + 7} ${CX - 7},${ROLL_R - 7} ${CX + 7},${ROLL_R - 7}`}
            fill={hasData ? 'white' : 'rgba(255,255,255,0.25)'}
          />
        </g>

        {/* ── TEXT READOUTS (lower ground area) ── */}
        {/* Subtle dark backing for legibility */}
        <rect x={0} y={68} width={W} height={H - 68} fill="rgba(0,0,0,0.25)" />

        {/* ALT */}
        <text x={CX - 100} y={78} textAnchor="middle"
          fill="#666" fontSize={10} fontFamily="sans-serif" letterSpacing={1}>ALT</text>
        <text x={CX - 100} y={96} textAnchor="middle"
          fill={altM !== null ? '#ddd' : '#444'} fontSize={20}
          fontWeight="bold" fontFamily="sans-serif">{altFt}</text>

        {/* Lean + pitch center */}
        <text x={CX} y={80} textAnchor="middle"
          fill={hasData ? 'white' : '#444'} fontSize={18}
          fontWeight="bold" fontFamily="sans-serif">
          {hasData ? (absLean > 0 ? `${absLean}° ${side}` : '0°') : '--'}
        </text>
        {pitch !== null && absPitch > 0 && (
          <text x={CX} y={97} textAnchor="middle"
            fill="rgba(255,200,80,0.85)" fontSize={11} fontFamily="sans-serif">
            {pitchDir}{absPitch}°
          </text>
        )}

        {/* G */}
        <text x={CX + 100} y={78} textAnchor="middle"
          fill="#666" fontSize={10} fontFamily="sans-serif" letterSpacing={1}>G</text>
        <text x={CX + 100} y={96} textAnchor="middle"
          fill={gx !== null ? gColor : '#444'} fontSize={20}
          fontWeight="bold" fontFamily="sans-serif">{g}</text>

      </svg>
    </div>
  )
}

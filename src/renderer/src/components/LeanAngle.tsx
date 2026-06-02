import { useCarplayStore } from '../store/store'

const W        = 565
const H        = 117
const CX       = W / 2
const PIVOT_Y  = H          // pivot at bottom-center
const R_INNER  = 68         // inner tick mark radius
const R_OUTER  = 84         // outer tick mark radius
const R_LABEL  = 97         // degree label radius
const R_ARC    = 76         // reference arc
const R_NEEDLE = 80         // needle length

const SKY    = '#0b1a30'
const GROUND = '#2e1c0e'
const NEEDLE = '#ff6b35'

const TICK_ANGLES = [10, 20, 30, 40]

function degToRad(d: number) { return (d * Math.PI) / 180 }

function pt(angleDeg: number, r: number) {
  const rad = degToRad(angleDeg)
  return { x: CX + r * Math.sin(rad), y: PIVOT_Y - r * Math.cos(rad) }
}

// Build the reference arc path
function buildArc(r: number, fromDeg: number, toDeg: number) {
  const pts: string[] = []
  for (let a = fromDeg; a <= toDeg; a += 2) {
    const p = pt(a, r)
    pts.push(`${a === fromDeg ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
  }
  return pts.join(' ')
}

export default function LeanAngle() {
  const leanAngle  = useCarplayStore((s) => s.leanAngle)
  const pitchAngle = useCarplayStore((s) => s.pitchAngle)

  const lean     = leanAngle ?? 0
  const hasData  = leanAngle !== null
  const absLean  = Math.abs(Math.round(lean))
  const leanSide = lean > 0.5 ? 'R' : lean < -0.5 ? 'L' : ''

  const absPitch  = pitchAngle !== null ? Math.abs(Math.round(pitchAngle)) : null
  const pitchDir  = pitchAngle !== null ? (pitchAngle > 0.5 ? '▲' : pitchAngle < -0.5 ? '▼' : '') : null

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        preserveAspectRatio="xMidYMid slice"
      >
        {/* Background */}
        <rect x={0} y={0} width={W} height={H / 2} fill={SKY} />
        <rect x={0} y={H / 2} width={W} height={H / 2} fill={GROUND} />

        {/* Horizon divider */}
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="rgba(255,140,60,0.4)" strokeWidth={1} />

        {/* Reference arc */}
        <path d={buildArc(R_ARC, -45, 45)} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1} />

        {/* Tick marks — both sides */}
        {TICK_ANGLES.flatMap(a => [-a, a]).map(a => {
          const inner = pt(a, R_INNER)
          const outer = pt(a, R_OUTER)
          const label = pt(a, R_LABEL)
          const major = Math.abs(a) % 20 === 0
          return (
            <g key={a}>
              <line
                x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
                stroke={major ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.25)'}
                strokeWidth={major ? 1.5 : 1}
              />
              {major && (
                <text
                  x={label.x} y={label.y + 3.5}
                  textAnchor="middle" dominantBaseline="middle"
                  fill="rgba(255,255,255,0.4)" fontSize={9} fontFamily="sans-serif"
                >
                  {Math.abs(a)}
                </text>
              )}
            </g>
          )
        })}

        {/* Center 0° tick */}
        <line
          x1={CX} y1={PIVOT_Y - R_INNER}
          x2={CX} y2={PIVOT_Y - R_OUTER}
          stroke="rgba(255,255,255,0.55)" strokeWidth={1.5}
        />

        {/* Needle — rotates with lean angle */}
        <g transform={`rotate(${lean}, ${CX}, ${PIVOT_Y})`}>
          {/* Needle shaft */}
          <line
            x1={CX} y1={PIVOT_Y}
            x2={CX} y2={PIVOT_Y - R_NEEDLE}
            stroke={NEEDLE} strokeWidth={2.5} strokeLinecap="round"
          />
          {/* Needle tip dot */}
          <circle cx={CX} cy={PIVOT_Y - R_NEEDLE} r={3.5} fill={NEEDLE} />
        </g>

        {/* Pivot cap */}
        <circle cx={CX} cy={PIVOT_Y} r={5} fill="#222" stroke={NEEDLE} strokeWidth={1.5} />

        {/* Lean angle readout — sky area, centered */}
        <text
          x={CX} y={30}
          textAnchor="middle" dominantBaseline="middle"
          fill={hasData ? 'white' : '#333'}
          fontSize={hasData ? 18 : 14}
          fontWeight="bold" fontFamily="sans-serif"
        >
          {hasData ? (absLean > 0 ? `${absLean}° ${leanSide}` : '0°') : '--'}
        </text>

        {/* Pitch readout — right of lean, small */}
        {absPitch !== null && (
          <text
            x={CX + 72} y={30}
            textAnchor="middle" dominantBaseline="middle"
            fill="rgba(255,140,60,0.85)"
            fontSize={11} fontFamily="sans-serif"
          >
            {pitchDir}{absPitch > 0 ? `${absPitch}°` : '—'}
          </text>
        )}
      </svg>
    </div>
  )
}

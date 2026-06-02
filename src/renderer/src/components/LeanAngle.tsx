import { useCarplayStore } from '../store/store'

const W = 565
const H = 117
const CX = W / 2
const CY = H / 2

// Colors
const SKY = '#0b1a30'
const GROUND = '#2e1c0e'
const HORIZON = 'rgba(255,255,255,0.55)'

export default function LeanAngle() {
  const leanAngle = useCarplayStore((s) => s.leanAngle)
  const angle = leanAngle ?? 0
  const hasData = leanAngle !== null

  const absAngle = Math.abs(Math.round(angle))
  const side = angle > 0.5 ? 'R' : angle < -0.5 ? 'L' : ''

  // Positive lean = lean right = horizon tilts clockwise (right side down)
  const rotate = `rotate(${angle}, ${CX}, ${CY})`

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <clipPath id="horizon-clip">
            <rect x={0} y={0} width={W} height={H} />
          </clipPath>
        </defs>

        <g clipPath="url(#horizon-clip)">
          {/* Sky — above horizon */}
          <rect
            x={-W} y={-3 * H}
            width={3 * W} height={3 * H}
            fill={SKY}
            transform={rotate}
          />
          {/* Ground — below horizon */}
          <rect
            x={-W} y={0}
            width={3 * W} height={3 * H}
            fill={GROUND}
            transform={rotate}
          />
          {/* Horizon line */}
          <line
            x1={-W} y1={0} x2={3 * W} y2={0}
            stroke={HORIZON}
            strokeWidth={1.5}
            transform={rotate}
          />
          {/* Tick marks at ±15° and ±30° */}
          {[-30, -15, 15, 30].map((deg) => {
            const rad = (deg * Math.PI) / 180
            const tickLen = Math.abs(deg) === 30 ? 12 : 8
            const x1 = CX + Math.cos(rad) * (CX * 0.85)
            const y1 = CY - Math.sin(rad) * (CX * 0.85)
            const x2 = CX + Math.cos(rad) * (CX * 0.85 + tickLen)
            const y2 = CY - Math.sin(rad) * (CX * 0.85 + tickLen)
            return (
              <line
                key={deg}
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="rgba(255,255,255,0.3)"
                strokeWidth={1}
              />
            )
          })}
          {/* Center reference dot */}
          <circle cx={CX} cy={CY} r={3} fill="white" opacity={0.7} />
          <line x1={CX - 12} y1={CY} x2={CX - 4} y2={CY} stroke="white" strokeWidth={1.5} opacity={0.7} />
          <line x1={CX + 4} y1={CY} x2={CX + 12} y2={CY} stroke="white" strokeWidth={1.5} opacity={0.7} />
        </g>

        {/* Degree readout */}
        {hasData ? (
          <text
            x={CX}
            y={CY + 6}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="white"
            fontSize={22}
            fontWeight="bold"
            fontFamily="sans-serif"
            style={{ textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}
          >
            {absAngle > 0 ? `${absAngle}° ${side}` : '0°'}
          </text>
        ) : (
          <text
            x={CX} y={CY + 6}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#444"
            fontSize={18}
            fontFamily="sans-serif"
          >
            --
          </text>
        )}
      </svg>
    </div>
  )
}

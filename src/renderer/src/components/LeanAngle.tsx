import { useCarplayStore } from '../store/store'

const W   = 565
const H   = 117
const CX  = W / 2

// Bar geometry — sits near top of strip (where circle is widest)
const BAR_Y    = 42
const BAR_LEFT = 58
const BAR_RIGHT= 507
const BAR_W    = BAR_RIGHT - BAR_LEFT   // 449px
const MAX_LEAN = 45                      // degrees at bar ends
const PPD      = BAR_W / (MAX_LEAN * 2) // pixels per degree ≈ 4.99

// Tick angles to draw
const TICKS = [10, 20, 30, 40]

function leanToX(deg: number) {
  const clamped = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, deg))
  return CX + clamped * PPD
}

// Color of the zone under the pointer
function zoneColor(deg: number): string {
  const abs = Math.abs(deg)
  if (abs < 15) return '#61dafb'   // safe — cyan
  if (abs < 30) return '#ffca28'   // caution — amber
  return '#ef5350'                  // aggressive — red
}

const SKY    = '#0a1828'
const GROUND = '#291a0c'

export default function LeanAngle() {
  const leanAngle  = useCarplayStore((s) => s.leanAngle)
  const pitchAngle = useCarplayStore((s) => s.pitchAngle)

  const lean    = leanAngle ?? 0
  const hasData = leanAngle !== null
  const absLean = Math.abs(Math.round(lean))
  const side    = lean > 0.5 ? 'R' : lean < -0.5 ? 'L' : ''

  const absPitch = pitchAngle !== null ? Math.abs(Math.round(pitchAngle)) : null
  const pitchDir = pitchAngle !== null
    ? (pitchAngle > 0.5 ? '▲' : pitchAngle < -0.5 ? '▼' : '') : null

  const ptrX  = leanToX(lean)
  const color = hasData ? zoneColor(lean) : '#444'

  return (
    <div style={{ width: '100%', height: '100%' }}>
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

        {/* Subtle horizon */}
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="rgba(255,120,40,0.25)" strokeWidth={1} />

        {/* Bar track */}
        <line
          x1={BAR_LEFT} y1={BAR_Y}
          x2={BAR_RIGHT} y2={BAR_Y}
          stroke="rgba(255,255,255,0.18)"
          strokeWidth={2}
          strokeLinecap="round"
        />

        {/* Tick marks above bar */}
        {TICKS.flatMap(t => [-t, t]).map(t => {
          const x = leanToX(t)
          const major = Math.abs(t) % 20 === 0
          const tickH = major ? 14 : 8
          return (
            <g key={t}>
              <line
                x1={x} y1={BAR_Y - tickH}
                x2={x} y2={BAR_Y}
                stroke={major ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.2)'}
                strokeWidth={major ? 1.5 : 1}
              />
              {major && (
                <text
                  x={x} y={BAR_Y - tickH - 4}
                  textAnchor="middle"
                  fill="rgba(255,255,255,0.35)"
                  fontSize={9}
                  fontFamily="sans-serif"
                >
                  {Math.abs(t)}
                </text>
              )}
            </g>
          )
        })}

        {/* Center tick */}
        <line
          x1={CX} y1={BAR_Y - 18}
          x2={CX} y2={BAR_Y}
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={1.5}
        />

        {/* Pointer — downward triangle, tip on bar */}
        <polygon
          points={`${ptrX},${BAR_Y} ${ptrX - 8},${BAR_Y - 16} ${ptrX + 8},${BAR_Y - 16}`}
          fill={color}
          opacity={hasData ? 1 : 0.3}
        />

        {/* Lean readout — centered, below bar */}
        <text
          x={CX} y={72}
          textAnchor="middle"
          fill={hasData ? 'white' : '#333'}
          fontSize={20}
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          {hasData ? (absLean > 0 ? `${absLean}° ${side}` : '0°') : '--'}
        </text>

        {/* Pitch — small, right of lean readout */}
        {absPitch !== null && pitchDir !== null && (
          <text
            x={CX + 70} y={72}
            textAnchor="middle"
            fill="rgba(255,140,60,0.8)"
            fontSize={12}
            fontFamily="sans-serif"
          >
            {pitchDir}{absPitch > 0 ? `${absPitch}°` : '—'}
          </text>
        )}

        {/* ALT — left, near center (safe zone) */}
        <text x={CX - 130} y={66} textAnchor="middle" fill="#555" fontSize={9} fontFamily="sans-serif" letterSpacing={1}>
          ALT
        </text>
        <AltText cx={CX - 130} cy={80} />

        {/* G — right, near center */}
        <text x={CX + 130} y={66} textAnchor="middle" fill="#555" fontSize={9} fontFamily="sans-serif" letterSpacing={1}>
          G
        </text>
        <GText cx={CX + 130} cy={80} />

      </svg>
    </div>
  )
}

// Small sub-components that read from store
function AltText({ cx, cy }: { cx: number; cy: number }) {
  const altM = useCarplayStore((s) => s.altitude)
  const altFt = altM !== null ? Math.round(altM * 3.28084).toLocaleString() : '--'
  return (
    <text x={cx} y={cy} textAnchor="middle" fill={altM !== null ? '#aaa' : '#333'}
      fontSize={13} fontWeight="bold" fontFamily="sans-serif">
      {altFt}
    </text>
  )
}

function GText({ cx, cy }: { cx: number; cy: number }) {
  const gx = useCarplayStore((s) => s.gForceX)
  const gy = useCarplayStore((s) => s.gForceY)
  const g  = gx !== null && gy !== null ? Math.sqrt(gx ** 2 + gy ** 2).toFixed(1) : '--'
  const hasData = gx !== null

  function gColor(val: string): string {
    const n = parseFloat(val)
    if (isNaN(n)) return '#333'
    if (n < 0.3) return '#61dafb'
    if (n < 0.7) return '#66bb6a'
    if (n < 1.1) return '#ffca28'
    return '#ef5350'
  }

  return (
    <text x={cx} y={cy} textAnchor="middle" fill={hasData ? gColor(g) : '#333'}
      fontSize={13} fontWeight="bold" fontFamily="sans-serif">
      {g}
    </text>
  )
}

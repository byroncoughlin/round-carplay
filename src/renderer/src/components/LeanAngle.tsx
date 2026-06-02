import { useCarplayStore } from '../store/store'

const W        = 565
const H        = 117
const CX       = W / 2
const HORIZON  = H / 2      // horizon at vertical center

// Horizontal bar geometry
const BAR_Y    = 38
const BAR_LEFT = 58
const BAR_RIGHT= 507
const MAX_LEAN = 45
const PPD      = (BAR_RIGHT - BAR_LEFT) / (MAX_LEAN * 2)

const TICKS = [10, 20, 30, 40]
const SKY    = '#0a1828'
const GROUND = '#291a0c'

function leanToX(deg: number) {
  return CX + Math.max(-MAX_LEAN, Math.min(MAX_LEAN, deg)) * PPD
}

function zoneColor(deg: number): string {
  const abs = Math.abs(deg)
  if (abs < 15) return '#61dafb'
  if (abs < 30) return '#ffca28'
  return '#ef5350'
}

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

  // Background rotates around center of strip — makes motion obvious even at 0°
  const rot = `rotate(${lean}, ${CX}, ${HORIZON})`

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
          <clipPath id="lean-bg-clip">
            <rect x={0} y={0} width={W} height={H} />
          </clipPath>
        </defs>

        {/* Tilting sky / ground background */}
        <g clipPath="url(#lean-bg-clip)">
          <rect x={-W} y={-3 * H} width={3 * W} height={3 * H} fill={SKY} transform={rot} />
          <rect x={-W} y={HORIZON} width={3 * W} height={3 * H} fill={GROUND} transform={rot} />
          {/* Horizon line — tilts with lean */}
          <line
            x1={-W} y1={HORIZON} x2={3 * W} y2={HORIZON}
            stroke="rgba(255,255,255,0.35)" strokeWidth={1.5}
            transform={rot}
          />
        </g>

        {/* Static bar */}
        <line
          x1={BAR_LEFT} y1={BAR_Y} x2={BAR_RIGHT} y2={BAR_Y}
          stroke="rgba(255,255,255,0.22)" strokeWidth={2} strokeLinecap="round"
        />

        {/* Tick marks */}
        {TICKS.flatMap(t => [-t, t]).map(t => {
          const x   = leanToX(t)
          const maj = Math.abs(t) % 20 === 0
          const th  = maj ? 14 : 8
          return (
            <g key={t}>
              <line
                x1={x} y1={BAR_Y - th} x2={x} y2={BAR_Y}
                stroke={maj ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.2)'}
                strokeWidth={maj ? 1.5 : 1}
              />
              {maj && (
                <text
                  x={x} y={BAR_Y - th - 4}
                  textAnchor="middle"
                  fill="rgba(255,255,255,0.35)"
                  fontSize={9} fontFamily="sans-serif"
                >
                  {Math.abs(t)}
                </text>
              )}
            </g>
          )
        })}

        {/* Center tick */}
        <line
          x1={CX} y1={BAR_Y - 18} x2={CX} y2={BAR_Y}
          stroke="rgba(255,255,255,0.45)" strokeWidth={1.5}
        />

        {/* Moving pointer — downward triangle on bar */}
        <polygon
          points={`${ptrX},${BAR_Y} ${ptrX - 8},${BAR_Y - 16} ${ptrX + 8},${BAR_Y - 16}`}
          fill={color}
          opacity={hasData ? 1 : 0.35}
        />

        {/* Lean readout */}
        <text
          x={CX} y={76}
          textAnchor="middle" fill={hasData ? 'white' : '#333'}
          fontSize={20} fontWeight="bold" fontFamily="sans-serif"
        >
          {hasData ? (absLean > 0 ? `${absLean}° ${side}` : '0°') : '--'}
        </text>

        {/* Pitch */}
        {absPitch !== null && pitchDir !== null && (
          <text
            x={CX + 72} y={76}
            textAnchor="middle" fill="rgba(255,140,60,0.8)"
            fontSize={12} fontFamily="sans-serif"
          >
            {pitchDir}{absPitch > 0 ? `${absPitch}°` : '—'}
          </text>
        )}

        {/* ALT */}
        <text x={CX - 130} y={64} textAnchor="middle" fill="#555"
          fontSize={10} fontFamily="sans-serif" letterSpacing={1}>ALT</text>
        <AltText cx={CX - 130} cy={82} />

        {/* G */}
        <text x={CX + 130} y={64} textAnchor="middle" fill="#555"
          fontSize={10} fontFamily="sans-serif" letterSpacing={1}>G</text>
        <GText cx={CX + 130} cy={82} />

      </svg>
    </div>
  )
}

function AltText({ cx, cy }: { cx: number; cy: number }) {
  const altM = useCarplayStore((s) => s.altitude)
  const ft   = altM !== null ? Math.round(altM * 3.28084).toLocaleString() : '--'
  return (
    <text x={cx} y={cy} textAnchor="middle"
      fill={altM !== null ? '#ccc' : '#333'}
      fontSize={17} fontWeight="bold" fontFamily="sans-serif">
      {ft}
    </text>
  )
}

function GText({ cx, cy }: { cx: number; cy: number }) {
  const gx = useCarplayStore((s) => s.gForceX)
  const gy = useCarplayStore((s) => s.gForceY)
  const g  = gx !== null && gy !== null
    ? Math.sqrt(gx ** 2 + gy ** 2).toFixed(1) : '--'

  function gColor(v: string): string {
    const n = parseFloat(v)
    if (isNaN(n)) return '#333'
    if (n < 0.3) return '#61dafb'
    if (n < 0.7) return '#66bb6a'
    if (n < 1.1) return '#ffca28'
    return '#ef5350'
  }

  return (
    <text x={cx} y={cy} textAnchor="middle"
      fill={gx !== null ? gColor(g) : '#333'}
      fontSize={17} fontWeight="bold" fontFamily="sans-serif">
      {g}
    </text>
  )
}

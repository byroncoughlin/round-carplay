import { useCarplayStore } from '../store/store'

interface CHTGaugeProps {
  side: 'L' | 'R'
}

const MIN_TEMP = 0
const MAX_TEMP = 300
const BAR_H = 200
const BAR_W = 36

function tempColor(temp: number): string {
  if (temp < 80) return '#4fc3f7'   // cold — blue
  if (temp < 160) return '#66bb6a'  // normal — green
  if (temp < 220) return '#ffca28'  // warm — amber
  return '#ef5350'                   // hot — red
}

export default function CHTGauge({ side }: CHTGaugeProps) {
  const temp = useCarplayStore((s) => (side === 'L' ? s.chtLeft : s.chtRight))

  const hasData = temp !== null
  const clamped = Math.max(MIN_TEMP, Math.min(MAX_TEMP, temp ?? 0))
  const fill = (clamped / MAX_TEMP) * BAR_H
  const color = hasData ? tempColor(clamped) : '#333'

  // SVG viewBox centered in the strip
  // Strip is 117×565 — we work in a 100×300 internal space, centered
  const VW = 100
  const VH = 300
  const cx = VW / 2
  const barX = cx - BAR_W / 2

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        width="100%"
        height="100%"
        style={{ display: 'block', maxWidth: '100px' }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Label */}
        <text
          x={cx} y={18}
          textAnchor="middle"
          fill="#666"
          fontSize={11}
          fontFamily="sans-serif"
          letterSpacing={1}
        >
          CHT
        </text>
        <text
          x={cx} y={33}
          textAnchor="middle"
          fill="#888"
          fontSize={14}
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          {side}
        </text>

        {/* Bar track */}
        <rect
          x={barX} y={45}
          width={BAR_W} height={BAR_H}
          fill="#1a1a1a"
          rx={4}
        />

        {/* Bar fill (grows from bottom) */}
        {hasData && fill > 0 && (
          <rect
            x={barX}
            y={45 + BAR_H - fill}
            width={BAR_W}
            height={fill}
            fill={color}
            rx={4}
          />
        )}

        {/* Subtle tick marks at 100°, 200° */}
        {[100, 200].map((t) => {
          const y = 45 + BAR_H - (t / MAX_TEMP) * BAR_H
          return (
            <line
              key={t}
              x1={barX} y1={y}
              x2={barX + BAR_W} y2={y}
              stroke="#333"
              strokeWidth={1}
            />
          )
        })}

        {/* Temperature readout */}
        <text
          x={cx}
          y={265}
          textAnchor="middle"
          fill={hasData ? color : '#444'}
          fontSize={hasData ? 22 : 18}
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          {hasData ? Math.round(clamped) : '--'}
        </text>
        <text
          x={cx} y={282}
          textAnchor="middle"
          fill="#555"
          fontSize={11}
          fontFamily="sans-serif"
          letterSpacing={1}
        >
          °C
        </text>
      </svg>
    </div>
  )
}

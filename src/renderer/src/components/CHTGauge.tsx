import { useCarplayStore } from '../store/store'

interface CHTGaugeProps {
  side: 'L' | 'R'
}

const MIN_TEMP = 0
const MAX_TEMP = 300
const BAR_H    = 230
const BAR_W    = 54

function tempColor(temp: number): string {
  if (temp < 80)  return '#4fc3f7'
  if (temp < 160) return '#66bb6a'
  if (temp < 220) return '#ffca28'
  return '#ef5350'
}

export default function CHTGauge({ side }: CHTGaugeProps) {
  const temp = useCarplayStore((s) => (side === 'L' ? s.chtLeft : s.chtRight))

  const hasData = temp !== null
  const clamped = Math.max(MIN_TEMP, Math.min(MAX_TEMP, temp ?? 0))
  const fill    = (clamped / MAX_TEMP) * BAR_H
  const color   = hasData ? tempColor(clamped) : '#333'

  const VW  = 110
  const VH  = 320
  const cx  = VW / 2
  const barX = cx - BAR_W / 2
  const barY = 42

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Label */}
        <text x={cx} y={18} textAnchor="middle" fill="#555" fontSize={12}
          fontFamily="sans-serif" letterSpacing={1}>CHT</text>
        <text x={cx} y={36} textAnchor="middle" fill="#777" fontSize={16}
          fontWeight="bold" fontFamily="sans-serif">{side}</text>

        {/* Track */}
        <rect x={barX} y={barY} width={BAR_W} height={BAR_H}
          fill="#141414" rx={6} />

        {/* Fill */}
        {hasData && fill > 0 && (
          <rect
            x={barX}
            y={barY + BAR_H - fill}
            width={BAR_W}
            height={fill}
            fill={color}
            rx={6}
          />
        )}

        {/* Tick lines at 100° and 200° */}
        {[100, 200].map(t => {
          const y = barY + BAR_H - (t / MAX_TEMP) * BAR_H
          return (
            <line key={t}
              x1={barX} y1={y} x2={barX + BAR_W} y2={y}
              stroke="#1e1e1e" strokeWidth={1.5}
            />
          )
        })}

        {/* Temperature number */}
        <text
          x={cx} y={barY + BAR_H + 34}
          textAnchor="middle"
          fill={hasData ? color : '#333'}
          fontSize={28}
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          {hasData ? Math.round(clamped) : '--'}
        </text>

        {/* Unit */}
        <text x={cx} y={barY + BAR_H + 52} textAnchor="middle"
          fill="#444" fontSize={12} fontFamily="sans-serif">°C</text>
      </svg>
    </div>
  )
}

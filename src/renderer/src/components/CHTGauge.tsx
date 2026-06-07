import { useCarplayStore, useStatusStore } from '../store/store'
import { useStableValue } from '../utils/smoothing'

interface CHTGaugeProps {
  side: 'L' | 'R'
}

const MAX_TEMP = 300
const BAR_W   = 70
const VW      = 110
// Long bar that fills the tall arc, with the temp number below it. BAR_Y (space
// above) is matched to the space below the bar (number region) so the bar's
// midpoint sits at the arc's vertical center — i.e. the gauge reads centered.
const BAR_H   = 300   // was 240 — longer, extends toward the bottom (but kept
                      // within the round display's clip at the left/right edge)
const BAR_Y   = 115   // top padding == bottom (number) padding -> bar centered
const VH      = 530   // 2*BAR_Y + BAR_H; fits the number below, no circle clip

function tempColor(temp: number): string {
  if (temp < 80)  return '#4fc3f7'
  if (temp < 160) return '#66bb6a'
  if (temp < 220) return '#ffca28'
  return '#ef5350'
}

export default function CHTGauge({ side }: CHTGaugeProps) {
  const rawTemp     = useCarplayStore((s) => (side === 'L' ? s.chtLeft : s.chtRight))
  // Reject single-frame spikes: a >3°C jump only shows after it holds ~3s.
  const temp        = useStableValue(rawTemp, 3, 3000)
  const setActive = useStatusStore(s => s.setActiveGraph)
  const metricKey = side === 'L' ? 'chtLeft' : 'chtRight'
  const tap = () => {
    const cur = useStatusStore.getState().activeGraph
    setActive(cur === metricKey ? null : metricKey as 'chtLeft' | 'chtRight')
  }

  const hasData = temp !== null
  const clamped = Math.max(0, Math.min(MAX_TEMP, temp ?? 0))
  const fill    = (clamped / MAX_TEMP) * BAR_H
  const color   = hasData ? tempColor(clamped) : '#333'

  // Push bar toward CarPlay square (inner edge of arc)
  const barX   = side === 'L' ? VW - BAR_W - 6 : 6
  const textCX = barX + BAR_W / 2

  return (
    <div
      style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
      onClick={tap}
    >
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        preserveAspectRatio={side === 'L' ? 'xMaxYMid meet' : 'xMinYMid meet'}
      >
        {/* Track */}
        <rect x={barX} y={BAR_Y} width={BAR_W} height={BAR_H} fill="#141414" rx={6} />

        {/* Fill from bottom */}
        {hasData && fill > 0 && (
          <rect
            x={barX} y={BAR_Y + BAR_H - fill}
            width={BAR_W} height={fill}
            fill={color} rx={6}
          />
        )}

        {/* Tick lines at 100° and 200° */}
        {[100, 200].map(t => {
          const y = BAR_Y + BAR_H - (t / MAX_TEMP) * BAR_H
          return <line key={t} x1={barX} y1={y} x2={barX + BAR_W} y2={y} stroke="#1e1e1e" strokeWidth={1.5} />
        })}

        {/* Temperature */}
        <text
          x={textCX} y={BAR_Y + BAR_H + 34}
          textAnchor="middle"
          fill={hasData ? color : '#333'}
          fontSize={28} fontWeight="bold" fontFamily="sans-serif"
        >
          {hasData ? Math.round(clamped) : '--'}
        </text>

        {/* Unit */}
        <text x={textCX} y={BAR_Y + BAR_H + 52}
          textAnchor="middle" fill="#444" fontSize={12} fontFamily="sans-serif">
          °C
        </text>
      </svg>
    </div>
  )
}

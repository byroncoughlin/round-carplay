import { useCarplayStore } from '../store/store'

const SIZE  = 70
const CX    = SIZE / 2
const CY    = SIZE / 2
const R     = 28
const MAX_G = 1.5

function dotColor(g: number): string {
  if (g < 0.3) return '#61dafb'
  if (g < 0.7) return '#66bb6a'
  if (g < 1.1) return '#ffca28'
  return '#ef5350'
}

export default function GForcePlot() {
  const gx = useCarplayStore((s) => s.gForceX)
  const gy = useCarplayStore((s) => s.gForceY)

  const hasData = gx !== null && gy !== null
  const totalG  = hasData ? Math.sqrt(gx! ** 2 + gy! ** 2) : null

  const rawX = hasData ? (gx! / MAX_G) * R : 0
  const rawY = hasData ? -(gy! / MAX_G) * R : 0
  const mag   = Math.sqrt(rawX ** 2 + rawY ** 2)
  const scale = mag > R ? R / mag : 1
  const dotX  = CX + rawX * scale
  const dotY  = CY + rawY * scale

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: '#666', letterSpacing: 2, textTransform: 'uppercase' }}>G</span>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} style={{ display: 'block', marginTop: 2 }}>
        {/* Outer ring — brighter */}
        <circle cx={CX} cy={CY} r={R} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} />
        {/* 0.5G inner ring */}
        <circle cx={CX} cy={CY} r={R * (0.5 / MAX_G) * (MAX_G / 1)} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
        {/* Crosshairs */}
        <line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
        <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />

        {hasData ? (
          <>
            <line x1={CX} y1={CY} x2={dotX} y2={dotY} stroke={dotColor(totalG!)} strokeWidth={1.5} opacity={0.6} />
            <circle cx={dotX} cy={dotY} r={5} fill={dotColor(totalG!)} />
            <circle cx={CX} cy={CY} r={2} fill="#555" />
          </>
        ) : (
          <circle cx={CX} cy={CY} r={2} fill="#444" />
        )}
      </svg>
      <span style={{ fontSize: 13, fontWeight: 700, color: hasData ? 'white' : '#444', marginTop: 1 }}>
        {totalG !== null ? totalG.toFixed(1) : '--'}
        <span style={{ fontSize: 9, color: '#666', marginLeft: 2 }}>G</span>
      </span>
    </div>
  )
}

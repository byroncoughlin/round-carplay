import { useCarplayStore } from '../store/store'

function toCardinal(deg: number): string {
  const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return cardinals[Math.round(deg / 45) % 8]
}

function toF(c: number): number {
  return Math.round(c * 9 / 5 + 32)
}

export default function SpeedDisplay() {
  const speedKmh = useCarplayStore((s) => s.gpsSpeed)
  const heading  = useCarplayStore((s) => s.heading)
  const ambientC = useCarplayStore((s) => s.ambientTemp)

  const speed    = speedKmh !== null ? Math.round(speedKmh * 0.621371) : null
  const cardinal = heading  !== null ? toCardinal(heading) : null
  const tempF    = ambientC !== null ? toF(ambientC) : null

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>

      {/* Speed — large, at bottom of arc where circle is widest, mph inline right */}
      <div style={{
        position: 'absolute',
        bottom: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        whiteSpace: 'nowrap',
      }}>
        <span style={{
          fontSize: 72,
          fontWeight: 800,
          color: speed !== null ? 'white' : '#333',
          lineHeight: 1,
          letterSpacing: -3,
        }}>
          {speed !== null ? speed : '--'}
        </span>
        <span style={{ fontSize: 13, color: '#555', letterSpacing: 2, textTransform: 'uppercase' }}>
          mph
        </span>
      </div>

      {/* Heading — bottom-left, 20% from edge */}
      <div style={{
        position: 'absolute', bottom: 14, left: '20%',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: cardinal ? 'white' : '#333', lineHeight: 1 }}>
          {cardinal ?? '--'}
        </span>
        <span style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
          {heading !== null ? `${Math.round(heading)}°` : ''}
        </span>
      </div>

      {/* Ambient temp — bottom-right, 20% from edge */}
      <div style={{
        position: 'absolute', bottom: 14, right: '20%',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: tempF !== null ? 'white' : '#333', lineHeight: 1 }}>
          {tempF !== null ? `${tempF}°` : '--'}
        </span>
        <span style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
          {tempF !== null ? 'F' : ''}
        </span>
      </div>

    </div>
  )
}

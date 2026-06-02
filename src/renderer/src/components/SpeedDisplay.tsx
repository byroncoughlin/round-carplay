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

      {/* Speed + mph — anchored to bottom of arc, centered */}
      <div style={{
        position: 'absolute',
        bottom: 4,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0,
      }}>
        <span style={{
          fontSize: 68,
          fontWeight: 800,
          color: speed !== null ? 'white' : '#333',
          lineHeight: 1,
          letterSpacing: -2,
        }}>
          {speed !== null ? speed : '--'}
        </span>
        <span style={{
          fontSize: 11,
          color: '#555',
          letterSpacing: 3,
          textTransform: 'uppercase',
          marginTop: 2,
        }}>
          mph
        </span>
      </div>

      {/* Heading — left side, 22% from edge */}
      <div style={{
        position: 'absolute',
        bottom: 18,
        left: '22%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: cardinal ? 'white' : '#333', lineHeight: 1 }}>
          {cardinal ?? '--'}
        </span>
        <span style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
          {heading !== null ? `${Math.round(heading)}°` : ''}
        </span>
      </div>

      {/* Ambient temp — right side, 22% from edge */}
      <div style={{
        position: 'absolute',
        bottom: 18,
        right: '22%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: tempF !== null ? 'white' : '#333', lineHeight: 1 }}>
          {tempF !== null ? `${tempF}°` : '--'}
        </span>
        <span style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
          {tempF !== null ? 'F' : ''}
        </span>
      </div>

    </div>
  )
}

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
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
    }}>

      {/* Speed — large, centered */}
      <span style={{
        fontSize: 72,
        fontWeight: 800,
        color: speed !== null ? 'white' : '#333',
        lineHeight: 1,
        letterSpacing: -2,
      }}>
        {speed !== null ? speed : '--'}
      </span>

      {/* mph */}
      <span style={{
        fontSize: 11,
        color: '#555',
        letterSpacing: 3,
        textTransform: 'uppercase',
        marginTop: 3,
      }}>
        mph
      </span>

      {/* Secondary row — heading and temp, small, centered */}
      <div style={{
        display: 'flex',
        gap: 14,
        alignItems: 'center',
        marginTop: 4,
      }}>
        <span style={{ fontSize: 13, color: '#888', fontWeight: 600 }}>
          {cardinal ?? '--'}
        </span>
        <span style={{ fontSize: 11, color: '#555' }}>
          {heading !== null ? `${Math.round(heading)}°` : ''}
        </span>
        <span style={{ fontSize: 13, color: '#888', fontWeight: 600 }}>
          {tempF !== null ? `${tempF}°F` : '--'}
        </span>
      </div>

    </div>
  )
}

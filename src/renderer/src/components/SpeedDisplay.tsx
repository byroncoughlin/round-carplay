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

      {/* Speed — centered */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <span style={{ fontSize: 58, fontWeight: 700, color: speed !== null ? 'white' : '#333', lineHeight: 1, letterSpacing: -2 }}>
          {speed !== null ? speed : '--'}
        </span>
        <span style={{ fontSize: 11, color: '#555', letterSpacing: 3, textTransform: 'uppercase', marginTop: 2 }}>mph</span>
      </div>

      {/* Heading — pinned to bottom of strip, 20% from left (safe inside circle) */}
      <div style={{
        position: 'absolute', bottom: 6, left: '20%',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: cardinal ? 'white' : '#333', lineHeight: 1 }}>
          {cardinal ?? '--'}
        </span>
        <span style={{ fontSize: 10, color: '#666', marginTop: 1 }}>
          {heading !== null ? `${Math.round(heading)}°` : ''}
        </span>
      </div>

      {/* Ambient temp — pinned to bottom of strip, 20% from right */}
      <div style={{
        position: 'absolute', bottom: 6, right: '20%',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: tempF !== null ? 'white' : '#333', lineHeight: 1 }}>
          {tempF !== null ? `${tempF}°` : '--'}
        </span>
        <span style={{ fontSize: 10, color: '#666', marginTop: 1 }}>
          {tempF !== null ? 'F' : ''}
        </span>
      </div>

    </div>
  )
}

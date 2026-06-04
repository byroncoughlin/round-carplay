import { useCarplayStore, useStatusStore } from '../store/store'

function toCardinal(deg: number): string {
  const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return cardinals[Math.round(deg / 45) % 8]
}

function toF(c: number): number {
  return Math.round(c * 9 / 5 + 32)
}

export default function SpeedDisplay() {
  const speedKmh    = useCarplayStore((s) => s.gpsSpeed)
  const heading     = useCarplayStore((s) => s.heading)
  const ambientC    = useCarplayStore((s) => s.ambientTemp)
  const setActive = useStatusStore((s) => s.setActiveGraph)
  const tap = (key: 'speed' | 'heading' | 'ambientTemp') =>
    setActive(useStatusStore.getState().activeGraph === key ? null : key)

  const speed    = speedKmh !== null ? Math.round(speedKmh * 0.621371) : null
  const cardinal = heading  !== null ? toCardinal(heading) : null
  const tempF    = ambientC !== null ? toF(ambientC) : null

  // Each band tiles the full arc height (top:0 bottom:0) so the entire
  // 117 px strip is tappable — no tiny text-only hit boxes.
  const bandBase = {
    position: 'absolute' as const,
    top: 0, bottom: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'flex-end' as const,
    cursor: 'pointer' as const,
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>

      {/* ── HEADING band — full left third ── */}
      <div
        style={{ ...bandBase, left: 0, width: '30%', paddingBottom: 1 }}
        onClick={() => tap('heading')}
      >
        <span style={{ fontSize: 32, fontWeight: 700, color: cardinal ? 'white' : '#333', lineHeight: 1 }}>
          {cardinal ?? '--'}
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#888', marginTop: 2 }}>
          {heading !== null ? `${Math.round(heading)}°` : ''}
        </span>
      </div>

      {/* ── SPEED band — full center ── */}
      <div
        style={{ ...bandBase, left: '30%', right: '30%' }}
        onClick={() => tap('speed')}
      >
        <span style={{
          fontSize: 90, fontWeight: 800,
          color: speed !== null ? 'white' : '#333',
          lineHeight: 1, letterSpacing: -2, marginBottom: -9,
        }}>
          {speed !== null ? speed : '--'}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#888', letterSpacing: 3, textTransform: 'uppercase' }}>
          mph
        </span>
      </div>

      {/* ── AMBIENT TEMP band — full right third ── */}
      <div
        style={{ ...bandBase, right: 0, width: '30%', paddingBottom: 1 }}
        onClick={() => tap('ambientTemp')}
      >
        <span style={{ fontSize: 32, fontWeight: 700, color: tempF !== null ? 'white' : '#333', lineHeight: 1 }}>
          {tempF !== null ? `${tempF}°` : '--'}
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#888', marginTop: 2 }}>
          {tempF !== null ? 'F' : ''}
        </span>
      </div>

    </div>
  )
}

import { useCarplayStore, useStatusStore } from '../store/store'
import { useSpeedStabilizer, useStableValue } from '../utils/smoothing'

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
  const gpsFix      = useCarplayStore((s) => s.gpsFix)
  const gpsSats     = useCarplayStore((s) => s.gpsSats)
  const setActive = useStatusStore((s) => s.setActiveGraph)
  const tap = (key: 'speed' | 'heading' | 'ambientTemp') =>
    setActive(useStatusStore.getState().activeGraph === key ? null : key)

  // Without a satellite fix the speed/heading are stale/meaningless, so blank
  // them and show the acquiring indicator instead.
  // Speed is stabilized: stationary GPS noise reads 0, and a sustained climb is
  // required to leave 0 (see useSpeedStabilizer).
  const rawMph   = gpsFix && speedKmh !== null ? speedKmh * 0.621371 : null
  const speed    = useSpeedStabilizer(rawMph)
  const cardinal = gpsFix && heading !== null ? toCardinal(heading) : null
  // Ambient is smoothed like the CHTs (reject >3°F single-reading jumps).
  const tempF    = useStableValue(ambientC !== null ? toF(ambientC) : null, 3, 3000)

  // GPS status chip: hidden once we have a fix; otherwise "NO GPS" (no data yet)
  // or "ACQUIRING · n SAT" while the receiver searches for satellites.
  const gpsDotColor = gpsFix == null ? '#777' : '#ffb300'
  const gpsLabel    = gpsFix == null ? 'NO GPS' : `ACQUIRING${gpsSats > 0 ? ` · ${gpsSats} SAT` : ''}`

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

      {/* ── GPS status chip — top-centre, only while there's no fix ── */}
      {!gpsFix && (
        <div style={{
          position: 'absolute', top: 5, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 5,
          whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 2,
        }}>
          <span
            className={gpsFix === false ? 'animate-pulse' : undefined}
            style={{ width: 7, height: 7, borderRadius: '50%', background: gpsDotColor, boxShadow: `0 0 6px ${gpsDotColor}88` }}
          />
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: '#bbb', fontFamily: 'monospace' }}>
            {gpsLabel}
          </span>
        </div>
      )}

      {/* ── HEADING band — left third, nudged 10px toward center ── */}
      <div
        style={{ ...bandBase, left: 10, width: '30%', paddingBottom: 1 }}
        onClick={() => tap('heading')}
      >
        <span style={{ fontSize: 32, fontWeight: 700, color: 'white', lineHeight: 1 }}>
          {cardinal ?? '--'}
        </span>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'white', marginTop: 2 }}>
          {cardinal !== null ? `${Math.round(heading!)}°` : ''}
        </span>
      </div>

      {/* ── SPEED band — full center ── */}
      <div
        style={{ ...bandBase, left: '30%', right: '30%' }}
        onClick={() => tap('speed')}
      >
        <span style={{
          fontSize: 90, fontWeight: 800,
          color: 'white',
          lineHeight: 1, letterSpacing: -2, marginBottom: -9,
        }}>
          {speed !== null ? speed : '--'}
        </span>
        <span style={{ fontSize: 13, fontWeight: 800, color: 'white', letterSpacing: 3, textTransform: 'uppercase' }}>
          mph
        </span>
      </div>

      {/* ── AMBIENT TEMP band — right third, nudged 10px toward center ── */}
      <div
        style={{ ...bandBase, right: 10, width: '30%', paddingBottom: 1 }}
        onClick={() => tap('ambientTemp')}
      >
        <span style={{ fontSize: 32, fontWeight: 700, color: 'white', lineHeight: 1 }}>
          {tempF !== null ? `${tempF}°` : '--'}
        </span>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'white', marginTop: 2 }}>
          {tempF !== null ? 'F' : ''}
        </span>
      </div>

    </div>
  )
}

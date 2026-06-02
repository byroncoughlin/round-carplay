import { useCarplayStore } from '../store/store'

export default function AltitudeDisplay() {
  const altM = useCarplayStore((s) => s.altitude)
  const altFt = altM !== null ? Math.round(altM * 3.28084) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: '#555', letterSpacing: 2, textTransform: 'uppercase' }}>ALT</span>
      <span style={{ fontSize: 18, fontWeight: 700, color: altFt !== null ? 'white' : '#333', lineHeight: 1.1, marginTop: 2 }}>
        {altFt !== null ? altFt.toLocaleString() : '--'}
      </span>
      <span style={{ fontSize: 10, color: '#555', marginTop: 1 }}>ft</span>
    </div>
  )
}

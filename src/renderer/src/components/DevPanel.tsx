import { useState } from 'react'
import { useCarplayStore, useStatusStore } from '../store/store'

const STATES = [
  {
    label: 'No Data',
    gpsSpeed: null, heading: null, altitude: null,
    leanAngle: null, pitchAngle: null, gForceX: null, gForceY: null,
    chtLeft: null, chtRight: null, ambientTemp: null,
  },
  {
    label: 'Cold Start',
    gpsSpeed: 0, heading: 347, altitude: 312,
    leanAngle: 0, pitchAngle: 0, gForceX: 0, gForceY: 0,
    chtLeft: 45, chtRight: 42, ambientTemp: 10,
  },
  {
    label: 'Normal Ride',
    gpsSpeed: 89, heading: 214, altitude: 428,
    leanAngle: 8, pitchAngle: -3, gForceX: 0.1, gForceY: 0.05,
    chtLeft: 155, chtRight: 160, ambientTemp: 22,
  },
  {
    label: 'Hard Right',
    gpsSpeed: 72, heading: 88, altitude: 415,
    leanAngle: 34, pitchAngle: -2, gForceX: 0.85, gForceY: -0.1,
    chtLeft: 188, chtRight: 192, ambientTemp: 22,
  },
  {
    label: 'Hard Left',
    gpsSpeed: 65, heading: 92, altitude: 415,
    leanAngle: -28, pitchAngle: -2, gForceX: -0.72, gForceY: -0.08,
    chtLeft: 175, chtRight: 178, ambientTemp: 22,
  },
  {
    label: 'Braking',
    gpsSpeed: 105, heading: 180, altitude: 390,
    leanAngle: 2, pitchAngle: -8, gForceX: 0.05, gForceY: -1.1,
    chtLeft: 195, chtRight: 198, ambientTemp: 24,
  },
  {
    label: 'Uphill',
    gpsSpeed: 40, heading: 22, altitude: 310,
    leanAngle: 0, pitchAngle: 18, gForceX: 0, gForceY: 0.3,
    chtLeft: 162, chtRight: 165, ambientTemp: 20,
  },
  {
    label: 'Hot Engine',
    gpsSpeed: 48, heading: 22, altitude: 280,
    leanAngle: 3, pitchAngle: -1, gForceX: 0.02, gForceY: 0.04,
    chtLeft: 238, chtRight: 251, ambientTemp: 38,
  },
]

export default function DevPanel() {
  const [index, setIndex] = useState(0)
  const visible = useStatusStore(s => s.showDiagnostics)

  const apply = (i: number) => {
    const s = STATES[i]
    useCarplayStore.setState({
      gpsSpeed: s.gpsSpeed,
      heading: s.heading,
      altitude: s.altitude,
      leanAngle: s.leanAngle,
      pitchAngle: s.pitchAngle,
      gForceX: s.gForceX,
      gForceY: s.gForceY,
      chtLeft: s.chtLeft,
      chtRight: s.chtRight,
      ambientTemp: s.ambientTemp,
    })
  }

  const prev = () => {
    const i = (index - 1 + STATES.length) % STATES.length
    setIndex(i)
    apply(i)
  }

  const next = () => {
    const i = (index + 1) % STATES.length
    setIndex(i)
    apply(i)
  }

  if (!visible) return null

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: 'rgba(0,0,0,0.82)',
        border: '1px solid #444',
        borderRadius: 28,
        padding: '8px 18px',
        zIndex: 200,
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <button onClick={prev} style={btnStyle}>◀</button>
      <span style={{ color: '#ccc', fontSize: 16, minWidth: 110, textAlign: 'center', fontWeight: 600 }}>
        {STATES[index].label}
      </span>
      <button onClick={next} style={btnStyle}>▶</button>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#aaa',
  fontSize: 22,
  cursor: 'pointer',
  padding: '4px 8px',
  lineHeight: 1,
}

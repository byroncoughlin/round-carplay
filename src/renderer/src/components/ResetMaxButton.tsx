import { useState } from 'react'

// Touch-friendly "RESET MAX" control with a confirm step, used by the live
// panels (RideDynamics, CylinderHeads) to clear session peak-hold values.
// Confirm/Cancel stack vertically so it fits narrow columns on the round screen.
export default function ResetMaxButton({ onReset, width = 120 }: {
  onReset: () => void
  width?: number
}) {
  const [confirm, setConfirm] = useState(false)

  const base = {
    cursor: 'pointer', fontFamily: 'monospace', fontWeight: 800 as const,
    letterSpacing: 1, borderRadius: 10, textAlign: 'center' as const,
    userSelect: 'none' as const, display: 'flex',
    alignItems: 'center', justifyContent: 'center', width,
  }

  if (!confirm) {
    return (
      <div onClick={() => setConfirm(true)} style={{
        ...base, minHeight: 46, padding: '11px 14px', fontSize: 15,
        color: '#ff9a9a', background: 'rgba(255,107,107,0.12)',
        border: '2px solid #ff6b6b66',
      }}>RESET MAX</div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width }}>
      <div onClick={() => { onReset(); setConfirm(false) }} style={{
        ...base, minHeight: 44, padding: '10px 12px', fontSize: 14,
        color: '#fff', background: '#7a1414', border: '2px solid #ff6b6b',
      }}>CONFIRM</div>
      <div onClick={() => setConfirm(false)} style={{
        ...base, minHeight: 40, padding: '9px 12px', fontSize: 14,
        color: '#ccc', background: '#242424', border: '2px solid #555',
      }}>CANCEL</div>
    </div>
  )
}

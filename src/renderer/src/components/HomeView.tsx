import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStatusStore } from '../store/store'

const GREEN = '#4caf50'
const AMBER = '#ffb300'
const GREY  = '#555'

/**
 * Idle "home" view shown on the root route when CarPlay isn't streaming:
 * a clock + connection-status chain + a button to enter the CarPlay view.
 * Crossfades/zooms to the CarPlay view (and back) — automatically when the
 * phone connects/disconnects, or manually via the buttons.
 */
export default function HomeView() {
  const { pathname }      = useLocation()
  const navigate          = useNavigate()
  const homeMode          = useStatusStore(s => s.homeMode)
  const setHomeMode       = useStatusStore(s => s.setHomeMode)
  const isDongleConnected = useStatusStore(s => s.isDongleConnected)
  const isStreaming       = useStatusStore(s => s.isStreaming)
  const activeGraph       = useStatusStore(s => s.activeGraph)

  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // Auto-switch views: while streaming, always show CarPlay; when a stream
  // ends, drop back to the home/clock view. (Covers app-start-while-streaming.)
  const prevStreaming = useRef(isStreaming)
  useEffect(() => {
    if (isStreaming) setHomeMode(false)
    else if (prevStreaming.current) setHomeMode(true)
    prevStreaming.current = isStreaming
  }, [isStreaming, setHomeMode])

  const onRoot   = pathname === '/'
  // Hide the idle overlay while a metric graph is open so the graph shows.
  const showIdle = onRoot && homeMode && !activeGraph

  // Clock
  let h = now.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  const mm = String(now.getMinutes()).padStart(2, '0')
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })

  // Connection chain status
  const adapterColor = isDongleConnected ? GREEN : AMBER
  const phoneColor   = isStreaming ? GREEN : isDongleConnected ? AMBER : GREY
  const linkColor    = isStreaming ? GREEN : '#3a3a3a'
  const phoneSub     = isStreaming ? 'connected' : isDongleConnected ? 'searching…' : 'no adapter'
  const adapterSub   = isDongleConnected ? 'connected' : 'searching…'

  const Node = (label: string, sub: string, color: string, pulse: boolean) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 86 }}>
      <div
        className={pulse ? 'animate-pulse' : undefined}
        style={{ width: 13, height: 13, borderRadius: '50%', background: color, boxShadow: `0 0 10px ${color}88` }}
      />
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2, color: '#cfcfcf', fontFamily: 'monospace' }}>{label}</span>
      <span style={{ fontSize: 9, letterSpacing: 1, color: '#777', fontFamily: 'monospace' }}>{sub}</span>
    </div>
  )

  return (
    <>
      {/* ── IDLE OVERLAY ── */}
      <div
        onClick={() => navigate('/settings')}
        style={{
          // Definite height (the 565/800 center square) so flex centering has
          // real space — the parent %-height chain doesn't resolve reliably here.
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: 'calc(min(100vw, 100vh) * 0.70625)',
          zIndex: 1300, background: '#000', cursor: 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          paddingBottom: 64,   // nudge the content a touch above true center
          opacity: showIdle ? 1 : 0,
          transform: showIdle ? 'scale(1)' : 'scale(0.82)',
          transformOrigin: 'center center',
          transition: 'opacity 380ms ease, transform 460ms cubic-bezier(0.22,1,0.36,1)',
          pointerEvents: showIdle ? 'auto' : 'none',
        }}
      >
        {/* connection chain */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 26 }}>
          {Node('ADAPTER', adapterSub, adapterColor, !isDongleConnected)}
          <div style={{ width: 56, height: 2, background: linkColor, borderRadius: 2, marginTop: 5,
            transition: 'background 400ms ease' }} />
          {Node('iPHONE', phoneSub, phoneColor, isDongleConnected && !isStreaming)}
        </div>

        {/* clock + date (whole idle view is the settings tap target) */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', lineHeight: 1 }}>
            <span style={{ fontSize: 146, fontWeight: 300, color: 'white', letterSpacing: -3, fontFamily: "'Roboto','Helvetica Neue',sans-serif" }}>
              {h}:{mm}
            </span>
            <span style={{ fontSize: 34, fontWeight: 500, color: '#888', marginLeft: 12, letterSpacing: 1 }}>{ampm}</span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 500, color: '#888', marginTop: 4, letterSpacing: 0.5 }}>{dateStr}</div>
        </div>
      </div>

      {/* ── RETURN-TO-CLOCK button (over the CarPlay 'searching' screen) ── */}
      {onRoot && !homeMode && !isStreaming && (
        <button
          onClick={() => setHomeMode(true)}
          style={{
            position: 'absolute', bottom: 26, left: '50%', transform: 'translateX(-50%)', zIndex: 1305,
            height: 44, padding: '0 22px', borderRadius: 22,
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)',
            color: '#bbb', fontSize: 13, fontWeight: 800, letterSpacing: 2, fontFamily: 'monospace',
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8,
          }}
          aria-label="home"
        >
          ⌂ HOME
        </button>
      )}
    </>
  )
}

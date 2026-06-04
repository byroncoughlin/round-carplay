import { useRef, useEffect } from 'react'
import { useCarplayStore, useStatusStore } from '../store/store'

const W           = 565
const H           = 117
const CX          = W / 2
const PITCH_SCALE = 2.5      // px per degree of pitch
const REF_Y       = H / 2   // fixed aircraft reference at vertical center

const SKY    = '#000000'
const GROUND = '#5c3412'
const REF    = '#ffd700'     // classic aviation gold



export default function LeanAngle() {
  const lean      = useCarplayStore(s => s.leanAngle)
  const pitch     = useCarplayStore(s => s.pitchAngle)
  const altM      = useCarplayStore(s => s.altitude)
  const gx        = useCarplayStore(s => s.gForceX)
  const gy        = useCarplayStore(s => s.gForceY)
  const activeGraph = useStatusStore(s => s.activeGraph)
  const setActive   = useStatusStore(s => s.setActiveGraph)
  const tap = (key: 'altitude' | 'leanAngle' | 'gForce' | 'pitchAngle') =>
    setActive(activeGraph === key ? null : key)

  const leanVal  = lean  ?? 0
  const pitchVal = pitch ?? 0
  const hasData  = lean !== null

  const absLean  = Math.abs(Math.round(leanVal))
  const side     = leanVal > 0.5 ? 'R' : leanVal < -0.5 ? 'L' : ''
  const absPitch = Math.abs(Math.round(pitchVal))
  const pitchDir = pitchVal > 0.5 ? '▲' : pitchVal < -0.5 ? '▼' : ''

  const altFt    = altM !== null ? Math.round(altM * 3.28084).toLocaleString() : '--'
  const totalG   = gx !== null && gy !== null ? Math.sqrt(gx ** 2 + gy ** 2) : null
  const hasG     = gx !== null
  const maxGRef  = useRef(0)
  useEffect(() => {
    if (totalG !== null && totalG > maxGRef.current) maxGRef.current = totalG
  }, [totalG])
  const gVal   = totalG ?? 0
  const gColor = !hasG ? '#444' : gVal < 0.5 ? '#66bb6a' : gVal < 1.0 ? '#ffca28' : '#ef5350'

  // Horizon position: drops when nose up (pitch > 0)
  const horizonY = REF_Y + pitchVal * PITCH_SCALE

  // Rotation around the (possibly pitch-shifted) horizon center
  const rot = `rotate(${leanVal}, ${CX}, ${horizonY})`

  // Pitch ladder lines (in rotating frame, relative to horizonY)
  const pitchLines = [-15, -10, -5, 5, 10, 15].map(p => ({
    y:     horizonY - p * PITCH_SCALE,
    len:   Math.abs(p) % 10 === 0 ? 120 : 70,
    label: Math.abs(p) % 10 === 0 ? Math.abs(p) : null,
  }))

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <clipPath id="ai-clip">
            <rect x={0} y={0} width={W} height={H} />
          </clipPath>
        </defs>

        {/* ── ROTATING BACKGROUND ── */}
        <g clipPath="url(#ai-clip)">
          <g transform={rot}>
            {/* Sky */}
            <rect x={-W} y={-3 * H} width={3 * W} height={3 * H + horizonY} fill={SKY} />
            {/* Ground */}
            <rect x={-W} y={horizonY} width={3 * W} height={3 * H} fill={GROUND} />
            {/* Horizon line */}
            <line x1={-W} y1={horizonY} x2={3 * W} y2={horizonY}
              stroke="white" strokeWidth={2} opacity={0.85} />
            {/* Pitch ladder */}
            {pitchLines.map(({ y, len, label }) => (
              <g key={y}>
                <line x1={CX - len / 2} y1={y} x2={CX + len / 2} y2={y}
                  stroke="white" strokeWidth={1} opacity={0.5} />
                {label && (
                  <>
                    <text x={CX - len / 2 - 5} y={y + 3.5}
                      textAnchor="end" fill="white" fontSize={8}
                      fontFamily="sans-serif" opacity={0.55}>{label}</text>
                    <text x={CX + len / 2 + 5} y={y + 3.5}
                      textAnchor="start" fill="white" fontSize={8}
                      fontFamily="sans-serif" opacity={0.55}>{label}</text>
                  </>
                )}
              </g>
            ))}
          </g>
        </g>

        {/* ── FIXED AIRCRAFT REFERENCE ── */}
        {/* Left wing */}
        <line x1={CX - 72} y1={REF_Y} x2={CX - 12} y2={REF_Y}
          stroke={REF} strokeWidth={3.5} strokeLinecap="round" />
        <line x1={CX - 72} y1={REF_Y} x2={CX - 72} y2={REF_Y + 9}
          stroke={REF} strokeWidth={3.5} strokeLinecap="round" />
        {/* Right wing */}
        <line x1={CX + 12} y1={REF_Y} x2={CX + 72} y2={REF_Y}
          stroke={REF} strokeWidth={3.5} strokeLinecap="round" />
        <line x1={CX + 72} y1={REF_Y} x2={CX + 72} y2={REF_Y + 9}
          stroke={REF} strokeWidth={3.5} strokeLinecap="round" />
        {/* Center pitch badge — replaces circle, sits on gold line */}
        <g style={{ cursor: 'pointer' }} onClick={() => tap('pitchAngle')}>
          <rect x={CX - 30} y={REF_Y - 13} width={60} height={26}
            fill="rgba(0,0,0,0.88)" rx={8} />
          <text x={CX} y={REF_Y + 7} textAnchor="middle"
            fill={pitch !== null ? REF : '#444'} fontSize={20}
            fontWeight="bold" fontFamily="monospace">
            {pitch !== null ? (absPitch === 0 ? '—' : `${pitchDir}${absPitch}°`) : '--'}
          </text>
        </g>

        {/* Roll arc and ticks removed */}

        {/* ── TEXT READOUTS (lower ground area) ── */}
        {/* Subtle dark backing for legibility */}
        <rect x={0} y={66} width={W} height={H - 66} fill="rgba(0,0,0,0.25)" />

        {/* ALT — simplified: label + big number + unit */}
        <g style={{ cursor: 'pointer' }} onClick={() => tap('altitude')}>
          <rect x={84} y={6} width={78} height={58} fill="rgba(0,0,0,0.72)" rx={5} />
          <text x={123} y={22} textAnchor="middle"
            fill="rgba(255,255,255,0.75)" fontSize={12}
            fontWeight="bold" fontFamily="monospace" letterSpacing={2}>ALT</text>
          <text x={123} y={48} textAnchor="middle"
            fill={altM !== null ? '#e0e0e0' : '#444'} fontSize={24}
            fontWeight="bold" fontFamily="monospace">{altFt}</text>
          <text x={123} y={59} textAnchor="middle"
            fill="rgba(255,255,255,0.7)" fontSize={11}
            fontWeight="bold" fontFamily="sans-serif">ft</text>
        </g>

        {/* Lean center — arch shape: rounded top, bottom clipped flat by SVG viewport */}
        <g style={{ cursor: 'pointer' }} onClick={() => tap('leanAngle')}>
          <rect x={CX - 40} y={88} width={80} height={40}
            fill="rgba(0,0,0,0.88)"
            stroke="rgba(255,255,255,0.07)" strokeWidth={0.75}
            rx={14} />
          <text x={282.5} y={112} textAnchor="middle"
            fill={hasData ? 'white' : '#444'} fontSize={24}
            fontWeight="bold" fontFamily="sans-serif">
            {hasData ? (absLean > 0 ? `${absLean}° ${side}` : '0°') : '--'}
          </text>
        </g>

        {/* G-METER — side-by-side: G large left, MAX smaller top-right */}
        <g style={{ cursor: 'pointer' }} onClick={() => tap('gForce')}>
          {/* "G" label + box */}
          <text x={445} y={11} textAnchor="middle"
            fill="rgba(255,255,255,0.75)" fontSize={12}
            fontWeight="bold" fontFamily="monospace" letterSpacing={2}>G</text>
          <rect x={415} y={14} width={60} height={34} fill="rgba(0,0,0,0.72)" rx={5} />
          <text x={445} y={40} textAnchor="middle"
            fill={hasG ? gColor : '#444'} fontSize={30}
            fontWeight="bold" fontFamily="monospace">
            {hasG ? gVal.toFixed(1) : '--'}
          </text>
          {/* MAX — right of G, smaller, sits higher */}
          {hasG && maxGRef.current > 0.05 && (
            <g>
              <text x={502} y={11} textAnchor="middle"
                fill="rgba(255,170,0,0.85)" fontSize={11}
                fontWeight="bold" fontFamily="monospace" letterSpacing={1}>MAX</text>
              <rect x={478} y={14} width={48} height={23} fill="rgba(0,0,0,0.65)" rx={5} />
              <text x={502} y={30} textAnchor="middle"
                fill="rgba(255,170,0,0.92)" fontSize={18}
                fontWeight="bold" fontFamily="monospace">
                {maxGRef.current.toFixed(1)}
              </text>
            </g>
          )}
        </g>

      </svg>
    </div>
  )
}

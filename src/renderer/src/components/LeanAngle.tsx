import { useRef, useEffect } from 'react'
import { useCarplayStore } from '../store/store'

const W           = 565
const H           = 117
const CX          = W / 2
const PITCH_SCALE = 2.5      // px per degree of pitch
const ROLL_R      = 50       // radius of roll arc from top-center
const REF_Y       = H / 2   // fixed aircraft reference at vertical center

const SKY    = '#000000'
const GROUND = '#5c3412'
const REF    = '#ffd700'     // classic aviation gold

function d2r(deg: number) { return (deg * Math.PI) / 180 }

// Arc path centered on (CX, 0) — the top center
function rollArcPath(r: number, fromDeg: number, toDeg: number) {
  const pts: string[] = []
  for (let a = fromDeg; a <= toDeg; a += 2) {
    const x = CX + r * Math.sin(d2r(a))
    const y = r * (1 - Math.cos(d2r(a)))
    pts.push(`${a === fromDeg ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
  }
  return pts.join(' ')
}

const ROLL_TICKS = [10, 20, 30, 45]

export default function LeanAngle() {
  const lean  = useCarplayStore(s => s.leanAngle)
  const pitch = useCarplayStore(s => s.pitchAngle)
  const altM  = useCarplayStore(s => s.altitude)
  const gx    = useCarplayStore(s => s.gForceX)
  const gy    = useCarplayStore(s => s.gForceY)

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
    len:   Math.abs(p) % 10 === 0 ? 90 : 55,
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
        <line x1={CX - 55} y1={REF_Y} x2={CX - 12} y2={REF_Y}
          stroke={REF} strokeWidth={3} strokeLinecap="round" />
        <line x1={CX - 55} y1={REF_Y} x2={CX - 55} y2={REF_Y + 7}
          stroke={REF} strokeWidth={3} strokeLinecap="round" />
        {/* Right wing */}
        <line x1={CX + 12} y1={REF_Y} x2={CX + 55} y2={REF_Y}
          stroke={REF} strokeWidth={3} strokeLinecap="round" />
        <line x1={CX + 55} y1={REF_Y} x2={CX + 55} y2={REF_Y + 7}
          stroke={REF} strokeWidth={3} strokeLinecap="round" />
        {/* Center circle + dot */}
        <circle cx={CX} cy={REF_Y} r={5} fill="none" stroke={REF} strokeWidth={2.5} />
        <circle cx={CX} cy={REF_Y} r={2} fill={REF} />

        {/* ── ROLL ARC (fixed) ── */}
        <path d={rollArcPath(ROLL_R, -50, 50)}
          fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth={1} />

        {/* Roll tick marks */}
        {ROLL_TICKS.flatMap(a => [-a, a]).map(a => {
          const major = Math.abs(a) >= 30
          const outerR = ROLL_R
          const innerR = ROLL_R - (major ? 10 : 6)
          const ox = CX + outerR * Math.sin(d2r(a))
          const oy = outerR * (1 - Math.cos(d2r(a)))
          const ix = CX + innerR * Math.sin(d2r(a))
          const iy = innerR * (1 - Math.cos(d2r(a)))
          return (
            <line key={a} x1={ox} y1={oy} x2={ix} y2={iy}
              stroke="rgba(255,255,255,0.5)"
              strokeWidth={major ? 1.5 : 1} />
          )
        })}

        {/* ── ROLL POINTER (rotates around top-center with lean) ── */}
        <g transform={`rotate(${leanVal}, ${CX}, 0)`}>
          <polygon
            points={`${CX},${ROLL_R + 7} ${CX - 7},${ROLL_R - 7} ${CX + 7},${ROLL_R - 7}`}
            fill={hasData ? 'white' : 'rgba(255,255,255,0.25)'}
          />
        </g>

        {/* ── TEXT READOUTS (lower ground area) ── */}
        {/* Subtle dark backing for legibility */}
        <rect x={0} y={66} width={W} height={H - 66} fill="rgba(0,0,0,0.25)" />

        {/* ALT — aviation EFIS-style box, anchored to number at x=138 y=35 */}
        {(() => {
          // Main number anchor: x=138 (right edge), y=35 (baseline), fontSize=20
          const numX  = 138
          const numY  = 35
          const bx    = 55    // box left edge
          const by    = 10    // box top
          const bw    = 87    // box width  (right edge at 142)
          const bh    = 32    // box height (bottom at 42)
          const altFtNum = altM !== null ? Math.round(altM * 3.28084) : null
          const prev = altFtNum !== null ? (altFtNum - 100).toLocaleString() : null
          const next = altFtNum !== null ? (altFtNum + 100).toLocaleString() : null
          return (
            <g>
              {/* Box fill */}
              <rect x={bx} y={by} width={bw} height={bh}
                fill="rgba(0,0,0,0.55)" rx={2} />
              {/* Subtle left tape-strip line */}
              <line x1={bx + 9} y1={by + 3} x2={bx + 9} y2={by + bh - 3}
                stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
              {/* Box border */}
              <rect x={bx} y={by} width={bw} height={bh}
                fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={0.75} rx={2} />
              {/* ALT label — top left */}
              <text x={bx + 13} y={by + 9}
                fill="rgba(255,255,255,0.35)" fontSize={7}
                fontFamily="monospace" letterSpacing={1}>ALT</text>
              {/* ft unit — top right */}
              <text x={bx + bw - 4} y={by + 9} textAnchor="end"
                fill="rgba(255,255,255,0.22)" fontSize={7}
                fontFamily="sans-serif">ft</text>
              {/* Ghost — previous 100ft */}
              {prev && (
                <text x={numX} y={numY - 13} textAnchor="end"
                  fill="rgba(255,255,255,0.14)" fontSize={8}
                  fontFamily="monospace">{prev}</text>
              )}
              {/* Current altitude — main readout at exact anchor */}
              <text x={numX} y={numY} textAnchor="end"
                fill={altM !== null ? '#e0e0e0' : '#444'} fontSize={16}
                fontWeight="bold" fontFamily="monospace">{altFt}</text>
              {/* Ghost — next 100ft */}
              {next && (
                <text x={numX} y={numY + 10} textAnchor="end"
                  fill="rgba(255,255,255,0.1)" fontSize={8}
                  fontFamily="monospace">{next}</text>
              )}
            </g>
          )
        })()}

        {/* Lean + pitch center */}
        <text x={CX} y={78} textAnchor="middle"
          fill={hasData ? 'white' : '#444'} fontSize={18}
          fontWeight="bold" fontFamily="sans-serif">
          {hasData ? (absLean > 0 ? `${absLean}° ${side}` : '0°') : '--'}
        </text>
        {pitch !== null && absPitch > 0 && (
          <text x={CX} y={95} textAnchor="middle"
            fill="rgba(255,200,80,0.85)" fontSize={11} fontFamily="sans-serif">
            {pitchDir}{absPitch}°
          </text>
        )}

        {/* G-METER — aviation arc gauge with max-G marker */}
        {(() => {
          const cx      = 460
          const cy      = 22
          const r       = 19
          const maxScale = 2.0

          const gPt = (gv: number, radius: number) => {
            const θ = Math.PI - (Math.min(gv, maxScale) / maxScale) * Math.PI
            return { x: cx + radius * Math.cos(θ), y: cy - radius * Math.sin(θ) }
          }

          const arcSeg = (g0: number, g1: number, color: string, w: number) => {
            const p0 = gPt(g0, r)
            const p1 = gPt(g1, r)
            return <path key={`${g0}`}
              d={`M${p0.x.toFixed(1)},${p0.y.toFixed(1)} A${r},${r} 0 0,0 ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`}
              fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
          }

          const needle   = gPt(gVal, r - 3)
          const maxNeedle = gPt(maxGRef.current, r - 1)

          return (
            <g>
              {/* Coloured zone arcs */}
              {arcSeg(0, 0.5, 'rgba(102,187,106,0.4)', 5)}
              {arcSeg(0.5, 1.0, 'rgba(255,202,40,0.4)', 5)}
              {arcSeg(1.0, 2.0, 'rgba(239,83,80,0.4)', 5)}
              {/* Thin white arc outline */}
              <path d={`M${cx - r},${cy} A${r},${r} 0 0,0 ${cx + r},${cy}`}
                fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
              {/* Max G amber marker */}
              {hasG && maxGRef.current > 0.05 && (
                <line x1={cx} y1={cy} x2={maxNeedle.x} y2={maxNeedle.y}
                  stroke="rgba(255,170,0,0.75)" strokeWidth={1.5} strokeLinecap="round" />
              )}
              {/* Current G needle */}
              {hasG && (
                <line x1={cx} y1={cy} x2={needle.x} y2={needle.y}
                  stroke={gColor} strokeWidth={2.5} strokeLinecap="round" />
              )}
              {/* Pivot dot */}
              <circle cx={cx} cy={cy} r={2.5} fill="rgba(255,255,255,0.55)" />
              {/* Scale labels */}
              <text x={cx - r - 3} y={cy + 5} textAnchor="end"
                fill="rgba(255,255,255,0.28)" fontSize={7} fontFamily="monospace">0</text>
              <text x={cx} y={cy - r - 3} textAnchor="middle"
                fill="rgba(255,255,255,0.25)" fontSize={7} fontFamily="monospace">1</text>
              <text x={cx + r + 3} y={cy + 5} textAnchor="start"
                fill="rgba(255,255,255,0.28)" fontSize={7} fontFamily="monospace">2</text>
              {/* Current G value */}
              <text x={460} y={40} textAnchor="middle"
                fill={hasG ? gColor : '#444'} fontSize={18}
                fontWeight="bold" fontFamily="monospace">
                {hasG ? gVal.toFixed(1) : '--'}
              </text>
              {/* Max G small label */}
              {hasG && maxGRef.current > 0.05 && (
                <text x={460} y={52} textAnchor="middle"
                  fill="rgba(255,170,0,0.55)" fontSize={7} fontFamily="monospace">
                  max {maxGRef.current.toFixed(1)}
                </text>
              )}
            </g>
          )
        })()}

      </svg>
    </div>
  )
}

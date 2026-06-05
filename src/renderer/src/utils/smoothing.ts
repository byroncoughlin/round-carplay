import { useEffect, useRef, useState } from 'react'

/**
 * Display smoothing for noisy sensor readings (thermocouples, etc.).
 *
 * Small changes (|Δ| ≤ `step`) pass through immediately so the number stays
 * responsive. A larger jump is treated as suspect and only committed once the
 * reading has held near the new level for `holdMs` — so a single spurious frame
 * (e.g. a bad MAX31855 read) is ignored, but a real, sustained change still
 * comes through. `null` (sensor offline) clears immediately.
 *
 * Driven by an internal tick rather than the raw-value change so a sustained
 * spike commits even when the sensor repeats the exact same number.
 */
export function useStableValue(
  raw: number | null,
  step: number,
  holdMs: number,
  tickMs = 200,
): number | null {
  const [shown, setShown] = useState<number | null>(raw)
  const rawRef   = useRef(raw);   rawRef.current = raw
  const shownRef = useRef(shown); shownRef.current = shown
  const pending  = useRef<{ value: number; since: number } | null>(null)

  useEffect(() => {
    const id = setInterval(() => {
      const r = rawRef.current
      if (r == null) { pending.current = null; setShown(null); return }
      const prev = shownRef.current
      if (prev == null) { pending.current = null; setShown(r); return }

      if (Math.abs(r - prev) <= step) {        // small change → responsive
        pending.current = null
        setShown(r)
        return
      }
      const now = Date.now()                    // big jump → must be sustained
      if (!pending.current || Math.abs(r - pending.current.value) > step) {
        pending.current = { value: r, since: now }
      }
      if (now - pending.current.since >= holdMs) {
        pending.current = null
        setShown(r)
      }
    }, tickMs)
    return () => clearInterval(id)
  }, [step, holdMs, tickMs])

  return shown
}

/**
 * GPS speedometer stabilizer. A stationary GPS reports random low-mph noise, so:
 *  - below `fall` mph the display reads 0, and
 *  - to leave 0 the speed must stay above `rise` for `holdMs` (hysteresis +
 *    sustain), so a brief noise spike while parked doesn't register as motion.
 * Once moving it tracks live with no lag, snapping back to 0 below `fall`.
 *
 * Returns `null` when `rawMph` is null (no fix) so the caller can show "--".
 */
export function useSpeedStabilizer(
  rawMph: number | null,
  { rise = 4, fall = 2, holdMs = 1800, tickMs = 200 } = {},
): number | null {
  const [shown, setShown] = useState<number | null>(rawMph == null ? null : 0)
  const rawRef     = useRef(rawMph); rawRef.current = rawMph
  const moving     = useRef(false)
  const aboveSince = useRef<number | null>(null)

  useEffect(() => {
    const id = setInterval(() => {
      const r = rawRef.current
      if (r == null) { moving.current = false; aboveSince.current = null; setShown(null); return }
      const now = Date.now()
      if (!moving.current) {
        if (r >= rise) {
          if (aboveSince.current == null) aboveSince.current = now
          if (now - aboveSince.current >= holdMs) {
            moving.current = true
            aboveSince.current = null
            setShown(Math.round(r))
            return
          }
        } else {
          aboveSince.current = null
        }
        setShown(0)
      } else {
        if (r < fall) { moving.current = false; aboveSince.current = null; setShown(0) }
        else setShown(Math.round(r))
      }
    }, tickMs)
    return () => clearInterval(id)
  }, [rise, fall, holdMs, tickMs])

  return shown
}

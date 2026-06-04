import { create } from 'zustand'

export type MetricKey =
  | 'speed' | 'heading' | 'ambientTemp' | 'chtLeft' | 'chtRight'
  | 'altitude' | 'gForce' | 'leanAngle' | 'pitchAngle'

export interface DataPoint {
  ts: number   // unix ms
  val: number
}

export interface MetricConfig {
  label: string
  unit: string
  color: string
  fmtVal: (v: number) => string
}

export const METRIC_CONFIG: Record<MetricKey, MetricConfig> = {
  speed:       { label: 'SPEED',     unit: 'mph', color: '#4fc3f7', fmtVal: v => String(Math.round(v)) },
  heading:     { label: 'HEADING',   unit: '°',   color: '#81c784', fmtVal: v => String(Math.round(v)) },
  ambientTemp: { label: 'AMBIENT',   unit: '°F',  color: '#fff176', fmtVal: v => String(Math.round(v)) },
  chtLeft:     { label: 'CHT LEFT',  unit: '°F',  color: '#ff8a65', fmtVal: v => String(Math.round(v)) },
  chtRight:    { label: 'CHT RIGHT', unit: '°F',  color: '#ff5252', fmtVal: v => String(Math.round(v)) },
  altitude:    { label: 'ALTITUDE',  unit: 'ft',  color: '#ce93d8', fmtVal: v => Math.round(v).toLocaleString() },
  gForce:      { label: 'G-FORCE',   unit: 'G',   color: '#ffca28', fmtVal: v => v.toFixed(2) },
  leanAngle:   { label: 'LEAN',      unit: '°',   color: '#ffd700', fmtVal: v => String(Math.round(v)) },
  pitchAngle:  { label: 'PITCH',     unit: '°',   color: '#80cbc4', fmtVal: v => String(Math.round(v)) },
}

const MAX_AGE_MS  = 8 * 60 * 60 * 1000  // 8 hours
const THROTTLE_MS = 1000                 // 1 sample / second per metric

const empty = (): Record<MetricKey, DataPoint[]> => ({
  speed: [], heading: [], ambientTemp: [], chtLeft: [], chtRight: [],
  altitude: [], gForce: [], leanAngle: [], pitchAngle: [],
})

interface DataLogStore {
  data: Record<MetricKey, DataPoint[]>
  lastSample: Partial<Record<MetricKey, number>>
  addPoint: (key: MetricKey, val: number) => void
  clearMetric: (key: MetricKey) => void
  clearAll: () => void
}

export const useDataLog = create<DataLogStore>((set, get) => ({
  data: empty(),
  lastSample: {},

  addPoint: (key, val) => {
    if (!isFinite(val)) return
    const now = Date.now()
    const last = get().lastSample[key] ?? 0
    if (now - last < THROTTLE_MS) return
    set(state => {
      const cutoff = now - MAX_AGE_MS
      const prev   = state.data[key].filter(p => p.ts > cutoff)
      return {
        data:       { ...state.data, [key]: [...prev, { ts: now, val }] },
        lastSample: { ...state.lastSample, [key]: now },
      }
    })
  },

  clearMetric: (key) =>
    set(state => ({
      data:       { ...state.data, [key]: [] },
      lastSample: { ...state.lastSample, [key]: 0 },
    })),

  clearAll: () => set({ data: empty(), lastSample: {} }),
}))

import { create } from 'zustand'

export type MetricKey =
  | 'speed' | 'heading' | 'ambientTemp' | 'chtLeft' | 'chtRight'
  | 'altitude' | 'gForce' | 'leanAngle' | 'pitchAngle' | 'piTemp'

export interface DataPoint {
  ts: number   // unix ms
  val: number
}

export interface MetricZone {
  max: number    // upper bound (inclusive) of this risk band, in the metric's unit
  color: string  // fill color for the area-under-line while it sits in this band
  label?: string // short tag drawn at the band's lower threshold line
}

export interface MetricConfig {
  label: string
  unit: string
  color: string
  fmtVal: (v: number) => string
  // Minimum y-axis span. If the visible data varies by less than this, the
  // chart still shows at least this range (centered on the data) so a steady
  // reading looks appropriately flat instead of zooming in on sensor noise.
  minRange: number
  // Optional risk bands (ascending by max, last = Infinity). When set, the
  // area under the line is colored per-band by value (traffic-light style) and
  // the current reading is tinted to match — e.g. Pi CPU temp throttle zones.
  zones?: MetricZone[]
}

// Cylinder-head risk bands — same thresholds/colors as the main-screen CHT
// gauge (see CHTGauge.tempColor): cold < 80, normal < 160, warm < 220, hot ≥ 220.
const CHT_ZONES: MetricZone[] = [
  { max: 80,       color: '#4fc3f7' },                  // cold   (blue)
  { max: 160,      color: '#66bb6a' },                  // normal (green)
  { max: 220,      color: '#ffca28', label: 'WARM' },   // warm   (amber)
  { max: Infinity, color: '#ef5350', label: 'HOT'  },   // hot    (red)
]

export const METRIC_CONFIG: Record<MetricKey, MetricConfig> = {
  speed:       { label: 'SPEED',     unit: 'mph', color: '#4fc3f7', minRange: 20,  fmtVal: v => String(Math.round(v)) },
  heading:     { label: 'HEADING',   unit: '°',   color: '#81c784', minRange: 45,  fmtVal: v => String(Math.round(v)) },
  ambientTemp: { label: 'AMBIENT',   unit: '°F',  color: '#fff176', minRange: 10,  fmtVal: v => String(Math.round(v)) },
  chtLeft:     { label: 'CHT LEFT',  unit: '°C',  color: '#ff8a65', minRange: 30,  fmtVal: v => String(Math.round(v)), zones: CHT_ZONES },
  chtRight:    { label: 'CHT RIGHT', unit: '°C',  color: '#ff5252', minRange: 30,  fmtVal: v => String(Math.round(v)), zones: CHT_ZONES },
  altitude:    { label: 'ALTITUDE',  unit: 'ft',  color: '#ce93d8', minRange: 100, fmtVal: v => Math.round(v).toLocaleString() },
  gForce:      { label: 'G-FORCE',   unit: 'G',   color: '#ffca28', minRange: 0.5, fmtVal: v => v.toFixed(2) },
  leanAngle:   { label: 'LEAN',      unit: '°',   color: '#ffd700', minRange: 30,  fmtVal: v => String(Math.round(v)) },
  pitchAngle:  { label: 'PITCH',     unit: '°',   color: '#80cbc4', minRange: 20,  fmtVal: v => String(Math.round(v)) },
  piTemp:      { label: 'PI CPU',    unit: '°C',  color: '#4dd0e1', minRange: 15,  fmtVal: v => String(Math.round(v)),
    // Pi 5 thermals: comfortable < 70 °C, warm 70–80 °C, soft-throttle ≥ 80 °C.
    zones: [
      { max: 70,       color: '#43d17a' },                      // healthy  (green)
      { max: 80,       color: '#ffb300', label: 'WARM'     },   // warm     (amber)
      { max: Infinity, color: '#ff5252', label: 'THROTTLE' },   // throttle (red)
    ],
  },
}

const MAX_AGE_MS  = 8 * 60 * 60 * 1000  // 8 hours
const THROTTLE_MS = 1000                 // 1 sample / second per metric

const empty = (): Record<MetricKey, DataPoint[]> => ({
  speed: [], heading: [], ambientTemp: [], chtLeft: [], chtRight: [],
  altitude: [], gForce: [], leanAngle: [], pitchAngle: [], piTemp: [],
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

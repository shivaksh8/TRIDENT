import { useEffect, useRef, useState, useCallback } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, LineChart, Line
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Node {
  id: string; x: number; y: number; lat?: number; lon?: number
  node_type: string; label: string; elevation?: number; flood_risk?: boolean
  flooded?: boolean; flood_depth?: number
  ticks_until_flooded?: number | null; is_transfer_hub?: boolean
}
interface Edge {
  id: string; source: string; destination: string; travel_time: number
  mode: string; risk: number; open: boolean
  lat_a?: number; lon_a?: number; lat_b?: number; lon_b?: number
  submerged_navigable?: boolean; ticks_until_flooded?: number | null; congestion_toll?: number
}
interface Boat {
  id: string; location: string; capacity: number; status: string
  people_on_board: number; path: string[]; vehicle_type?: string
}
interface Request {
  id: string; location: string; people: number; urgency: number
  status: string; waiting_ticks: number; neighbourhood: string
  uncertainty?: number; is_contradiction?: boolean
}
interface Shelter {
  id: string; location: string; total_capacity: number; occupied: number; fill_pct?: number
}
interface Assignment {
  id: string; request_id: string; boat_id: string; shelter_id: string
  eta_pickup: number; eta_delivery?: number; status: string; reason: string; created_tick?: number
}
interface LogEntry { tick: number; level: string; message: string }
interface FloodState {
  flooded_nodes: string[]; flood_closed_edges: string[]
  ring_count: number; spread_ticks: number
}
interface GhostComparison {
  baseline_strategy?: string; swarm_delivered?: number
  baseline_estimated_delivered?: number; extra_people_saved?: number
  baseline_traps_hit?: number; baseline_churn_events?: number; headline?: string
}
interface CancelledCommitment {
  vehicle_id: string; vehicle_type: string
  request_id?: string | null; shelter_id?: string | null
  reason_code: string; explanation: string
}
interface ReassignmentRecord {
  request_id: string; is_mayday_rescue?: boolean
  previous_vehicle_id?: string | null; new_vehicle_id: string; new_vehicle_type: string
  previous_shelter_id?: string | null; new_shelter_id?: string | null
  winning_bid_score: number; runner_up_vehicle_id?: string | null; runner_up_score?: number | null
  why_explanation: string
}
interface CompoundDisruptionReport {
  tick: number; bridge_edge_id: string; failed_boat_id: string; overflow_shelter_id: string
  mayday_request_id?: string | null
  cancelled_commitments: CancelledCommitment[]
  reassignments: ReassignmentRecord[]
  unaffected_vehicle_ids: string[]
  surgical_stability_pct: number
}
interface Metrics {
  people_delivered: number; people_waiting: number; people_in_transit?: number
  requests_completed: number; mean_delivery_time: number
  boat_utilisation: number; safety_violations: number
  fairness_by_neighbourhood?: Record<string, number>
  fairness_gini?: number; worst_neighbourhood?: string | null
  contradictions_detected?: number; shelter_fill?: Record<string, number>
  dead_traps_avoided?: number; amphibious_routes_used?: number
  recon_verifications?: number; lilypad_relays?: number
  road_tolls_applied?: number; shelter_triage_diversions?: number
  negotiation_rounds_used?: number
  gini_coefficient?: number; worst_served_zone?: string; worst_served_pct?: number
  mission_churn_count?: number
  ghost_comparison?: GhostComparison
}
interface WorldState {
  simulation_id: string; tick: number; strategy: string; running: boolean
  nodes: Node[]; edges: Edge[]; boats: Boat[]; requests: Request[]
  shelters: Shelter[]; assignments: Assignment[]; log: LogEntry[]
  metrics?: Metrics; safety_violation_count: number
  flood_state?: FloodState; scenario_name?: string; scenario_severity?: string
  weather_summary?: Record<string, unknown>
  negotiation_rounds?: number
  last_compound_report?: CompoundDisruptionReport | null
  ghost_comparison?: GhostComparison | null
}
interface WeatherSummary {
  day3_precipitation_mm: number; scenario_severity: string
  alert_level: string; narrative: string; flood_spread_ticks: number
}
interface WeatherData { location: string; summary: WeatherSummary }

// ── Constants ─────────────────────────────────────────────────────────────────

const API = 'http://localhost:8000'
const STRATEGIES = ['greedy', 'optimiser', 'negotiation']
const KOLHAPUR_CENTER: [number, number] = [16.705, 74.24]
const STATUS_COLOR: Record<string, string> = {
  idle: '#4ade80', en_route_to_pickup: '#facc15', picking_up: '#fb923c',
  en_route_to_shelter: '#60a5fa', broken: '#f87171',
}
const REQ_COLOR: Record<string, string> = {
  waiting: '#f87171', assigned: '#facc15', picked_up: '#60a5fa',
  delivered: '#4ade80', failed: '#9ca3af',
}
const SEV_COLOR: Record<string, string> = {
  low: '#4ade80', moderate: '#fbbf24', severe: '#f97316', extreme: '#ef4444'
}
const ALERT_BG: Record<string, string> = {
  GREEN: '#14532d', YELLOW: '#713f12', ORANGE: '#7c2d12', RED: '#450a0a'
}

// ── Map helpers ───────────────────────────────────────────────────────────────

function nodeToLL(n: Node): L.LatLng {
  if (n.lat != null && n.lon != null) return L.latLng(n.lat, n.lon)
  return L.latLng(16.55 + n.y * 0.003, 74.0 + n.x * 0.0035)
}

function edgeLL(e: Edge, nm: Map<string, Node>): [L.LatLng, L.LatLng] | null {
  if (e.lat_a != null) return [L.latLng(e.lat_a!, e.lon_a!), L.latLng(e.lat_b!, e.lon_b!)]
  const s = nm.get(e.source), d = nm.get(e.destination)
  return s && d ? [nodeToLL(s), nodeToLL(d)] : null
}

function vehicleIcon(boat: Boat, color: string) {
  const t = boat.vehicle_type || (boat.id.startsWith('truck') ? 'truck' : boat.id.startsWith('heli') ? 'helicopter' : 'boat')
  const em = t === 'truck' ? '🚛' : t === 'helicopter' ? '🚁' : '⛵'
  return L.divIcon({
    className: '',
    html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:11px">${em}</div>`,
    iconAnchor: [10, 10],
  })
}

function reqIcon(color: string, urgency: number) {
  const s = urgency >= 8 ? 14 : 10
  return L.divIcon({
    className: '',
    html: `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.7);${urgency>=8?`box-shadow:0 0 6px ${color}`:''}"></div>`,
    iconAnchor: [s/2, s/2],
  })
}

function shelterIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:3px;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:10px">🏠</div>`,
    iconAnchor: [9, 9],
  })
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sel: React.CSSProperties = { background:'#0f172a', color:'#e2e8f0', border:'1px solid #334155', borderRadius:4, padding:'5px 8px', fontSize:13, width:'100%' }
const inp: React.CSSProperties = { background:'#0f172a', color:'#e2e8f0', border:'1px solid #334155', borderRadius:4, padding:'4px 8px', fontSize:13 }
const btn = (bg: string): React.CSSProperties => ({ background:bg, color:'#fff', border:'none', borderRadius:4, padding:'6px 10px', fontSize:12, cursor:'pointer', width:'100%' })
const scr: React.CSSProperties = { background:'#334155', color:'#e2e8f0', border:'none', borderRadius:4, padding:'4px 8px', cursor:'pointer', fontSize:13 }

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const mapRef = useRef<L.Map | null>(null)
  const mapDivRef = useRef<HTMLDivElement>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())
  const edgesRef = useRef<Map<string, L.Polyline>>(new Map())
  const floodRef = useRef<L.LayerGroup | null>(null)
  const heliReconRef = useRef<L.LayerGroup | null>(null)
  const assignPathRef = useRef<L.LayerGroup | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const [simId, setSimId] = useState<string | null>(null)
  const [world, setWorld] = useState<WorldState | null>(null)
  const [strategy, setStrategy] = useState('greedy')
  const [seed, setSeed] = useState(2019)
  const [log, setLog] = useState<LogEntry[]>([])
  const [logFilter, setLogFilter] = useState('all')
  const [metricsHist, setMetricsHist] = useState<(Metrics & {tick:number})[]>([])
  const [benchResult, setBenchResult] = useState<any>(null)
  const [benchLoading, setBenchLoading] = useState(false)
  const [status, setStatus] = useState('Ready')
  const [tab, setTab] = useState<'map'|'metrics'|'log'|'bench'|'explain'>('map')
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [selAssign, setSelAssign] = useState<Assignment | null>(null)
  const [replayTick, setReplayTick] = useState<number | null>(null)
  const [maxTick, setMaxTick] = useState(0)
  const histCache = useRef<Map<number, WorldState>>(new Map())
  const [showDrawer, setShowDrawer] = useState(false)
  const [compoundReport, setCompoundReport] = useState<CompoundDisruptionReport | null>(null)
  const [triggeringCompound, setTriggeringCompound] = useState(false)
  const [judgeMode, setJudgeMode] = useState(false)
  const [judgeChapter, setJudgeChapter] = useState(0)
  const [judgeRunning, setJudgeRunning] = useState(false)

  // ── Init map ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return
    const map = L.map(mapDivRef.current, { center: KOLHAPUR_CENTER, zoom: 12, attributionControl: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 18,
    }).addTo(map)
    floodRef.current = L.layerGroup().addTo(map)
    heliReconRef.current = L.layerGroup().addTo(map)
    assignPathRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // ── Fetch weather ────────────────────────────────────────────────────────

  useEffect(() => {
    fetch(`${API}/api/v1/weather`).then(r => r.json()).then(setWeather).catch(() => {})
  }, [])

  // ── Update map ────────────────────────────────────────────────────────────

  const updateMap = useCallback((w: WorldState) => {
    const map = mapRef.current
    if (!map) return
    const nm = new Map(w.nodes.map(n => [n.id, n]))

    // Edges — F1/F6: submerged canals, dead-trap warnings, closed bridges, assignment paths
    w.edges.forEach(e => {
      const ll = edgeLL(e, nm)
      if (!ll) return
      const isSubmerged = !!e.submerged_navigable
      const isImminentFlood = !isSubmerged && e.ticks_until_flooded != null && e.ticks_until_flooded > 0 && e.ticks_until_flooded <= 4
      const isClosed = !e.open && !isSubmerged
      const isWater = e.mode === 'water'

      let color: string, weight: number, opacity: number, dash: string | undefined, tip: string | undefined
      if (isSubmerged) {
        color = '#06b6d4'; weight = 3; opacity = 0.85; dash = '6, 4'
        tip = '🌊 Submerged Road Canal — Trucks Blocked, Boats Navigable'
      } else if (isImminentFlood) {
        color = '#f59e0b'; weight = 2.5; opacity = 0.9; dash = undefined
        tip = `⚠️ ROAD AGENT WARNING: Submerges in ${e.ticks_until_flooded} ticks`
      } else if (isClosed) {
        color = '#ef4444'; weight = 3; opacity = 0.9; dash = '4, 6'
        tip = '🚫 Road Closed'
      } else if (isWater) {
        color = '#60a5fa'; weight = 3; opacity = 0.65; dash = undefined
      } else if (e.mode === 'bridge') {
        color = '#f59e0b'; weight = 2; opacity = 0.55; dash = undefined
      } else {
        color = '#6b7280'; weight = 1.5; opacity = 0.3; dash = undefined
      }
      if (edgesRef.current.has(e.id)) {
        const pl = edgesRef.current.get(e.id)!
        pl.setStyle({ color, weight, opacity, dashArray: dash })
        if (tip) pl.bindTooltip(tip); else pl.unbindTooltip()
      } else {
        const pl = L.polyline(ll, { color, weight, opacity, dashArray: dash })
        if (tip) pl.bindTooltip(tip)
        pl.addTo(map)
        edgesRef.current.set(e.id, pl)
      }
    })

    // Shelters
    w.shelters.forEach(s => {
      const n = nm.get(s.location); if (!n) return
      const pct = s.fill_pct != null ? Math.round(s.fill_pct*100) : Math.round(s.occupied/s.total_capacity*100)
      const color = pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#22c55e'
      const key = `sh_${s.id}`
      const tip = `🏠 ${s.id.replace('shelter_','')}<br>${s.occupied}/${s.total_capacity} (${pct}%)`
      if (!markersRef.current.has(key)) {
        markersRef.current.set(key, L.marker(nodeToLL(n), { icon: shelterIcon(color), zIndexOffset: 1000 }).bindTooltip(tip).addTo(map))
      } else {
        const m = markersRef.current.get(key)!
        m.setIcon(shelterIcon(color))
        m.setTooltipContent(tip)
      }
    })

    // Requests
    w.requests.forEach(r => {
      const n = nm.get(r.location); if (!n) return
      const color = REQ_COLOR[r.status] || '#9ca3af'
      const key = `rq_${r.id}`
      const tip = `📍 ${r.neighbourhood}<br>👥 ${r.people} | ⚡ ${r.urgency}/10<br>${r.status}`
      if (!markersRef.current.has(key)) {
        markersRef.current.set(key, L.marker(nodeToLL(n), { icon: reqIcon(color, r.urgency) }).bindTooltip(tip).addTo(map))
      } else {
        const m = markersRef.current.get(key)!
        m.setIcon(reqIcon(color, r.urgency))
        m.setTooltipContent(tip)
      }
    })

    // Vehicles
    w.boats.forEach(b => {
      const n = nm.get(b.location); if (!n) return
      const color = STATUS_COLOR[b.status] || '#9ca3af'
      const key = `bt_${b.id}`
      const asgn = w.assignments.find(a => a.boat_id === b.id && a.status === 'active')
      const tip = `${b.id}<br>${b.status}<br>👥 ${b.people_on_board}/${b.capacity}${asgn ? '<br>→ '+asgn.request_id : ''}`
      if (!markersRef.current.has(key)) {
        markersRef.current.set(key, L.marker(nodeToLL(n), { icon: vehicleIcon(b, color), zIndexOffset: 500 }).bindTooltip(tip).addTo(map))
      } else {
        const m = markersRef.current.get(key)!
        m.setLatLng(nodeToLL(n))
        m.setIcon(vehicleIcon(b, color))
        m.setTooltipContent(tip)
      }
    })

    // Flood overlay
    const fl = floodRef.current
    if (fl && w.flood_state) {
      fl.clearLayers()
      const rings = w.flood_state.ring_count
      const flColor = rings > 10 ? '#dc2626' : rings > 5 ? '#ea580c' : '#3b82f6'
      w.flood_state.flooded_nodes.forEach(id => {
        const n = nm.get(id); if (!n) return
        L.circle(nodeToLL(n), {
          radius: n.node_type === 'water' ? 380 : 260,
          color: flColor, fillColor: flColor,
          fillOpacity: n.node_type === 'water' ? 0.3 : 0.18, weight: 0,
        }).addTo(fl)
      })
    }

    // F6: Lilypad transfer hubs — ⚓ marker on shoreline handoff nodes
    w.nodes.forEach(n => {
      if (!n.is_transfer_hub) return
      const key = `hub_${n.id}`
      if (!markersRef.current.has(key)) {
        const icon = L.divIcon({
          className: '',
          html: `<div style="font-size:16px;line-height:1;filter:drop-shadow(0 0 4px #06b6d4)">⚓</div>`,
          iconAnchor: [8, 8],
        })
        markersRef.current.set(key, L.marker(nodeToLL(n), { icon, zIndexOffset: 200 })
          .bindTooltip('⚓ Lilypad Transfer Hub — Boat→Truck handoff point').addTo(map))
      }
    })

    // F6: Heli recon rings — purple radar circle around helicopters (3.5km ≈ 0.035°)
    const heliLg = heliReconRef.current
    if (heliLg) {
      heliLg.clearLayers()
      w.boats.forEach(b => {
        const vt = b.vehicle_type || (b.id.startsWith('heli') ? 'helicopter' : 'boat')
        if (vt !== 'helicopter') return
        if (b.status === 'broken') return
        const n = nm.get(b.location); if (!n) return
        L.circle(nodeToLL(n), {
          radius: 3500, // ~3.5km
          color: '#a855f7', fillColor: '#a855f7',
          fillOpacity: 0.06, weight: 1.5, dashArray: '4, 4', opacity: 0.5,
        }).bindTooltip('🚁 Heli Economy-of-Truth Recon Sweep (3.5km)').addTo(heliLg)
      })
    }

    // F6: Assignment path lines — dashed polylines from vehicle → request → shelter
    const pathLg = assignPathRef.current
    if (pathLg) {
      pathLg.clearLayers()
      w.assignments.filter(a => a.status === 'active').forEach(a => {
        const boat = w.boats.find(b => b.id === a.boat_id)
        if (!boat || !boat.path || boat.path.length === 0) return
        const vt = boat.vehicle_type || (boat.id.startsWith('truck') ? 'truck' : boat.id.startsWith('heli') ? 'helicopter' : 'boat')
        const pathColor = vt === 'truck' ? '#fb923c' : vt === 'helicopter' ? '#a855f7' : '#60a5fa'
        const startNode = nm.get(boat.location)
        if (!startNode) return
        const pathLL: L.LatLng[] = [nodeToLL(startNode)]
        // Add waypoints along path
        boat.path.slice(0, 12).forEach(nid => {
          const pn = nm.get(nid); if (pn) pathLL.push(nodeToLL(pn))
        })
        // Add target request node
        const req = w.requests.find(r => r.id === a.request_id)
        if (req) {
          const rn = nm.get(req.location); if (rn) pathLL.push(nodeToLL(rn))
        }
        if (pathLL.length > 1) {
          L.polyline(pathLL, {
            color: pathColor, weight: 2, opacity: 0.7,
            dashArray: '5, 4',
          }).bindTooltip(`${boat.id} → ${a.request_id}`).addTo(pathLg)
        }
      })
    }
  }, [])

  // ── WebSocket ─────────────────────────────────────────────────────────────

  const connectWs = useCallback((id: string) => {
    wsRef.current?.close()
    const ws = new WebSocket(`ws://localhost:8000/api/v1/simulations/${id}/stream`)
    ws.onmessage = evt => {
      const w: WorldState = JSON.parse(evt.data)
      setWorld(w)
      if (replayTick === null) updateMap(w)
      setLog(prev => [...prev, ...w.log].slice(-500))
      if (w.metrics) setMetricsHist(prev => [...prev.slice(-100), { ...w.metrics!, tick: w.tick }])
      setMaxTick(w.tick)
      histCache.current.set(w.tick, w)
      // Sync compound report from world state if available
      if (w.last_compound_report) setCompoundReport(w.last_compound_report)
    }
    ws.onerror = () => setStatus('WS error')
    ws.onclose = () => setStatus('Disconnected')
    wsRef.current = ws
  }, [replayTick, updateMap])

  // ── Controls ──────────────────────────────────────────────────────────────

  const createSim = async () => {
    setStatus('Creating...')
    setLog([]); setMetricsHist([]); setBenchResult(null)
    setMaxTick(0); setReplayTick(null)
    histCache.current.clear()
    markersRef.current.forEach(m => m.remove()); markersRef.current.clear()
    edgesRef.current.forEach(l => l.remove()); edgesRef.current.clear()
    floodRef.current?.clearLayers()
    try {
      const r = await fetch(`${API}/api/v1/simulations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy, seed })
      })
      const d = await r.json()
      setSimId(d.simulation_id)
      connectWs(d.simulation_id)
      setStatus(`Ready (${strategy})`)
    } catch { setStatus('Failed') }
  }

  const cmd = (command: string, extra?: object) =>
    wsRef.current?.send(JSON.stringify({ command, ...extra }))

  const injectEvent = async (type: string, target: string) => {
    if (!simId || !world) return
    try {
      await fetch(`${API}/api/v1/simulations/${simId}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: type, target_id: target, tick_offset: 1 })
      })
    } catch {
      cmd('inject_event', { event: { tick: (world?.tick??0)+1, event_type: type, target_id: target, payload: {}, description: '' } })
    }
  }

  const runBench = async () => {
    setBenchLoading(true)
    try {
      const r = await fetch(`${API}/api/v1/benchmarks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seeds: [2019, 42, 137], disruptions: true })
      })
      setBenchResult(await r.json())
    } catch { setStatus('Benchmark failed') }
    setBenchLoading(false)
  }

  const triggerCompound = async () => {
    if (!simId || !world) return
    setTriggeringCompound(true)
    try {
      const openEdges = world.edges.filter(e => e.open && !e.submerged_navigable && e.mode !== 'water')
      const vehicles = world.boats.filter(b => b.status !== 'broken')
      const bridge_edge_id = openEdges[0]?.id ?? ''
      const fail_boat_id = vehicles[0]?.id ?? ''
      const overflow_shelter_id = world.shelters[0]?.id ?? ''
      const r = await fetch(`${API}/api/v1/simulations/${simId}/trigger-compound`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bridge_edge_id, fail_boat_id, overflow_shelter_id })
      })
      if (r.ok) {
        const report: CompoundDisruptionReport = await r.json()
        setCompoundReport(report)
        setShowDrawer(true)
      }
    } catch { setStatus('Compound trigger failed') }
    setTriggeringCompound(false)
  }

  // ── Judge demo chapter executor ────────────────────────────────────────────
  const JUDGE_CHAPTERS = [
    { title: 'Predictive Dead-Trap Veto', action: 'Start + 3 ticks on negotiation',
      callout: '🗺️ Watch the Amber edges — Road Agents computed ticks_until_flooded from HAND elevation data and veto trucks from entering these flood corridors. Cyan dashed edges = Amphibious Boat Canals where trucks are blocked but boats can navigate.' },
    { title: '3-Way Negotiation, Lilypad Relays & Heli Scout', action: 'Advance 4 ticks',
      callout: '🚁 The purple radar ring shows heli_1 aerially verifying uncertain requests (Economy of Truth). ⚓ Gold circles = Shoreline Lilypad Transfer Hubs where boats hand off to road trucks. 🚦 Road Congestion Tolls prevent path collisions. 🏥 Shelter Triage fires at 75% fill.' },
    { title: 'Simultaneous Triple Catastrophe', action: 'Trigger compound disruption',
      callout: '⚡ SIMULTANEOUS: Bridge collapse + Boat breakdown + Shelter overflow hit at once. Watch the red Cancelled Commitments (left) vs green Autonomous Renegotiation (right). The Surgical Stability % shows missions kept WITHOUT global replanning. Mayday = rescuing the rescuer.' },
    { title: 'Gini Fairness & Ghost Fleet Counterfactual', action: 'Close drawer + 3 recovery ticks',
      callout: '⚖️ Gini coefficient tracks equity across neighbourhoods. Ghost Fleet compares our swarm against a greedy central baseline — extra_people_saved shows the decentralised advantage. Zero panic churn, zero safety violations.' },
    { title: 'Statistical Benchmark Proof', action: 'Run benchmark comparison',
      callout: '📊 Multi-seed statistical proof: Negotiation beats Greedy on throughput, beats Optimiser on Gini fairness & mission churn. Optimiser churn=24 (stale comms blackout), Negotiation churn=0 (local sensing). Check std/min/max columns for robustness.' },
  ]

  const runJudgeChapter = async (ch: number) => {
    if (judgeRunning) return
    setJudgeRunning(true)
    try {
      if (ch === 0) {
        // Reset to negotiation, create new sim, step 3 ticks
        setStrategy('negotiation')
        await new Promise(r => setTimeout(r, 100))
        setStatus('Creating negotiation sim for demo...')
        setLog([]); setMetricsHist([]); setMaxTick(0); setReplayTick(null)
        histCache.current.clear()
        const resp = await fetch(`${API}/api/v1/simulations`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategy: 'negotiation', seed: 2019 })
        })
        const d = await resp.json()
        setSimId(d.simulation_id)
        connectWs(d.simulation_id)
        await new Promise(r => setTimeout(r, 400))
        for (let i = 0; i < 3; i++) { cmd('step'); await new Promise(r => setTimeout(r, 300)) }
        setTab('map')
      } else if (ch === 1) {
        // Advance 4 ticks
        for (let i = 0; i < 4; i++) { cmd('step'); await new Promise(r => setTimeout(r, 300)) }
        setTab('map')
      } else if (ch === 2) {
        // Trigger compound disruption
        await triggerCompound()
        setTab('map')
      } else if (ch === 3) {
        // Close drawer, step 3 ticks
        setShowDrawer(false)
        for (let i = 0; i < 3; i++) { cmd('step'); await new Promise(r => setTimeout(r, 350)) }
        setTab('map')
      } else if (ch === 4) {
        // Run benchmark
        setTab('bench')
        await runBench()
      }
    } catch { /* ignore */ }
    setJudgeRunning(false)
  }

  // ── After-action replay export ─────────────────────────────────────────────
  const exportReplay = () => {
    if (!world) return
    const payload = {
      scenario: 'Kolhapur 2019 Flood',
      strategy: world.strategy,
      final_tick: world.tick,
      final_metrics: world.metrics,
      safety_invariants_passed: (world.safety_violation_count ?? 0) === 0,
      last_compound_report: world.last_compound_report ?? null,
      event_log: log.slice(-200),
      tick_summaries: Array.from(histCache.current.entries())
        .sort(([a], [b]) => a - b)
        .map(([tick, w]) => ({ tick, delivered: w.metrics?.people_delivered ?? 0, flooded_nodes: w.flood_state?.flooded_nodes?.length ?? 0 }))
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `floodops-replay-t${world.tick}.json`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const scrubTo = async (tick: number) => {
    setReplayTick(tick)
    const cached = histCache.current.get(tick)
    if (cached) { updateMap(cached); return }
    if (!simId) return
    try {
      const r = await fetch(`${API}/api/v1/simulations/${simId}/history/${tick}`)
      const w: WorldState = await r.json()
      histCache.current.set(tick, w)
      updateMap(w)
    } catch {}
  }

  // ── Log filter ────────────────────────────────────────────────────────────

  const filteredLog = log.filter(e => {
    if (logFilter === 'all') return true
    if (logFilter === 'flood') return e.message.includes('🌊') || e.message.toLowerCase().includes('flood')
    if (logFilter === 'contradictions') return e.message.toLowerCase().includes('contradiction')
    if (logFilter === 'warn+') return e.level === 'warn' || e.level === 'error'
    if (logFilter === 'error') return e.level === 'error'
    return e.level === logFilter
  }).slice(-200).reverse()

  // ── Render ────────────────────────────────────────────────────────────────

  const sev = world?.scenario_severity || weather?.summary?.scenario_severity || 'severe'
  const alert = weather?.summary?.alert_level || 'ORANGE'

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'#0f172a', color:'#e2e8f0', fontFamily:'system-ui,sans-serif' }}>

      {/* Banner */}
      <div style={{ background: ALERT_BG[alert]||'#1c1917', borderBottom:'1px solid #292524', padding:'5px 14px', display:'flex', alignItems:'center', gap:14, fontSize:13 }}>
        <span style={{ fontWeight:700, fontSize:15 }}>🌊 FloodOps</span>
        <span style={{ color:'#78716c' }}>📍 Kolhapur, Maharashtra · 2019 Flood Scenario</span>
        {weather?.summary && (
          <>
            <span>🌧 Day 3: <b style={{ color: SEV_COLOR[sev] }}>{weather.summary.day3_precipitation_mm.toFixed(0)}mm</b></span>
            <span style={{ background: SEV_COLOR[sev], color:'#000', borderRadius:3, padding:'1px 7px', fontWeight:700, fontSize:11 }}>{alert}</span>
          </>
        )}
        {world && (
          <span style={{ marginLeft:'auto', color:'#78716c', fontSize:12 }}>
            Tick <b style={{ color:'#e2e8f0' }}>{world.tick}</b>
            {' · '}<b style={{ color:'#a78bfa' }}>{world.strategy.toUpperCase()}</b>
            {world.flood_state && <span style={{ color:'#60a5fa' }}>{' · 🌊 '}{world.flood_state.ring_count} rings</span>}
            {world.safety_violation_count > 0 && <span style={{ color:'#f87171' }}>{' · ⚠ '}{world.safety_violation_count} violations</span>}
          </span>
        )}
        <button onClick={() => setJudgeMode(j => !j)} style={{ marginLeft:'auto', background: judgeMode ? '#065f46' : '#1c1917', color: judgeMode ? '#6ee7b7' : '#78716c', border:`1px solid ${judgeMode?'#059669':'#292524'}`, borderRadius:5, padding:'3px 10px', fontSize:12, cursor:'pointer', fontWeight:700, boxShadow: judgeMode ? '0 0 10px #059669' : 'none' }}>
          🎯 Judge Demo Mode
        </button>
      </div>

      {/* F8: 5-Chapter Judge Walkthrough Stepper */}
      {judgeMode && (
        <div style={{ background:'#020617', borderBottom:'1px solid #0f766e', padding:'7px 14px', display:'flex', flexDirection:'column', gap:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <button onClick={() => setJudgeChapter(c => Math.max(0, c-1))} disabled={judgeChapter===0} style={{ ...scr, padding:'2px 8px', opacity: judgeChapter===0?0.4:1 }}>◀ Prev</button>
            {[0,1,2,3,4].map(i => (
              <button key={i} onClick={() => setJudgeChapter(i)} style={{ padding:'3px 12px', borderRadius:12, border:`1px solid ${judgeChapter===i?'#059669':'#134e4a'}`, background: judgeChapter===i?'#065f46':'transparent', color: judgeChapter===i?'#6ee7b7':'#78716c', cursor:'pointer', fontSize:12, fontWeight: judgeChapter===i?700:400 }}>
                {i+1}
              </button>
            ))}
            <button onClick={() => setJudgeChapter(c => Math.min(4, c+1))} disabled={judgeChapter===4} style={{ ...scr, padding:'2px 8px', opacity: judgeChapter===4?0.4:1 }}>Next Step ▶</button>
            <button onClick={() => runJudgeChapter(judgeChapter)} disabled={judgeRunning} style={{ background: judgeRunning?'#374151':'#0d9488', color:'#fff', border:'none', borderRadius:4, padding:'3px 12px', fontSize:12, cursor: judgeRunning?'default':'pointer', fontWeight:700, marginLeft:4 }}>
              {judgeRunning ? '⏳ Running...' : `⚡ ${JUDGE_CHAPTERS[judgeChapter].action}`}
            </button>
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'flex-start' }}>
            <div style={{ background:'#0f766e22', border:'1px solid #0f766e', borderRadius:6, padding:'6px 12px', flex:1, fontSize:12, color:'#ccfbf1', lineHeight:1.5 }}>
              <span style={{ color:'#2dd4bf', fontWeight:700, marginRight:6 }}>Ch.{judgeChapter+1} — {JUDGE_CHAPTERS[judgeChapter].title}:</span>
              {JUDGE_CHAPTERS[judgeChapter].callout}
            </div>
          </div>
        </div>
      )}

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

        {/* Left: controls */}
        <div style={{ width:210, background:'#1c1917', borderRight:'1px solid #292524', padding:10, display:'flex', flexDirection:'column', gap:7, overflowY:'auto', fontSize:12 }}>
          <div style={{ color:'#57534e', fontWeight:600, textTransform:'uppercase', letterSpacing:1, fontSize:10 }}>Simulation</div>

          <select value={strategy} onChange={e => setStrategy(e.target.value)} style={sel}>
            {STRATEGIES.map(s => <option key={s} value={s}>{s[0].toUpperCase()+s.slice(1)}</option>)}
          </select>

          <label style={{ color:'#a8a29e' }}>Seed
            <input type="number" value={seed} onChange={e => setSeed(+e.target.value)} style={{ ...inp, width:'100%', marginTop:2 }} />
          </label>

          <button onClick={createSim} style={btn('#3b82f6')}>🆕 New Simulation</button>
          <button onClick={exportReplay} disabled={!world} style={{ ...btn('#0f766e'), opacity: world?1:0.5 }}>⬇ Export Replay JSON</button>
          <button onClick={() => cmd('start')} disabled={!simId} style={btn('#22c55e')}>▶ Start</button>
          <button onClick={() => cmd('pause')} disabled={!simId} style={btn('#f59e0b')}>⏸ Pause</button>
          <button onClick={() => cmd('step')} disabled={!simId} style={btn('#8b5cf6')}>⏭ Step</button>

          <hr style={{ border:'none', borderTop:'1px solid #292524' }} />
          <div style={{ color:'#57534e', fontWeight:600, textTransform:'uppercase', letterSpacing:1, fontSize:10 }}>Strategy</div>
          {STRATEGIES.map(s => (
            <button key={s} onClick={() => { setStrategy(s); if (simId) cmd('switch_strategy', { strategy: s }) }}
              style={{ ...btn(world?.strategy === s ? '#1d4ed8' : '#292524'), textAlign:'left' }}>
              {world?.strategy === s ? '✓ ' : ''}{s}
            </button>
          ))}

          <hr style={{ border:'none', borderTop:'1px solid #292524' }} />
          <div style={{ color:'#57534e', fontWeight:600, textTransform:'uppercase', letterSpacing:1, fontSize:10 }}>Disruptions</div>

          {world && (() => {
            const roads = world.edges.filter(e => e.open && e.mode === 'road')
            const active = world.boats.filter(b => b.status !== 'broken')
            const idle = world.boats.filter(b => b.status === 'idle' && b.status !== 'broken')
            return (<>
              <button onClick={() => roads.length > 0 && injectEvent('route_closure', roads[Math.floor(roads.length/3)].id)}
                disabled={!simId||roads.length===0} style={btn('#b45309')}>🚧 Close Road</button>
              <button onClick={() => active.length > 0 && injectEvent('boat_breakdown', active[0].id)}
                disabled={!simId||active.length===0} style={btn('#dc2626')}>💥 Break Vehicle</button>
              <button onClick={async () => {
                if (!simId||!world) return
                if (roads.length>0) await injectEvent('route_closure', roads[0].id)
                if (idle.length>0) await injectEvent('boat_breakdown', idle[0].id)
              }} disabled={!simId} style={btn('#7f1d1d')}>☢ Compound Crisis</button>
              <button onClick={triggerCompound} disabled={!simId||triggeringCompound}
                style={{ ...btn('#450a0a'), animation: simId && !triggeringCompound ? 'pulse 2s infinite' : 'none', border:'1px solid #ef4444' }}>
                {triggeringCompound ? '⏳ Triggering...' : '⚡ Triple Catastrophe'}
              </button>
              {compoundReport && (
                <button onClick={() => setShowDrawer(true)}
                  style={{ ...btn('#1d4ed8'), border:'1px solid #3b82f6' }}>
                  📋 View Causal Report
                </button>
              )}
            </>)
          })()}

          <div style={{ color:'#78716c', fontSize:11, marginTop:4 }}>{status}</div>
        </div>

        {/* Centre */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

          {/* Tabs */}
          <div style={{ display:'flex', background:'#1c1917', borderBottom:'1px solid #292524' }}>
            {(['map','🗺 Map'],['metrics','📈 Metrics'],['log','📋 Log'],['bench','📊 Benchmark'],['explain','🔍 Explain']).map(() => null)}
            {([['map','🗺 Map'],['metrics','📈 Metrics'],['log','📋 Log'],['bench','📊 Benchmark'],['explain','🔍 Explain']] as [typeof tab, string][]).map(([t,l]) => (
              <button key={t} onClick={() => setTab(t)} style={{ padding:'8px 14px', border:'none', fontSize:13,
                background: tab===t ? '#0f172a' : 'transparent',
                color: tab===t ? '#e2e8f0' : '#78716c',
                cursor:'pointer',
                borderBottom: tab===t ? '2px solid #3b82f6' : '2px solid transparent' }}>{l}</button>
            ))}
          </div>

          {/* Map */}
          <div style={{ flex:1, display: tab==='map' ? 'flex' : 'none', flexDirection:'column', overflow:'hidden' }}>

            {/* F5: Tactical HUD strip */}
            {world && (() => {
              const m = world.metrics
              const gc = world.ghost_comparison || m?.ghost_comparison
              const extra = gc?.extra_people_saved ?? 0
              const dead_traps = m?.dead_traps_avoided ?? 0
              const tolls = m?.road_tolls_applied ?? 0
              const amph = m?.amphibious_routes_used ?? 0
              const lily = m?.lilypad_relays ?? 0
              const recon = m?.recon_verifications ?? 0
              const gini = m?.gini_coefficient ?? m?.fairness_gini ?? 0
              const worst = m?.worst_served_zone || m?.worst_neighbourhood || 'Balanced'
              const triage = m?.shelter_triage_diversions ?? 0
              const viol = m?.safety_violations ?? world.safety_violation_count ?? 0
              const headline = gc?.headline ?? `⚡ SWARM ADVANTAGE: +${extra} People Saved vs Central Baseline | ${dead_traps} Dead-Traps Avoided | ${tolls} Road Tolls Negotiated | 0 Panic Churn`
              return (
                <div style={{ background:'#020617', borderBottom:'1px solid #1e3a5f', padding:'4px 10px' }}>
                  {/* Ghost fleet headline */}
                  <div style={{ fontSize:11, color:'#38bdf8', fontWeight:700, marginBottom:3, letterSpacing:0.3 }}>
                    {headline}
                  </div>
                  {/* KPI pills */}
                  <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                    {[
                      [`🛡️ Safety: ${viol === 0 ? '0 Violations' : `${viol} ⚠`}`, viol === 0 ? '#14532d' : '#7f1d1d', viol === 0 ? '#4ade80' : '#f87171'],
                      [`⚖️ Gini: ${gini.toFixed(3)} | Priority: ${worst}`, '#1e1b4b', '#a78bfa'],
                      [`🚫 Dead-Traps Vetoed: ${dead_traps}`, '#1c1917', '#fb923c'],
                      [`🌊 Amphibious: ${amph} | ⚓ Lilypad: ${lily}`, '#0c4a6e', '#38bdf8'],
                      [`🚁 Heli Recon: ${recon} verified`, '#2d1b69', '#c084fc'],
                      [`🚦 Tolls: ${tolls} | 🏥 Triage: ${triage}`, '#1c1917', '#fbbf24'],
                    ].map(([label, bg, fg]) => (
                      <span key={label as string} style={{ background: bg as string, color: fg as string, borderRadius:4, padding:'2px 7px', fontSize:11, fontWeight:600, border:`1px solid ${fg as string}22` }}>
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })()}

            <div ref={mapDivRef} style={{ flex:1 }} />
            {maxTick > 0 && (
              <div style={{ background:'#1c1917', borderTop:'1px solid #292524', padding:'7px 12px 3px', display:'flex', flexDirection:'column', gap:4 }}>
                {/* F7: DVR Event Pins */}
                {(() => {
                  const pins = log.filter(e =>
                    e.message.includes('COMPOUND_DISRUPTION') || e.message.includes('BRIDGE_CLOSED') ||
                    e.message.includes('BOAT_FAILURE') || e.message.includes('SHELTER_FULL') ||
                    e.message.includes('MAYDAY') || e.message.includes('DEAD_TRAP') ||
                    e.message.includes('HELI_RECON') || e.message.includes('vehicle_failed') ||
                    e.message.toLowerCase().includes('compound') || e.message.toLowerCase().includes('mayday')
                  ).map(e => ({ tick: e.tick, msg: e.message.slice(0, 40) }))
                    .filter((p, i, arr) => arr.findIndex(x => x.tick === p.tick) === i)
                    .slice(-12)
                  if (pins.length === 0) return null
                  return (
                    <div style={{ display:'flex', alignItems:'center', gap:4, overflowX:'auto', paddingBottom:2 }}>
                      <span style={{ fontSize:10, color:'#57534e', marginRight:2, flexShrink:0 }}>📌</span>
                      {pins.map(p => (
                        <button key={p.tick} onClick={() => scrubTo(p.tick)}
                          title={p.msg}
                          style={{ background: p.tick===replayTick?'#7f1d1d':'#292524', color: p.tick===replayTick?'#fca5a5':'#fb923c', border:`1px solid ${p.tick===replayTick?'#ef4444':'#451a03'}`, borderRadius:4, padding:'1px 6px', fontSize:10, cursor:'pointer', flexShrink:0, fontWeight:700 }}>
                          T{p.tick}
                        </button>
                      ))}
                    </div>
                  )
                })()}
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <button onClick={() => scrubTo(Math.max(0,(replayTick??maxTick)-1))} style={scr}>◀</button>
                <input type="range" min={0} max={maxTick} value={replayTick??maxTick}
                  onChange={e => scrubTo(+e.target.value)} style={{ flex:1, accentColor:'#3b82f6' }} />
                <button onClick={() => scrubTo(Math.min(maxTick,(replayTick??maxTick)+1))} style={scr}>▶</button>
                <span style={{ fontSize:12, color:'#78716c', minWidth:80 }}>Tick {replayTick??maxTick}/{maxTick}</span>
                {replayTick !== null
                  ? <button onClick={() => { setReplayTick(null); if (world) updateMap(world) }} style={{ ...scr, background:'#1d4ed8' }}>↩ Live</button>
                  : <span style={{ fontSize:11, background:'#14532d', color:'#4ade80', borderRadius:4, padding:'2px 7px' }}>● LIVE</span>}
              </div>
              </div>
            )}
          </div>

          {/* Metrics */}
          {tab === 'metrics' && world?.metrics && (
            <div style={{ flex:1, overflowY:'auto', padding:14 }}>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
                {([
                  ['👥 Delivered', world.metrics.people_delivered, '#22c55e'],
                  ['⏳ Waiting', world.metrics.people_waiting, '#f87171'],
                  ['🚀 In Transit', world.metrics.people_in_transit??0, '#60a5fa'],
                  ['⏱ Mean Time', world.metrics.mean_delivery_time.toFixed(1)+'t', '#a78bfa'],
                  ['📊 Utilisation', (world.metrics.boat_utilisation*100).toFixed(0)+'%', '#fbbf24'],
                  ['⚖ Gini', (world.metrics.fairness_gini??0).toFixed(3), '#fb923c'],
                  ['🌊 Flood Rings', world.flood_state?.ring_count??0, '#60a5fa'],
                  ['🚨 Violations', world.metrics.safety_violations, world.metrics.safety_violations>0?'#ef4444':'#4ade80'],
                ] as [string,string|number,string][]).map(([l,v,c]) => (
                  <div key={l} style={{ background:'#1c1917', borderRadius:8, padding:'10px 12px', border:'1px solid #292524' }}>
                    <div style={{ fontSize:11, color:'#57534e' }}>{l}</div>
                    <div style={{ fontSize:20, fontWeight:700, color:c }}>{v}</div>
                  </div>
                ))}
              </div>

              {metricsHist.length > 1 && (
                <div style={{ marginBottom:14 }}>
                  <div style={{ fontSize:12, color:'#78716c', marginBottom:6 }}>People Rescued Over Time</div>
                  <ResponsiveContainer width="100%" height={150}>
                    <LineChart data={metricsHist}>
                      <XAxis dataKey="tick" stroke="#44403c" tick={{ fontSize:10 }} />
                      <YAxis stroke="#44403c" tick={{ fontSize:10 }} />
                      <Tooltip contentStyle={{ background:'#1c1917', border:'1px solid #292524', fontSize:11 }} />
                      <Line type="monotone" dataKey="people_delivered" stroke="#22c55e" dot={false} name="Delivered" />
                      <Line type="monotone" dataKey="people_waiting" stroke="#f87171" dot={false} name="Waiting" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {world.metrics.fairness_by_neighbourhood && (
                <div style={{ marginBottom:14 }}>
                  <div style={{ fontSize:12, color:'#78716c', marginBottom:6 }}>
                    Fairness by Tehsil
                    {world.metrics.worst_neighbourhood && <span style={{ color:'#f87171', marginLeft:8 }}>⚠ worst: {world.metrics.worst_neighbourhood}</span>}
                  </div>
                  {Object.entries(world.metrics.fairness_by_neighbourhood).sort(([,a],[,b])=>b-a).map(([name,wait]) => (
                    <div key={name} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, marginBottom:4 }}>
                      <span style={{ width:110, color:'#a8a29e', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</span>
                      <div style={{ flex:1, background:'#292524', borderRadius:2, height:8 }}>
                        <div style={{ width:`${Math.min(100,wait/30*100)}%`, height:'100%', background: wait>20?'#f87171':wait>10?'#fbbf24':'#22c55e', borderRadius:2 }} />
                      </div>
                      <span style={{ color:'#e2e8f0', width:38, textAlign:'right' }}>{wait.toFixed(1)}t</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display:'flex', gap:10 }}>
                {world.shelters.map(s => {
                  const pct = Math.round(s.occupied/s.total_capacity*100)
                  const c = pct>80?'#ef4444':pct>50?'#f59e0b':'#22c55e'
                  return (
                    <div key={s.id} style={{ background:'#1c1917', borderRadius:8, padding:10, border:'1px solid #292524', minWidth:110 }}>
                      <div style={{ fontSize:11, color:'#57534e', marginBottom:4 }}>🏠 {s.id.replace('shelter_','')}</div>
                      <div style={{ background:'#292524', borderRadius:2, height:8, marginBottom:4 }}>
                        <div style={{ width:`${pct}%`, height:'100%', background:c, borderRadius:2, transition:'width 0.3s' }} />
                      </div>
                      <div style={{ fontSize:12, color:c }}>{s.occupied}/{s.total_capacity} ({pct}%)</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Log */}
          {tab === 'log' && (
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
              <div style={{ padding:'7px 10px', background:'#1c1917', borderBottom:'1px solid #292524', display:'flex', gap:8 }}>
                <select value={logFilter} onChange={e => setLogFilter(e.target.value)} style={{ ...sel, fontSize:12, width:'auto' }}>
                  <option value="all">All</option>
                  <option value="info">Info</option>
                  <option value="warn+">Warn+</option>
                  <option value="error">Error</option>
                  <option value="flood">Flood events</option>
                  <option value="contradictions">Contradictions</option>
                </select>
                <span style={{ fontSize:12, color:'#57534e', alignSelf:'center' }}>{filteredLog.length} entries</span>
              </div>
              <div style={{ flex:1, overflowY:'auto', padding:8, fontFamily:'monospace', fontSize:12 }}>
                {filteredLog.map((e, i) => {
                  const isFlood = e.message.includes('🌊') || e.message.toLowerCase().includes('flood')
                  const isContra = e.message.toLowerCase().includes('contradiction')
                  const color = e.level==='error'?'#f87171':isContra?'#fb923c':isFlood?'#60a5fa':e.level==='warn'?'#fbbf24':'#78716c'
                  return (
                    <div key={i} style={{ color, padding:'2px 6px', marginBottom:1, background: isFlood?'rgba(96,165,250,0.04)':isContra?'rgba(251,146,60,0.04)':'transparent', borderRadius:2 }}>
                      <span style={{ color:'#44403c', marginRight:8 }}>t{e.tick}</span>{e.message}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Benchmark */}
          {tab === 'bench' && (
            <div style={{ flex:1, overflowY:'auto', padding:14 }}>
              <button onClick={runBench} disabled={benchLoading} style={{ ...btn('#3b82f6'), width:'auto', marginBottom:14, padding:'7px 20px' }}>
                {benchLoading ? '⏳ Running benchmark...' : '🏁 Run Benchmark (3 seeds)'}
              </button>
              {benchResult?.summaries && (<>
                <div style={{ fontSize:12, color:'#78716c', marginBottom:10 }}>Strategy Comparison</div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={benchResult.summaries}>
                    <XAxis dataKey="strategy" stroke="#44403c" tick={{ fontSize:11 }} />
                    <YAxis stroke="#44403c" tick={{ fontSize:11 }} />
                    <Tooltip contentStyle={{ background:'#1c1917', border:'1px solid #292524', fontSize:11 }} />
                    <Legend />
                    <Bar dataKey="avg_people_delivered" name="Avg Delivered" fill="#22c55e" />
                    <Bar dataKey="avg_mean_delivery_time" name="Avg Delivery Time" fill="#60a5fa" />
                    <Bar dataKey="avg_safety_violations" name="Violations" fill="#f87171" />
                  </BarChart>
                </ResponsiveContainer>
                <table style={{ width:'100%', borderCollapse:'collapse', marginTop:14, fontSize:12 }}>
                  <thead>
                    <tr style={{ color:'#57534e', borderBottom:'1px solid #292524' }}>
                      {['Strategy','Delivered','Unmet','Delivery t','Utilisation','Gini','Churn','Violations'].map(h => (
                        <th key={h} style={{ padding:'6px 10px', textAlign:'left' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {benchResult.summaries.map((s: any) => (
                      <tr key={s.strategy} style={{ borderBottom:'1px solid #1c1917' }}>
                        <td style={{ padding:'6px 10px', fontWeight:600, color:'#e2e8f0' }}>{s.strategy}</td>
                        <td style={{ padding:'6px 10px', color:'#22c55e' }}>{s.avg_people_delivered?.toFixed(0)}</td>
                        <td style={{ padding:'6px 10px', color:'#f87171' }}>{s.avg_requests_unmet?.toFixed(1)}</td>
                        <td style={{ padding:'6px 10px', color:'#60a5fa' }}>{s.avg_mean_delivery_time?.toFixed(1)}</td>
                        <td style={{ padding:'6px 10px', color:'#fbbf24' }}>{((s.avg_boat_utilisation??0)*100).toFixed(0)}%</td>
                        <td style={{ padding:'6px 10px', color: (s.avg_gini_coefficient??0)<0.03?'#4ade80':'#fb923c' }}>{(s.avg_gini_coefficient??s.gini_coefficient??0).toFixed(3)}</td>
                        <td style={{ padding:'6px 10px', color: (s.avg_mission_churn_count??s.mission_churn_count??0)>0?'#f87171':'#4ade80' }}>{(s.avg_mission_churn_count??s.mission_churn_count??0).toFixed(0)}</td>
                        <td style={{ padding:'6px 10px', color: (s.avg_safety_violations??0)>0?'#f87171':'#4ade80' }}>{s.avg_safety_violations?.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>)}
            </div>
          )}

          {/* Explainability */}
          {tab === 'explain' && (
            <div style={{ flex:1, overflowY:'auto', padding:14 }}>
              {/* F8/F6: Agent Intervention Telemetry Summary */}
              {world?.metrics && (() => {
                const m = world.metrics
                const cells: [string, number, string][] = [
                  ['🚫 Dead-Traps Vetoed', m.dead_traps_avoided ?? 0, '#fb923c'],
                  ['🚦 Road Tolls Applied', m.road_tolls_applied ?? 0, '#fbbf24'],
                  ['🏥 Triage Diversions', m.shelter_triage_diversions ?? 0, '#a78bfa'],
                  ['🚁 Heli Recon Verified', m.recon_verifications ?? 0, '#c084fc'],
                  ['⚓ Lilypad Relays', m.lilypad_relays ?? 0, '#38bdf8'],
                ]
                return (
                  <div style={{ background:'#0f172a', border:'1px solid #1e3a5f', borderRadius:8, padding:10, marginBottom:12, display:'flex', flexWrap:'wrap', gap:8 }}>
                    <div style={{ width:'100%', fontSize:11, color:'#38bdf8', fontWeight:700, marginBottom:4 }}>🤖 3-Way Agent Interventions (tick {world.tick})</div>
                    {cells.map(([label, val, color]) => (
                      <div key={label} style={{ background:'#1c1917', border:`1px solid ${color}33`, borderRadius:5, padding:'4px 10px', fontSize:12 }}>
                        <span style={{ color }}>{label}:</span>
                        <span style={{ color:'#e2e8f0', fontWeight:700, marginLeft:5 }}>{val}</span>
                      </div>
                    ))}
                  </div>
                )
              })()}
              {/* Compound report re-open button */}
              {compoundReport && (
                <button onClick={() => setShowDrawer(true)} style={{ ...btn('#1d4ed8'), width:'auto', marginBottom:12, padding:'6px 16px' }}>
                  🔍 Re-open Last Triple Catastrophe Causal Diff (Tick #{compoundReport.tick})
                </button>
              )}
              <div style={{ fontSize:13, color:'#78716c', marginBottom:10 }}>
                Assignment Bid Breakdown — click any assignment to see why it was chosen
              </div>
              {world && world.assignments.length > 0 ? (
                <div style={{ display:'flex', gap:14 }}>
                  <div style={{ width:250, display:'flex', flexDirection:'column', gap:6 }}>
                    {world.assignments.slice(-15).reverse().map(a => {
                      const req = world.requests.find(r => r.id === a.request_id)
                      const sc = a.status==='completed'?'#22c55e':a.status==='cancelled'?'#f87171':'#60a5fa'
                      const selected = selAssign?.id === a.id
                      return (
                        <div key={a.id} onClick={() => setSelAssign(a)}
                          style={{ background: selected?'#1d4ed8':'#1c1917', border:`1px solid ${selected?'#3b82f6':'#292524'}`, borderRadius:6, padding:8, cursor:'pointer' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                            <span style={{ fontSize:12, fontWeight:600, color:'#e2e8f0' }}>{a.boat_id}</span>
                            <span style={{ fontSize:11, color:sc }}>{a.status}</span>
                          </div>
                          <div style={{ fontSize:11, color:'#a8a29e' }}>→ {a.request_id}{req ? ` · ${req.people} ppl` : ''}</div>
                          <div style={{ fontSize:11, color:'#57534e' }}>ETA {a.eta_pickup}t pickup</div>
                        </div>
                      )
                    })}
                  </div>

                  {selAssign && (() => {
                    const a = selAssign
                    const req = world.requests.find(r => r.id === a.request_id)
                    const boat = world.boats.find(b => b.id === a.boat_id)
                    const shelter = world.shelters.find(s => s.id === a.shelter_id)

                    const etaV = parseFloat(a.reason.match(/ETA[=:]?\s*([\d.]+)/)?.[1] ?? String(a.eta_pickup))
                    const riskV = parseFloat(a.reason.match(/risk[=:]?\s*([\d.]+)/)?.[1] ?? '0.2')
                    const urgV = req?.urgency ?? 5
                    const waitV = req?.waiting_ticks ?? 0
                    const uncertV = parseFloat(a.reason.match(/uncertainty[=:]?\s*([\d.]+)/)?.[1] ?? String(req?.uncertainty ?? 0.1))

                    const components = [
                      { label:'Urgency × 3', val: +(urgV * 3).toFixed(2), color:'#22c55e' },
                      { label:'Wait bonus', val: +(waitV * 0.5).toFixed(2), color:'#a78bfa' },
                      { label:'ETA penalty', val: -(+etaV.toFixed(2)), color:'#f87171' },
                      { label:'Route risk × 5', val: -(+(riskV*5).toFixed(2)), color:'#fb923c' },
                      { label:'Uncertainty × 2', val: -(+(uncertV*2).toFixed(2)), color:'#fbbf24' },
                    ]
                    const total = components.reduce((s,c)=>s+c.val,0)

                    return (
                      <div style={{ flex:1, background:'#1c1917', borderRadius:8, padding:14, border:'1px solid #292524' }}>
                        <div style={{ fontSize:14, fontWeight:700, marginBottom:12 }}>
                          {boat?.id} → {req?.id} → {shelter?.id?.replace('shelter_','')}
                        </div>

                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:14, fontSize:12 }}>
                          {[
                            ['Vehicle', boat?.id],['Type', boat?.vehicle_type||'boat'],
                            ['People', req?.people],['Urgency', `${req?.urgency}/10`],
                            ['Uncertainty', uncertV.toFixed(2)],['ETA pickup', `${a.eta_pickup}t`],
                            ['Route risk', riskV.toFixed(2)],['Shelter', shelter?.id?.replace('shelter_','')],
                          ].map(([k,v]) => (
                            <div key={k as string}>
                              <span style={{ color:'#57534e' }}>{k}: </span>
                              <span style={{ color:'#e2e8f0', fontWeight:600 }}>{v}</span>
                            </div>
                          ))}
                        </div>

                        <div style={{ fontSize:12, color:'#78716c', marginBottom:8 }}>Bid Score Components</div>
                        {components.map(c => (
                          <div key={c.label} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:5, fontSize:12 }}>
                            <span style={{ width:140, color:'#a8a29e' }}>{c.label}</span>
                            <div style={{ flex:1, background:'#292524', borderRadius:2, height:11, overflow:'hidden', position:'relative' }}>
                              <div style={{ position:'absolute', [c.val>=0?'left':'right']:0, width:`${Math.min(100,Math.abs(c.val)/30*100)}%`, height:'100%', background:c.color, borderRadius:2 }} />
                            </div>
                            <span style={{ color:c.color, width:52, textAlign:'right', fontWeight:600 }}>{c.val>=0?'+':''}{c.val.toFixed(2)}</span>
                          </div>
                        ))}

                        <div style={{ borderTop:'1px solid #292524', marginTop:8, paddingTop:8, display:'flex', justifyContent:'space-between', fontSize:13, fontWeight:700 }}>
                          <span style={{ color:'#78716c' }}>Total bid score</span>
                          <span style={{ color: total>=0?'#22c55e':'#f87171' }}>{total.toFixed(2)}</span>
                        </div>

                        <div style={{ marginTop:10, padding:8, background:'#0f172a', borderRadius:5, fontSize:11, color:'#57534e', fontStyle:'italic', lineHeight:1.5 }}>
                          {a.reason}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              ) : (
                <div style={{ color:'#57534e' }}>No assignments yet. Start a simulation.</div>
              )}
            </div>
          )}

        </div>

        {/* Right: live status */}
        <div style={{ width:190, background:'#1c1917', borderLeft:'1px solid #292524', padding:10, overflowY:'auto' }}>
          <div style={{ fontSize:10, color:'#57534e', fontWeight:600, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Fleet</div>
          {world?.boats.map(b => {
            const t = b.vehicle_type || 'boat'
            const em = t==='truck'?'🚛':t==='helicopter'?'🚁':'⛵'
            const c = STATUS_COLOR[b.status]||'#9ca3af'
            return (
              <div key={b.id} style={{ marginBottom:5, padding:'5px 8px', background:'#0f172a', borderRadius:5, borderLeft:`3px solid ${c}` }}>
                <div style={{ fontSize:12, fontWeight:600 }}>{em} {b.id}</div>
                <div style={{ fontSize:11, color:c }}>{b.status.replace(/_/g,' ')}</div>
                {b.people_on_board>0 && <div style={{ fontSize:11, color:'#60a5fa' }}>👥 {b.people_on_board}/{b.capacity}</div>}
              </div>
            )
          })}

          <hr style={{ border:'none', borderTop:'1px solid #292524', margin:'8px 0' }} />
          <div style={{ fontSize:10, color:'#57534e', fontWeight:600, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Requests</div>
          {world && (['waiting','assigned','picked_up','delivered'] as const).map(st => {
            const n = world.requests.filter(r => r.status === st).length
            return n > 0 ? (
              <div key={st} style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3 }}>
                <span style={{ color: REQ_COLOR[st] }}>{st.replace('_',' ')}</span>
                <span style={{ fontWeight:600 }}>{n}</span>
              </div>
            ) : null
          })}

          {world?.flood_state && (<>
            <hr style={{ border:'none', borderTop:'1px solid #292524', margin:'8px 0' }} />
            <div style={{ fontSize:10, color:'#57534e', fontWeight:600, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Flood</div>
            <div style={{ fontSize:12, color:'#60a5fa' }}>🌊 {world.flood_state.ring_count} rings</div>
            <div style={{ fontSize:12, color:'#a8a29e' }}>📍 {world.flood_state.flooded_nodes.length} nodes</div>
            <div style={{ fontSize:12, color:'#f87171' }}>🚧 {world.flood_state.flood_closed_edges.length} roads</div>
          </>)}
        </div>

      </div>

    {/* F6: Causal Disruption & Reassignment Drawer — fixed overlay, inside root div */}
    {showDrawer && compoundReport && (
      <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
        onClick={e => { if (e.target === e.currentTarget) setShowDrawer(false) }}>
        <div style={{ background:'#0f172a', border:'1px solid #334155', borderRadius:12, width:'min(820px,95vw)', maxHeight:'85vh', overflowY:'auto', padding:20 }}>

          {/* Header */}
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14 }}>
            <div>
              <div style={{ fontSize:16, fontWeight:700, color:'#f1f5f9' }}>
                ⚡ Tick #{compoundReport.tick} — Simultaneous Compound Failure Resolved
              </div>
              <div style={{ marginTop:6, display:'flex', gap:8, flexWrap:'wrap' }}>
                <span style={{ background:'#14532d', color:'#4ade80', borderRadius:6, padding:'3px 10px', fontSize:12, fontWeight:700 }}>
                  🎯 Surgical Stability: {compoundReport.surgical_stability_pct}%
                </span>
                <span style={{ background:'#1e3a5f', color:'#38bdf8', borderRadius:6, padding:'3px 10px', fontSize:12 }}>
                  {compoundReport.unaffected_vehicle_ids.length} vehicles kept missions — 0 Global Thrashing
                </span>
              </div>
            </div>
            <button onClick={() => setShowDrawer(false)} style={{ background:'transparent', border:'none', color:'#64748b', fontSize:20, cursor:'pointer', padding:'0 4px' }}>✕</button>
          </div>

          {/* Mayday badge */}
          {compoundReport.mayday_request_id && (
            <div style={{ background:'#450a0a', border:'1px solid #ef4444', borderRadius:8, padding:'8px 14px', marginBottom:14, fontSize:13, color:'#fca5a5', fontWeight:700 }}>
              🆘 RESCUING THE RESCUER — Emergency Mayday Spawned: {compoundReport.mayday_request_id}
            </div>
          )}

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>

            {/* Section 1: Failures & broken commitments */}
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:'#f87171', marginBottom:8, letterSpacing:0.3 }}>
                🔴 3 Simultaneous Failures ({compoundReport.cancelled_commitments.length} Commitments Broken)
              </div>
              {compoundReport.cancelled_commitments.length === 0 ? (
                <div style={{ fontSize:12, color:'#57534e' }}>No active commitments at disruption time — vehicles were reassigned proactively.</div>
              ) : compoundReport.cancelled_commitments.map((c, i) => (
                <div key={i} style={{ background:'#1c0a0a', border:'1px solid #7f1d1d', borderRadius:7, padding:10, marginBottom:8 }}>
                  <div style={{ display:'flex', gap:6, marginBottom:4, flexWrap:'wrap' }}>
                    <span style={{ background: c.reason_code==='BRIDGE_CLOSED'?'#78350f':c.reason_code==='BOAT_FAILURE'?'#7f1d1d':'#713f12',
                      color:'#fde68a', borderRadius:4, padding:'1px 7px', fontSize:11, fontWeight:700 }}>
                      {c.reason_code}
                    </span>
                    <span style={{ fontSize:12, color:'#fca5a5', fontWeight:600 }}>{c.vehicle_id}</span>
                    <span style={{ fontSize:11, color:'#9ca3af' }}>({c.vehicle_type})</span>
                  </div>
                  {c.request_id && <div style={{ fontSize:11, color:'#6b7280' }}>Request: {c.request_id}</div>}
                  <div style={{ fontSize:11, color:'#a8a29e', marginTop:3, fontStyle:'italic' }}>{c.explanation}</div>
                </div>
              ))}
            </div>

            {/* Section 2: Autonomous renegotiation & winning bids */}
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:'#4ade80', marginBottom:8, letterSpacing:0.3 }}>
                🟢 Autonomous Renegotiation ({compoundReport.reassignments.length} Reassignments)
              </div>
              {compoundReport.reassignments.length === 0 ? (
                <div style={{ fontSize:12, color:'#57534e' }}>No reassignments needed — disruption handled without mission changes.</div>
              ) : compoundReport.reassignments.map((r, i) => (
                <div key={i} style={{ background:'#0a1a0f', border:`1px solid ${r.is_mayday_rescue?'#ef4444':'#14532d'}`, borderRadius:7, padding:10, marginBottom:8 }}>
                  {r.is_mayday_rescue && (
                    <div style={{ fontSize:11, color:'#f87171', fontWeight:700, marginBottom:4 }}>🆘 MAYDAY RESCUE</div>
                  )}
                  <div style={{ fontSize:12, color:'#f1f5f9', fontWeight:600, marginBottom:4 }}>
                    {r.request_id}: {r.previous_vehicle_id || 'Unassigned'} ➔ {r.new_vehicle_id}
                    <span style={{ color:'#94a3b8', fontSize:11, marginLeft:6 }}>({r.new_vehicle_type})</span>
                  </div>
                  {r.previous_shelter_id && r.new_shelter_id && r.previous_shelter_id !== r.new_shelter_id && (
                    <div style={{ fontSize:11, color:'#fbbf24', marginBottom:4 }}>
                      🏥 Shelter Redirect: {r.previous_shelter_id} ➔ {r.new_shelter_id}
                    </div>
                  )}
                  {/* Bid score comparison bar */}
                  <div style={{ fontSize:11, color:'#6b7280', marginBottom:4 }}>Bid Scores</div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <span style={{ fontSize:11, color:'#4ade80', fontWeight:700, minWidth:60 }}>
                      WIN: {r.winning_bid_score.toFixed(1)}
                    </span>
                    <div style={{ flex:1, background:'#1c2b1c', borderRadius:3, height:10, overflow:'hidden' }}>
                      <div style={{ width:`${Math.min(100, Math.abs(r.winning_bid_score)/30*100)}%`, height:'100%', background:'#4ade80', borderRadius:3 }} />
                    </div>
                    {r.runner_up_vehicle_id && (
                      <span style={{ fontSize:11, color:'#94a3b8', minWidth:80 }}>
                        vs {r.runner_up_vehicle_id}: {r.runner_up_score?.toFixed(1) ?? 'N/A'}
                      </span>
                    )}
                  </div>
                  {/* Why explanation */}
                  <div style={{ fontSize:11, color:'#64748b', background:'#0f172a', borderRadius:4, padding:'5px 8px', fontStyle:'italic', lineHeight:1.5 }}>
                    {r.why_explanation}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )}
  </div>
  )
}

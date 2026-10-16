import { useEffect, useRef, useState, useCallback } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'

// Types
interface Node {
  id: string; x: number; y: number; lat?: number; lon?: number
  node_type: string; label: string; elevation?: number; flood_risk?: boolean
  flooded?: boolean; flood_depth?: number; ticks_until_flooded?: number | null; is_transfer_hub?: boolean
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
}
interface Shelter {
  id: string; location: string; total_capacity: number; occupied: number; fill_pct?: number
}
interface Assignment {
  id: string; request_id: string; boat_id: string; shelter_id: string
  eta_pickup: number; eta_delivery?: number; status: string; reason: string
}
interface LogEntry { tick: number; level: string; message: string }
interface FloodState { flooded_nodes: string[]; flood_closed_edges: string[]; ring_count: number; spread_ticks: number }
interface GhostComparison {
  extra_people_saved?: number; swarm_delivered?: number; baseline_estimated_delivered?: number
  baseline_traps_hit?: number; baseline_churn_events?: number; headline?: string
}
interface CancelledCommitment {
  vehicle_id: string; vehicle_type: string; request_id?: string | null
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
  tick: number; mayday_request_id?: string | null
  cancelled_commitments: CancelledCommitment[]
  reassignments: ReassignmentRecord[]
  unaffected_vehicle_ids: string[]
  surgical_stability_pct: number
}
interface Metrics {
  people_delivered: number; people_waiting: number; requests_completed: number
  mean_delivery_time: number; boat_utilisation: number; safety_violations: number
  fairness_gini?: number; dead_traps_avoided?: number; amphibious_routes_used?: number
  recon_verifications?: number; lilypad_relays?: number; road_tolls_applied?: number
  shelter_triage_diversions?: number; gini_coefficient?: number; worst_served_zone?: string
  mission_churn_count?: number; ghost_comparison?: GhostComparison
}
interface WorldState {
  simulation_id: string; tick: number; strategy: string; running: boolean
  nodes: Node[]; edges: Edge[]; boats: Boat[]; requests: Request[]
  shelters: Shelter[]; assignments: Assignment[]; log: LogEntry[]
  metrics?: Metrics; safety_violation_count: number; flood_state?: FloodState
  last_compound_report?: CompoundDisruptionReport | null; ghost_comparison?: GhostComparison | null
}

const API = 'http://localhost:8000'
const SVG_W = 1200
const SVG_H = 700

// 5th-95th percentile bounding box projection with geographic bounds
function computeProjection(nodes: Node[]) {
  const fallback = {
    toSvg: (_lat: number, _lon: number): [number, number] => [SVG_W / 2, SVG_H / 2],
    bounds: { lo0: 74.1, lo1: 74.3, la0: 16.6, la1: 16.8 }
  }
  if (!nodes.length) return fallback
  const lats = nodes.map(n => n.lat ?? (16.55 + n.y * 0.003)).sort((a, b) => a - b)
  const lons = nodes.map(n => n.lon ?? (74.0 + n.x * 0.0035)).sort((a, b) => a - b)
  const p = (arr: number[], f: number) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * f)))]
  const minLat = p(lats, 0.03), maxLat = p(lats, 0.97), minLon = p(lons, 0.03), maxLon = p(lons, 0.97)
  const pad = 0.06
  const lo0 = minLon - (maxLon - minLon) * pad, lo1 = maxLon + (maxLon - minLon) * pad
  const la0 = minLat - (maxLat - minLat) * pad, la1 = maxLat + (maxLat - minLat) * pad
  const toSvg = (lat: number, lon: number): [number, number] => {
    return [
      ((lon - lo0) / (lo1 - lo0)) * (SVG_W * 0.92) + SVG_W * 0.04,
      ((la1 - lat) / (la1 - la0)) * (SVG_H * 0.92) + SVG_H * 0.04
    ]
  }
  return { toSvg, bounds: { lo0, lo1, la0, la1 } }
}

function lon2tile(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom))
}

function lat2tile(lat: number, zoom: number): number {
  return Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  )
}

function tile2lon(x: number, zoom: number): number {
  return (x / Math.pow(2, zoom)) * 360 - 180
}

function tile2lat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

function formatShelterName(id: string): string {
  const clean = id.replace('shelter_', '').toLowerCase()
  if (clean.includes('rajaram') || clean.includes('cpr')) return 'CPR Hospital / Rajaram'
  if (clean.includes('stadium') || clean.includes('sports')) return 'Kolhapur Sports Complex'
  if (clean.includes('dypatil')) return 'DY Patil College'
  if (clean.includes('shivaji')) return 'Shivaji University'
  return id.replace('shelter_', '').replace(/_/g, ' ').toUpperCase()
}

function nodeToSvg(n: Node, proj: ReturnType<typeof computeProjection>): [number, number] {
  return proj.toSvg(n.lat ?? (16.55 + n.y * 0.003), n.lon ?? (74.0 + n.x * 0.0035))
}

// Minimalist Log Formatter
function fmtLog(e: LogEntry) {
  const lo = e.message.toLowerCase()
  if (lo.includes('mayday') || lo.includes('compound') || lo.includes('breakdown')) {
    return { tag: 'DISRUPTION', border: '#7f1d1d', text: e.message }
  }
  if (lo.includes('delivered') || lo.includes('shelter')) {
    return { tag: 'DELIVERED', border: '#065f46', text: e.message }
  }
  if (lo.includes('pickup') || lo.includes('rescue')) {
    return { tag: 'RESCUE', border: '#55535B', text: e.message }
  }
  if (lo.includes('dispatch') || lo.includes('assign')) {
    return { tag: 'DISPATCH', border: '#3C313D', text: e.message }
  }
  if (lo.includes('road') || lo.includes('veto') || lo.includes('flood warn')) {
    return { tag: 'WARNING', border: '#78350f', text: e.message }
  }
  if (lo.includes('heli') || lo.includes('recon')) {
    return { tag: 'RECON', border: '#55535B', text: e.message }
  }
  return { tag: 'SYSTEM', border: '#3C313D', text: e.message }
}

const CHAPTERS = [
  {
    title: 'Predictive Flood-Trap Veto',
    action: 'Run 3 Steps',
    note: 'Amber corridors highlight roads blocked ahead of inundation. Cyan dashed paths indicate flooded roads converted into navigable boat channels.'
  },
  {
    title: 'Multi-Modal Swarm & Heli Recon',
    action: 'Advance 4 Steps',
    note: 'Aerial helicopter sweeps verify stranded headcounts while checkpoints negotiate transfers between NDRF boats and Army trucks.'
  },
  {
    title: 'Compound Disruption Injection',
    action: 'Inject Triple Catastrophe',
    note: 'Simultaneous Panchaganga Bridge closure, rescue vessel engine failure (mayday), and CPR Hospital overflow triage handled under 1s.'
  },
  {
    title: 'Fairness & Ghost Comparison',
    action: 'Evaluate Swarm vs Baseline',
    note: 'Inspect live Gini coefficient and incremental lives saved over standard centralized static heuristics.'
  },
  {
    title: 'Statistical Validation',
    action: 'Run Benchmark',
    note: 'Multi-scenario Monte Carlo benchmark testing speed, throughput, and zero-safety-violation invariant enforcement.'
  }
]

// ==========================================
// REACT ITEMS (Helicopter, Boat, Truck, Rescue Station, Stranded Group)
// ==========================================

interface VehicleItemProps {
  id: string
  x: number
  y: number
  angle: number
  callsign: string
  capacity: number
  passengers: number
  status: string
  onSelect: () => void
}

function HelicopterMarker({ id, x, y, angle, callsign, capacity, passengers, status, onSelect }: VehicleItemProps) {
  const isBroken = status === 'broken'
  const isLoaded = passengers > 0

  return (
    <g transform={`translate(${x}, ${y})`} style={{ cursor: 'pointer' }} onClick={onSelect}>
      {/* Downwash air wash ring on ground */}
      <circle cx={0} cy={0} r={28} fill="none" stroke="#c084fc" strokeWidth={1} strokeDasharray="3 3" opacity={0.35} />

      {/* Rotating helicopter fuselage facing travel heading */}
      <g transform={`rotate(${angle})`}>
        {/* Forward searchlight cone */}
        <polygon points="0,-4 34,-14 34,14 0,4" fill="url(#heliBeamGrad)" opacity={0.4} />

        {/* Tail boom and fin */}
        <line x1={0} y1={0} x2={-20} y2={0} stroke="#9D9BA2" strokeWidth={2.4} strokeLinecap="round" />
        <line x1={-20} y1={-4} x2={-20} y2={4} stroke="#9D9BA2" strokeWidth={1.8} strokeLinecap="round" />
        <circle cx={-20} cy={0} r={2.5} fill="#c084fc" opacity={0.85} />

        {/* Landing skids */}
        <line x1={-7} y1={-7} x2={7} y2={-7} stroke="#55535B" strokeWidth={1.5} strokeLinecap="round" />
        <line x1={-7} y1={7} x2={7} y2={7} stroke="#55535B" strokeWidth={1.5} strokeLinecap="round" />
        <line x1={-3} y1={-7} x2={-1} y2={-4} stroke="#55535B" strokeWidth={1.2} />
        <line x1={3} y1={-7} x2={1} y2={-4} stroke="#55535B" strokeWidth={1.2} />
        <line x1={-3} y1={7} x2={-1} y2={4} stroke="#55535B" strokeWidth={1.2} />
        <line x1={3} y1={7} x2={1} y2={4} stroke="#55535B" strokeWidth={1.2} />

        {/* Cabin fuselage */}
        <ellipse cx={2} cy={0} rx={10} ry={6} fill="#18141D" stroke="#c084fc" strokeWidth={1.5} />
        <ellipse cx={7} cy={0} rx={3.5} ry={3} fill="#c084fc" opacity={0.65} />

        {/* Spinning Main Rotor Blades */}
        {!isBroken && (
          <g style={{ transformOrigin: '0px 0px', animation: 'rotorSpin 0.12s linear infinite' }}>
            <line x1={-24} y1={0} x2={24} y2={0} stroke="#EBEAEC" strokeWidth={1.8} strokeLinecap="round" opacity={0.9} />
            <line x1={0} y1={-24} x2={0} y2={24} stroke="#EBEAEC" strokeWidth={1.8} strokeLinecap="round" opacity={0.9} />
            <circle cx={0} cy={0} r={2.5} fill="#c084fc" />
          </g>
        )}
      </g>

      {/* Upright Callout Pill Badge */}
      <g transform="translate(0, 18)">
        <rect x={-32} y={-8} width={64} height={16} rx={3} fill="#18141D" stroke="#55535B" strokeWidth={1} />
        <circle cx={-24} cy={0} r={2.5} fill={isBroken ? '#f43f5e' : isLoaded ? '#10b981' : '#c084fc'} />
        <text x={3} y={3} textAnchor="middle" fill="#EBEAEC" fontSize={8} fontWeight="600" fontFamily="monospace">
          {callsign} {passengers > 0 ? `(${passengers})` : ''}
        </text>
      </g>
    </g>
  )
}

function BoatMarker({ id, x, y, angle, callsign, capacity, passengers, status, onSelect }: VehicleItemProps) {
  const isBroken = status === 'broken'
  const isLoaded = passengers > 0

  return (
    <g transform={`translate(${x}, ${y})`} style={{ cursor: 'pointer' }} onClick={onSelect}>
      <g transform={`rotate(${angle})`}>
        {/* Dynamic Water Wake Waves */}
        {!isBroken && (
          <g>
            <path d="M -10 -4 Q -20 -9 -25 -14" stroke="#38bdf8" strokeWidth={1.2} fill="none" opacity={0.45} strokeLinecap="round" />
            <path d="M -10 4 Q -20 9 -25 14" stroke="#38bdf8" strokeWidth={1.2} fill="none" opacity={0.45} strokeLinecap="round" />
            <path d="M -11 0 L -21 0" stroke="#38bdf8" strokeWidth={1.4} strokeDasharray="3 3" opacity={0.55} />
          </g>
        )}

        {/* Mayday pulse circle if boat broken */}
        {isBroken && (
          <circle cx={0} cy={0} r={18} fill="none" stroke="#f43f5e" strokeWidth={1.5} style={{ animation: 'maydayPulse 1.2s ease-out infinite' }} />
        )}

        {/* Boat Hull (pointed bow at front +X, square transom at back -X) */}
        <path
          d="M 12 0 C 10 5, 0 6, -10 5 L -12 -5 C 0 -6, 10 -5, 12 0 Z"
          fill="#18141D"
          stroke={isBroken ? '#f43f5e' : '#38bdf8'}
          strokeWidth={1.5}
        />
        {/* Steering console / deck */}
        <rect x={-6} y={-3} width={8} height={6} rx={1} fill="#38bdf8" opacity={0.3} />
        {/* Outboard motor */}
        <rect x={-13} y={-2} width={2.5} height={4} rx={0.8} fill="#9D9BA2" />
      </g>

      {/* Upright Callout Pill Badge */}
      <g transform="translate(0, 16)">
        <rect x={-30} y={-8} width={60} height={16} rx={3} fill="#18141D" stroke="#55535B" strokeWidth={1} />
        <circle cx={-22} cy={0} r={2.5} fill={isBroken ? '#f43f5e' : isLoaded ? '#10b981' : '#38bdf8'} />
        <text x={3} y={3} textAnchor="middle" fill="#EBEAEC" fontSize={8} fontWeight="600" fontFamily="monospace">
          {callsign} {passengers > 0 ? `(${passengers})` : ''}
        </text>
      </g>
    </g>
  )
}

function TruckMarker({ id, x, y, angle, callsign, capacity, passengers, status, onSelect }: VehicleItemProps) {
  const isBroken = status === 'broken'
  const isLoaded = passengers > 0

  return (
    <g transform={`translate(${x}, ${y})`} style={{ cursor: 'pointer' }} onClick={onSelect}>
      <g transform={`rotate(${angle})`}>
        {/* Forward Headlight Beams */}
        <polygon points="12,-4 32,-10 32,10 12,4" fill="url(#truckBeamGrad)" opacity={0.3} />

        {/* Truck Wheels (3 pairs) */}
        <rect x={-10} y={-7} width={5} height={2} rx={0.5} fill="#55535B" />
        <rect x={-10} y={5} width={5} height={2} rx={0.5} fill="#55535B" />
        <rect x={-4} y={-7} width={5} height={2} rx={0.5} fill="#55535B" />
        <rect x={-4} y={5} width={5} height={2} rx={0.5} fill="#55535B" />
        <rect x={6} y={-7} width={5} height={2} rx={0.5} fill="#55535B" />
        <rect x={6} y={5} width={5} height={2} rx={0.5} fill="#55535B" />

        {/* Cargo canopy */}
        <rect x={-12} y={-5.5} width={14} height={11} rx={1.5} fill="#272028" stroke="#fb923c" strokeWidth={1.2} />
        {/* Cab front */}
        <path d="M 2 -5.5 L 11 -5.5 L 12 -3 L 12 3 L 11 5.5 L 2 5.5 Z" fill="#18141D" stroke="#fb923c" strokeWidth={1.2} />
        <line x1={6} y1={-4} x2={6} y2={4} stroke="#fb923c" strokeWidth={1.4} opacity={0.7} />
      </g>

      {/* Upright Callout Pill Badge */}
      <g transform="translate(0, 16)">
        <rect x={-32} y={-8} width={64} height={16} rx={3} fill="#18141D" stroke="#55535B" strokeWidth={1} />
        <circle cx={-24} cy={0} r={2.5} fill={isBroken ? '#f43f5e' : isLoaded ? '#10b981' : '#fb923c'} />
        <text x={3} y={3} textAnchor="middle" fill="#EBEAEC" fontSize={8} fontWeight="600" fontFamily="monospace">
          {callsign} {passengers > 0 ? `(${passengers})` : ''}
        </text>
      </g>
    </g>
  )
}

interface RescueStationProps {
  id: string
  x: number
  y: number
  name: string
  occupied: number
  capacity: number
  fillPct: number
  onSelect: () => void
}

function RescueStationMarker({ id, x, y, name, occupied, capacity, fillPct, onSelect }: RescueStationProps) {
  const isCritical = fillPct >= 0.90
  const isTriage = fillPct >= 0.75
  const ringColor = isCritical ? '#f43f5e' : isTriage ? '#f59e0b' : '#10b981'
  const radius = 15
  const circumference = 2 * Math.PI * radius // ~94.25
  const dashOffset = circumference * (1 - Math.min(1, fillPct))

  return (
    <g transform={`translate(${x}, ${y})`} style={{ cursor: 'pointer' }} onClick={onSelect}>
      {/* Triage Warning Ripple Wave */}
      {isTriage && (
        <circle
          cx={0}
          cy={0}
          r={radius + 4}
          fill="none"
          stroke={ringColor}
          strokeWidth={1.5}
          style={{ animation: 'triagePulse 2s cubic-bezier(0, 0.2, 0.8, 1) infinite' }}
        />
      )}

      {/* Base Disc */}
      <circle cx={0} cy={0} r={radius} fill="#18141D" stroke="#55535B" strokeWidth={1.5} />

      {/* Circular Capacity Radial Gauge */}
      <circle
        cx={0}
        cy={0}
        r={radius}
        fill="none"
        stroke={ringColor}
        strokeWidth={2.8}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform="rotate(-90)"
      />

      {/* Medical / Safe Haven Cross */}
      <path
        d="M -4.5 0 L 4.5 0 M 0 -4.5 L 0 4.5"
        stroke="#FFFFFF"
        strokeWidth={2.2}
        strokeLinecap="round"
      />

      {/* Floating Station Name and Bed Occupancy */}
      <g transform="translate(0, -22)">
        <rect x={-44} y={-8} width={88} height={17} rx={3.5} fill="#18141D" stroke="#55535B" strokeWidth={1} />
        <text x={0} y={-0.5} textAnchor="middle" fill="#EBEAEC" fontSize={8.5} fontWeight="700">
          {name}
        </text>
        <text x={0} y={7} textAnchor="middle" fill="#9D9BA2" fontSize={7} fontFamily="monospace">
          {occupied.toLocaleString()} / {capacity.toLocaleString()} beds ({Math.round(fillPct * 100)}%)
        </text>
      </g>
    </g>
  )
}

interface StrandedGroupProps {
  id: string
  x: number
  y: number
  name: string
  people: number
  urgency: number
  assignedVehicle?: string
  onSelect: () => void
}

function StrandedGroupMarker({ id, x, y, name, people, urgency, assignedVehicle, onSelect }: StrandedGroupProps) {
  const isMayday = urgency >= 5
  const beaconColor = isMayday ? '#ef4444' : '#f59e0b'

  return (
    <g transform={`translate(${x}, ${y})`} style={{ cursor: 'pointer' }} onClick={onSelect}>
      {/* SOS Distress Beacon Ring */}
      <circle
        cx={0}
        cy={0}
        r={14}
        fill="none"
        stroke={beaconColor}
        strokeWidth={1.2}
        style={{ animation: 'maydayPulse 1.8s ease-out infinite' }}
      />
      <circle cx={0} cy={0} r={3.5} fill={beaconColor} />

      {/* Stranded Count & Sector Pill */}
      <g transform="translate(0, -14)">
        <rect
          x={-36}
          y={-8}
          width={72}
          height={assignedVehicle ? 24 : 16}
          rx={3}
          fill="#18141D"
          stroke={isMayday ? '#ef4444' : '#55535B'}
          strokeWidth={1}
        />
        <text x={0} y={assignedVehicle ? -1 : 3} textAnchor="middle" fill="#EBEAEC" fontSize={8} fontWeight="600">
          {name.slice(0, 10)} ({people.toLocaleString()})
        </text>
        {assignedVehicle && (
          <text x={0} y={11} textAnchor="middle" fill="#a7f3d0" fontSize={7} fontWeight="600" fontFamily="monospace">
            {assignedVehicle.toUpperCase()} EN ROUTE
          </text>
        )}
      </g>
    </g>
  )
}

// ==========================================
// MAIN APPLICATION
// ==========================================

export default function App() {
  const [world, setWorld] = useState<WorldState | null>(null)
  const [simId, setSimId] = useState<string | null>(null)
  const [strategy, setStrategy] = useState('negotiation')
  const [seed, setSeed] = useState(2019)
  const [log, setLog] = useState<LogEntry[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const histCache = useRef<Map<number, WorldState>>(new Map())
  const [maxTick, setMaxTick] = useState(0)
  const [replayTick, setReplayTick] = useState<number | null>(null)

  const [rightTab, setRightTab] = useState<'distress' | 'fleet' | 'shelters' | 'swarm'>('distress')
  const [showTools, setShowTools] = useState(false)
  const [selResource, setSelResource] = useState<{ type: string; id: string } | null>(null)
  const [cleanAtlas, setCleanAtlas] = useState(true)

  const [benchResult, setBenchResult] = useState<any>(null)
  const [benchLoading, setBenchLoading] = useState(false)
  const [showBench, setShowBench] = useState(false)
  const [compoundReport, setCompoundReport] = useState<CompoundDisruptionReport | null>(null)
  const [showDrawer, setShowDrawer] = useState(false)
  const [triggeringCompound, setTriggeringCompound] = useState(false)

  const [guideMode, setGuideMode] = useState(false)
  const [guideChap, setGuideChap] = useState(0)
  const [guideRunning, setGuideRunning] = useState(false)

  // Background map style: OpenStreetMap Standard, OSM Dark, Satellite, or Off
  const [mapStyle, setMapStyle] = useState<'osm' | 'osm_dark' | 'satellite' | 'none'>('osm')
  const [mapOpacity, setMapOpacity] = useState(0.85)

  // Smooth Navigation State (LERP + momentum friction physics + cursor-focal zoom)
  const svgContainerRef = useRef<HTMLDivElement | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)

  const panRef = useRef({ x: 0, y: 0 })
  const targetPanRef = useRef({ x: 0, y: 0 })
  const zoomRef = useRef(1)
  const targetZoomRef = useRef(1)
  const velRef = useRef({ vx: 0, vy: 0 })
  const dragRef = useRef({
    dragging: false,
    startX: 0,
    startY: 0,
    panStart: { x: 0, y: 0 },
    lastX: 0,
    lastY: 0,
    lastTime: 0
  })

  // Butter-Smooth Vehicle Animation Engine with Heading Rotation
  const vPosRef = useRef<Map<string, { x: number; y: number; angle: number }>>(new Map())
  const vTgtRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const [, setAnimTick] = useState(0)
  const rafRef = useRef<number | null>(null)
  const projRef = useRef(computeProjection([]))

  // Minimalist Palette
  const P = {
    bg: '#18141D',
    panel: '#3C313D',
    panelSubtle: '#272028',
    border: '#55535B',
    borderFaint: 'rgba(85,83,91,0.5)',
    text: '#EBEAEC',
    muted: '#9D9BA2',
    accent: '#A46CA8',
    river: '#38bdf8',
    canal: '#22d3ee',
    trap: '#f59e0b',
    closed: '#f43f5e',
    shelter: '#10b981'
  }

  // 60fps RAF Loop for Smooth Navigation & Sub-Pixel Vehicle Gliding
  useEffect(() => {
    let lastTs = performance.now()
    const loop = (ts: number) => {
      const dt = Math.min(32, ts - lastTs)
      lastTs = ts

      // 1. Map friction coasting when not dragging
      if (!dragRef.current.dragging) {
        if (Math.abs(velRef.current.vx) > 0.05 || Math.abs(velRef.current.vy) > 0.05) {
          targetPanRef.current.x += velRef.current.vx * (dt / 16)
          targetPanRef.current.y += velRef.current.vy * (dt / 16)
          velRef.current.vx *= 0.88
          velRef.current.vy *= 0.88
        } else {
          velRef.current.vx = 0
          velRef.current.vy = 0
        }
      }

      // 2. Map LERP pan and zoom towards targets
      const pLerp = 0.22
      const zLerp = 0.24
      const dx = (targetPanRef.current.x - panRef.current.x) * pLerp
      const dy = (targetPanRef.current.y - panRef.current.y) * pLerp
      const dz = (targetZoomRef.current - zoomRef.current) * zLerp

      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
        panRef.current.x += dx
        panRef.current.y += dy
        setPan({ x: panRef.current.x, y: panRef.current.y })
      }
      if (Math.abs(dz) > 0.001) {
        zoomRef.current += dz
        setZoom(zoomRef.current)
      }

      // 3. Butter-Smooth Vehicle Movement & Heading Rotation
      let vehicleMoved = false
      vTgtRef.current.forEach((tgt, id) => {
        const cur = vPosRef.current.get(id) ?? { x: tgt.x, y: tgt.y, angle: 0 }
        const vdx = tgt.x - cur.x
        const vdy = tgt.y - cur.y
        const dist = Math.hypot(vdx, vdy)

        if (dist > 0.15) {
          // Calculate heading angle toward movement direction
          const targetAngle = Math.atan2(vdy, vdx) * (180 / Math.PI)
          let diffAngle = (targetAngle - cur.angle) % 360
          if (diffAngle > 180) diffAngle -= 360
          if (diffAngle < -180) diffAngle += 360
          const newAngle = cur.angle + diffAngle * 0.16

          // Exponential decay position interpolation
          const speed = 0.095
          const nx = cur.x + vdx * speed
          const ny = cur.y + vdy * speed
          vPosRef.current.set(id, { x: nx, y: ny, angle: newAngle })
          vehicleMoved = true
        }
      })

      // Continuously re-render when vehicles are actively gliding
      if (vehicleMoved) {
        setAnimTick(t => (t + 1) % 1000000)
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Sync vehicle destination waypoints from world state
  useEffect(() => {
    if (!world) return
    const proj = projRef.current
    world.boats.forEach(b => {
      // Find current or next waypoint along path for smooth progression
      const n = world.nodes.find(nd => nd.id === b.location)
      if (!n) return
      const [tx, ty] = proj.toSvg(n.lat ?? (16.55 + n.y * 0.003), n.lon ?? (74.0 + n.x * 0.0035))
      vTgtRef.current.set(b.id, { x: tx, y: ty })
      if (!vPosRef.current.has(b.id)) {
        vPosRef.current.set(b.id, { x: tx, y: ty, angle: 0 })
      }
    })
  }, [world])

  useEffect(() => {
    if (!world?.nodes.length) return
    projRef.current = computeProjection(world.nodes)
  }, [world?.nodes])

  // WebSocket connection handler
  const connectWs = useCallback((id: string) => {
    wsRef.current?.close()
    const ws = new WebSocket(`ws://localhost:8000/api/v1/simulations/${id}/stream`)
    ws.onmessage = evt => {
      const w: WorldState = JSON.parse(evt.data)
      setWorld(w)
      setLog(prev => [...prev, ...w.log].slice(-500))
      setMaxTick(w.tick)
      histCache.current.set(w.tick, w)
      if (w.last_compound_report) setCompoundReport(w.last_compound_report)
    }
    wsRef.current = ws
  }, [])

  const createSim = async () => {
    setLog([])
    setBenchResult(null)
    setMaxTick(0)
    setReplayTick(null)
    histCache.current.clear()
    try {
      const r = await fetch(`${API}/api/v1/simulations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy, seed })
      })
      const d = await r.json()
      setSimId(d.simulation_id)
      connectWs(d.simulation_id)
    } catch {}
  }

  const cmd = (command: string, extra?: object) => wsRef.current?.send(JSON.stringify({ command, ...extra }))

  const injectEvent = async (type: string, target: string) => {
    if (!simId || !world) return
    try {
      await fetch(`${API}/api/v1/simulations/${simId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: type, target_id: target, tick_offset: 1 })
      })
    } catch {
      cmd('inject_event', {
        event: { tick: (world?.tick ?? 0) + 1, event_type: type, target_id: target, payload: {}, description: '' }
      })
    }
  }

  const runBench = async () => {
    setBenchLoading(true)
    try {
      const r = await fetch(`${API}/api/v1/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seeds: [2019, 42, 137], disruptions: true })
      })
      setBenchResult(await r.json())
    } catch {}
    setBenchLoading(false)
  }

  const triggerCompound = async () => {
    if (!simId || !world) return
    setTriggeringCompound(true)
    try {
      const openEdges = world.edges.filter(e => e.open && !e.submerged_navigable && e.mode !== 'water')
      const vehicles = world.boats.filter(b => b.status !== 'broken')
      const r = await fetch(`${API}/api/v1/simulations/${simId}/trigger-compound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bridge_edge_id: openEdges[0]?.id ?? '',
          fail_boat_id: vehicles[0]?.id ?? '',
          overflow_shelter_id: world.shelters[0]?.id ?? ''
        })
      })
      if (r.ok) {
        const report: CompoundDisruptionReport = await r.json()
        setCompoundReport(report)
        setShowDrawer(true)
      }
    } catch {}
    setTriggeringCompound(false)
  }

  const runGuideChap = async (ch: number) => {
    if (guideRunning) return
    setGuideRunning(true)
    try {
      if (ch === 0) {
        setStrategy('negotiation')
        await new Promise(r => setTimeout(r, 100))
        setLog([])
        setMaxTick(0)
        setReplayTick(null)
        histCache.current.clear()
        const resp = await fetch(`${API}/api/v1/simulations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategy: 'negotiation', seed: 2019 })
        })
        const d = await resp.json()
        setSimId(d.simulation_id)
        connectWs(d.simulation_id)
        await new Promise(r => setTimeout(r, 400))
        for (let i = 0; i < 3; i++) {
          cmd('step')
          await new Promise(r => setTimeout(r, 300))
        }
      } else if (ch === 1) {
        for (let i = 0; i < 4; i++) {
          cmd('step')
          await new Promise(r => setTimeout(r, 300))
        }
      } else if (ch === 2) {
        await triggerCompound()
      } else if (ch === 3) {
        setShowDrawer(false)
        for (let i = 0; i < 3; i++) {
          cmd('step')
          await new Promise(r => setTimeout(r, 350))
        }
      } else if (ch === 4) {
        setShowBench(true)
        await runBench()
      }
    } catch {}
    setGuideRunning(false)
  }

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
        .map(([t, ws]) => ({
          tick: t,
          delivered: ws.metrics?.people_delivered ?? 0,
          flooded_nodes: ws.flood_state?.flooded_nodes?.length ?? 0
        }))
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `floodops-replay-t${world.tick}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const scrubTo = async (t: number) => {
    setReplayTick(t)
    if (histCache.current.has(t)) return
    if (!simId) return
    try {
      const r = await fetch(`${API}/api/v1/simulations/${simId}/history/${t}`)
      histCache.current.set(t, await r.json())
    } catch {}
  }

  // Smooth Cursor-Focal Wheel Zoom Handler
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    if (!svgContainerRef.current) return
    const rect = svgContainerRef.current.getBoundingClientRect()
    const normX = ((e.clientX - rect.left) / rect.width) * SVG_W
    const normY = ((e.clientY - rect.top) / rect.height) * SVG_H

    const curZoom = targetZoomRef.current
    const worldX = (normX - targetPanRef.current.x) / curZoom
    const worldY = (normY - targetPanRef.current.y) / curZoom

    const factor = Math.pow(0.9982, e.deltaY)
    const nextZoom = Math.min(8.0, Math.max(0.4, curZoom * factor))

    targetZoomRef.current = nextZoom
    targetPanRef.current = {
      x: normX - worldX * nextZoom,
      y: normY - worldY * nextZoom
    }
  }

  // Smooth Drag & Momentum Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      panStart: { ...targetPanRef.current },
      lastX: e.clientX,
      lastY: e.clientY,
      lastTime: performance.now()
    }
    velRef.current = { vx: 0, vy: 0 }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current.dragging) return
    const now = performance.now()
    const dt = Math.max(1, now - dragRef.current.lastTime)
    const dx = e.clientX - dragRef.current.lastX
    const dy = e.clientY - dragRef.current.lastY

    if (svgContainerRef.current) {
      const rect = svgContainerRef.current.getBoundingClientRect()
      const scaleX = SVG_W / rect.width
      const scaleY = SVG_H / rect.height
      const totalDx = (e.clientX - dragRef.current.startX) * scaleX
      const totalDy = (e.clientY - dragRef.current.startY) * scaleY

      targetPanRef.current = {
        x: dragRef.current.panStart.x + totalDx,
        y: dragRef.current.panStart.y + totalDy
      }

      velRef.current = {
        vx: (dx * scaleX) * (16 / dt) * 0.75,
        vy: (dy * scaleY) * (16 / dt) * 0.75
      }
    }

    dragRef.current.lastX = e.clientX
    dragRef.current.lastY = e.clientY
    dragRef.current.lastTime = now
  }

  const handleMouseUp = () => {
    dragRef.current.dragging = false
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!svgContainerRef.current) return
    const rect = svgContainerRef.current.getBoundingClientRect()
    const normX = ((e.clientX - rect.left) / rect.width) * SVG_W
    const normY = ((e.clientY - rect.top) / rect.height) * SVG_H

    const curZoom = targetZoomRef.current
    const worldX = (normX - targetPanRef.current.x) / curZoom
    const worldY = (normY - targetPanRef.current.y) / curZoom

    const nextZoom = Math.min(8.0, curZoom * 1.5)
    targetZoomRef.current = nextZoom
    targetPanRef.current = {
      x: normX - worldX * nextZoom,
      y: normY - worldY * nextZoom
    }
  }

  const resetView = () => {
    targetPanRef.current = { x: 0, y: 0 }
    targetZoomRef.current = 1
    velRef.current = { vx: 0, vy: 0 }
  }

  const dw = replayTick !== null ? (histCache.current.get(replayTick) ?? world) : world
  const m = dw?.metrics
  const gc = dw?.ghost_comparison || m?.ghost_comparison
  const gini = m?.gini_coefficient ?? m?.fairness_gini ?? 0
  const viol = m?.safety_violations ?? dw?.safety_violation_count ?? 0
  const waiting = dw?.requests.filter(r => r.status === 'waiting' || r.status === 'assigned').length ?? 0
  const delivered = m?.people_delivered ?? 0
  const tick = dw?.tick ?? 0
  const extraSaved = gc?.extra_people_saved ?? 0

  const renderMap = () => {
    if (!dw || !dw.nodes.length) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: P.muted }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: P.text, marginBottom: 4 }}>Kolhapur Basin 2019 Network Ready</div>
            <div style={{ fontSize: 11, color: P.muted }}>Click &quot;New Run&quot; to initialize autonomous swarm simulation</div>
          </div>
        </div>
      )
    }

    const proj = projRef.current
    const nodePos = new Map<string, [number, number]>()
    dw.nodes.forEach(n => nodePos.set(n.id, nodeToSvg(n, proj)))

    // Generate real geographic slippy tiles from OpenStreetMap
    const tileZoom = zoom >= 1.5 ? 13 : 12
    const tiles: Array<{ key: string; url: string; x: number; y: number; width: number; height: number }> = []
    if (mapStyle !== 'none' && proj.bounds) {
      const { lo0, lo1, la0, la1 } = proj.bounds
      const xMin = Math.max(0, lon2tile(lo0, tileZoom) - 1)
      const xMax = Math.min(Math.pow(2, tileZoom) - 1, lon2tile(lo1, tileZoom) + 1)
      const yMin = Math.max(0, lat2tile(la1, tileZoom) - 1)
      const yMax = Math.min(Math.pow(2, tileZoom) - 1, lat2tile(la0, tileZoom) + 1)

      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          const northLat = tile2lat(y, tileZoom)
          const southLat = tile2lat(y + 1, tileZoom)
          const westLon = tile2lon(x, tileZoom)
          const eastLon = tile2lon(x + 1, tileZoom)
          const [x1, y1] = proj.toSvg(northLat, westLon)
          const [x2, y2] = proj.toSvg(southLat, eastLon)

          let url = ''
          if (mapStyle === 'osm' || mapStyle === 'osm_dark') {
            const sub = ['a', 'b', 'c'][(x + y) % 3]
            url = `https://${sub}.tile.openstreetmap.org/${tileZoom}/${x}/${y}.png`
          } else if (mapStyle === 'satellite') {
            url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${tileZoom}/${y}/${x}`
          }

          tiles.push({
            key: `${mapStyle}_${tileZoom}_${x}_${y}`,
            url,
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y2 - y1
          })
        }
      }
    }

    const activeEdgeIds = new Set<string>()
    if (cleanAtlas) {
      dw.assignments.filter(a => a.status === 'active').forEach(a => {
        const boat = dw.boats.find(b => b.id === a.boat_id)
        if (!boat?.path) return
        for (let i = 1; i < boat.path.length; i++) {
          const e = dw.edges.find(
            e2 => (e2.source === boat.path[i - 1] && e2.destination === boat.path[i]) ||
                  (e2.source === boat.path[i] && e2.destination === boat.path[i - 1])
          )
          if (e) activeEdgeIds.add(e.id)
        }
      })
      const hot = new Set([
        ...dw.shelters.map(s => s.location),
        ...dw.requests.filter(r => r.status !== 'delivered').map(r => r.location)
      ])
      dw.edges.forEach(e => {
        if (hot.has(e.source) || hot.has(e.destination)) activeEdgeIds.add(e.id)
        if (!e.open || e.submerged_navigable || (e.ticks_until_flooded != null && e.ticks_until_flooded <= 4)) activeEdgeIds.add(e.id)
        if (e.mode === 'water' || e.mode === 'river') activeEdgeIds.add(e.id)
      })
    }

    const floodPlumes = (dw.flood_state?.flooded_nodes ?? []).flatMap(id => {
      const pos = nodePos.get(id)
      if (!pos) return []
      const [fx, fy] = pos
      return [
        <circle key={'fpo_' + id} cx={fx} cy={fy} r={24} fill="rgba(34,211,238,0.12)" stroke="none" />,
        <circle key={'fpi_' + id} cx={fx} cy={fy} r={10} fill="rgba(56,189,248,0.28)" stroke="none" />
      ]
    })

    const edgeLines: React.ReactElement[] = []
    dw.edges.forEach(e => {
      const p1 = e.lat_a != null ? proj.toSvg(e.lat_a, e.lon_a!) : nodePos.get(e.source)
      const p2 = e.lat_b != null ? proj.toSvg(e.lat_b, e.lon_b!) : nodePos.get(e.destination)
      if (!p1 || !p2) return
      const [x1, y1] = p1, [x2, y2] = p2
      const isSub = !!e.submerged_navigable
      const isFlood = !isSub && e.ticks_until_flooded != null && e.ticks_until_flooded > 0 && e.ticks_until_flooded <= 4
      const isClosed = !e.open && !isSub
      const isWater = e.mode === 'water' || e.mode === 'river'
      const isActive = activeEdgeIds.has(e.id)
      const isBg = cleanAtlas && !isActive && !isWater && !isSub && !isFlood && !isClosed

      const stroke = isBg ? '#3C313D' : isWater ? P.river : isSub ? P.canal : isFlood ? P.trap : isClosed ? P.closed : P.border
      const sw = isBg ? 0.8 : isWater ? 3.5 : isSub ? 3 : isFlood ? 2.5 : isClosed ? 3 : 1.6
      const op = isBg ? 0.25 : 0.85
      const dash = isSub ? '6 4' : isFlood ? '4 3' : isClosed ? '3 4' : undefined

      if (isWater) {
        edgeLines.push(
          <line key={'ec_' + e.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#38bdf8" strokeWidth={5.5} opacity={0.2} strokeLinecap="round" />
        )
      }
      edgeLines.push(
        <line key={'e_' + e.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw} opacity={op} strokeDasharray={dash} strokeLinecap="round" />
      )
    })

    // Active Mission Trails
    const pathTrails: React.ReactElement[] = []
    dw.assignments.filter(a => a.status === 'active').forEach(a => {
      const boat = dw.boats.find(b => b.id === a.boat_id)
      if (!boat?.path?.length) return
      const curPos = vPosRef.current.get(boat.id)
      if (!curPos) return
      const pts: Array<[number, number]> = [[curPos.x, curPos.y]]
      boat.path.slice(0, 8).forEach(nid => {
        const pp = nodePos.get(nid)
        if (pp) pts.push(pp)
      })
      const req = dw.requests.find(r => r.id === a.request_id)
      if (req) {
        const rp = nodePos.get(req.location)
        if (rp) pts.push(rp)
      }
      if (pts.length > 1) {
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
        pathTrails.push(
          <path key={'tr_' + boat.id} d={d} stroke={P.accent} strokeWidth={1.8} strokeDasharray="5 4" fill="none" opacity={0.8} strokeLinecap="round" />
        )
      }
    })

    // React Items: Rescue Stations (Shelters)
    const shelterItems = dw.shelters.map(s => {
      const pos = nodePos.get(s.location)
      if (!pos) return null
      const [sx, sy] = pos
      const pct = s.fill_pct != null ? s.fill_pct : s.occupied / s.total_capacity
      return (
        <RescueStationMarker
          key={'sh_' + s.id}
          id={s.id}
          x={sx}
          y={sy}
          name={formatShelterName(s.id)}
          occupied={s.occupied}
          capacity={s.total_capacity}
          fillPct={pct}
          onSelect={() => setSelResource({ type: 'shelter', id: s.id })}
        />
      )
    }).filter(Boolean)

    // React Items: Stranded Civilian Groups
    const strandedItems = dw.requests.filter(r => r.status !== 'delivered').map(r => {
      const pos = nodePos.get(r.location)
      if (!pos) return null
      const [vx, vy] = pos
      const asgn = dw.assignments.find(a => a.request_id === r.id && a.status === 'active')
      return (
        <StrandedGroupMarker
          key={'rq_' + r.id}
          id={r.id}
          x={vx}
          y={vy}
          name={(r.neighbourhood || r.location).replace(/_/g, ' ')}
          people={r.people}
          urgency={r.urgency}
          assignedVehicle={asgn?.boat_id}
          onSelect={() => setSelResource({ type: 'request', id: r.id })}
        />
      )
    }).filter(Boolean)

    // React Items: Multi-Modal Fleet (Helicopters, Motorised Boats, Army Convoys)
    const vehicleItems = dw.boats.map(b => {
      const pos = vPosRef.current.get(b.id) ?? {
        x: vTgtRef.current.get(b.id)?.x ?? 0,
        y: vTgtRef.current.get(b.id)?.y ?? 0,
        angle: 0
      }
      const vt = b.vehicle_type || (b.id.startsWith('truck') ? 'truck' : b.id.startsWith('heli') ? 'helicopter' : 'boat')
      const callsign = `${vt === 'helicopter' ? 'IAF' : vt === 'truck' ? 'ARMY' : 'NDRF'} ${b.id.replace(/boat_|truck_|heli_/, '').toUpperCase()}`

      if (vt === 'helicopter') {
        return (
          <HelicopterMarker
            key={'vh_' + b.id}
            id={b.id}
            x={pos.x}
            y={pos.y}
            angle={pos.angle}
            callsign={callsign}
            capacity={b.capacity}
            passengers={b.people_on_board}
            status={b.status}
            onSelect={() => setSelResource({ type: 'vehicle', id: b.id })}
          />
        )
      } else if (vt === 'truck') {
        return (
          <TruckMarker
            key={'vh_' + b.id}
            id={b.id}
            x={pos.x}
            y={pos.y}
            angle={pos.angle}
            callsign={callsign}
            capacity={b.capacity}
            passengers={b.people_on_board}
            status={b.status}
            onSelect={() => setSelResource({ type: 'vehicle', id: b.id })}
          />
        )
      } else {
        return (
          <BoatMarker
            key={'vh_' + b.id}
            id={b.id}
            x={pos.x}
            y={pos.y}
            angle={pos.angle}
            callsign={callsign}
            capacity={b.capacity}
            passengers={b.people_on_board}
            status={b.status}
            onSelect={() => setSelResource({ type: 'vehicle', id: b.id })}
          />
        )
      }
    }).filter(Boolean)

    const vb = `${-pan.x / zoom} ${-pan.y / zoom} ${SVG_W / zoom} ${SVG_H / zoom}`

    return (
      <svg
        width="100%"
        height="100%"
        viewBox={vb}
        style={{
          background: P.bg,
          cursor: dragRef.current.dragging ? 'grabbing' : 'grab',
          display: 'block'
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      >
        <defs>
          <linearGradient id="heliBeamGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#c084fc" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#c084fc" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="truckBeamGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#fb923c" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#fb923c" stopOpacity="0" />
          </linearGradient>
          <style>{`
            .osm-tile-toned { filter: brightness(0.68) invert(0.88) hue-rotate(180deg) contrast(1.12); }
            .osm-tile-standard { filter: contrast(1.04) brightness(0.96); }
            @keyframes rotorSpin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
            @keyframes maydayPulse {
              0% { transform: scale(1); opacity: 0.95; }
              50% { transform: scale(1.4); opacity: 0.35; }
              100% { transform: scale(1); opacity: 0.95; }
            }
            @keyframes triagePulse {
              0% { r: 16; opacity: 0.85; }
              100% { r: 32; opacity: 0; }
            }
          `}</style>
        </defs>

        {/* 1. Underlying canvas */}
        <rect
          x={-pan.x / zoom - 4000}
          y={-pan.y / zoom - 4000}
          width={SVG_W / zoom + 8000}
          height={SVG_H / zoom + 8000}
          fill={P.bg}
        />

        {/* 2. Actual Background Map Tiles */}
        {tiles.length > 0 && (
          <g id="actual-map-background" opacity={mapOpacity}>
            {tiles.map(t => (
              <image
                key={t.key}
                href={t.url}
                x={t.x}
                y={t.y}
                width={t.width}
                height={t.height}
                preserveAspectRatio="none"
                className={
                  mapStyle === 'osm_dark'
                    ? 'osm-tile-toned'
                    : mapStyle === 'osm'
                    ? 'osm-tile-standard'
                    : undefined
                }
              />
            ))}
          </g>
        )}

        {/* 3. Subtle Basin Watermarks */}
        <text x={SVG_W * 0.12} y={SVG_H * 0.12} fill="#55535B" fontSize={11} fontWeight="500" letterSpacing="0.05em">
          PANCHAGANGA BASIN
        </text>
        <text x={SVG_W * 0.72} y={SVG_H * 0.88} fill="#55535B" fontSize={10} fontWeight="500" letterSpacing="0.05em">
          SHIROL FLOODPLAIN
        </text>

        {/* 4. Vectors and Custom React Map Items */}
        <g opacity={0.65}>{floodPlumes}</g>
        {edgeLines}
        {pathTrails}
        {shelterItems}
        {strandedItems}
        {vehicleItems}

        {/* 5. Minimalist Scale */}
        <g transform="translate(24, 672)">
          <rect x={0} y={-8} width={74} height={14} rx={2} fill="rgba(24,20,29,0.75)" />
          <line x1={4} y1={0} x2={70} y2={0} stroke={P.muted} strokeWidth={1.5} />
          <text x={4} y={-10} fill={P.muted} fontSize={7} fontFamily="monospace">0</text>
          <text x={56} y={-10} fill={P.muted} fontSize={7} fontFamily="monospace">4 km</text>
        </g>
      </svg>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: P.bg,
        color: P.text,
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        overflow: 'hidden'
      }}
    >
      {/* 1. Header */}
      <header
        style={{
          height: 46,
          background: P.bg,
          borderBottom: `1px solid ${P.border}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 14px',
          gap: 10,
          flexShrink: 0
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '-0.02em', color: P.text }}>FloodOps</span>
          <span style={{ fontSize: 10, color: P.muted, fontFamily: 'monospace' }}>2019 Kolhapur</span>
        </div>

        <div style={{ width: 1, height: 18, background: P.border }} />

        {/* Scenario & Strategy Pickers */}
        <select
          value={seed}
          onChange={e => setSeed(+e.target.value)}
          style={{
            background: P.panel,
            color: P.text,
            border: `1px solid ${P.border}`,
            borderRadius: 4,
            padding: '3px 8px',
            fontSize: 11,
            cursor: 'pointer'
          }}
        >
          <option value={2019}>2019 Kolhapur Benchmark</option>
          <option value={42}>District Scenario A</option>
          <option value={137}>District Scenario B</option>
        </select>

        <select
          value={strategy}
          onChange={e => setStrategy(e.target.value)}
          style={{
            background: P.panel,
            color: P.text,
            border: `1px solid ${P.border}`,
            borderRadius: 4,
            padding: '3px 8px',
            fontSize: 11,
            cursor: 'pointer'
          }}
        >
          <option value="negotiation">Autonomous Swarm Auction</option>
          <option value="optimiser">Central Dispatch Optimizer</option>
          <option value="greedy">Nearest-First Greedy</option>
        </select>

        <div style={{ width: 1, height: 18, background: P.border }} />

        {/* Execution Controls */}
        <button
          onClick={createSim}
          style={{
            background: P.panel,
            color: P.text,
            border: `1px solid ${P.border}`,
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 500,
            cursor: 'pointer'
          }}
        >
          New Run
        </button>

        <button
          onClick={() => cmd('step')}
          disabled={!simId}
          style={{
            background: P.panel,
            color: P.text,
            border: `1px solid ${P.border}`,
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 600,
            cursor: simId ? 'pointer' : 'default',
            opacity: simId ? 1 : 0.4
          }}
        >
          +1 Step
        </button>

        <button
          onClick={() => cmd('start')}
          disabled={!simId}
          style={{
            background: simId ? '#10b981' : P.panel,
            color: '#FFFFFF',
            border: 'none',
            borderRadius: 4,
            padding: '4px 12px',
            fontSize: 11,
            fontWeight: 600,
            cursor: simId ? 'pointer' : 'default',
            opacity: simId ? 1 : 0.4
          }}
        >
          Play
        </button>

        <button
          onClick={() => cmd('pause')}
          disabled={!simId}
          style={{
            background: P.panel,
            color: P.text,
            border: `1px solid ${P.border}`,
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 11,
            cursor: 'pointer',
            opacity: simId ? 1 : 0.4
          }}
        >
          Pause
        </button>

        <button
          onClick={triggerCompound}
          disabled={!simId || triggeringCompound}
          style={{
            background: P.panel,
            color: '#f87171',
            border: `1px solid ${P.border}`,
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            opacity: !simId || triggeringCompound ? 0.4 : 1
          }}
        >
          {triggeringCompound ? 'Injecting...' : 'Triple Catastrophe'}
        </button>

        {/* Status Indicators in Header */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {dw && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
              <span style={{ color: '#10b981', fontFamily: 'monospace', fontWeight: 600 }}>
                {delivered.toLocaleString()} evacuated
              </span>
              <span style={{ color: P.border }}>&bull;</span>
              <span style={{ color: P.muted, fontFamily: 'monospace' }}>
                {waiting.toLocaleString()} waiting
              </span>
              {extraSaved > 0 && (
                <>
                  <span style={{ color: P.border }}>&bull;</span>
                  <span style={{ color: P.accent, fontFamily: 'monospace', fontWeight: 600 }}>
                    +{extraSaved.toLocaleString()} swarm delta
                  </span>
                </>
              )}
              <span style={{ color: P.border }}>&bull;</span>
              <span style={{ color: P.muted, fontFamily: 'monospace' }}>t={tick}s</span>
            </div>
          )}

          <div style={{ width: 1, height: 18, background: P.border }} />

          <button
            onClick={() => setGuideMode(g => !g)}
            style={{
              background: guideMode ? P.accent : P.panel,
              color: '#FFFFFF',
              border: `1px solid ${P.border}`,
              borderRadius: 4,
              padding: '3px 8px',
              fontSize: 11,
              cursor: 'pointer'
            }}
          >
            Guide
          </button>

          <button
            onClick={() => setShowBench(b => !b)}
            style={{
              background: showBench ? P.accent : P.panel,
              color: '#FFFFFF',
              border: `1px solid ${P.border}`,
              borderRadius: 4,
              padding: '3px 8px',
              fontSize: 11,
              cursor: 'pointer'
            }}
          >
            Benchmark
          </button>

          <button
            onClick={() => setShowTools(t => !t)}
            style={{
              background: showTools ? P.accent : P.panel,
              color: '#FFFFFF',
              border: `1px solid ${P.border}`,
              borderRadius: 4,
              padding: '3px 8px',
              fontSize: 11,
              cursor: 'pointer'
            }}
          >
            Tools
          </button>
        </div>
      </header>

      {/* Guided Walkthrough Bar */}
      {guideMode && (
        <div
          style={{
            background: P.panelSubtle,
            borderBottom: `1px solid ${P.border}`,
            padding: '6px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0
          }}
        >
          <div style={{ display: 'flex', gap: 4 }}>
            {[0, 1, 2, 3, 4].map(idx => (
              <button
                key={idx}
                onClick={() => setGuideChap(idx)}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 3,
                  border: `1px solid ${guideChap === idx ? P.accent : P.border}`,
                  background: guideChap === idx ? P.accent : P.panel,
                  color: '#FFFFFF',
                  fontSize: 10,
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                {idx + 1}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 11, color: P.text, flex: 1 }}>
            <span style={{ fontWeight: 600, color: P.accent }}>{CHAPTERS[guideChap].title}:</span>{' '}
            <span style={{ color: P.muted }}>{CHAPTERS[guideChap].note}</span>
          </div>

          <button
            onClick={() => runGuideChap(guideChap)}
            disabled={guideRunning}
            style={{
              background: P.accent,
              color: '#FFFFFF',
              border: 'none',
              borderRadius: 4,
              padding: '3px 12px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            {guideRunning ? 'Executing...' : CHAPTERS[guideChap].action}
          </button>

          <button
            onClick={() => setGuideMode(false)}
            style={{ background: 'transparent', border: 'none', color: P.muted, cursor: 'pointer', fontSize: 14 }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Main Workspace Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left Column: Map + Live Log */}
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Interactive Map Viewport with Smooth Floating Controls */}
          <div
            ref={svgContainerRef}
            onWheel={handleWheel}
            style={{
              flex: '0 0 68%',
              position: 'relative',
              overflow: 'hidden',
              background: P.bg
            }}
          >
            {renderMap()}

            {/* Floating Glass Pill Island (Top-Right) */}
            <div
              style={{
                position: 'absolute',
                top: 10,
                right: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'rgba(24, 20, 29, 0.88)',
                backdropFilter: 'blur(8px)',
                border: `1px solid ${P.border}`,
                borderRadius: 6,
                padding: '4px 8px',
                zIndex: 10
              }}
            >
              {/* Map Style Segmented Control */}
              <div style={{ display: 'flex', gap: 2 }}>
                {(['osm', 'osm_dark', 'satellite', 'none'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setMapStyle(s)}
                    style={{
                      background: mapStyle === s ? P.panel : 'transparent',
                      color: mapStyle === s ? '#FFFFFF' : P.muted,
                      border: 'none',
                      borderRadius: 3,
                      padding: '2px 6px',
                      fontSize: 10,
                      fontWeight: mapStyle === s ? 600 : 400,
                      cursor: 'pointer'
                    }}
                  >
                    {s === 'osm' ? 'OSM Standard' : s === 'osm_dark' ? 'OSM Dark' : s === 'satellite' ? 'Sat' : 'Off'}
                  </button>
                ))}
              </div>

              <div style={{ width: 1, height: 14, background: P.border }} />

              {/* Corridors Filter */}
              <button
                onClick={() => setCleanAtlas(c => !c)}
                style={{
                  background: cleanAtlas ? P.panel : 'transparent',
                  color: cleanAtlas ? '#FFFFFF' : P.muted,
                  border: 'none',
                  borderRadius: 3,
                  padding: '2px 6px',
                  fontSize: 10,
                  cursor: 'pointer'
                }}
              >
                {cleanAtlas ? 'Active Corridors' : 'All Roads'}
              </button>

              <div style={{ width: 1, height: 14, background: P.border }} />

              {/* Opacity Slider */}
              {mapStyle !== 'none' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 9, color: P.muted }}>Op</span>
                  <input
                    type="range"
                    min="0.2"
                    max="1.0"
                    step="0.05"
                    value={mapOpacity}
                    onChange={e => setMapOpacity(+e.target.value)}
                    style={{ width: 40, accentColor: P.accent, cursor: 'pointer' }}
                  />
                </div>
              )}

              {/* Zoom Controls & Reset */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button
                  onClick={() => {
                    targetZoomRef.current = Math.min(8.0, targetZoomRef.current * 1.3)
                  }}
                  style={{
                    background: P.panel,
                    color: P.text,
                    border: 'none',
                    borderRadius: 3,
                    width: 20,
                    height: 20,
                    cursor: 'pointer',
                    fontSize: 12
                  }}
                >
                  +
                </button>
                <button
                  onClick={() => {
                    targetZoomRef.current = Math.max(0.4, targetZoomRef.current / 1.3)
                  }}
                  style={{
                    background: P.panel,
                    color: P.text,
                    border: 'none',
                    borderRadius: 3,
                    width: 20,
                    height: 20,
                    cursor: 'pointer',
                    fontSize: 12
                  }}
                >
                  &minus;
                </button>
                <button
                  onClick={resetView}
                  style={{
                    background: 'transparent',
                    color: P.muted,
                    border: 'none',
                    padding: '2px 4px',
                    fontSize: 10,
                    cursor: 'pointer'
                  }}
                >
                  Reset
                </button>
              </div>

              <span style={{ fontSize: 9, color: P.muted, fontFamily: 'monospace' }}>
                {Math.round(zoom * 100)}%
              </span>
            </div>

            {/* Minimalist Legend (Bottom-Left) */}
            <div
              style={{
                position: 'absolute',
                bottom: 10,
                left: 12,
                display: 'flex',
                gap: 12,
                background: 'rgba(24, 20, 29, 0.85)',
                backdropFilter: 'blur(6px)',
                border: `1px solid ${P.border}`,
                borderRadius: 4,
                padding: '4px 10px',
                fontSize: 9,
                color: P.muted,
                pointerEvents: 'none'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 2, background: P.river, display: 'inline-block' }} />
                <span>River</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 2, background: P.canal, display: 'inline-block' }} />
                <span>Canal</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 2, background: P.trap, display: 'inline-block' }} />
                <span>Flood Trap</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 2, background: P.closed, display: 'inline-block' }} />
                <span>Closed</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
                <span>Shelter</span>
              </div>
            </div>
          </div>

          {/* Bottom Incident Feed & Scrubber */}
          <div
            style={{
              flex: '1 1 0',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderTop: `1px solid ${P.border}`,
              background: P.bg
            }}
          >
            <div
              style={{
                height: 28,
                background: P.panelSubtle,
                borderBottom: `1px solid ${P.border}`,
                padding: '0 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexShrink: 0
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 600, color: P.muted, letterSpacing: '0.04em' }}>
                INCIDENT DISPATCH STREAM
              </span>

              {log.filter(e => e.message.toLowerCase().includes('mayday') || e.message.includes('COMPOUND')).slice(-4).map((e, idx) => (
                <button
                  key={idx}
                  onClick={() => scrubTo(e.tick)}
                  style={{
                    background: 'transparent',
                    color: '#ef4444',
                    border: `1px solid #7f1d1d`,
                    borderRadius: 3,
                    padding: '1px 5px',
                    fontSize: 9,
                    cursor: 'pointer',
                    fontFamily: 'monospace'
                  }}
                >
                  T{e.tick}
                </button>
              ))}

              {maxTick > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                  <input
                    type="range"
                    min={0}
                    max={maxTick}
                    value={replayTick ?? maxTick}
                    onChange={e => scrubTo(+e.target.value)}
                    style={{ width: 80, accentColor: P.accent }}
                  />
                  <span style={{ fontSize: 10, color: P.muted, fontFamily: 'monospace' }}>
                    {replayTick ?? maxTick}/{maxTick}s
                  </span>
                  {replayTick !== null && (
                    <button
                      onClick={() => setReplayTick(null)}
                      style={{
                        background: P.panel,
                        color: P.accent,
                        border: `1px solid ${P.border}`,
                        borderRadius: 3,
                        padding: '1px 6px',
                        fontSize: 9,
                        cursor: 'pointer'
                      }}
                    >
                      Return Live
                    </button>
                  )}
                </div>
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 14px' }}>
              {log.slice(-120).reverse().map((entry, idx) => {
                const item = fmtLog(entry)
                return (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      padding: '3px 0',
                      borderBottom: `1px solid rgba(85,83,91,0.2)`
                    }}
                  >
                    <span style={{ color: P.muted, fontSize: 9, fontFamily: 'monospace', minWidth: 24 }}>
                      {entry.tick}s
                    </span>
                    <span
                      style={{
                        border: `1px solid ${item.border}`,
                        color: P.muted,
                        borderRadius: 2,
                        padding: '0 4px',
                        fontSize: 8,
                        fontWeight: 600,
                        fontFamily: 'monospace',
                        minWidth: 54,
                        textAlign: 'center'
                      }}
                    >
                      {item.tag}
                    </span>
                    <span style={{ fontSize: 11, color: P.text, lineHeight: 1.4 }}>
                      {item.text}
                    </span>
                  </div>
                )
              })}
              {log.length === 0 && (
                <div style={{ color: P.muted, fontSize: 11, textAlign: 'center', paddingTop: 14 }}>
                  No telemetry logged. Start simulation to observe real-time auction negotiations.
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Right Column: Clean Telemetry Tabs */}
        <div
          style={{
            flex: '0 0 280px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: P.panel,
            borderLeft: `1px solid ${P.border}`
          }}
        >
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${P.border}`, flexShrink: 0 }}>
            {([
              ['distress', `Stranded (${dw?.requests.filter(r => r.status !== 'delivered').length ?? 0})`],
              ['fleet', `Fleet (${dw?.boats.length ?? 0})`],
              ['shelters', 'Shelters'],
              ['swarm', 'Swarm AI']
            ] as [typeof rightTab, string][]).map(([tabKey, label]) => (
              <button
                key={tabKey}
                onClick={() => setRightTab(tabKey)}
                style={{
                  padding: '8px 0',
                  border: 'none',
                  fontSize: 10,
                  background: 'transparent',
                  color: rightTab === tabKey ? P.text : P.muted,
                  borderBottom: `2px solid ${rightTab === tabKey ? P.accent : 'transparent'}`,
                  fontWeight: rightTab === tabKey ? 600 : 400,
                  cursor: 'pointer',
                  flex: 1
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Active Tab Panel */}
          <div style={{ flex: '0 0 58%', overflowY: 'auto', padding: '10px 12px' }}>
            {rightTab === 'distress' && dw && dw.requests.filter(r => r.status !== 'delivered').map(r => {
              const asgn = dw.assignments.find(a => a.request_id === r.id && a.status === 'active')
              const isUrgent = r.urgency >= 5 && r.status === 'waiting'
              return (
                <div
                  key={r.id}
                  onClick={() => setSelResource({ type: 'request', id: r.id })}
                  style={{
                    border: `1px solid ${isUrgent ? '#ef4444' : P.border}`,
                    borderRadius: 4,
                    padding: '6px 8px',
                    marginBottom: 6,
                    cursor: 'pointer',
                    background: P.panelSubtle
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 11, color: P.text }}>{r.neighbourhood || r.location}</span>
                    <span style={{ fontSize: 9, color: isUrgent ? '#ef4444' : P.muted, fontFamily: 'monospace' }}>
                      {isUrgent ? 'URGENT' : r.status.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: P.muted }}>
                    {r.people.toLocaleString()} stranded &bull; Level {r.urgency}/5
                  </div>
                  {asgn && (
                    <div style={{ fontSize: 9, color: P.accent, marginTop: 4, fontFamily: 'monospace' }}>
                      {asgn.boat_id.toUpperCase()} en route (ETA {asgn.eta_pickup}t)
                    </div>
                  )}
                </div>
              )
            })}

            {rightTab === 'fleet' && dw && dw.boats.map(b => {
              const vt = b.vehicle_type || (b.id.startsWith('truck') ? 'truck' : b.id.startsWith('heli') ? 'helicopter' : 'boat')
              const asgn = dw.assignments.find(a => a.boat_id === b.id && a.status === 'active')
              const broken = b.status === 'broken'
              const typeName = vt === 'helicopter' ? 'IAF Airlift Sqn' : vt === 'truck' ? 'Army Convoy' : 'NDRF Flotilla'
              return (
                <div
                  key={b.id}
                  onClick={() => setSelResource({ type: 'vehicle', id: b.id })}
                  style={{
                    border: `1px solid ${broken ? '#ef4444' : P.border}`,
                    borderRadius: 4,
                    padding: '6px 8px',
                    marginBottom: 6,
                    cursor: 'pointer',
                    background: P.panelSubtle
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 11, color: P.text }}>
                      {b.id.replace(/boat_|truck_|heli_/, '').toUpperCase()}
                    </span>
                    <span style={{ fontSize: 9, color: broken ? '#ef4444' : P.muted, fontFamily: 'monospace' }}>
                      {b.status.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: P.muted, marginBottom: 4 }}>
                    {typeName} &bull; Cap {b.capacity.toLocaleString()}
                  </div>
                  <div style={{ background: P.panel, height: 4, borderRadius: 2, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${(b.people_on_board / b.capacity) * 100}%`,
                        height: '100%',
                        background: P.accent
                      }}
                    />
                  </div>
                  {asgn && (
                    <div style={{ fontSize: 9, color: P.accent, marginTop: 4, fontFamily: 'monospace' }}>
                      Serving {asgn.request_id}
                    </div>
                  )}
                </div>
              )
            })}

            {rightTab === 'shelters' && dw && (
              <div>
                {dw.shelters.map(s => {
                  const pct = s.fill_pct != null ? s.fill_pct : s.occupied / s.total_capacity
                  const barColor = pct >= 0.9 ? '#f43f5e' : pct >= 0.75 ? '#f59e0b' : '#10b981'
                  return (
                    <div
                      key={s.id}
                      style={{
                        border: `1px solid ${P.border}`,
                        borderRadius: 4,
                        padding: '6px 8px',
                        marginBottom: 6,
                        background: P.panelSubtle
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                        <span style={{ fontWeight: 600, fontSize: 11, color: P.text }}>{formatShelterName(s.id)}</span>
                        <span style={{ fontSize: 9, color: barColor, fontFamily: 'monospace' }}>{Math.round(pct * 100)}%</span>
                      </div>
                      <div style={{ background: P.panel, height: 4, borderRadius: 2, overflow: 'hidden', marginBottom: 4 }}>
                        <div style={{ width: `${pct * 100}%`, height: '100%', background: barColor }} />
                      </div>
                      <div style={{ fontSize: 10, color: P.muted }}>
                        {s.occupied.toLocaleString()} / {s.total_capacity.toLocaleString()} beds
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {rightTab === 'swarm' && (
              <div>
                <div style={{ background: P.panelSubtle, border: `1px solid ${P.border}`, borderRadius: 4, padding: '8px 10px', marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: P.muted, marginBottom: 2 }}>Additional Lives Saved</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#10b981', fontFamily: 'monospace' }}>
                    +{extraSaved.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 9, color: P.muted }}>vs centralized computer heuristic</div>
                </div>

                <div style={{ background: P.panelSubtle, border: `1px solid ${P.border}`, borderRadius: 4, padding: '8px 10px', marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: P.muted, marginBottom: 2 }}>Fairness Distribution (Gini)</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: gini < 0.03 ? '#10b981' : '#f59e0b', fontFamily: 'monospace' }}>
                    {gini.toFixed(3)}
                  </div>
                  <div style={{ fontSize: 9, color: P.muted }}>
                    {gini < 0.03 ? 'High equity across all 20 flood sectors' : 'Moderate sector distribution variance'}
                  </div>
                </div>

                <div style={{ background: P.panelSubtle, border: `1px solid ${P.border}`, borderRadius: 4, padding: '8px 10px', marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: P.muted, marginBottom: 2 }}>Safety Invariants</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: viol === 0 ? '#10b981' : '#f43f5e', fontFamily: 'monospace' }}>
                    {viol === 0 ? '0 Violations Enforced' : `${viol} Violations Detected`}
                  </div>
                </div>

                {compoundReport && (
                  <button
                    onClick={() => setShowDrawer(true)}
                    style={{
                      width: '100%',
                      background: P.panel,
                      color: P.text,
                      border: `1px solid ${P.border}`,
                      borderRadius: 4,
                      padding: '6px 0',
                      fontSize: 10,
                      cursor: 'pointer',
                      fontWeight: 600
                    }}
                  >
                    View Compound Recovery Report
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Inspector Panel */}
          <div
            style={{
              flex: '0 0 42%',
              borderTop: `1px solid ${P.border}`,
              padding: '10px 12px',
              overflowY: 'auto',
              background: P.panelSubtle
            }}
          >
            <div style={{ fontSize: 9, fontWeight: 600, color: P.muted, textTransform: 'uppercase', marginBottom: 6 }}>
              Resource Details
            </div>
            {!selResource ? (
              <div style={{ color: P.muted, fontSize: 10, lineHeight: 1.6, textAlign: 'center', paddingTop: 14 }}>
                Select any vessel, relief camp, or sector marker on the map to inspect live auction telemetry.
              </div>
            ) : dw && (() => {
              if (selResource.type === 'request') {
                const r = dw.requests.find(x => x.id === selResource.id)
                if (!r) return <div style={{ color: P.muted }}>Not found.</div>
                const asgn = dw.assignments.find(a => a.request_id === r.id)
                return (
                  <div style={{ fontSize: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: P.text }}>{r.neighbourhood}</div>
                    {[
                      ['Stranded Count', r.people.toLocaleString()],
                      ['Urgency Priority', `${r.urgency}/5`],
                      ['Status', r.status.toUpperCase()],
                      ['Wait Ticks', `${r.waiting_ticks}s`],
                      ['Vehicle Dispatched', asgn ? asgn.boat_id.toUpperCase() : 'Unassigned']
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: `1px solid ${P.borderFaint}` }}>
                        <span style={{ color: P.muted }}>{k}</span>
                        <span style={{ fontFamily: 'monospace' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )
              }
              if (selResource.type === 'vehicle') {
                const b = dw.boats.find(x => x.id === selResource.id)
                if (!b) return <div style={{ color: P.muted }}>Not found.</div>
                const vt = b.vehicle_type || (b.id.startsWith('truck') ? 'truck' : b.id.startsWith('heli') ? 'helicopter' : 'boat')
                const asgn = dw.assignments.find(a => a.boat_id === b.id && a.status === 'active')
                return (
                  <div style={{ fontSize: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: P.text }}>
                      {vt.toUpperCase()} &bull; {b.id.toUpperCase()}
                    </div>
                    {[
                      ['Status', b.status.toUpperCase()],
                      ['Occupancy', `${b.people_on_board.toLocaleString()} / ${b.capacity.toLocaleString()}`],
                      ['Active Mission', asgn ? asgn.request_id : 'Idle Standby']
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: `1px solid ${P.borderFaint}` }}>
                        <span style={{ color: P.muted }}>{k}</span>
                        <span style={{ fontFamily: 'monospace' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )
              }
              if (selResource.type === 'shelter') {
                const s = dw.shelters.find(x => x.id === selResource.id)
                if (!s) return <div style={{ color: P.muted }}>Not found.</div>
                const pct = s.fill_pct != null ? s.fill_pct : s.occupied / s.total_capacity
                return (
                  <div style={{ fontSize: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: P.text }}>
                      {formatShelterName(s.id)}
                    </div>
                    {[
                      ['Beds Occupied', `${s.occupied.toLocaleString()} / ${s.total_capacity.toLocaleString()}`],
                      ['Utilization', `${Math.round(pct * 100)}%`],
                      ['Triage Diversion', pct >= 0.75 ? 'Active' : 'Standby']
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: `1px solid ${P.borderFaint}` }}>
                        <span style={{ color: P.muted }}>{k}</span>
                        <span style={{ fontFamily: 'monospace' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )
              }
              return null
            })()}
          </div>
        </div>

        {/* Tools Drawer */}
        {showTools && (
          <div
            style={{
              flex: '0 0 260px',
              display: 'flex',
              flexDirection: 'column',
              background: P.bg,
              borderLeft: `1px solid ${P.border}`,
              padding: '12px 14px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 12, color: P.text }}>Disaster Controls</span>
              <button
                onClick={() => setShowTools(false)}
                style={{ background: 'transparent', border: 'none', color: P.muted, cursor: 'pointer', fontSize: 14 }}
              >
                &times;
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: P.muted, textTransform: 'uppercase', marginBottom: 6 }}>
                Simulate Disruption
              </div>
              {dw ? (() => {
                const roads = dw.edges.filter(e => e.open && e.mode === 'road')
                const vehicles = dw.boats.filter(b => b.status !== 'broken')
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <button
                      onClick={() => roads.length > 0 && injectEvent('route_closure', roads[Math.floor(roads.length / 3)].id)}
                      disabled={!simId || roads.length === 0}
                      style={{
                        background: P.panel,
                        color: P.text,
                        border: `1px solid ${P.border}`,
                        borderRadius: 4,
                        padding: '6px 8px',
                        fontSize: 10,
                        cursor: 'pointer'
                      }}
                    >
                      Close Road Corridor
                    </button>
                    <button
                      onClick={() => vehicles.length > 0 && injectEvent('boat_breakdown', vehicles[0].id)}
                      disabled={!simId || vehicles.length === 0}
                      style={{
                        background: P.panel,
                        color: P.text,
                        border: `1px solid ${P.border}`,
                        borderRadius: 4,
                        padding: '6px 8px',
                        fontSize: 10,
                        cursor: 'pointer'
                      }}
                    >
                      Trigger Vessel Breakdown
                    </button>
                  </div>
                )
              })() : (
                <div style={{ color: P.muted, fontSize: 10 }}>Start simulation first.</div>
              )}
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: P.muted, textTransform: 'uppercase', marginBottom: 6 }}>
                Replay Export
              </div>
              <button
                onClick={exportReplay}
                disabled={!dw}
                style={{
                  width: '100%',
                  background: P.panel,
                  color: P.text,
                  border: `1px solid ${P.border}`,
                  borderRadius: 4,
                  padding: '6px 0',
                  fontSize: 10,
                  cursor: 'pointer'
                }}
              >
                Download Replay Log (.json)
              </button>
            </div>
          </div>
        )}

      </div>

      {/* Benchmark Modal */}
      {showBench && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(24,20,29,0.85)',
            backdropFilter: 'blur(4px)',
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20
          }}
          onClick={e => {
            if (e.target === e.currentTarget) setShowBench(false)
          }}
        >
          <div
            style={{
              background: P.panel,
              border: `1px solid ${P.border}`,
              borderRadius: 8,
              width: 'min(760px, 94vw)',
              maxHeight: '80vh',
              overflowY: 'auto',
              padding: 18
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: P.text }}>
                Multi-Strategy Benchmark Analysis
              </span>
              <button
                onClick={() => setShowBench(false)}
                style={{ background: 'transparent', border: 'none', color: P.muted, fontSize: 18, cursor: 'pointer' }}
              >
                &times;
              </button>
            </div>

            <button
              onClick={runBench}
              disabled={benchLoading}
              style={{
                background: P.accent,
                color: '#FFFFFF',
                border: 'none',
                borderRadius: 4,
                padding: '6px 14px',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                marginBottom: 14
              }}
            >
              {benchLoading ? 'Executing 3 Monte Carlo Seeds...' : 'Run Monte Carlo Benchmark'}
            </button>

            {benchResult?.summaries && (
              <div>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={benchResult.summaries}>
                    <XAxis dataKey="strategy" tick={{ fontSize: 10, fill: P.muted }} />
                    <YAxis tick={{ fontSize: 10, fill: P.muted }} />
                    <Tooltip contentStyle={{ background: P.bg, border: `1px solid ${P.border}`, fontSize: 10, color: P.text }} />
                    <Legend />
                    <Bar dataKey="avg_people_delivered" name="People Rescued" fill="#10b981" />
                    <Bar dataKey="avg_mean_delivery_time" name="Mean Time" fill="#38bdf8" />
                    <Bar dataKey="avg_safety_violations" name="Violations" fill="#f43f5e" />
                  </BarChart>
                </ResponsiveContainer>

                <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 10 }}>
                  <thead>
                    <tr style={{ background: P.panelSubtle }}>
                      {['Strategy', 'Rescued', 'Mean Time', 'Gini Fairness', 'Violations'].map(h => (
                        <th key={h} style={{ padding: '6px 8px', textAlign: 'left', color: P.muted, fontWeight: 600, borderBottom: `1px solid ${P.border}` }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {benchResult.summaries.map((s: any) => (
                      <tr key={s.strategy} style={{ borderBottom: `1px solid ${P.borderFaint}` }}>
                        <td style={{ padding: '6px 8px', fontWeight: 600, fontFamily: 'monospace' }}>{s.strategy}</td>
                        <td style={{ padding: '6px 8px', color: '#10b981', fontFamily: 'monospace' }}>
                          {Math.round(s.avg_people_delivered ?? 0).toLocaleString()}
                        </td>
                        <td style={{ padding: '6px 8px', color: P.muted, fontFamily: 'monospace' }}>
                          {s.avg_mean_delivery_time?.toFixed(1)}
                        </td>
                        <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>
                          {(s.avg_gini_coefficient ?? 0).toFixed(3)}
                        </td>
                        <td style={{ padding: '6px 8px', color: (s.avg_safety_violations ?? 0) > 0 ? '#f43f5e' : '#10b981', fontFamily: 'monospace' }}>
                          {s.avg_safety_violations?.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Compound Disruption Modal */}
      {showDrawer && compoundReport && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(24,20,29,0.85)',
            backdropFilter: 'blur(5px)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20
          }}
          onClick={e => {
            if (e.target === e.currentTarget) setShowDrawer(false)
          }}
        >
          <div
            style={{
              background: P.panel,
              border: `1px solid ${P.border}`,
              borderRadius: 8,
              width: 'min(780px, 94vw)',
              maxHeight: '84vh',
              overflowY: 'auto',
              padding: 18
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: P.text }}>
                  Compound Disruption Resolution &bull; Tick #{compoundReport.tick}
                </div>
                <div style={{ marginTop: 4, display: 'flex', gap: 10, fontSize: 10, color: P.muted }}>
                  <span style={{ color: '#10b981', fontFamily: 'monospace', fontWeight: 600 }}>
                    {compoundReport.surgical_stability_pct}% Fleet Stability Preserved
                  </span>
                  <span>&bull;</span>
                  <span>{compoundReport.unaffected_vehicle_ids.length} vessels kept original assignments</span>
                </div>
              </div>
              <button
                onClick={() => setShowDrawer(false)}
                style={{ background: 'transparent', border: 'none', color: P.muted, fontSize: 18, cursor: 'pointer' }}
              >
                &times;
              </button>
            </div>

            {compoundReport.mayday_request_id && (
              <div
                style={{
                  background: 'rgba(239,68,68,0.1)',
                  border: '1px solid #7f1d1d',
                  borderRadius: 4,
                  padding: '6px 10px',
                  marginBottom: 12,
                  fontSize: 11,
                  color: '#f87171'
                }}
              >
                Mayday broadcast issued: Disabled rescue vessel converted into high-priority rescue dispatch ({compoundReport.mayday_request_id}).
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: P.muted, marginBottom: 6 }}>
                  Disrupted Missions ({compoundReport.cancelled_commitments.length})
                </div>
                {compoundReport.cancelled_commitments.map((c, i) => (
                  <div key={i} style={{ background: P.panelSubtle, border: `1px solid ${P.border}`, borderRadius: 4, padding: '8px 10px', marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontWeight: 600, fontSize: 10, color: P.text }}>{c.vehicle_id.toUpperCase()}</span>
                      <span style={{ fontSize: 8, color: '#f87171', fontFamily: 'monospace' }}>{c.reason_code}</span>
                    </div>
                    <div style={{ fontSize: 9, color: P.muted }}>{c.explanation}</div>
                  </div>
                ))}
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: P.muted, marginBottom: 6 }}>
                  Autonomous Swarm Reassignments ({compoundReport.reassignments.length})
                </div>
                {compoundReport.reassignments.map((r, i) => (
                  <div key={i} style={{ background: P.panelSubtle, border: `1px solid ${P.border}`, borderRadius: 4, padding: '8px 10px', marginBottom: 6 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 2, color: P.text }}>
                      {r.new_vehicle_id.toUpperCase()} won auction for sector
                    </div>
                    <div style={{ fontSize: 9, color: P.muted }}>{r.why_explanation}</div>
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

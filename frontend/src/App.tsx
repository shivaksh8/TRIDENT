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
const SVG_W = 1100
const SVG_H = 630

// 5th-95th percentile bounding box projection
function computeProjection(nodes: Node[]) {
  const fallback = { toSvg: (_lat: number, _lon: number): [number,number] => [SVG_W/2, SVG_H/2] }
  if (!nodes.length) return fallback
  const lats = nodes.map(n => n.lat ?? (16.55 + n.y * 0.003)).sort((a,b) => a-b)
  const lons = nodes.map(n => n.lon ?? (74.0 + n.x * 0.0035)).sort((a,b) => a-b)
  const p = (arr: number[], f: number) => arr[Math.max(0,Math.min(arr.length-1,Math.floor(arr.length*f)))]
  const minLat=p(lats,0.04), maxLat=p(lats,0.96), minLon=p(lons,0.04), maxLon=p(lons,0.96)
  const pad=0.07
  const lo0=minLon-(maxLon-minLon)*pad, lo1=maxLon+(maxLon-minLon)*pad
  const la0=minLat-(maxLat-minLat)*pad, la1=maxLat+(maxLat-minLat)*pad
  const toSvg = (lat: number, lon: number): [number,number] => {
    const cx=Math.max(lo0,Math.min(lo1,lon)), cy=Math.max(la0,Math.min(la1,lat))
    return [((cx-lo0)/(lo1-lo0))*(SVG_W*0.9)+SVG_W*0.05, ((la1-cy)/(la1-la0))*(SVG_H*0.9)+SVG_H*0.05]
  }
  return { toSvg }
}

function nodeToSvg(n: Node, proj: ReturnType<typeof computeProjection>): [number,number] {
  return proj.toSvg(n.lat ?? (16.55+n.y*0.003), n.lon ?? (74.0+n.x*0.0035))
}

// Plain-English log translator
function fmtLog(e: LogEntry) {
  const lo = e.message.toLowerCase()
  if (lo.includes('mayday')) return { badge:'DISASTER', bg:'#7f1d1d', fg:'#fca5a5', text:e.message }
  if (lo.includes('delivered')||lo.includes('shelter')) return { badge:'SAFE', bg:'#14532d', fg:'#86efac', text:e.message }
  if (lo.includes('pickup')||lo.includes('rescue')) return { badge:'RESCUE', bg:'#1e3a5f', fg:'#93c5fd', text:e.message }
  if (lo.includes('dispatch')||lo.includes('assign')) return { badge:'DISPATCH', bg:'#1e3a5f', fg:'#7dd3fc', text:e.message }
  if (lo.includes('road')||lo.includes('veto')||lo.includes('flood warn')) return { badge:'ROAD WARN', bg:'#78350f', fg:'#fde68a', text:e.message }
  if (lo.includes('heli')||lo.includes('recon')) return { badge:'HELI', bg:'#2e1065', fg:'#c4b5fd', text:e.message }
  if (lo.includes('compound')||lo.includes('bridge')||lo.includes('breakdown')) return { badge:'DISASTER', bg:'#7f1d1d', fg:'#fca5a5', text:e.message }
  if (lo.includes('bid')||lo.includes('negotiation')) return { badge:'NEGOT', bg:'#1e3a5f', fg:'#93c5fd', text:e.message }
  return { badge:'SYS', bg:'#1e293b', fg:'#94a3b8', text:e.message }
}

const CHAPTERS = [
  { title:'Predictive Dead-Trap Veto', action:'Start + 3 steps',
    note:'Amber roads = flood traps the AI blocked trucks from entering. Cyan dashed = flooded roads used as boat canals.' },
  { title:'Negotiation & Heli Scout', action:'Advance 4 steps',
    note:'Purple ring = helicopter verification sweep. Teal CHECKPOINT = boat-to-truck transfer points. Swarm negotiates routes automatically.' },
  { title:'Triple Catastrophe', action:'Trigger triple disaster',
    note:'Bridge collapse + Boat breakdown + Shelter overflow simultaneously. The popup shows how the swarm fixed everything in under 1 second.' },
  { title:'Fairness & Ghost Fleet', action:'Close popup + 3 steps',
    note:'Swarm tab shows extra lives saved vs standard dispatch. Gini = how fairly rescue was distributed across all villages.' },
  { title:'Statistical Proof', action:'Run comparison',
    note:'Multi-scenario benchmark: Smart Swarm rescues more people, more fairly, faster than both baseline approaches.' },
]

export default function App() {
  const [world, setWorld] = useState<WorldState|null>(null)
  const [simId, setSimId] = useState<string|null>(null)
  const [strategy, setStrategy] = useState('negotiation')
  const [seed, setSeed] = useState(2019)
  const [log, setLog] = useState<LogEntry[]>([])
  const wsRef = useRef<WebSocket|null>(null)
  const histCache = useRef<Map<number,WorldState>>(new Map())
  const [maxTick, setMaxTick] = useState(0)
  const [replayTick, setReplayTick] = useState<number|null>(null)

  const [darkMode, setDarkMode] = useState(true)
  const [rightTab, setRightTab] = useState<'distress'|'fleet'|'shelters'|'swarm'>('distress')
  const [showSidebar, setShowSidebar] = useState(false)
  const [selResource, setSelResource] = useState<{type:string;id:string}|null>(null)
  const [cleanAtlas, setCleanAtlas] = useState(true)

  const [benchResult, setBenchResult] = useState<any>(null)
  const [benchLoading, setBenchLoading] = useState(false)
  const [showBench, setShowBench] = useState(false)
  const [compoundReport, setCompoundReport] = useState<CompoundDisruptionReport|null>(null)
  const [showDrawer, setShowDrawer] = useState(false)
  const [triggeringCompound, setTriggeringCompound] = useState(false)

  const [judgeMode, setJudgeMode] = useState(false)
  const [judgeChap, setJudgeChap] = useState(0)
  const [judgeRunning, setJudgeRunning] = useState(false)

  const [svgPan, setSvgPan] = useState({x:0,y:0})
  const [svgZoom, setSvgZoom] = useState(1)
  const dragRef = useRef({dragging:false,startX:0,startY:0,panStart:{x:0,y:0}})

  // Vehicle animation
  const vPosRef = useRef<Map<string,{x:number;y:number}>>(new Map())
  const vTgtRef = useRef<Map<string,{x:number;y:number}>>(new Map())
  const rafRef = useRef<number|null>(null)
  const [, forceAnim] = useState(0)
  const projRef = useRef(computeProjection([]))

  const T = {
    bg:       darkMode?'#0f172a':'#f1f5f9',
    panel:    darkMode?'#1e293b':'#ffffff',
    panel2:   darkMode?'#0f172a':'#f8fafc',
    border:   darkMode?'#334155':'#e2e8f0',
    text:     darkMode?'#f1f5f9':'#1e293b',
    muted:    darkMode?'#94a3b8':'#64748b',
    faint:    darkMode?'#475569':'#94a3b8',
    accent:   '#3b82f6',
    river:    '#0284c7',
    canal:    '#0ea5e9',
    deadtrap: '#d97706',
    closed:   '#dc2626',
    shelter:  '#15803d',
    highway:  darkMode?'#94a3b8':'#334155',
  }

  useEffect(() => {
    const step = () => {
      let moved=false
      vTgtRef.current.forEach((tgt,id) => {
        const cur=vPosRef.current.get(id)??{...tgt}
        const nx=cur.x+(tgt.x-cur.x)*0.12, ny=cur.y+(tgt.y-cur.y)*0.12
        vPosRef.current.set(id,{x:nx,y:ny})
        if(Math.abs(nx-tgt.x)>0.4||Math.abs(ny-tgt.y)>0.4) moved=true
      })
      if(moved) forceAnim(n=>n+1)
      rafRef.current=requestAnimationFrame(step)
    }
    rafRef.current=requestAnimationFrame(step)
    return()=>{ if(rafRef.current) cancelAnimationFrame(rafRef.current) }
  },[])

  useEffect(() => {
    if(!world) return
    const proj=projRef.current
    world.boats.forEach(b => {
      const n=world.nodes.find(nd=>nd.id===b.location); if(!n) return
      const [tx,ty]=proj.toSvg(n.lat??(16.55+n.y*0.003),n.lon??(74.0+n.x*0.0035))
      vTgtRef.current.set(b.id,{x:tx,y:ty})
      if(!vPosRef.current.has(b.id)) vPosRef.current.set(b.id,{x:tx,y:ty})
    })
  },[world])

  useEffect(() => {
    if(!world?.nodes.length) return
    projRef.current=computeProjection(world.nodes)
  },[world?.nodes])

  const connectWs = useCallback((id:string) => {
    wsRef.current?.close()
    const ws=new WebSocket(`ws://localhost:8000/api/v1/simulations/${id}/stream`)
    ws.onmessage=evt=>{
      const w:WorldState=JSON.parse(evt.data)
      setWorld(w); setLog(prev=>[...prev,...w.log].slice(-500))
      setMaxTick(w.tick); histCache.current.set(w.tick,w)
      if(w.last_compound_report) setCompoundReport(w.last_compound_report)
    }
    wsRef.current=ws
  },[])

  const createSim=async()=>{
    setLog([]); setBenchResult(null); setMaxTick(0); setReplayTick(null); histCache.current.clear()
    try {
      const r=await fetch(`${API}/api/v1/simulations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({strategy,seed})})
      const d=await r.json(); setSimId(d.simulation_id); connectWs(d.simulation_id)
    } catch {}
  }

  const cmd=(command:string,extra?:object)=>wsRef.current?.send(JSON.stringify({command,...extra}))

  const injectEvent=async(type:string,target:string)=>{
    if(!simId||!world) return
    try { await fetch(`${API}/api/v1/simulations/${simId}/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event_type:type,target_id:target,tick_offset:1})}) }
    catch { cmd('inject_event',{event:{tick:(world?.tick??0)+1,event_type:type,target_id:target,payload:{},description:''}}) }
  }

  const runBench=async()=>{
    setBenchLoading(true)
    try { const r=await fetch(`${API}/api/v1/benchmarks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seeds:[2019,42,137],disruptions:true})}); setBenchResult(await r.json()) }
    catch {}
    setBenchLoading(false)
  }

  const triggerCompound=async()=>{
    if(!simId||!world) return; setTriggeringCompound(true)
    try {
      const openEdges=world.edges.filter(e=>e.open&&!e.submerged_navigable&&e.mode!=='water')
      const vehicles=world.boats.filter(b=>b.status!=='broken')
      const r=await fetch(`${API}/api/v1/simulations/${simId}/trigger-compound`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bridge_edge_id:openEdges[0]?.id??'',fail_boat_id:vehicles[0]?.id??'',overflow_shelter_id:world.shelters[0]?.id??''})})
      if(r.ok){const report:CompoundDisruptionReport=await r.json(); setCompoundReport(report); setShowDrawer(true)}
    } catch {}
    setTriggeringCompound(false)
  }

  const runJudgeChap=async(ch:number)=>{
    if(judgeRunning) return; setJudgeRunning(true)
    try {
      if(ch===0){
        setStrategy('negotiation'); await new Promise(r=>setTimeout(r,100))
        setLog([]); setMaxTick(0); setReplayTick(null); histCache.current.clear()
        const resp=await fetch(`${API}/api/v1/simulations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({strategy:'negotiation',seed:2019})})
        const d=await resp.json(); setSimId(d.simulation_id); connectWs(d.simulation_id)
        await new Promise(r=>setTimeout(r,400))
        for(let i=0;i<3;i++){cmd('step');await new Promise(r=>setTimeout(r,300))}
      } else if(ch===1){
        for(let i=0;i<4;i++){cmd('step');await new Promise(r=>setTimeout(r,300))}
      } else if(ch===2){ await triggerCompound()
      } else if(ch===3){
        setShowDrawer(false)
        for(let i=0;i<3;i++){cmd('step');await new Promise(r=>setTimeout(r,350))}
      } else if(ch===4){ setShowBench(true); await runBench() }
    } catch {}
    setJudgeRunning(false)
  }

  const exportReplay=()=>{
    if(!world) return
    const payload={scenario:'Kolhapur 2019 Flood',strategy:world.strategy,final_tick:world.tick,final_metrics:world.metrics,safety_invariants_passed:(world.safety_violation_count??0)===0,last_compound_report:world.last_compound_report??null,event_log:log.slice(-200),tick_summaries:Array.from(histCache.current.entries()).sort(([a],[b])=>a-b).map(([t,ws])=>({tick:t,delivered:ws.metrics?.people_delivered??0,flooded_nodes:ws.flood_state?.flooded_nodes?.length??0}))}
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`floodops-replay-t${world.tick}.json`
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  }

  const scrubTo=async(t:number)=>{
    setReplayTick(t); if(histCache.current.has(t)) return; if(!simId) return
    try { const r=await fetch(`${API}/api/v1/simulations/${simId}/history/${t}`); histCache.current.set(t,await r.json()) } catch {}
  }

  const dw=replayTick!==null?(histCache.current.get(replayTick)??world):world
  const m=dw?.metrics
  const gc=dw?.ghost_comparison||m?.ghost_comparison
  const gini=m?.gini_coefficient??m?.fairness_gini??0
  const viol=m?.safety_violations??dw?.safety_violation_count??0
  const waiting=dw?.requests.filter(r=>r.status==='waiting'||r.status==='assigned').length??0
  const delivered=m?.people_delivered??0
  const tick=dw?.tick??0
  const extraSaved=gc?.extra_people_saved??0
  const totalDisplaced=73940
  const renderMap=()=>{
    const bgColor=darkMode?'#0c1a2e':'#f4f1ea'
    const gridColor=darkMode?'rgba(30,58,95,0.5)':'rgba(210,200,185,0.7)'
    const lblColor=darkMode?'#334155':'#b0a898'
    if(!dw||!dw.nodes.length) return (
      <svg width="100%" height="100%" viewBox={`0 0 ${SVG_W} ${SVG_H}`} style={{background:bgColor,display:'block'}}>
        <text x={SVG_W/2} y={SVG_H/2} textAnchor="middle" fill={lblColor} fontSize={18}>Start a simulation to see the map</text>
      </svg>
    )
    const proj=projRef.current
    const nm=new Map(dw.nodes.map(n=>[n.id,n]))
    const nodePos=new Map<string,[number,number]>()
    dw.nodes.forEach(n=>nodePos.set(n.id,nodeToSvg(n,proj)))

    const activeEdgeIds=new Set<string>()
    if(cleanAtlas){
      dw.assignments.filter(a=>a.status==='active').forEach(a=>{
        const boat=dw.boats.find(b=>b.id===a.boat_id); if(!boat?.path) return
        for(let i=1;i<boat.path.length;i++){
          const e=dw.edges.find(e2=>(e2.source===boat.path[i-1]&&e2.destination===boat.path[i])||(e2.source===boat.path[i]&&e2.destination===boat.path[i-1]))
          if(e) activeEdgeIds.add(e.id)
        }
      })
      const hot=new Set([...dw.shelters.map(s=>s.location),...dw.requests.filter(r=>r.status!=='delivered').map(r=>r.location)])
      dw.edges.forEach(e=>{
        if(hot.has(e.source)||hot.has(e.destination)) activeEdgeIds.add(e.id)
        if(!e.open||e.submerged_navigable||(e.ticks_until_flooded!=null&&e.ticks_until_flooded<=4)) activeEdgeIds.add(e.id)
        if(e.mode==='water'||e.mode==='river') activeEdgeIds.add(e.id)
      })
    }

    const floodPlumes=(dw.flood_state?.flooded_nodes??[]).flatMap(id=>{
      const pos=nodePos.get(id); if(!pos) return []
      const [fx,fy]=pos
      return [<circle key={'fpo_'+id} cx={fx} cy={fy} r={26} fill="rgba(56,189,248,0.18)" stroke="none"/>,
              <circle key={'fpi_'+id} cx={fx} cy={fy} r={13} fill="rgba(2,132,199,0.28)" stroke="none"/>]
    })

    const edgeLines:React.ReactElement[]=[]
    const pillBadges:React.ReactElement[]=[]
    let pillCount=0
    dw.edges.forEach(e=>{
      const p1=e.lat_a!=null?proj.toSvg(e.lat_a,e.lon_a!):nodePos.get(e.source)
      const p2=e.lat_b!=null?proj.toSvg(e.lat_b,e.lon_b!):nodePos.get(e.destination)
      if(!p1||!p2) return
      const [x1,y1]=p1,[x2,y2]=p2
      const isSub=!!e.submerged_navigable
      const isFlood=!isSub&&e.ticks_until_flooded!=null&&e.ticks_until_flooded>0&&e.ticks_until_flooded<=4
      const isClosed=!e.open&&!isSub
      const isWater=e.mode==='water'||e.mode==='river'
      const isActive=activeEdgeIds.has(e.id)
      const isBg=cleanAtlas&&!isActive&&!isWater&&!isSub&&!isFlood&&!isClosed
      const stroke=isBg?(darkMode?'#1e3a5f':'#cbd5e1'):isWater?T.river:isSub?T.canal:isFlood?T.deadtrap:isClosed?T.closed:T.highway
      const sw=isBg?1:isWater?4.5:isSub?4:isFlood?3:isClosed?4:2.5
      const op=isBg?0.28:0.85
      const dash=isSub?'8 5':isFlood?'5 4':isClosed?'4 5':undefined
      if(isWater) edgeLines.push(<line key={'ec_'+e.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#bae6fd" strokeWidth={7} opacity={0.45} strokeLinecap="round"/>)
      edgeLines.push(<line key={'e_'+e.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw} opacity={op} strokeDasharray={dash} strokeLinecap="round"/>)
      if(isSub) edgeLines.push(<line key={'ca_'+e.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="white" strokeWidth={1.5} opacity={0.4} strokeDasharray="6 8" strokeLinecap="round" style={{animation:'flowDash 1.4s linear infinite'}}/>)
      if(pillCount<22&&!isBg){
        let pt='',pb='',pf=''
        if(isSub){pt='CANAL';pb='#0e7490';pf='#cffafe'}
        else if(isFlood){pt=`FLOOD ${e.ticks_until_flooded}s`;pb='#92400e';pf='#fde68a'}
        else if(isClosed){pt='CLOSED';pb='#7f1d1d';pf='#fca5a5'}
        if(pt){
          const mx=(x1+x2)/2,my=(y1+y2)/2
          pillBadges.push(<g key={'pill_'+e.id}><rect x={mx-30} y={my-8} width={60} height={15} rx={7} fill={pb} opacity={0.95}/><text x={mx} y={my+3} textAnchor="middle" fill={pf} fontSize={8} fontWeight="700">{pt}</text></g>)
          pillCount++
        }
      }
    })

    const pathTrails:React.ReactElement[]=[]
    dw.assignments.filter(a=>a.status==='active').forEach(a=>{
      const boat=dw.boats.find(b=>b.id===a.boat_id); if(!boat?.path?.length) return
      const vt=boat.vehicle_type||(boat.id.startsWith('truck')?'truck':boat.id.startsWith('heli')?'helicopter':'boat')
      const pathColor=vt==='truck'?'#fb923c':vt==='helicopter'?'#a855f7':'#3b82f6'
      const curPos=vPosRef.current.get(boat.id); if(!curPos) return
      const pts:Array<[number,number]>=[[curPos.x,curPos.y]]
      boat.path.slice(0,8).forEach(nid=>{const pp=nodePos.get(nid);if(pp) pts.push(pp)})
      const req=dw.requests.find(r=>r.id===a.request_id)
      if(req){const rp=nodePos.get(req.location);if(rp) pts.push(rp)}
      if(pts.length>1){
        const d=pts.map((p,i)=>`${i===0?'M':'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
        pathTrails.push(<path key={'tr_'+boat.id} d={d} stroke={pathColor} strokeWidth={2} strokeDasharray="8 5" fill="none" opacity={0.65} strokeLinecap="round"/>)
        const last=pts[pts.length-1],prev=pts[pts.length-2]
        const angle=Math.atan2(last[1]-prev[1],last[0]-prev[0])*180/Math.PI
        pathTrails.push(<polygon key={'ar_'+boat.id} points="-6,-4 6,0 -6,4" fill={pathColor} opacity={0.85} transform={`translate(${last[0]},${last[1]}) rotate(${angle})`}/>)
      }
    })

    const shelterBadges=dw.shelters.map(s=>{
      const pos=nodePos.get(s.location); if(!pos) return null
      const [sx,sy]=pos
      const pct=s.fill_pct!=null?Math.round(s.fill_pct*100):Math.round(s.occupied/s.total_capacity*100)
      const bg=pct>=90?'#dc2626':pct>=75?'#d97706':T.shelter
      return <g key={'sh_'+s.id} style={{cursor:'pointer'}} onClick={()=>setSelResource({type:'shelter',id:s.id})}>
        <rect x={sx-34} y={sy-28} width={68} height={26} rx={8} fill={bg} opacity={0.95} stroke="#fff" strokeWidth={1.5} filter="drop-shadow(0 2px 4px rgba(0,0,0,0.3))"/>
        <text x={sx} y={sy-17} textAnchor="middle" fill="#fff" fontSize={9} fontWeight="700">{s.id.replace('shelter_','').replace(/_/g,' ')}</text>
        <text x={sx} y={sy-7} textAnchor="middle" fill="#fff" fontSize={8} opacity={0.9}>{s.occupied.toLocaleString()}/{s.total_capacity.toLocaleString()}</text>
      </g>
    }).filter(Boolean) as React.ReactElement[]

    const victimBadges=dw.requests.filter(r=>r.status!=='delivered').map(r=>{
      const pos=nodePos.get(r.location); if(!pos) return null
      const [vx,vy]=pos
      const isMayday=r.urgency>=5
      const bg=isMayday?'#dc2626':'#b45309'
      const asgn=dw.assignments.find(a=>a.request_id===r.id&&a.status==='active')
      const bh=asgn?34:24
      return <g key={'rq_'+r.id} style={{cursor:'pointer'}} onClick={()=>setSelResource({type:'request',id:r.id})}>
        <rect x={vx-36} y={vy-bh-4} width={72} height={bh} rx={8} fill={bg} opacity={0.95} stroke={isMayday?'#fca5a5':'#fbbf24'} strokeWidth={1.5} filter="drop-shadow(0 2px 4px rgba(0,0,0,0.3))"/>
        <text x={vx} y={vy-bh+11} textAnchor="middle" fill="#fff" fontSize={9} fontWeight="700">{r.neighbourhood||r.location.replace(/_/g,' ')}</text>
        <text x={vx} y={vy-bh+21} textAnchor="middle" fill="#fff" fontSize={8}>{r.people.toLocaleString()} people stranded</text>
        {asgn&&<text x={vx} y={vy-bh+31} textAnchor="middle" fill="#86efac" fontSize={8} fontWeight="700">{asgn.boat_id.toUpperCase()} en route</text>}
      </g>
    }).filter(Boolean) as React.ReactElement[]

    const vehicleBadges=dw.boats.map(b=>{
      const pos=vPosRef.current.get(b.id)??vTgtRef.current.get(b.id); if(!pos) return null
      const {x:vx,y:vy}=pos
      const vt=b.vehicle_type||(b.id.startsWith('truck')?'truck':b.id.startsWith('heli')?'helicopter':'boat')
      const broken=b.status==='broken'
      const bg=broken?'#7f1d1d':vt==='truck'?'#c2410c':vt==='helicopter'?'#6d28d9':'#0f172a'
      const border=broken?'#ef4444':vt==='truck'?'#fdba74':vt==='helicopter'?'#c4b5fd':'#38bdf8'
      const icon=vt==='truck'?'TRUCK':vt==='helicopter'?'HELI':'BOAT'
      const lbl=broken?'BROKEN':`${b.people_on_board.toLocaleString()}/${b.capacity.toLocaleString()}`
      const sid=b.id.replace(/boat_|truck_|heli_/,'').toUpperCase().slice(0,5)
      return <g key={'bt_'+b.id} style={{cursor:'pointer'}} onClick={()=>setSelResource({type:'vehicle',id:b.id})}>
        {vt==='helicopter'&&!broken&&<circle cx={vx} cy={vy} r={44} stroke="#a855f7" strokeWidth={1.5} fill="rgba(168,85,247,0.06)" strokeDasharray="4 4" opacity={0.55}/>}
        <rect x={vx-36} y={vy-11} width={72} height={22} rx={8} fill={bg} stroke={border} strokeWidth={1.5} filter="drop-shadow(0 2px 5px rgba(0,0,0,0.35))"/>
        <text x={vx} y={vy+4} textAnchor="middle" fill="#fff" fontSize={9} fontWeight="700">{icon} {sid} - {lbl}</text>
      </g>
    }).filter(Boolean) as React.ReactElement[]

    const hubBadges:React.ReactElement[]=[]
    const usedHub:Array<[number,number]>=[]
    for(const n of dw.nodes.filter(nd=>nd.is_transfer_hub)){
      if(hubBadges.length>=3) break
      const pos=nodePos.get(n.id); if(!pos) continue
      const [hx,hy]=pos
      if(usedHub.some(([ox,oy])=>Math.hypot(hx-ox,hy-oy)<120)) continue
      usedHub.push([hx,hy])
      hubBadges.push(<g key={'hub_'+n.id}><rect x={hx-30} y={hy-12} width={60} height={18} rx={9} fill="#0f766e" stroke="#2dd4bf" strokeWidth={1.5} opacity={0.9}/><text x={hx} y={hy+3} textAnchor="middle" fill="#ccfbf1" fontSize={8} fontWeight="700">CHECKPOINT</text></g>)
    }

    void nm
    const vb=`${-svgPan.x/svgZoom} ${-svgPan.y/svgZoom} ${SVG_W/svgZoom} ${SVG_H/svgZoom}`
    return (
      <svg width="100%" height="100%" viewBox={vb} style={{background:bgColor,cursor:dragRef.current.dragging?'grabbing':'grab',display:'block'}}
        onMouseDown={e=>{dragRef.current={dragging:true,startX:e.clientX,startY:e.clientY,panStart:{...svgPan}};e.preventDefault()}}
        onMouseMove={e=>{if(!dragRef.current.dragging)return;setSvgPan({x:dragRef.current.panStart.x+(e.clientX-dragRef.current.startX),y:dragRef.current.panStart.y+(e.clientY-dragRef.current.startY)})}}
        onMouseUp={()=>{dragRef.current.dragging=false}}
        onMouseLeave={()=>{dragRef.current.dragging=false}}
        onWheel={e=>{e.preventDefault();setSvgZoom(z=>Math.min(8,Math.max(0.4,z*(e.deltaY>0?0.85:1.18))))}}>
        <defs><style>{'@keyframes flowDash{from{stroke-dashoffset:0}to{stroke-dashoffset:-26}}'}</style></defs>
        <rect x={0} y={0} width={SVG_W} height={SVG_H} fill={bgColor}/>
        {[...Array(12)].map((_,i)=><line key={'vg'+i} x1={(i+1)*SVG_W/13} y1={0} x2={(i+1)*SVG_W/13} y2={SVG_H} stroke={gridColor} strokeWidth={0.7}/>)}
        {[...Array(8)].map((_,i)=><line key={'hg'+i} x1={0} y1={(i+1)*SVG_H/9} x2={SVG_W} y2={(i+1)*SVG_H/9} stroke={gridColor} strokeWidth={0.7}/>)}
        <text x={SVG_W*0.14} y={SVG_H*0.11} fill={lblColor} fontSize={11} fontStyle="italic">Panchaganga River Basin</text>
        <text x={SVG_W*0.62} y={SVG_H*0.87} fill={lblColor} fontSize={10} fontStyle="italic">Shirol Floodplain</text>
        <text x={SVG_W*0.78} y={SVG_H*0.21} fill={lblColor} fontSize={10} fontStyle="italic">High Ground</text>
        <g opacity={0.65}>{floodPlumes}</g>
        {edgeLines}{pathTrails}{pillBadges}
        {shelterBadges}{victimBadges}{hubBadges}{vehicleBadges}
        <g transform={`translate(${SVG_W-46},46)`}>
          <circle cx={0} cy={0} r={20} fill={darkMode?'rgba(15,23,42,0.8)':'rgba(255,255,255,0.85)'} stroke={darkMode?'#334155':'#e2e8f0'} strokeWidth={1}/>
          <polygon points="0,-14 3.5,4 0,0 -3.5,4" fill={darkMode?'#ef4444':'#dc2626'}/>
          <polygon points="0,14 3.5,-4 0,0 -3.5,-4" fill={darkMode?'#64748b':'#94a3b8'}/>
          <text x={0} y={-16} textAnchor="middle" fill={darkMode?'#ef4444':'#dc2626'} fontSize={8} fontWeight="800">N</text>
        </g>
        <g transform="translate(18,614)">
          <rect x={0} y={-8} width={80} height={14} rx={3} fill={darkMode?'rgba(15,23,42,0.75)':'rgba(255,255,255,0.85)'}/>
          <line x1={4} y1={0} x2={76} y2={0} stroke={darkMode?'#94a3b8':'#475569'} strokeWidth={2}/>
          <line x1={4} y1={-4} x2={4} y2={4} stroke={darkMode?'#94a3b8':'#475569'} strokeWidth={1.5}/>
          <line x1={40} y1={-3} x2={40} y2={3} stroke={darkMode?'#94a3b8':'#475569'} strokeWidth={1.5}/>
          <line x1={76} y1={-4} x2={76} y2={4} stroke={darkMode?'#94a3b8':'#475569'} strokeWidth={1.5}/>
          <text x={4} y={-10} fill={darkMode?'#94a3b8':'#64748b'} fontSize={7}>0</text>
          <text x={34} y={-10} fill={darkMode?'#94a3b8':'#64748b'} fontSize={7}>2 km</text>
          <text x={66} y={-10} fill={darkMode?'#94a3b8':'#64748b'} fontSize={7}>4 km</text>
        </g>
      </svg>
    )
  }

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif',fontSize:13,overflow:'hidden'}}>

      {/* Top bar */}
      <div style={{background:T.panel,borderBottom:`1px solid ${T.border}`,padding:'0 10px',height:52,display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
        <span style={{fontWeight:800,fontSize:15,flexShrink:0}}>FloodOps</span>
        <span style={{background:darkMode?'#1e3a5f':'#dbeafe',color:darkMode?'#38bdf8':'#1e40af',borderRadius:5,padding:'1px 6px',fontSize:10,fontWeight:700,flexShrink:0}}>RESCUE SIM</span>
        <span style={{background:darkMode?'#1e293b':'#f1f5f9',border:'1px solid',borderColor:darkMode?'#334155':'#cbd5e1',borderRadius:4,padding:'2px 8px',color:darkMode?'#94a3b8':'#475569',fontSize:10,fontWeight:600,flexShrink:0}}>73,940 Displaced &middot; 20 Villages</span>
        <div style={{width:1,height:28,background:T.border,flexShrink:0}}/>
        <select value={seed} onChange={e=>setSeed(+e.target.value)} style={{border:`1px solid ${T.border}`,borderRadius:5,padding:'4px 7px',fontSize:11,background:T.panel,color:T.text,cursor:'pointer',maxWidth:145}}>
          <option value={2019}>Kolhapur 2019 Flood</option>
          <option value={42}>District Test A</option>
          <option value={137}>District Test B</option>
        </select>
        <select value={strategy} onChange={e=>setStrategy(e.target.value)} style={{border:`1px solid ${T.border}`,borderRadius:5,padding:'4px 7px',fontSize:11,background:T.panel,color:T.text,cursor:'pointer',maxWidth:200}}>
          <option value="negotiation">Smart Autonomous Swarm</option>
          <option value="optimiser">Central HQ Computer</option>
          <option value="greedy">Nearest-First (Basic)</option>
        </select>
        <div style={{width:1,height:28,background:T.border,flexShrink:0}}/>
        <button onClick={createSim} style={{background:T.panel,color:T.text,border:`1px solid ${T.border}`,borderRadius:5,padding:'5px 10px',fontSize:11,cursor:'pointer',fontWeight:600}}>New</button>
        <button onClick={()=>cmd('step')} disabled={!simId} style={{background:'#1e293b',color:'#fff',border:'none',borderRadius:5,padding:'5px 11px',fontSize:11,cursor:simId?'pointer':'default',fontWeight:700,opacity:simId?1:0.5}}>+1 Step</button>
        <button onClick={()=>cmd('start')} disabled={!simId} style={{background:simId?'#15803d':T.panel,color:simId?'#fff':T.muted,border:`1px solid ${T.border}`,borderRadius:5,padding:'5px 10px',fontSize:11,cursor:simId?'pointer':'default',opacity:simId?1:0.5,fontWeight:600}}>Play</button>
        <button onClick={()=>cmd('pause')} disabled={!simId} style={{background:T.panel,color:T.text,border:`1px solid ${T.border}`,borderRadius:5,padding:'5px 10px',fontSize:11,cursor:'pointer',opacity:simId?1:0.5}}>Pause</button>
        <button onClick={triggerCompound} disabled={!simId||triggeringCompound} style={{background:'#dc2626',color:'#fff',border:'none',borderRadius:5,padding:'5px 11px',fontSize:11,cursor:'pointer',fontWeight:700,opacity:(!simId||triggeringCompound)?0.6:1}}>
          {triggeringCompound?'Triggering...':'Triple Disaster'}
        </button>
        <button onClick={createSim} style={{background:T.panel,color:T.text,border:`1px solid ${T.border}`,borderRadius:5,padding:'5px 10px',fontSize:11,cursor:'pointer'}}>Reset</button>
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:5,flexShrink:0}}>
          {dw&&(
            <>
              <div style={{background:darkMode?'#14532d':'#dcfce7',border:'1px solid #22c55e',borderRadius:7,padding:'3px 10px'}}>
                <span style={{fontWeight:800,fontSize:14,color:'#22c55e'}}>{delivered.toLocaleString()}</span>
                <span style={{color:darkMode?'#86efac':'#166534',marginLeft:4,fontSize:10}}>Rescued</span>
              </div>
              <div style={{background:darkMode?'#450a0a':'#fee2e2',border:'1px solid #ef4444',borderRadius:7,padding:'3px 10px'}}>
                <span style={{fontWeight:800,fontSize:14,color:'#ef4444'}}>{waiting.toLocaleString()}</span>
                <span style={{color:darkMode?'#fca5a5':'#991b1b',marginLeft:4,fontSize:10}}>Stranded</span>
              </div>
              {extraSaved>0&&<div style={{background:darkMode?'#1e3a5f':'#dbeafe',border:'1px solid #3b82f6',borderRadius:7,padding:'3px 10px'}}>
                <span style={{fontWeight:800,fontSize:14,color:T.accent}}>+{extraSaved.toLocaleString()}</span>
                <span style={{color:darkMode?'#93c5fd':'#1e40af',marginLeft:4,fontSize:10}}>Swarm Saved</span>
              </div>}
              <span style={{color:T.faint,fontSize:10}}>T{tick}</span>
            </>
          )}
          <button onClick={()=>setShowBench(b=>!b)} style={{background:showBench?T.accent:T.panel,color:showBench?'#fff':T.muted,border:`1px solid ${T.border}`,borderRadius:5,padding:'4px 9px',fontSize:11,cursor:'pointer',fontWeight:600}}>Compare AI</button>
          <button onClick={()=>setJudgeMode(j=>!j)} style={{background:judgeMode?'#1d4ed8':T.panel,color:judgeMode?'#fff':T.muted,border:`1px solid ${T.border}`,borderRadius:5,padding:'4px 9px',fontSize:11,cursor:'pointer',fontWeight:600}}>Guide</button>
          <button onClick={()=>setShowSidebar(s=>!s)} style={{background:showSidebar?T.accent:T.panel,color:showSidebar?'#fff':T.muted,border:`1px solid ${T.border}`,borderRadius:5,padding:'4px 9px',fontSize:11,cursor:'pointer',fontWeight:600}}>Tools</button>
          <button onClick={()=>setDarkMode(d=>!d)} style={{background:T.panel2,border:`1px solid ${T.border}`,borderRadius:5,padding:'4px 8px',fontSize:11,cursor:'pointer',color:T.text}}>{darkMode?'Light':'Dark'}</button>
        </div>
      </div>

      {judgeMode&&(
        <div style={{background:darkMode?'#020617':'#eff6ff',borderBottom:`1px solid ${darkMode?'#1e3a5f':'#bfdbfe'}`,padding:'6px 12px',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:5}}>
            <button onClick={()=>setJudgeChap(c=>Math.max(0,c-1))} disabled={judgeChap===0} style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:4,padding:'2px 8px',fontSize:11,cursor:'pointer',opacity:judgeChap===0?0.4:1}}>Back</button>
            {[0,1,2,3,4].map(i=><button key={i} onClick={()=>setJudgeChap(i)} style={{padding:'2px 10px',borderRadius:10,border:`1.5px solid ${judgeChap===i?T.accent:T.border}`,background:judgeChap===i?T.accent:T.panel,color:judgeChap===i?'#fff':T.muted,cursor:'pointer',fontSize:11,fontWeight:judgeChap===i?700:400}}>{i+1}</button>)}
            <button onClick={()=>setJudgeChap(c=>Math.min(4,c+1))} disabled={judgeChap===4} style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:4,padding:'2px 8px',fontSize:11,cursor:'pointer',opacity:judgeChap===4?0.4:1}}>Next</button>
            <button onClick={()=>runJudgeChap(judgeChap)} disabled={judgeRunning} style={{background:judgeRunning?T.faint:'#1d4ed8',color:'#fff',border:'none',borderRadius:5,padding:'4px 12px',fontSize:11,cursor:'pointer',fontWeight:700}}>
              {judgeRunning?'Running...':CHAPTERS[judgeChap].action}
            </button>
            <button onClick={()=>setJudgeMode(false)} style={{marginLeft:'auto',background:'transparent',border:'none',color:T.faint,fontSize:16,cursor:'pointer'}}>x</button>
          </div>
          <div style={{background:darkMode?'#0c1f3f':'#dbeafe',border:`1px solid ${darkMode?'#1e3a5f':'#bfdbfe'}`,borderRadius:6,padding:'5px 10px',fontSize:11,color:darkMode?'#93c5fd':'#1e40af',lineHeight:1.5}}>
            <strong>Step {judgeChap+1} - {CHAPTERS[judgeChap].title}:</strong>{' '}{CHAPTERS[judgeChap].note}
          </div>
        </div>
      )}

      <div style={{display:'flex',flex:1,overflow:'hidden'}}>

        <div style={{flex:'1 1 0',minWidth:0,display:'flex',flexDirection:'column',overflow:'hidden'}}>

          <div style={{background:T.panel,borderBottom:`1px solid ${T.border}`,padding:'4px 10px',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:6}}>
            <div style={{display:'flex',alignItems:'center',gap:9,flexWrap:'wrap'}}>
              <span style={{fontWeight:700,fontSize:11,color:T.text}}>RESCUE MAP</span>
              {([['#0284c7','River'],['#334155','Highway'],['#0ea5e9','Boat Canal'],['#d97706','Flood Trap'],['#dc2626','Bridge Closed'],['#15803d','Shelter'],['#b45309','Stranded']] as [string,string][]).map(([col,lbl])=>(
                <span key={lbl} style={{display:'flex',alignItems:'center',gap:3,fontSize:9,color:T.muted}}>
                  <span style={{width:9,height:9,background:col,borderRadius:2,display:'inline-block'}}/>{lbl}
                </span>
              ))}
            </div>
            <div style={{display:'flex',alignItems:'center',gap:5}}>
              <button onClick={()=>setCleanAtlas(v=>!v)} style={{background:cleanAtlas?(darkMode?'#1e3a5f':'#dbeafe'):T.panel2,color:cleanAtlas?(darkMode?'#38bdf8':'#1d4ed8'):T.muted,border:`1px solid ${T.border}`,borderRadius:7,padding:'2px 8px',fontSize:10,cursor:'pointer'}}>{cleanAtlas?'Clean':'All Roads'}</button>
              <button onClick={()=>setSvgZoom(z=>Math.min(8,z*1.3))} style={{background:T.panel2,border:`1px solid ${T.border}`,borderRadius:4,padding:'2px 7px',fontSize:12,cursor:'pointer',color:T.text}}>+</button>
              <button onClick={()=>setSvgZoom(z=>Math.max(0.4,z/1.3))} style={{background:T.panel2,border:`1px solid ${T.border}`,borderRadius:4,padding:'2px 7px',fontSize:12,cursor:'pointer',color:T.text}}>-</button>
              <button onClick={()=>{setSvgZoom(1);setSvgPan({x:0,y:0})}} style={{background:T.panel2,border:`1px solid ${T.border}`,borderRadius:4,padding:'2px 7px',fontSize:11,cursor:'pointer',color:T.text}}>Reset</button>
              <span style={{fontSize:10,color:T.faint}}>{Math.round(svgZoom*100)}%</span>
            </div>
          </div>

          <div style={{flex:'0 0 65%',overflow:'hidden',position:'relative'}}>
            {renderMap()}
          </div>

          <div style={{flex:'1 1 0',display:'flex',flexDirection:'column',overflow:'hidden',borderTop:`1px solid ${T.border}`}}>
            <div style={{background:T.panel,borderBottom:`1px solid ${T.border}`,padding:'4px 10px',display:'flex',alignItems:'center',gap:7,flexShrink:0,flexWrap:'wrap'}}>
              <span style={{fontWeight:700,fontSize:10,color:T.text,textTransform:'uppercase'}}>Live Rescue Feed</span>
              {log.filter(e=>e.message.toLowerCase().includes('mayday')||e.message.includes('COMPOUND')||e.message.includes('BRIDGE')).slice(-6).map((e,i)=>(
                <button key={i} onClick={()=>scrubTo(e.tick)} style={{background:darkMode?'#450a0a':'#fee2e2',color:'#ef4444',border:'1px solid #ef4444',borderRadius:4,padding:'1px 5px',fontSize:9,cursor:'pointer',fontWeight:700}}>T{e.tick}</button>
              ))}
              {maxTick>0&&(
                <div style={{display:'flex',alignItems:'center',gap:4,marginLeft:'auto'}}>
                  <input type="range" min={0} max={maxTick} value={replayTick??maxTick} onChange={e=>scrubTo(+e.target.value)} style={{width:80,accentColor:T.accent}}/>
                  <span style={{fontSize:10,color:T.muted}}>{replayTick??maxTick}/{maxTick}</span>
                  {replayTick!==null&&<button onClick={()=>setReplayTick(null)} style={{background:T.accent,color:'#fff',border:'none',borderRadius:3,padding:'1px 6px',fontSize:9,cursor:'pointer'}}>Live</button>}
                </div>
              )}
            </div>
            <div style={{flex:1,overflowY:'auto',padding:'4px 10px',background:T.bg}}>
              {log.slice(-150).reverse().map((e,i)=>{
                const h=fmtLog(e)
                return <div key={i} style={{display:'flex',alignItems:'flex-start',gap:6,padding:'2px 0',borderBottom:`1px solid ${T.panel}`}}>
                  <span style={{color:T.faint,fontSize:9,minWidth:26,flexShrink:0}}>{e.tick}s</span>
                  <span style={{background:h.bg,color:h.fg,borderRadius:3,padding:'1px 5px',fontSize:8,fontWeight:700,flexShrink:0,minWidth:58,textAlign:'center'}}>{h.badge}</span>
                  <span style={{fontSize:10,color:T.text,lineHeight:1.4,flex:1}}>{h.text}</span>
                </div>
              })}
              {log.length===0&&<div style={{color:T.faint,fontSize:11,textAlign:'center',paddingTop:12}}>Start a simulation to see the rescue feed.</div>}
            </div>
          </div>

        </div>

        <div style={{flex:'0 0 288px',display:'flex',flexDirection:'column',overflow:'hidden',background:T.panel,borderLeft:`1px solid ${T.border}`}}>
          <div style={{display:'flex',borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
            {([['distress',`Stranded (${dw?.requests.filter(r=>r.status!=='delivered').length??0})`],['fleet',`Fleet (${dw?.boats.length??0})`],['shelters','Shelters'],['swarm','Swarm AI']] as [typeof rightTab,string][]).map(([t,l])=>(
              <button key={t} onClick={()=>setRightTab(t)} style={{padding:'7px 0',border:'none',fontSize:10,background:'transparent',color:rightTab===t?T.text:T.faint,cursor:'pointer',borderBottom:`2px solid ${rightTab===t?T.accent:'transparent'}`,fontWeight:rightTab===t?700:400,flex:1}}>{l}</button>
            ))}
          </div>

          <div style={{flex:'0 0 57%',overflowY:'auto',padding:'7px 8px'}}>
            {rightTab==='distress'&&dw&&dw.requests.filter(r=>r.status!=='delivered').map(r=>{
              const asgn=dw.assignments.find(a=>a.request_id===r.id&&a.status==='active')
              const isMayday=r.urgency>=5&&r.status==='waiting'
              return <div key={r.id} onClick={()=>setSelResource({type:'request',id:r.id})} style={{border:`1.5px solid ${isMayday?'#ef4444':T.border}`,borderRadius:7,padding:'7px 9px',marginBottom:6,cursor:'pointer',background:isMayday?(darkMode?'#300':'#fff5f5'):T.panel}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                  <span style={{fontWeight:700,fontSize:12}}>{r.neighbourhood||r.location}</span>
                  <span style={{fontSize:10,fontWeight:700,color:isMayday?'#ef4444':r.status==='assigned'?T.accent:'#f59e0b'}}>{isMayday?'URGENT':r.status.toUpperCase()}</span>
                </div>
                <div style={{fontSize:11,color:T.muted}}>{r.people.toLocaleString()} people stranded</div>
                <div style={{display:'flex',gap:2,marginTop:3}}>
                  {Array.from({length:r.urgency}).map((_,i)=><div key={i} style={{width:14,height:5,background:r.urgency>=4?'#ef4444':'#f59e0b',borderRadius:2}}/>)}
                  {Array.from({length:5-r.urgency}).map((_,i)=><div key={i} style={{width:14,height:5,background:T.panel2,borderRadius:2}}/>)}
                </div>
                {asgn&&<div style={{fontSize:10,color:T.accent,marginTop:3}}>{asgn.boat_id.toUpperCase()} dispatched, ETA {asgn.eta_pickup}t</div>}
              </div>
            })}
            {rightTab==='distress'&&(!dw||dw.requests.filter(r=>r.status!=='delivered').length===0)&&(
              <div style={{color:T.faint,textAlign:'center',paddingTop:20,fontSize:11}}>No active incidents.</div>
            )}

            {rightTab==='fleet'&&dw&&dw.boats.map(b=>{
              const vt=b.vehicle_type||(b.id.startsWith('truck')?'truck':b.id.startsWith('heli')?'helicopter':'boat')
              const asgn=dw.assignments.find(a=>a.boat_id===b.id&&a.status==='active')
              const broken=b.status==='broken'
              const ac=vt==='truck'?'#fb923c':vt==='helicopter'?'#a855f7':T.accent
              const typeLabel=vt==='helicopter'?'IAF Airlift Sqn':vt==='truck'?'Army Convoy':'NDRF Flotilla'
              return <div key={b.id} onClick={()=>setSelResource({type:'vehicle',id:b.id})} style={{border:`1.5px solid ${broken?'#ef4444':T.border}`,borderRadius:7,padding:'7px 9px',marginBottom:6,cursor:'pointer'}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                  <span style={{fontWeight:700,fontSize:12,color:ac}}>{vt.toUpperCase()} {b.id.replace(/boat_|truck_|heli_/,'').toUpperCase()}</span>
                  <span style={{fontSize:10,color:broken?'#ef4444':T.muted,fontWeight:700}}>{b.status.replace(/_/g,' ').toUpperCase()}</span>
                </div>
                <div style={{fontSize:10,color:T.muted,marginBottom:3}}>{typeLabel} &mdash; Cap: {b.capacity.toLocaleString()}</div>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                  <div style={{flex:1,background:T.panel2,borderRadius:3,height:6}}>
                    <div style={{width:`${(b.people_on_board/b.capacity)*100}%`,height:'100%',background:ac,borderRadius:3}}/>
                  </div>
                  <span style={{fontSize:10,color:T.muted}}>{b.people_on_board.toLocaleString()} on board</span>
                </div>
                {asgn&&<div style={{fontSize:10,color:T.accent}}>Rescuing {asgn.request_id}</div>}
              </div>
            })}

            {rightTab==='shelters'&&(
              <div>
                {dw?.shelters.map(s=>{
                  const pct=s.fill_pct!=null?Math.round(s.fill_pct*100):Math.round(s.occupied/s.total_capacity*100)
                  const bg=pct>=90?'#ef4444':pct>=75?'#f59e0b':'#22c55e'
                  return <div key={s.id} style={{border:`1.5px solid ${T.border}`,borderRadius:7,padding:'7px 9px',marginBottom:6}}>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                      <span style={{fontWeight:700,fontSize:12}}>Shelter: {s.id.replace('shelter_','').replace(/_/g,' ')}</span>
                      {pct>=75&&<span style={{background:darkMode?'#431407':'#fef3c7',color:'#f59e0b',borderRadius:4,padding:'1px 6px',fontSize:10,fontWeight:700}}>TRIAGE</span>}
                    </div>
                    <div style={{background:T.panel2,borderRadius:4,height:8,marginBottom:3}}>
                      <div style={{width:`${pct}%`,height:'100%',background:bg,borderRadius:4,transition:'width 0.4s'}}/>
                    </div>
                    <div style={{fontSize:11,color:T.muted}}>{s.occupied.toLocaleString()}/{s.total_capacity.toLocaleString()} beds ({pct}%)</div>
                  </div>
                })}
                {m&&(
                  <div style={{marginTop:8}}>
                    <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:'uppercase',marginBottom:6}}>What the AI Did Automatically</div>
                    {([
                      [`${m.dead_traps_avoided??0} Flood Traps Avoided`,'Roads warned before submerging','#f59e0b'],
                      [`${m.amphibious_routes_used??0} Flooded Roads as Boat Canals`,'Highways converted','#0ea5e9'],
                      [`${m.recon_verifications??0} Rumours Verified by Helicopter`,'Aerial scout confirmed counts','#a855f7'],
                      [`${(m.shelter_triage_diversions??0)+(m.road_tolls_applied??0)} Jams & Overflows Prevented`,'Traffic managed','#22c55e'],
                    ] as [string,string,string][]).map(([title,sub,color])=>(
                      <div key={title} style={{display:'flex',justifyContent:'space-between',background:T.panel2,borderRadius:5,padding:'5px 8px',marginBottom:4,border:`1px solid ${T.border}`}}>
                        <div>
                          <div style={{fontWeight:700,fontSize:11,color}}>{title}</div>
                          <div style={{fontSize:10,color:T.muted}}>{sub}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {rightTab==='swarm'&&(
              <div>
                <div style={{background:darkMode?'#0c1f3f':'#eff6ff',border:`1px solid ${darkMode?'#1e3a5f':'#bfdbfe'}`,borderRadius:7,padding:9,marginBottom:8}}>
                  <div style={{fontWeight:700,fontSize:12,color:T.accent,marginBottom:3}}>Extra Lives Saved by Swarm</div>
                  <div style={{fontSize:22,fontWeight:800,color:'#22c55e'}}>+{extraSaved.toLocaleString()}</div>
                  <div style={{fontSize:10,color:T.muted}}>vs standard computer dispatch</div>
                </div>
                <div style={{background:darkMode?'#064e3b33':'#ecfdf5',border:`1px solid ${darkMode?'#065f46':'#a7f3d0'}`,borderRadius:7,padding:'6px 9px',marginBottom:8}}>
                  <div style={{fontSize:11,fontWeight:700,color:'#4ade80'}}>Total Evacuated</div>
                  <div style={{fontSize:18,fontWeight:800,color:'#4ade80'}}>{delivered.toLocaleString()} / {totalDisplaced.toLocaleString()}</div>
                  <div style={{fontSize:10,color:T.muted}}>of 73,940 displaced across 20 villages</div>
                </div>
                <div style={{background:darkMode?'#14532d22':'#f0fdf4',border:`1px solid ${darkMode?'#15803d':'#bbf7d0'}`,borderRadius:7,padding:'6px 9px',marginBottom:8}}>
                  <div style={{fontSize:11,fontWeight:700,color:'#22c55e'}}>Fairness Score (Gini)</div>
                  <div style={{fontSize:18,fontWeight:800,color:gini<0.03?'#22c55e':'#f59e0b'}}>{gini.toFixed(3)}</div>
                  <div style={{fontSize:10,color:T.muted}}>{gini<0.03?'Excellent - all areas served fairly':'Some areas need more attention'}</div>
                </div>
                <div style={{background:viol===0?(darkMode?'#14532d22':'#dcfce7'):(darkMode?'#450a0a':'#fee2e2'),border:`1px solid ${viol===0?'#22c55e':'#ef4444'}`,borderRadius:6,padding:'5px 9px',marginBottom:8}}>
                  <span style={{fontWeight:700,fontSize:12,color:viol===0?'#22c55e':'#ef4444'}}>{viol===0?'Safety: Zero Violations':`Safety: ${viol} Violation${viol>1?'s':''}`}</span>
                </div>
                {compoundReport&&(
                  <button onClick={()=>setShowDrawer(true)} style={{width:'100%',background:T.panel2,color:T.accent,border:`1px solid ${T.border}`,borderRadius:6,padding:'6px 0',fontSize:11,cursor:'pointer',fontWeight:700}}>
                    View Disaster Recovery Report
                  </button>
                )}
              </div>
            )}
          </div>

          <div style={{flex:'0 0 43%',borderTop:`1px solid ${T.border}`,padding:10,overflowY:'auto',background:T.panel2}}>
            <div style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:'uppercase',marginBottom:6}}>Selected Item</div>
            {!selResource?(
              <div style={{textAlign:'center',paddingTop:16,color:T.faint,fontSize:10,lineHeight:1.7}}>
                Click any vehicle, shelter, or stranded group on the map to see details here.
              </div>
            ):dw&&(()=>{
              if(selResource.type==='request'){
                const r=dw.requests.find(x=>x.id===selResource.id)
                if(!r) return <div style={{color:T.faint}}>Not found.</div>
                const asgn=dw.assignments.find(a=>a.request_id===r.id)
                return <div style={{fontSize:11}}>
                  <div style={{fontWeight:700,fontSize:13,marginBottom:6}}>{r.neighbourhood}</div>
                  {([['People Stranded',r.people.toLocaleString()],['Urgency',`${r.urgency}/5`],['Status',r.status.replace(/_/g,' ')],['Waiting',`${r.waiting_ticks} ticks`],['Rescue Vehicle',asgn?asgn.boat_id.toUpperCase():'Not yet assigned']] as [string,string|number][]).map(([k,v])=>(
                    <div key={k as string} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',borderBottom:`1px solid ${T.border}`}}>
                      <span style={{color:T.muted}}>{k}</span><span style={{fontWeight:600}}>{v}</span>
                    </div>
                  ))}
                  {asgn&&<div style={{marginTop:6,fontSize:10,color:T.muted,fontStyle:'italic'}}>{asgn.reason}</div>}
                </div>
              }
              if(selResource.type==='vehicle'){
                const b=dw.boats.find(x=>x.id===selResource.id)
                if(!b) return <div style={{color:T.faint}}>Not found.</div>
                const vt=b.vehicle_type||(b.id.startsWith('truck')?'truck':b.id.startsWith('heli')?'helicopter':'boat')
                const asgn=dw.assignments.find(a=>a.boat_id===b.id&&a.status==='active')
                return <div style={{fontSize:11}}>
                  <div style={{fontWeight:700,fontSize:13,marginBottom:6}}>{vt.toUpperCase()} - {b.id.toUpperCase()}</div>
                  {([['Status',b.status.replace(/_/g,' ')],['People On Board',`${b.people_on_board.toLocaleString()}/${b.capacity.toLocaleString()}`],['Task',asgn?`Rescuing ${asgn.request_id}`:'Waiting']] as [string,string][]).map(([k,v])=>(
                    <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',borderBottom:`1px solid ${T.border}`}}>
                      <span style={{color:T.muted}}>{k}</span><span style={{fontWeight:600}}>{v}</span>
                    </div>
                  ))}
                </div>
              }
              if(selResource.type==='shelter'){
                const s=dw.shelters.find(x=>x.id===selResource.id)
                if(!s) return <div style={{color:T.faint}}>Not found.</div>
                const pct=s.fill_pct!=null?Math.round(s.fill_pct*100):Math.round(s.occupied/s.total_capacity*100)
                return <div style={{fontSize:11}}>
                  <div style={{fontWeight:700,fontSize:13,marginBottom:6}}>Shelter: {s.id.replace('shelter_','').replace(/_/g,' ')}</div>
                  {([['Beds Used',`${s.occupied.toLocaleString()} of ${s.total_capacity.toLocaleString()}`],['Capacity',`${pct}%`],['Status',pct>=90?'CRITICAL':pct>=75?'TRIAGE ACTIVE':'Normal']] as [string,string][]).map(([k,v])=>(
                    <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',borderBottom:`1px solid ${T.border}`}}>
                      <span style={{color:T.muted}}>{k}</span><span style={{fontWeight:600}}>{v}</span>
                    </div>
                  ))}
                </div>
              }
              return null
            })()}
          </div>
        </div>

        {showSidebar&&(
          <div style={{flex:'0 0 292px',display:'flex',flexDirection:'column',overflow:'hidden',background:T.panel,borderLeft:`1px solid ${T.border}`}}>
            <div style={{borderBottom:`1px solid ${T.border}`,padding:'9px 12px',display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
              <span style={{fontWeight:700,fontSize:12}}>Tools</span>
              <button onClick={()=>setShowSidebar(false)} style={{background:'transparent',border:'none',color:T.faint,fontSize:18,cursor:'pointer'}}>x</button>
            </div>
            <div style={{flex:1,overflowY:'auto',padding:'10px 12px'}}>
              <div style={{marginBottom:12}}>
                <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:'uppercase',marginBottom:5}}>Disruptions</div>
                {dw?(()=>{
                  const roads=dw.edges.filter(e=>e.open&&e.mode==='road')
                  const vehicles=dw.boats.filter(b=>b.status!=='broken')
                  return <div style={{display:'flex',flexDirection:'column',gap:4}}>
                    <button onClick={()=>roads.length>0&&injectEvent('route_closure',roads[Math.floor(roads.length/3)].id)} disabled={!simId||roads.length===0} style={{background:darkMode?'#431407':'#fef3c7',color:'#f59e0b',border:`1px solid ${darkMode?'#78350f':'#fde68a'}`,borderRadius:5,padding:'5px 8px',fontSize:11,cursor:'pointer',opacity:(!simId||roads.length===0)?0.5:1}}>Close a Road</button>
                    <button onClick={()=>vehicles.length>0&&injectEvent('boat_breakdown',vehicles[0].id)} disabled={!simId||vehicles.length===0} style={{background:darkMode?'#450a0a':'#fee2e2',color:'#ef4444',border:`1px solid ${darkMode?'#7f1d1d':'#fca5a5'}`,borderRadius:5,padding:'5px 8px',fontSize:11,cursor:'pointer',opacity:(!simId||vehicles.length===0)?0.5:1}}>Break a Vehicle</button>
                  </div>
                })():<div style={{color:T.faint,fontSize:10}}>Start a simulation first.</div>}
              </div>
              <div style={{marginBottom:12}}>
                <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:'uppercase',marginBottom:5}}>Benchmark</div>
                <button onClick={runBench} disabled={benchLoading} style={{width:'100%',background:darkMode?'#1e3a5f':'#dbeafe',color:T.accent,border:`1px solid ${T.border}`,borderRadius:5,padding:'6px 0',fontSize:11,cursor:'pointer',fontWeight:700}}>
                  {benchLoading?'Running...':'Run AI Comparison Test'}
                </button>
              </div>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:'uppercase',marginBottom:5}}>Export</div>
                <button onClick={exportReplay} disabled={!dw} style={{width:'100%',background:darkMode?'#14532d22':'#f0fdf4',color:'#22c55e',border:`1px solid ${darkMode?'#15803d':'#bbf7d0'}`,borderRadius:5,padding:'5px 0',fontSize:11,cursor:'pointer',fontWeight:700,opacity:dw?1:0.5}}>Download Replay JSON</button>
              </div>
            </div>
          </div>
        )}

      </div>

      {showBench&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:9998,display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={e=>{if(e.target===e.currentTarget)setShowBench(false)}}>
          <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,width:'min(820px,95vw)',maxHeight:'80vh',overflowY:'auto',padding:20}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:12}}>
              <span style={{fontWeight:800,fontSize:14}}>AI Strategy Comparison</span>
              <button onClick={()=>setShowBench(false)} style={{background:'transparent',border:'none',color:T.faint,fontSize:20,cursor:'pointer'}}>x</button>
            </div>
            <button onClick={runBench} disabled={benchLoading} style={{background:T.accent,color:'#fff',border:'none',borderRadius:6,padding:'6px 16px',fontSize:11,cursor:'pointer',fontWeight:700,marginBottom:12}}>
              {benchLoading?'Running...':'Run Test (3 scenarios)'}
            </button>
            {benchResult?.summaries&&(
              <div>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={benchResult.summaries}>
                    <XAxis dataKey="strategy" tick={{fontSize:10,fill:T.muted}}/>
                    <YAxis tick={{fontSize:10,fill:T.muted}}/>
                    <Tooltip contentStyle={{background:T.panel,border:`1px solid ${T.border}`,fontSize:10,color:T.text}}/>
                    <Legend/>
                    <Bar dataKey="avg_people_delivered" name="People Rescued" fill="#22c55e"/>
                    <Bar dataKey="avg_mean_delivery_time" name="Avg Rescue Time" fill="#60a5fa"/>
                    <Bar dataKey="avg_safety_violations" name="Violations" fill="#f87171"/>
                  </BarChart>
                </ResponsiveContainer>
                <table style={{width:'100%',borderCollapse:'collapse',marginTop:12,fontSize:11}}>
                  <thead>
                    <tr style={{background:T.panel2}}>
                      {['Strategy','Rescued','Avg Time','Fairness','Violations'].map(h=>(
                        <th key={h} style={{padding:'5px 8px',textAlign:'left',color:T.muted,fontWeight:600,borderBottom:`1px solid ${T.border}`}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {benchResult.summaries.map((s: any)=>(
                      <tr key={s.strategy} style={{borderBottom:`1px solid ${T.border}`}}>
                        <td style={{padding:'5px 8px',fontWeight:700}}>{s.strategy}</td>
                        <td style={{padding:'5px 8px',color:'#22c55e',fontWeight:700}}>{Math.round(s.avg_people_delivered??0).toLocaleString()}</td>
                        <td style={{padding:'5px 8px',color:T.accent}}>{s.avg_mean_delivery_time?.toFixed(1)}</td>
                        <td style={{padding:'5px 8px',color:(s.avg_gini_coefficient??0)<0.03?'#22c55e':'#f59e0b'}}>{(s.avg_gini_coefficient??0).toFixed(3)}</td>
                        <td style={{padding:'5px 8px',color:(s.avg_safety_violations??0)>0?'#ef4444':'#22c55e'}}>{s.avg_safety_violations?.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {showDrawer&&compoundReport&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.72)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={e=>{if(e.target===e.currentTarget)setShowDrawer(false)}}>
          <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,width:'min(840px,95vw)',maxHeight:'88vh',overflowY:'auto',padding:20}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14}}>
              <div>
                <div style={{fontSize:15,fontWeight:800}}>Triple Disaster Recovery - Tick #{compoundReport.tick}</div>
                <div style={{marginTop:7,display:'flex',gap:8,flexWrap:'wrap'}}>
                  <span style={{background:darkMode?'#14532d':'#dcfce7',color:'#22c55e',borderRadius:6,padding:'3px 10px',fontSize:11,fontWeight:700}}>{compoundReport.surgical_stability_pct}% Stability</span>
                  <span style={{background:darkMode?'#1e3a5f':'#dbeafe',color:T.accent,borderRadius:6,padding:'3px 10px',fontSize:11}}>{compoundReport.unaffected_vehicle_ids.length} vehicles kept their missions</span>
                </div>
              </div>
              <button onClick={()=>setShowDrawer(false)} style={{background:'transparent',border:'none',color:T.faint,fontSize:20,cursor:'pointer'}}>x</button>
            </div>
            {compoundReport.mayday_request_id&&(
              <div style={{background:darkMode?'#450a0a':'#fee2e2',border:'1px solid #ef4444',borderRadius:7,padding:'8px 14px',marginBottom:12,fontSize:12,color:'#ef4444',fontWeight:700}}>
                EMERGENCY: A rescue vehicle needed rescuing itself! Dispatch: {compoundReport.mayday_request_id}
              </div>
            )}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:'#ef4444',marginBottom:8}}>1. What Went Wrong ({compoundReport.cancelled_commitments.length} missions disrupted)</div>
                {compoundReport.cancelled_commitments.length===0
                  ?<div style={{fontSize:11,color:T.faint}}>No active missions were disrupted.</div>
                  :compoundReport.cancelled_commitments.map((c,i)=>(
                    <div key={i} style={{background:darkMode?'#300':'#fff5f5',border:'1px solid #ef4444',borderRadius:7,padding:10,marginBottom:7}}>
                      <div style={{display:'flex',gap:5,marginBottom:3,flexWrap:'wrap'}}>
                        <span style={{background:darkMode?'#450a0a':'#fee2e2',color:'#ef4444',borderRadius:4,padding:'1px 6px',fontSize:10,fontWeight:700}}>{c.reason_code.replace(/_/g,' ')}</span>
                        <span style={{fontSize:11,fontWeight:700}}>{c.vehicle_id.toUpperCase()}</span>
                      </div>
                      <div style={{fontSize:10,color:T.muted,fontStyle:'italic'}}>{c.explanation}</div>
                    </div>
                  ))
                }
              </div>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:'#22c55e',marginBottom:8}}>2. How the Swarm Fixed It ({compoundReport.reassignments.length} auto reassignments)</div>
                {compoundReport.reassignments.length===0
                  ?<div style={{fontSize:11,color:T.faint}}>No reassignments needed.</div>
                  :compoundReport.reassignments.map((r,i)=>(
                    <div key={i} style={{background:darkMode?'#0a1a0f':'#f0fdf4',border:`1px solid ${r.is_mayday_rescue?'#ef4444':'#22c55e'}`,borderRadius:7,padding:10,marginBottom:7}}>
                      {r.is_mayday_rescue&&<div style={{fontSize:10,color:'#ef4444',fontWeight:700,marginBottom:3}}>EMERGENCY RESCUE</div>}
                      <div style={{fontSize:11,fontWeight:700,marginBottom:3}}>{r.previous_vehicle_id||'Unassigned'} replaced by {r.new_vehicle_id.toUpperCase()}</div>
                      {r.previous_shelter_id&&r.new_shelter_id&&r.previous_shelter_id!==r.new_shelter_id&&<div style={{fontSize:10,color:'#f59e0b',marginBottom:3}}>Rerouted to different shelter</div>}
                      <div style={{fontSize:10,color:T.muted,fontStyle:'italic',lineHeight:1.5}}>{r.why_explanation}</div>
                    </div>
                  ))
                }
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

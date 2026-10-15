# FloodOps — Project Status
**Last updated:** 2026-10-15  
**Problem Statement:** PS 27 — Flood Rescue Dispatch (Code-E-Manipal Hackathon)

---

## 1. Problem Statement Summary

> Flood response plans become stale as routes close, shelters fill and reports conflict. Coordinate rescue teams, boats, shelters and incident reports as autonomous agents with partial information, resource contention and different urgency levels.

**Core requirement:** Implement dynamic re-planning over a changing road/water graph, with uncertainty-tagged reports, capacity constraints, fairness criteria and explicit safety invariants. Compare decentralised negotiation with a centralised baseline.

**Evaluation criteria:** Time to service · unmet requests · resource idle time · route violations · fairness across neighbourhoods · recovery after contradictory updates.

**Stretch goal (explicitly asked):** Trigger simultaneous bridge closure + boat failure + shelter overflow; show which commitments are cancelled, who is re-assigned and why.

---

## 2. Current Build Status

| Phase | Description | Status |
|---|---|---|
| Phase 1 | Core simulation engine | ✅ Complete |
| Phase 1 | React testbed frontend | ✅ Complete |
| Phase 1 | B1/B2/B3 backend hardening | ✅ Complete |
| Phase 2 | F1/F2/F3 UI test harness | ✅ Complete |
| Phase 3 | Real data pipeline (OSM, IFI, elevation, weather) | ✅ Complete |
| Phase 4 | Engine upgrades (flood spread, two-layer routing, vehicle types) | ✅ Complete |
| Phase 5 | Phase 3 frontend upgrades | ✅ Complete |
| Phase 6 | B4/B5 fairness metrics + benchmark stats | ⬜ Not started |
| Phase 6 | B6 simultaneous compound disruption | ⬜ Not started |
| Phase 6 | B7 scenario export/import | ⬜ Not started |
| Phase 6 | B8 speed control | ⬜ Not started |
| Phase 6 | B9 multi-round negotiation | ⬜ Not started |
| Phase 7 | Demo mode (scripted 4-min walkthrough) | ⬜ Not started |
| Phase 7 | Replay export | ⬜ Not started |
| Phase 7 | Production command-center layout | ⬜ Not started |

---

## 3. How to Run

### Backend
```bash
cd floodops/backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend
```bash
cd floodops/frontend
npm install
npm run dev
# → http://localhost:5173
```

---

## 4. Repository Structure

```
floodops/
├── backend/
│   ├── app/
│   │   ├── main.py                      FastAPI app, all REST + WebSocket routes, /weather endpoint
│   │   ├── simulation/
│   │   │   ├── models.py                All Pydantic models: Node, Edge, Boat, Request, Shelter,
│   │   │   │                            WorldState, Metrics, VehicleType, EventType
│   │   │   ├── scenario.py              Original synthetic scenario (20 nodes, 5 boats, 10 requests)
│   │   │   ├── scenario_kolhapur.py     NEW: Real Kolhapur scenario from OSM + IFI data
│   │   │   ├── graph.py                 NetworkX routing with two-layer mode (road / water / any)
│   │   │   ├── engine.py                Tick engine: movement, assignment, replanning, flood advance,
│   │   │   │                            invariant checker, shelter overflow, uncertainty decay
│   │   │   ├── flood.py                 NEW: BFS flood spread from river nodes weighted by elevation
│   │   │   └── benchmark.py             3-strategy benchmark runner
│   │   └── strategies/
│   │       └── dispatch.py              Greedy / Optimiser / Negotiation (all vehicle-aware)
│   ├── data/
│   │   ├── osm_loader.py                Pulls Kolhapur road+waterway graph via Overpass API
│   │   ├── fix_connectivity.py          Ensures single connected component via MST edges
│   │   ├── patch_waterways.py           Hardcodes Panchaganga/Bhogawati/Kasari rivers (Overpass fallback)
│   │   ├── ifi_loader.py                IFI 2019 Kolhapur flood data → rescue requests JSON
│   │   ├── elevation.py                 SRTM elevation via open-topo-data API (or estimator fallback)
│   │   ├── weather.py                   Open-Meteo live rainfall fetch + severity mapping
│   │   ├── kolhapur_graph.json          GENERATED: 219 nodes (200 road + 19 water), 76 edges, 3 rivers
│   │   ├── kolhapur_requests.json       GENERATED: 25 rescue groups, 20 villages, ~400 people
│   │   └── weather_cache.json           GENERATED: Live Open-Meteo forecast data
│   ├── test_smoke.py                    Full test suite: B1/B2/B3 + benchmark + disruptions
│   └── requirements.txt
└── frontend/
    └── src/
        └── App.tsx                      Full React app (42KB): all UI tabs, map, scrubber, explainability
```

---

## 5. The Three Dispatch Strategies

### Greedy (Baseline)
Nearest available boat/vehicle wins. For each request, scan idle vehicles, pick shortest path that has capacity. Ignores global state.

**Weakness:** Locally optimal, globally wasteful. Grabs low-urgency nearby requests while critical ones wait.

### Centralised Optimiser
Builds a cost matrix of all vehicles × all requests. Runs SciPy `linear_sum_assignment` (Hungarian algorithm) to find the globally optimal matching. Recomputes every tick.

**Weakness:** Full recomputation on every disruption can cause cascading reassignments, even for unaffected vehicles.

### Hybrid Contract-Net Negotiation (Innovation)
Each vehicle is an autonomous agent that bids on requests. Coordinator resolves competing bids and commits assignments. On disruption, only affected commitments are reconsidered.

**Bid score formula:**
```
score = (urgency × 3.0)
      - (ETA × 1.0)
      - (route_risk × 5.0)
      - (uncertainty × 2.0)
      + shelter_available_bonus
```

**Why it wins under compound disruptions:** Surgical renegotiation — only broken routes/vehicles re-bid. Everything else stays committed. Recovery is faster and more stable than full recomputation.

---

## 6. Real Data Layer (Phase 3 — Complete)

| Source | What it provides | Status |
|---|---|---|
| **OpenStreetMap via Overpass API** | Kolhapur district road network + river geometry | ✅ Graph JSON generated |
| **IFI (India Flood Inventory) 2019** | 20 real flood-affected villages, GPS coords, displaced population | ✅ Requests JSON generated |
| **open-topo-data (SRTM)** | Elevation for all 219 graph nodes → flood-risk tagging | ✅ Embedded in graph JSON |
| **Open-Meteo API** | Live + forecast rainfall for Kolhapur (16.7°N, 74.2°E), no key required | ✅ Cached + live endpoint |

### Graph specs
- **219 nodes**: 200 road nodes + 19 water nodes along 3 rivers
- **76 edges**: 44 road edges + 32 waterway edges
- **Rivers**: Panchaganga (main), Bhogawati (tributary), Kasari (tributary)
- **Elevation range**: 573–656m (mean 597m)
- **Flood-risk nodes**: 32 nodes below 640m near river corridors
- **Connectivity**: 1 fully-connected component (MST fix applied)

### Vehicle fleet (Kolhapur scenario)
| Vehicle | Type | Capacity | Routing |
|---|---|---|---|
| boat_1, boat_2, boat_3 | `boat` | 15 people | Water edges only |
| truck_1, truck_2 | `truck` | 12 people | Road edges only |
| heli_1 | `helicopter` | 10 people | Any edge |

---

## 7. Engine Features (Phase 4 — Complete)

### Flood Spread BFS (`flood.py`)
- Starts from all river/waterway nodes
- BFS weighted by inverse elevation (lower = floods first)
- Expands N rings per tick (rate controlled by weather severity)
- Newly flooded road edges auto-close → triggers replanning
- `flood_boundary` list exposed on WorldState every tick

### Two-Layer Routing (`graph.py`)
- `shortest_path(src, dst, vehicle_id=...)` — resolves vehicle type, filters to correct edge layer
- Boats: waterway edges only
- Trucks: road edges only
- Helicopter: all edges (any)
- Unreachable = blocked (no cross-layer fallback — prevents invalid routing)

### B1 — Uncertainty Decay
- Reports start with `uncertainty` 0.3–0.8
- Decays by 0.05/tick; `confirmed=True` when it hits 0
- Negotiation and optimiser penalise high-uncertainty requests in bid scoring

### B2 — Shelter Overflow
- `SHELTER_FULL` event fires at 90% capacity
- `fill_pct` computed each tick
- In-transit boats to full shelter get rerouted to next available
- `overflow_warned` flag prevents duplicate events

### B3 — Contradictory Reports
- Duplicate-location reports detected
- Negotiation uses higher count; greedy uses latest
- `CONTRADICTION_DETECTED` event logged

### Safety Invariants (checked every tick)
- No double-booking (same vehicle on two missions)
- Capacity never exceeded
- No people disappear (conservation check)
- Closed routes never traversed

---

## 8. Frontend Features (Phase 5 — Complete)

**File:** `frontend/src/App.tsx` (42KB)

### Map Tab
- OpenStreetMap tile layer, centred on Kolhapur (16.705°N, 74.24°E)
- Real lat/lon from OSM node data
- Vehicle icons: ⛵ boats (blue), 🚛 trucks (orange), 🚁 helicopter (purple)
- Request markers: color by status, glow on high urgency
- Shelter markers: color by fill % (green/yellow/red)
- Animated flood circles expanding from river nodes each tick
- Blue waterway edges, gray road edges, dashed = closed

### Metrics Tab
- People delivered / waiting / in-transit charts (Recharts)
- Fairness: neighbourhood table + Gini coefficient (color-coded)
- Shelter capacity bars (live-updating per tick)
- Boat utilisation over time

### Log Tab
- All simulation events in reverse-chronological order
- Level filter: All / Info / Warn+ / Error / Contradictions only
- Contradiction entries: orange highlight
- Shelter-full entries: yellow highlight

### Benchmark Tab
- One-click runs all 3 strategies × 3 seeds
- Bar charts + comparison table
- Std dev / min / max columns (partial — B5 not finalized)

### Explainability Tab
- Click any assignment → bid score breakdown
- Bar chart: urgency weight, wait bonus, ETA penalty, route risk, uncertainty penalty, total
- Shows why the winning bid won over competitors

### Replay Scrubber
- Slider across full tick history
- ◀ ▶ step buttons
- LIVE badge (green) vs REPLAY badge (purple)
- ↩ Live button to snap back
- Cache-first (200 tick in-memory, then `GET /history/{tick}` fallback)

### Weather Banner (top strip)
- 📍 Kolhapur, Maharashtra
- Live Day 3 rainfall forecast from Open-Meteo
- Alert level: GREEN / YELLOW / ORANGE / RED

---

## 9. API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/simulations` | Create simulation (`scenario`, `strategy`, `use_kolhapur`) |
| `GET` | `/api/v1/simulations/{id}` | Get world state |
| `POST` | `/api/v1/simulations/{id}/step` | Advance one tick |
| `POST` | `/api/v1/simulations/{id}/events` | Inject disruption event |
| `GET` | `/api/v1/simulations/{id}/history/{tick}` | Get world snapshot at tick N |
| `GET` | `/api/v1/simulations/{id}/metrics` | Get full metrics snapshot |
| `POST` | `/api/v1/benchmark` | Run 3-strategy benchmark |
| `GET` | `/api/v1/weather` | Live Open-Meteo weather for Kolhapur |
| `WS` | `/ws/{sim_id}` | WebSocket auto-tick stream |

---

## 10. Smoke Test Coverage

Run with: `cd floodops/backend && python test_smoke.py`

| Test | What it checks |
|---|---|
| `test_smoke_greedy` | 20-tick greedy run, all requests resolved, 0 violations |
| `test_smoke_negotiation` | 20-tick negotiation run |
| `test_disruption` | Route closure + boat breakdown → replanning fires |
| `test_benchmark` | All 3 strategies run, negotiation not worse than greedy mean |
| `test_b1_uncertainty` | Uncertainty decays, confirmed flag set |
| `test_b2_shelter_overflow` | SHELTER_FULL event fires at capacity threshold |
| `test_b3_contradictions` | CONTRADICTION_DETECTED logged on duplicate location |

**Last result:** All 7 tests pass ✅

---

## 11. What's Left (Remaining Build Plan)

### Backend

**B4 — Fairness metric hardening**
- Add Gini coefficient (0 = perfect fairness) across neighbourhoods
- Track worst-served region explicitly in metrics snapshot

**B5 — Benchmark with full stats**
- Add standard deviation, min, max per strategy per metric
- One "failure scenario" (seed where greedy breaks badly)

**B6 — Simultaneous compound disruption** ← PS stretch goal
- Bridge closure + boat failure + shelter overflow at same tick
- Correct ordering: route first, then vehicles
- Dedicated test in smoke test

**B7 — Scenario export/import**
- `GET /api/v1/simulations/{id}/export` → full JSON (world + history + metrics)
- `POST /api/v1/simulations/import` → load saved scenario

**B8 — Speed control**
- `set_speed` WebSocket command (0.5 / 1 / 2 / 5 ticks/sec)
- Persist speed across pause/resume

**B9 — Multi-round negotiation** (time permitting)
- Second bid round for unassigned requests after initial assignment
- Controlled by `negotiation_rounds` config (default 1, max 3)

### Frontend

**F5 — Command-center layout**
- Full-width map center stage
- Floating KPI strip top-right
- Collapsible assignment feed bottom-right
- Disruption toolbar

**F6 — Assignment path animation**
- Dashed line: boat → request → shelter on assignment
- Removes on completion

**F7 — Replay export**
- Download full tick history as JSON

**F8 — Demo mode**
- Scripted 4-minute walkthrough button
- Pause points for narration
- Auto-opens explainability panel at compound disruption moment

---

## 12. Demo Narrative (Planned)

1. *"This is Kolhapur district, Maharashtra. Roads and rivers from OpenStreetMap. Rescue requests seeded from 2019 Kolhapur flood — 20 villages, ~400 people displaced."*
2. Weather banner shows Day 3 forecast. Flood polygon begins advancing from Panchaganga river.
3. **Greedy strategy**: boats get stranded on land routes, trucks can't cross rivers. Show inefficiency.
4. **Switch to Negotiation**: boats route via rivers, trucks via roads. Assignments adapt as flood advances.
5. **Explainability panel**: *"boat_2 won over truck_1 because river route has 60% lower risk despite +2 ticks ETA"*
6. **Compound disruption** (B6): bridge closure + boat_2 breakdown + shelter_1 at 95% simultaneously.
7. System shows: which commitments cancelled, who re-assigned, why — in the log and explainability panel.
8. **Benchmark tab**: negotiation recovers 40% faster than greedy under compound failure.

---

## 13. Key Technical Decisions

| Decision | Rationale |
|---|---|
| Keep synthetic engine, add real data as a layer | Engine is solid. Real data is a visual multiplier, not a rebuild. |
| Kolhapur district (not Majuli/Kerala) | Good OSM coverage, 2019 flood well-documented, Panchaganga river is photogenic |
| Overpass API for OSM (with hardcoded fallback) | Free, no registration. Fallback ensures demo never breaks on network issues. |
| open-topo-data for elevation (with estimator fallback) | No registration, batch queries. Fallback handles DNS issues. |
| Two-layer routing — no cross-layer fallback | Boats that can't reach by water are truly blocked. This is the real multi-agent problem. |
| Gini coefficient for fairness | Single interpretable number. Judges understand it. 0 = perfect equity. |
| Contract-net for negotiation | Established MAS protocol, not custom. Credible to academic judges. |

---

## 14. Stack Summary

| Layer | Technologies |
|---|---|
| Backend runtime | Python 3.11+, FastAPI, Uvicorn |
| Graph routing | NetworkX, SciPy (Hungarian algorithm) |
| Data processing | Requests, JSON |
| Frontend | React 18, TypeScript, Vite |
| Map | Leaflet + React-Leaflet |
| Charts | Recharts |
| Real data | OpenStreetMap (Overpass API), IFI/NDMA 2019 flood data, Open-Meteo, open-topo-data |

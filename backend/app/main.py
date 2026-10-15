"""
FloodOps FastAPI application.
Provides REST endpoints + WebSocket for simulation control and streaming.
"""

from __future__ import annotations
import asyncio
import uuid
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.simulation.engine import SimulationEngine
from app.simulation.models import (
    StrategyType, EventType, SimulationEvent, WorldState,
    CompoundDisruptionReport,
)
from app.simulation.benchmark import run_benchmark, run_single

app = FastAPI(title="FloodOps API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory stores
_simulations: dict[str, SimulationEngine] = {}
_benchmarks: dict[str, dict] = {}
_ws_connections: dict[str, list[WebSocket]] = {}  # sim_id -> [ws, ...]


# ---------------------------------------------------------------------------
# Request/Response schemas
# ---------------------------------------------------------------------------

class CreateSimulationRequest(BaseModel):
    strategy: StrategyType = StrategyType.GREEDY
    seed: int = 42


class InjectEventRequest(BaseModel):
    event_type: EventType
    target_id: str
    tick_offset: int = 0  # fire at current_tick + offset
    payload: dict = {}
    description: str = ""


class BenchmarkRequest(BaseModel):
    seeds: list[int] = [42, 99, 137]
    disruptions: bool = True


# ---------------------------------------------------------------------------
# Simulation endpoints
# ---------------------------------------------------------------------------

@app.post("/api/v1/simulations", response_model=dict)
async def create_simulation(req: CreateSimulationRequest):
    sim_id = str(uuid.uuid4())[:8]
    engine = SimulationEngine(sim_id, req.strategy, req.seed)
    _simulations[sim_id] = engine
    _ws_connections[sim_id] = []
    return {"simulation_id": sim_id, "strategy": req.strategy, "seed": req.seed}


@app.get("/api/v1/simulations/{sim_id}")
async def get_simulation(sim_id: str):
    engine = _get_engine(sim_id)
    return engine.get_snapshot()


@app.post("/api/v1/simulations/{sim_id}/start")
async def start_simulation(sim_id: str):
    engine = _get_engine(sim_id)
    engine.start()
    return {"status": "running", "tick": engine.state.tick}


@app.post("/api/v1/simulations/{sim_id}/pause")
async def pause_simulation(sim_id: str):
    engine = _get_engine(sim_id)
    engine.pause()
    return {"status": "paused", "tick": engine.state.tick}


@app.post("/api/v1/simulations/{sim_id}/step")
async def step_simulation(sim_id: str):
    engine = _get_engine(sim_id)
    state = engine.step()
    await _broadcast(sim_id, state)
    return state


@app.post("/api/v1/simulations/{sim_id}/events")
async def inject_event(sim_id: str, req: InjectEventRequest):
    engine = _get_engine(sim_id)
    event = SimulationEvent(
        tick=engine.state.tick + req.tick_offset,
        event_type=req.event_type,
        target_id=req.target_id,
        payload=req.payload,
        description=req.description,
    )
    engine.inject_event(event)
    return {"status": "queued", "event": event}


@app.get("/api/v1/simulations/{sim_id}/metrics")
async def get_metrics(sim_id: str):
    engine = _get_engine(sim_id)
    return engine._compute_metrics()


@app.get("/api/v1/simulations/{sim_id}/history/{tick}")
async def get_history_tick(sim_id: str, tick: int):
    engine = _get_engine(sim_id)
    snap = engine.get_history_tick(tick)
    if snap is None:
        raise HTTPException(status_code=404, detail=f"No snapshot for tick {tick}")
    return snap


@app.post("/api/v1/simulations/{sim_id}/strategy")
async def switch_strategy(sim_id: str, strategy: StrategyType):
    engine = _get_engine(sim_id)
    engine.strategy = strategy
    engine.state.strategy = strategy
    return {"strategy": strategy, "tick": engine.state.tick}


# ---------------------------------------------------------------------------
# Benchmark endpoints
# ---------------------------------------------------------------------------

@app.post("/api/v1/benchmarks")
async def create_benchmark(req: BenchmarkRequest):
    # Run in executor to avoid blocking the event loop
    loop = asyncio.get_event_loop()
    results = await loop.run_in_executor(
        None, lambda: run_benchmark(req.seeds, req.disruptions)
    )
    bid = results["benchmark_id"]
    _benchmarks[bid] = results
    return {"benchmark_id": bid}


@app.get("/api/v1/benchmarks/{benchmark_id}")
async def get_benchmark(benchmark_id: str):
    if benchmark_id not in _benchmarks:
        raise HTTPException(status_code=404, detail="Benchmark not found")
    return _benchmarks[benchmark_id]


# ---------------------------------------------------------------------------
# WebSocket streaming
# ---------------------------------------------------------------------------

@app.websocket("/api/v1/simulations/{sim_id}/stream")
async def simulation_stream(websocket: WebSocket, sim_id: str):
    if sim_id not in _simulations:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    _ws_connections[sim_id].append(websocket)

    engine = _simulations[sim_id]

    try:
        # Send initial state
        await websocket.send_json(engine.get_snapshot().model_dump())

        while True:
            # Listen for client commands
            try:
                data = await asyncio.wait_for(websocket.receive_json(), timeout=0.1)
                await _handle_ws_command(sim_id, data, websocket)
            except asyncio.TimeoutError:
                pass

            # Auto-advance if running
            if engine.state.running:
                state = engine.step()
                await _broadcast(sim_id, state)
                await asyncio.sleep(0.5)  # 2 ticks/second default speed

    except WebSocketDisconnect:
        pass
    finally:
        _ws_connections[sim_id] = [
            ws for ws in _ws_connections.get(sim_id, [])
            if ws != websocket
        ]


async def _handle_ws_command(sim_id: str, data: dict, ws: WebSocket):
    engine = _simulations.get(sim_id)
    if engine is None:
        return

    cmd = data.get("command")
    if cmd == "start":
        engine.start()
    elif cmd == "pause":
        engine.pause()
    elif cmd == "step":
        state = engine.step()
        await _broadcast(sim_id, state)
    elif cmd == "inject_event":
        event = SimulationEvent(**data["event"])
        engine.inject_event(event)
    elif cmd == "switch_strategy":
        strategy = StrategyType(data["strategy"])
        engine.strategy = strategy
        engine.state.strategy = strategy


async def _broadcast(sim_id: str, state: WorldState):
    connections = _ws_connections.get(sim_id, [])
    dead = []
    payload = state.model_dump()
    for ws in connections:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        connections.remove(ws)


# ---------------------------------------------------------------------------
# Health + scenario info
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "simulations": len(_simulations)}


@app.get("/api/v1/weather")
async def get_weather():
    """Return live weather data for Kolhapur (Open-Meteo, cached 1h)."""
    try:
        from data.weather import load_or_fetch
        return load_or_fetch()
    except ImportError:
        import json, os
        cache = os.path.join(os.path.dirname(__file__), "..", "..", "data", "weather_cache.json")
        if os.path.exists(cache):
            with open(cache) as f:
                return json.load(f)
        return {"error": "weather data unavailable"}


@app.get("/api/v1/scenario/info")
async def scenario_info():
    """Return node/edge layout for the frontend to render before simulation starts."""
    try:
        from app.simulation.scenario_kolhapur import generate_kolhapur_scenario
        s = generate_kolhapur_scenario(seed=2019, max_requests=10)
        return {
            "nodes": [n.model_dump() for n in s["nodes"]],
            "edges": [e.model_dump() for e in s["edges"]],
            "shelters": [sh.model_dump() for sh in s["shelters"]],
            "scenario": "kolhapur_2019",
        }
    except Exception:
        from app.simulation.scenario import generate_scenario
        s = generate_scenario(42)
        return {
            "nodes": [n.model_dump() for n in s["nodes"]],
            "edges": [e.model_dump() for e in s["edges"]],
            "shelters": [sh.model_dump() for sh in s["shelters"]],
            "scenario": "synthetic",
        }


# ---------------------------------------------------------------------------
# B6: Simultaneous compound disruption endpoint
# ---------------------------------------------------------------------------

class CompoundDisruptionRequest(BaseModel):
    bridge_edge_id: str = ""
    fail_boat_id: str = ""
    overflow_shelter_id: str = ""


@app.post("/api/v1/simulations/{sim_id}/trigger-compound")
async def trigger_compound_disruption(
    sim_id: str,
    req: CompoundDisruptionRequest,
) -> CompoundDisruptionReport:
    """
    B6 Stretch Goal: Simultaneously trigger bridge closure + boat breakdown + shelter overflow.
    Returns a causal CompoundDisruptionReport with cancelled commitments, reassignments,
    mayday injection, and surgical stability %.
    """
    engine = _get_engine(sim_id)
    report = engine.trigger_compound_disruption(
        bridge_edge_id=req.bridge_edge_id,
        fail_boat_id=req.fail_boat_id,
        overflow_shelter_id=req.overflow_shelter_id,
    )
    # Broadcast updated state to all WS clients
    state_dict = engine.state.model_dump()
    for ws in _ws_connections.get(sim_id, []):
        try:
            await ws.send_json(state_dict)
        except Exception:
            pass
    return report


@app.get("/api/v1/simulations/{sim_id}/compound-report")
async def get_compound_report(sim_id: str) -> dict:
    """Get the last compound disruption report for this simulation."""
    engine = _get_engine(sim_id)
    if engine._last_compound_report is None:
        raise HTTPException(status_code=404, detail="No compound disruption has been triggered yet")
    return engine._last_compound_report.model_dump()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_engine(sim_id: str) -> SimulationEngine:
    if sim_id not in _simulations:
        raise HTTPException(status_code=404, detail=f"Simulation {sim_id} not found")
    return _simulations[sim_id]

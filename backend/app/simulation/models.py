"""
FloodOps core data models.
All entities are plain dataclasses / Pydantic models so they can be
serialised to JSON for the API and WebSocket broadcast.
"""

from __future__ import annotations
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field
import uuid


# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------

class NodeType(str, Enum):
    LAND = "land"
    WATER = "water"
    SHELTER = "shelter"
    STAGING = "staging"


class EdgeMode(str, Enum):
    ROAD = "road"
    WATER = "water"
    BRIDGE = "bridge"


class BoatStatus(str, Enum):
    IDLE = "idle"
    EN_ROUTE_TO_PICKUP = "en_route_to_pickup"
    PICKING_UP = "picking_up"
    EN_ROUTE_TO_SHELTER = "en_route_to_shelter"
    BROKEN = "broken"


class RequestStatus(str, Enum):
    WAITING = "waiting"
    ASSIGNED = "assigned"
    PICKED_UP = "picked_up"
    DELIVERED = "delivered"
    FAILED = "failed"


class AssignmentStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class StrategyType(str, Enum):
    GREEDY = "greedy"
    OPTIMISER = "optimiser"
    NEGOTIATION = "negotiation"


class EventType(str, Enum):
    ROUTE_CLOSURE = "route_closure"
    ROUTE_REOPEN = "route_reopen"
    BOAT_BREAKDOWN = "boat_breakdown"
    NEW_REQUEST = "new_request"
    SHELTER_FULL = "shelter_full"       # B2: auto-fired when shelter hits 90%
    CONTRADICTION_DETECTED = "contradiction_detected"  # B3
    COMPOUND_DISRUPTION = "compound_disruption"        # B6: simultaneous multi-failure


# ---------------------------------------------------------------------------
# Graph primitives
# ---------------------------------------------------------------------------

class Node(BaseModel):
    id: str
    x: float          # longitude / map x (= lon for real data)
    y: float          # latitude  / map y (= lat for real data)
    node_type: NodeType = NodeType.LAND
    label: Optional[str] = None
    # Real-world geographic coords (populated for Kolhapur scenario)
    lat: Optional[float] = None
    lon: Optional[float] = None
    elevation: Optional[float] = None
    flood_risk: bool = False
    # F1: Predictive flood fields
    flooded: bool = False
    flood_depth: float = 0.0
    ticks_until_flooded: Optional[int] = None   # None=safe; 0=flooded now; k=floods in k ticks
    is_transfer_hub: bool = False               # True when on shoreline between dry road + water/submerged


class Edge(BaseModel):
    id: str
    source: str
    destination: str
    travel_time: float        # ticks to traverse
    mode: EdgeMode = EdgeMode.WATER
    risk: float = 0.0         # 0.0 – 1.0
    open: bool = True
    # F1: Predictive flood fields
    submerged_navigable: bool = False   # True when road is flooded but boats can sail over it
    ticks_until_flooded: Optional[int] = None   # min of endpoint ticks_until_flooded
    congestion_toll: float = 0.0               # road agent negotiation cost


# ---------------------------------------------------------------------------
# Simulation entities
# ---------------------------------------------------------------------------

class VehicleType(str, Enum):
    BOAT       = "boat"
    TRUCK      = "truck"
    HELICOPTER = "helicopter"


class Boat(BaseModel):
    id: str
    location: str             # current node id
    capacity: int = 10
    speed: float = 1.0        # edges per tick (used for ETA calc)
    status: BoatStatus = BoatStatus.IDLE
    current_assignment: Optional[str] = None   # assignment id
    people_on_board: int = 0
    path: list[str] = Field(default_factory=list)   # remaining node ids
    vehicle_type: VehicleType = VehicleType.BOAT    # determines routing layer

    @property
    def allowed_modes(self) -> list[str]:
        if self.vehicle_type == VehicleType.BOAT:
            return ["water"]
        if self.vehicle_type == VehicleType.TRUCK:
            return ["road", "bridge"]
        return ["water", "road", "bridge"]  # helicopter


class RescueRequest(BaseModel):
    id: str
    location: str             # node id
    people: int
    urgency: int = 5          # 1 (low) – 10 (critical)
    status: RequestStatus = RequestStatus.WAITING
    waiting_ticks: int = 0
    neighbourhood: str = "unknown"
    uncertainty: float = 0.0  # 0 = confirmed, 1 = unverified report
    # B1: uncertainty tracking
    confirmed: bool = False   # True once uncertainty decays below threshold
    # B3: contradiction tracking
    contradicts: Optional[str] = None   # id of the request this conflicts with
    is_contradiction: bool = False      # True if this is the newer conflicting report
    resolved_people: Optional[int] = None  # engine sets this after resolution


class Shelter(BaseModel):
    id: str
    location: str             # node id
    total_capacity: int
    occupied: int = 0
    overflow_warned: bool = False   # B2: prevents duplicate SHELTER_FULL events

    @property
    def available(self) -> int:
        return self.total_capacity - self.occupied

    @property
    def is_full(self) -> bool:
        return self.occupied >= self.total_capacity

    @property
    def fill_pct(self) -> float:
        return round(self.occupied / max(self.total_capacity, 1), 3)


class Assignment(BaseModel):
    id: str
    request_id: str
    boat_id: str
    shelter_id: str
    eta_pickup: Optional[float] = None
    eta_delivery: Optional[float] = None
    status: AssignmentStatus = AssignmentStatus.PENDING
    reason: str = ""          # human-readable explanation
    created_tick: int = 0
    completed_tick: Optional[int] = None


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

class SimulationEvent(BaseModel):
    tick: int
    event_type: EventType
    target_id: str            # edge id, boat id, node id, etc.
    payload: dict = Field(default_factory=dict)
    description: str = ""


# ---------------------------------------------------------------------------
# Log entry (decision log / replay)
# ---------------------------------------------------------------------------

class LogEntry(BaseModel):
    tick: int
    level: str = "info"       # info | warn | error
    message: str
    entity_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Metrics snapshot
# ---------------------------------------------------------------------------

class MetricsSnapshot(BaseModel):
    tick: int
    strategy: StrategyType
    people_delivered: int = 0
    people_waiting: int = 0
    people_in_transit: int = 0
    requests_completed: int = 0
    requests_unmet: int = 0
    mean_delivery_time: float = 0.0
    p90_delivery_time: float = 0.0
    boat_utilisation: float = 0.0   # fraction of boats active
    idle_ticks: int = 0
    disruptions_handled: int = 0
    safety_violations: int = 0
    fairness_by_neighbourhood: dict[str, float] = Field(default_factory=dict)
    # B4: enhanced fairness
    fairness_gini: float = 0.0      # 0 = perfect fairness, 1 = fully unfair
    worst_neighbourhood: Optional[str] = None
    # B3: contradiction tracking
    contradictions_detected: int = 0
    contradictions_resolved: int = 0
    # B2: shelter status
    shelter_fill: dict[str, float] = Field(default_factory=dict)  # shelter_id → fill_pct
    # F1: predictive amphibious metrics
    dead_traps_avoided: int = 0
    amphibious_routes_used: int = 0
    # F2: multi-round negotiation + recon metrics
    recon_verifications: int = 0
    lilypad_relays: int = 0
    road_tolls_applied: int = 0
    shelter_triage_diversions: int = 0
    negotiation_rounds_used: int = 0
    # B4: active fairness tracking
    gini_coefficient: float = 0.0
    worst_served_zone: str = "None"
    worst_served_pct: float = 0.0
    mission_churn_count: int = 0
    comms_blackout_violations_avoided: int = 0


# ---------------------------------------------------------------------------
# Full world state (broadcast over WebSocket each tick)
# ---------------------------------------------------------------------------

class WorldState(BaseModel):
    simulation_id: str
    tick: int
    strategy: StrategyType
    running: bool = False
    nodes: list[Node] = Field(default_factory=list)
    edges: list[Edge] = Field(default_factory=list)
    boats: list[Boat] = Field(default_factory=list)
    requests: list[RescueRequest] = Field(default_factory=list)
    shelters: list[Shelter] = Field(default_factory=list)
    assignments: list[Assignment] = Field(default_factory=list)
    recent_events: list[SimulationEvent] = Field(default_factory=list)
    log: list[LogEntry] = Field(default_factory=list)
    metrics: Optional[MetricsSnapshot] = None
    safety_violation_count: int = 0
    # Flood spread state (Phase 2)
    flood_state: Optional[dict] = None        # FloodState.to_dict()
    scenario_severity: str = "severe"         # from weather cache
    scenario_name: str = "synthetic"          # 'synthetic' or 'kolhapur_2019'
    weather_summary: Optional[dict] = None    # from Open-Meteo
    negotiation_rounds: int = 3               # B9: rounds per tick for multi-round negotiation
    ghost_comparison: Optional["GhostComparison"] = None  # F4: live counterfactual


# ---------------------------------------------------------------------------
# B6: Compound disruption causal chain models
# ---------------------------------------------------------------------------

class CancelledCommitment(BaseModel):
    vehicle_id: str
    vehicle_type: str
    request_id: Optional[str] = None
    shelter_id: Optional[str] = None
    reason_code: str   # "BRIDGE_CLOSED" | "BOAT_FAILURE" | "SHELTER_OVERFLOW"
    explanation: str


class ReassignmentRecord(BaseModel):
    request_id: str
    is_mayday_rescue: bool = False
    previous_vehicle_id: Optional[str] = None
    new_vehicle_id: str
    new_vehicle_type: str
    previous_shelter_id: Optional[str] = None
    new_shelter_id: Optional[str] = None
    winning_bid_score: float
    runner_up_vehicle_id: Optional[str] = None
    runner_up_score: Optional[float] = None
    why_explanation: str


class CompoundDisruptionReport(BaseModel):
    tick: int
    bridge_edge_id: str
    failed_boat_id: str
    overflow_shelter_id: str
    mayday_request_id: Optional[str] = None
    cancelled_commitments: list[CancelledCommitment] = []
    reassignments: list[ReassignmentRecord] = []
    unaffected_vehicle_ids: list[str] = []
    surgical_stability_pct: float = 100.0


# ---------------------------------------------------------------------------
# F4: Ghost Fleet Counterfactual Comparison
# ---------------------------------------------------------------------------

class GhostComparison(BaseModel):
    baseline_strategy: str = "greedy_central_baseline"
    swarm_delivered: int = 0
    baseline_estimated_delivered: int = 0
    extra_people_saved: int = 0
    baseline_traps_hit: int = 0
    baseline_churn_events: int = 0
    headline: str = ""

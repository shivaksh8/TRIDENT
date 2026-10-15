"""
Three dispatch strategies for FloodOps.

All strategies share the same interface:
    assign(world, graph) -> list[Assignment]

They read world state and return a list of new assignments.
They must NOT mutate world state directly — the engine applies them.
"""

from __future__ import annotations
import uuid
from typing import Optional
from app.simulation.models import (
    Boat, RescueRequest, Shelter, Assignment, WorldState,
    BoatStatus, RequestStatus, AssignmentStatus, VehicleType, LogEntry,
)
from app.simulation.graph import GraphEngine, check_path_dead_trap


# ---------------------------------------------------------------------------
# Helpers shared by all strategies
# ---------------------------------------------------------------------------

def _idle_boats(world: WorldState) -> list[Boat]:
    return [b for b in world.boats if b.status == BoatStatus.IDLE]


def _waiting_requests(world: WorldState) -> list[RescueRequest]:
    return [r for r in world.requests if r.status == RequestStatus.WAITING]


def _effective_people(req: RescueRequest) -> int:
    """B3: use resolved_people if a contradiction was resolved, else actual count."""
    return req.resolved_people if req.resolved_people is not None else req.people


def _available_shelters(world: WorldState) -> list[Shelter]:
    return [s for s in world.shelters if not s.is_full]


def _best_shelter(
    boat_location: str,
    shelters: list[Shelter],
    graph: GraphEngine,
    vehicle_id: Optional[str] = None,
) -> Optional[Shelter]:
    """Pick the reachable shelter with most available capacity."""
    reachable = [
        s for s in shelters
        if graph.path_exists(boat_location, s.location, vehicle_id=vehicle_id)
    ]
    if not reachable:
        return None
    return max(reachable, key=lambda s: s.available)


def _eta(boat: Boat, request: RescueRequest, graph: GraphEngine) -> float:
    path = graph.shortest_path(boat.location, request.location, vehicle_id=boat.id)
    if path is None:
        return float("inf")
    return graph.path_travel_time(path, vehicle_id=boat.id)


def _make_assignment(
    request: RescueRequest,
    boat: Boat,
    shelter: Shelter,
    graph: GraphEngine,
    reason: str,
    tick: int,
) -> Assignment:
    path_to_req = graph.shortest_path(boat.location, request.location, vehicle_id=boat.id)
    eta_pickup = graph.path_travel_time(path_to_req, vehicle_id=boat.id) if path_to_req else float("inf")

    path_to_shelter = graph.shortest_path(request.location, shelter.location, vehicle_id=boat.id)
    eta_delivery = eta_pickup + (
        graph.path_travel_time(path_to_shelter, vehicle_id=boat.id) if path_to_shelter else float("inf")
    )

    return Assignment(
        id=str(uuid.uuid4())[:8],
        request_id=request.id,
        boat_id=boat.id,
        shelter_id=shelter.id,
        eta_pickup=round(eta_pickup, 2),
        eta_delivery=round(eta_delivery, 2),
        status=AssignmentStatus.PENDING,
        reason=reason,
        created_tick=tick,
    )


# ---------------------------------------------------------------------------
# Strategy 1: Greedy nearest-first
# ---------------------------------------------------------------------------

def greedy_assign(world: WorldState, graph: GraphEngine) -> list[Assignment]:
    """
    Assign the nearest idle boat to each waiting request, one pass.
    O(boats × requests) — simple and fast.
    """
    assignments = []
    assigned_boat_ids: set[str] = set()
    assigned_request_ids: set[str] = set()
    shelter_reserved: dict[str, int] = {}  # local tracking, don't mutate world state

    waiting = sorted(
        _waiting_requests(world),
        key=lambda r: (-r.urgency, r.waiting_ticks)  # highest urgency first
    )
    boats = _idle_boats(world)
    shelters = _available_shelters(world)

    for request in waiting:
        if not shelters:
            break

        best_boat = None
        best_eta = float("inf")

        for boat in boats:
            if boat.id in assigned_boat_ids:
                continue
            if boat.people_on_board + _effective_people(request) > boat.capacity:
                continue
            eta = _eta(boat, request, graph)
            if eta < best_eta:
                best_eta = eta
                best_boat = boat

        if best_boat is None:
            continue

        # Find shelter with enough remaining space (accounting for pending reservations)
        shelter = None
        for s in shelters:
            reserved = shelter_reserved.get(s.id, 0)
            if s.occupied + reserved + _effective_people(request) <= s.total_capacity:
                if graph.path_exists(request.location, s.location, vehicle_id=best_boat.id):
                    shelter = s
                    break
        if shelter is None:
            continue

        uncertainty_note = f", uncertainty={request.uncertainty:.2f}" if request.uncertainty > 0 else ""
        contradiction_note = " [CONTRADICTED]" if request.is_contradiction else ""
        reason = (
            f"Greedy: boat {best_boat.id} is nearest (ETA {best_eta:.1f} ticks), "
            f"urgency {request.urgency}/10{uncertainty_note}{contradiction_note}"
        )
        assignments.append(
            _make_assignment(request, best_boat, shelter, graph, reason, world.tick)
        )
        assigned_boat_ids.add(best_boat.id)
        assigned_request_ids.add(request.id)

        # Track reserved capacity locally (don't mutate world state)
        shelter_reserved[shelter.id] = shelter_reserved.get(shelter.id, 0) + request.people

    return assignments


# ---------------------------------------------------------------------------
# Strategy 2: Centralised optimiser (scipy linear_sum_assignment)
# ---------------------------------------------------------------------------

def optimiser_assign(world: WorldState, graph: GraphEngine) -> list[Assignment]:
    """
    Build a cost matrix and solve the assignment problem globally.
    Cost = weighted combo of ETA, urgency inverse, route risk.
    Falls back to greedy if scipy unavailable.

    B5: Simulates Central Comms Backhaul Lag (No-Internet Blackout):
    - During active flood (tick >= 3), cost matrix uses 2-tick-stale flood data
      (newly submerged_navigable spillover edges are invisible to the optimiser).
    - Mid-route reassignments increment mission_churn_count and apply +1 tick delay.
    """
    try:
        from scipy.optimize import linear_sum_assignment
        import numpy as np
    except ImportError:
        return greedy_assign(world, graph)

    boats = [b for b in _idle_boats(world)]
    requests = _waiting_requests(world)
    shelters = _available_shelters(world)

    if not boats or not requests or not shelters:
        return []

    # B5: Track which vehicles were previously committed (for churn detection)
    previously_assigned_req_ids = {
        a.request_id for a in world.assignments
        if a.status.value == "active"
    }

    # B5: Comms blackout lag — during active flood (tick >= 3), pretend spillover
    # edges added in the last 2 ticks don't exist (stale server-side snapshot).
    # Build a "stale edge" blacklist: submerged_navigable edges with ticks_until_flooded=0
    # that would have been newly added this or last tick.
    stale_edge_ids: set[str] = set()
    if world.tick >= 3:
        # Edges injected by spillover (submerged_navigable=True, not in original waterways)
        for e in world.edges:
            if e.submerged_navigable and e.mode.value == "water":
                stale_edge_ids.add(e.id)

    n_b, n_r = len(boats), len(requests)
    INF = 1e9

    # Build cost matrix [boats × requests]
    cost = np.full((n_b, n_r), INF)

    for i, boat in enumerate(boats):
        for j, req in enumerate(requests):
            if boat.people_on_board + _effective_people(req) > boat.capacity:
                continue
            path = graph.shortest_path(boat.location, req.location, vehicle_id=boat.id)
            if path is None:
                continue
            eta = graph.path_travel_time(path, vehicle_id=boat.id)
            urgency_weight = (11 - req.urgency) * 2  # higher urgency → lower cost
            wait_discount = max(0, 5 - req.waiting_ticks * 0.5)
            # B1: uncertainty increases cost (less confident = less preferred)
            uncertainty_penalty = req.uncertainty * 3.0
            # B5: stale-snapshot penalty — optimiser can't see newly created spillover edges
            # so if the only viable path uses them, it gets a +3 penalty (blind to amphibious)
            stale_penalty = 0.0
            if stale_edge_ids:
                path_edges_stale = any(
                    True for k in range(len(path) - 1)
                    for e in world.edges
                    if e.source == path[k] and e.destination == path[k+1]
                    and e.id in stale_edge_ids
                )
                if path_edges_stale:
                    stale_penalty = 3.0  # simulates blind spot to recent spillover
            cost[i][j] = eta + urgency_weight + wait_discount + uncertainty_penalty + stale_penalty

    # Pad to square if needed
    size = max(n_b, n_r)
    padded = np.full((size, size), INF)
    padded[:n_b, :n_r] = cost

    row_ind, col_ind = linear_sum_assignment(padded)

    assignments = []
    shelter_occupancy: dict[str, int] = {s.id: s.occupied for s in shelters}

    for r_idx, c_idx in zip(row_ind, col_ind):
        if r_idx >= n_b or c_idx >= n_r:
            continue
        if padded[r_idx][c_idx] >= INF:
            continue

        boat = boats[r_idx]
        req = requests[c_idx]

        # Pick shelter with space
        shelter = None
        for s in shelters:
            if shelter_occupancy[s.id] + _effective_people(req) <= s.total_capacity:
                if graph.path_exists(req.location, s.location, vehicle_id=boat.id):
                    shelter = s
                    break
        if shelter is None:
            continue

        uncertainty_note = f", uncertainty={req.uncertainty:.2f}" if req.uncertainty > 0 else ""
        reason = (
            f"Optimiser: globally optimal assignment, "
            f"cost={padded[r_idx][c_idx]:.1f}, urgency {req.urgency}/10{uncertainty_note}"
        )
        a = _make_assignment(req, boat, shelter, graph, reason, world.tick)
        assignments.append(a)
        shelter_occupancy[shelter.id] += _effective_people(req)

    # B5: stash mission churn count for engine pickup
    world.__dict__.setdefault("_b5_mission_churn", 0)
    # churn = number of newly assigned requests that were previously unassigned
    # (the optimiser globally reassigns everything each tick, causing thrashing)
    new_req_ids = {a.request_id for a in assignments}
    churn = len(new_req_ids - previously_assigned_req_ids) if world.tick >= 3 else 0
    world.__dict__["_b5_mission_churn"] += churn

    return assignments


# ---------------------------------------------------------------------------
# Strategy 3: Hybrid contract-net negotiation
# ---------------------------------------------------------------------------

class Bid:
    def __init__(self, boat: Boat, request: RescueRequest, score: float, reason: str,
                 vetoed: bool = False, amphibious: bool = False):
        self.boat = boat
        self.request = request
        self.score = score
        self.reason = reason
        self.vetoed = vetoed
        self.amphibious = amphibious


def negotiation_assign(world: WorldState, graph: GraphEngine) -> list[Assignment]:
    """
    B9 Contract-net style, multi-round:
    Each tick runs up to world.negotiation_rounds rounds. In each round:
    1. Every still-idle vehicle bids on every still-unassigned request.
    2. Coordinator picks the highest-score bid per request, resolves conflicts.
    3. Winners commit; outbid vehicles immediately re-bid next round on remaining requests.

    F1: dead-trap veto for trucks, amphibious bonus for boats.
    F2: throughput efficiency bonus, heli recon bonus, lilypad relay bonus,
        congestion toll penalty, negotiation_rounds_used tracking.
    """
    shelters = _available_shelters(world)
    if not shelters:
        return []

    max_rounds = getattr(world, "negotiation_rounds", 3)

    # --- B4: Pre-compute zone service ratios for fairness boost ---
    # s_z = (delivered_z + 0.5 * in_transit_z) / max(1, total_z)
    from app.simulation.models import RequestStatus as RS
    zone_total: dict[str, int] = {}
    zone_delivered: dict[str, float] = {}
    for req in world.requests:
        z = req.neighbourhood or "unknown"
        zone_total[z] = zone_total.get(z, 0) + 1
        if req.status == RS.DELIVERED:
            zone_delivered[z] = zone_delivered.get(z, 0.0) + 1.0
        elif req.status in (RS.ASSIGNED, RS.PICKED_UP):
            zone_delivered[z] = zone_delivered.get(z, 0.0) + 0.5
    zone_service: dict[str, float] = {
        z: zone_delivered.get(z, 0.0) / max(1, zone_total[z])
        for z in zone_total
    }
    mean_service = sum(zone_service.values()) / max(len(zone_service), 1)

    # Stash worst_served for engine pickup
    if zone_service:
        worst_zone = min(zone_service, key=zone_service.get)
        world.__dict__["_b4_worst_served_zone"] = worst_zone
        world.__dict__["_b4_worst_served_pct"] = round(zone_service[worst_zone] * 100, 1)
    else:
        world.__dict__["_b4_worst_served_zone"] = "None"
        world.__dict__["_b4_worst_served_pct"] = 0.0

    # --- F3: Reset then mark road congestion tolls ---
    # Clear all existing tolls first
    for e in world.edges:
        e.congestion_toll = 0.0
    # Mark edges used by currently-active vehicles
    _node_map = {n.id: n for n in world.nodes}
    for boat in world.boats:
        if boat.status not in (BoatStatus.EN_ROUTE_TO_PICKUP, BoatStatus.EN_ROUTE_TO_SHELTER):
            continue
        for k in range(len(boat.path) - 1):
            for e in world.edges:
                if e.source == boat.path[k] and e.destination == boat.path[k+1]:
                    e.congestion_toll += 1.5
                    break

    # Track across all rounds
    all_assignments: list[Assignment] = []
    committed_boat_ids: set[str] = set()
    committed_request_ids: set[str] = set()
    shelter_occupancy: dict[str, int] = {s.id: s.occupied for s in shelters}

    # F1/F2/F3 counters (stashed on world for engine pickup)
    _f1_dead_traps_avoided = 0
    _f1_amphibious_routes_used = 0
    _f2_rounds_used = 0
    _f2_recon_verifications = 0
    _f2_lilypad_relays = 0
    _f2_road_tolls_applied = 0
    _f2_shelter_triage_diversions = 0

    for round_num in range(max_rounds):
        # Get fresh idle/waiting sets for this round
        idle_boats = [b for b in world.boats
                      if b.status == BoatStatus.IDLE and b.id not in committed_boat_ids]
        waiting_reqs = sorted(
            [r for r in world.requests
             if r.status == RequestStatus.WAITING and r.id not in committed_request_ids],
            key=lambda r: (-r.urgency, r.waiting_ticks)
        )

        if not idle_boats or not waiting_reqs:
            break

        _f2_rounds_used += 1

        # ----- Build bids for this round -----
        round_bids: list[Bid] = []

        for boat in idle_boats:
            for req in waiting_reqs:
                if boat.people_on_board + _effective_people(req) > boat.capacity:
                    continue
                path = graph.shortest_path(boat.location, req.location, vehicle_id=boat.id)
                if path is None:
                    continue

                eta = graph.path_travel_time(path, vehicle_id=boat.id)
                route_risk = sum(
                    graph._graph_any[path[k]][path[k+1]].get("risk", 0)
                    for k in range(len(path)-1)
                    if graph._graph_any.has_edge(path[k], path[k+1])
                ) / max(len(path)-1, 1)

                # --- F1: Dead-trap veto for trucks ---
                if boat.vehicle_type == VehicleType.TRUCK or boat.id.startswith("truck"):
                    is_trap, trap_id, trap_ttf = check_path_dead_trap(
                        world, path, VehicleType.TRUCK, current_speed=boat.speed
                    )
                    if is_trap:
                        _f1_dead_traps_avoided += 1
                        world.log.append(LogEntry(
                            tick=world.tick,
                            level="warn",
                            message=(
                                f"ROAD_AGENT_VETO: Truck {boat.id} blocked from {req.id} "
                                f"-- road {trap_id} submerges in {trap_ttf} ticks (Dead-Trap Avoided)"
                            ),
                            entity_id=boat.id,
                        ))
                        continue  # skip — veto tracked, no bid submitted

                # --- F1: Amphibious bonus ---
                amphibious_bonus = 0.0
                is_amphibious = False
                if boat.vehicle_type == VehicleType.BOAT or boat.id.startswith("boat"):
                    if graph.uses_submerged_edge(path):
                        amphibious_bonus = 2.0
                        is_amphibious = True

                # --- F2: Helicopter recon bonus ---
                # Heli gets +1.5 for high-uncertainty requests (it can verify quickly)
                heli_recon_bonus = 0.0
                is_recon = False
                if boat.vehicle_type == VehicleType.HELICOPTER or boat.id.startswith("heli"):
                    if req.uncertainty >= 0.4 and not req.confirmed:
                        heli_recon_bonus = 1.5
                        is_recon = True

                # --- F2: Lilypad relay bonus ---
                # Any vehicle gets +1.0 if its destination is a transfer_hub node
                # (shoreline node connecting dry road + water, ideal for multi-hop relay)
                lilypad_bonus = 0.0
                is_lilypad = False
                req_node = next((n for n in world.nodes if n.id == req.location), None)
                if req_node and req_node.is_transfer_hub:
                    lilypad_bonus = 1.0
                    is_lilypad = True

                # --- F2: Congestion toll penalty ---
                # Use edge congestion_toll if set (road network pricing signal)
                congestion_toll = 0.0
                for k in range(len(path)-1):
                    edge = next(
                        (e for e in world.edges
                         if e.source == path[k] and e.destination == path[k+1]),
                        None
                    )
                    if edge:
                        congestion_toll += edge.congestion_toll

                # --- F2: Throughput efficiency bonus ---
                people_eff = min(boat.capacity, _effective_people(req))
                throughput_bonus = people_eff * 0.45

                # --- B4: Fairness boost for underserved zones ---
                req_zone = req.neighbourhood or "unknown"
                zone_s = zone_service.get(req_zone, 0.0)
                fairness_boost = max(0.0, (mean_service - zone_s) * 8.0) if zone_s < mean_service else 0.0

                # B4: Cap congestion toll at 3.0 so it breaks ties, not throughput
                congestion_toll = min(congestion_toll, 3.0)

                # Final bid score
                score = (
                    req.urgency * 3.0
                    + throughput_bonus
                    + req.waiting_ticks * 0.3
                    - eta * 1.0
                    - route_risk * 3.0
                    - req.uncertainty * 2.0
                    - congestion_toll
                    + amphibious_bonus
                    + heli_recon_bonus
                    + lilypad_bonus
                    + fairness_boost
                )

                # F3: track road toll applied per bid evaluation
                if congestion_toll > 0:
                    _f2_road_tolls_applied += 1

                notes = []
                if req.is_contradiction: notes.append("CONTRADICTED")
                if is_amphibious: notes.append("AMPHIBIOUS")
                if is_recon: notes.append("RECON")
                if is_lilypad: notes.append("LILYPAD")
                note_str = " [" + ",".join(notes) + "]" if notes else ""

                reason = (
                    f"Bid R{round_num+1}: ETA={eta:.1f}, risk={route_risk:.2f}, "
                    f"urgency={req.urgency}, wait={req.waiting_ticks}, "
                    f"eff={people_eff}, uncertainty={req.uncertainty:.2f}"
                    f"{note_str}"
                )
                round_bids.append(Bid(boat, req, score, reason,
                                      amphibious=is_amphibious))

        if not round_bids:
            break

        # ----- Step 2: best bid per request (non-vetoed) -----
        best_bids: dict[str, Bid] = {}
        for bid in round_bids:
            rid = bid.request.id
            if rid not in best_bids or bid.score > best_bids[rid].score:
                best_bids[rid] = bid

        # ----- Step 3: resolve conflicts — one boat wins one request -----
        boat_to_bid: dict[str, Bid] = {}
        for rid, bid in sorted(best_bids.items(), key=lambda x: -x[1].score):
            if bid.boat.id not in boat_to_bid:
                boat_to_bid[bid.boat.id] = bid

        # ----- Step 4: commit round winners -----
        round_committed = 0
        for bid in boat_to_bid.values():
            # Pick shelter with enough space
            shelter = None
            for s in shelters:
                if shelter_occupancy[s.id] + _effective_people(bid.request) <= s.total_capacity:
                    if graph.path_exists(bid.request.location, s.location, vehicle_id=bid.boat.id):
                        shelter = s
                        break
            if shelter is None:
                continue

            # F1: track amphibious immediately at commit
            if bid.amphibious:
                _f1_amphibious_routes_used += 1

            # F2: track recon verifications
            if bid.boat.id.startswith("heli") and bid.request.uncertainty >= 0.4:
                _f2_recon_verifications += 1

            # F2: track lilypad relays
            req_node = next((n for n in world.nodes if n.id == bid.request.location), None)
            if req_node and req_node.is_transfer_hub:
                _f2_lilypad_relays += 1

            # F3: shelter triage diversion — low-urgency req diverted from nearly-full shelter
            for s_check in shelters:
                fill_pct = s_check.occupied / s_check.total_capacity if s_check.total_capacity > 0 else 0
                if fill_pct >= 0.75 and s_check.id != shelter.id and bid.request.urgency <= 3:
                    _f2_shelter_triage_diversions += 1
                    break

            reason = (
                f"Negotiation R{round_num+1} commit: {bid.reason}, "
                f"score={bid.score:.2f}, shelter={shelter.id}"
            )
            a = _make_assignment(
                bid.request, bid.boat, shelter, graph, reason, world.tick
            )
            all_assignments.append(a)
            committed_boat_ids.add(bid.boat.id)
            committed_request_ids.add(bid.request.id)
            shelter_occupancy[shelter.id] += _effective_people(bid.request)
            round_committed += 1

        if round_committed == 0:
            break  # no progress this round — stop early

    # Stash counters for engine pickup
    world.__dict__.setdefault("_f1_dead_traps_avoided", 0)
    world.__dict__.setdefault("_f1_amphibious_routes_used", 0)
    world.__dict__.setdefault("_f2_negotiation_rounds_used", 0)
    world.__dict__.setdefault("_f2_recon_verifications", 0)
    world.__dict__.setdefault("_f2_lilypad_relays", 0)
    world.__dict__.setdefault("_f2_road_tolls_applied", 0)
    world.__dict__.setdefault("_f2_shelter_triage_diversions", 0)
    world.__dict__["_f1_dead_traps_avoided"] += _f1_dead_traps_avoided
    world.__dict__["_f1_amphibious_routes_used"] += _f1_amphibious_routes_used
    world.__dict__["_f2_negotiation_rounds_used"] += _f2_rounds_used
    world.__dict__["_f2_recon_verifications"] += _f2_recon_verifications
    world.__dict__["_f2_lilypad_relays"] += _f2_lilypad_relays
    world.__dict__["_f2_road_tolls_applied"] += _f2_road_tolls_applied
    world.__dict__["_f2_shelter_triage_diversions"] += _f2_shelter_triage_diversions

    return all_assignments

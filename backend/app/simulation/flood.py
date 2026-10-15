"""
Flood Spread Algorithm (BFS-based)
Simulates flood inundation expanding outward from river/water nodes.

Features:
  - BFS ring expansion weighted by elevation
  - Amphibious flip: flooded road edges become submerged_navigable (boats can sail, trucks blocked)
  - Predictive countdown: ticks_until_flooded on every node/edge within an 8-tick horizon
  - Transfer hub tagging: shoreline nodes connecting dry road + water/submerged edges

How it works:
  - Start from all water-type nodes (river sources)
  - Each tick interval, expand one ring outward weighted by inverse elevation
  - Nodes below FLOOD_INUNDATION_ELEV that are adjacent to already-flooded nodes get inundated
  - When a road edge floods: closed=True (blocks trucks) + submerged_navigable=True (boats can use it)
  - After each expansion, run an 8-tick lookahead BFS to set ticks_until_flooded on nodes/edges
"""

from __future__ import annotations
from collections import deque
from typing import Optional
import math
import uuid

from app.simulation.models import Node, Edge, SimulationEvent, EventType, LogEntry, EdgeMode

# Kolhapur floodplain elevation threshold (meters)
# 605m covers ~35% of nodes — keeps ticks_until_flooded=1..8 active across mid-game
# ticks 5..25 so trucks regularly encounter imminent flood corridors to veto.
FLOOD_INUNDATION_ELEV = 605.0

# Lookahead horizon (ticks)
LOOKAHEAD_TICKS = 8

_ELEVATION_CACHE: dict[str, float] = {}


def load_elevation_cache(nodes_raw: list[dict]) -> None:
    """Call once at simulation startup with the raw graph JSON node list."""
    global _ELEVATION_CACHE
    for n in nodes_raw:
        _ELEVATION_CACHE[n["id"]] = float(n.get("elevation") or 590.0)


def get_elevation(node_id: str) -> float:
    return _ELEVATION_CACHE.get(node_id, 590.0)


class FloodState:
    """
    Tracks which nodes are flooded and manages BFS expansion.
    Attached to the SimulationEngine as engine.flood_state.
    """

    def __init__(
        self,
        nodes: list[Node],
        edges: list[Edge],
        spread_ticks: int = 3,
    ):
        self.spread_ticks = spread_ticks
        self.last_spread_tick: int = 0

        # Keep references to live node/edge objects for in-place mutation
        self._nodes: dict[str, Node] = {n.id: n for n in nodes}
        self._edges: dict[str, Edge] = {e.id: e for e in edges}

        # Build adjacency for edge-based connectivity
        self._adj: dict[str, set[str]] = {n.id: set() for n in nodes}
        self._edge_map: dict[tuple[str, str], str] = {}
        for e in edges:
            self._adj[e.source].add(e.destination)
            self._adj[e.destination].add(e.source)
            self._edge_map[(e.source, e.destination)] = e.id
            self._edge_map[(e.destination, e.source)] = e.id

        # Geographic proximity adjacency for flood spread.
        # Flood spreads by elevation/geography, not strictly along edges.
        # Build an expanded adjacency including nodes within a geographic radius.
        self._flood_adj: dict[str, set[str]] = {n.id: set(self._adj[n.id]) for n in nodes}
        self._build_geographic_flood_adj(nodes)

        # All water nodes are initial flood sources
        self.flooded_nodes: set[str] = {
            n.id for n in nodes if n.node_type.value == "water"
        }

        # Mark initial water nodes as flooded
        for node_id in self.flooded_nodes:
            node = self._nodes.get(node_id)
            if node:
                node.flooded = True
                node.flood_depth = 1.0
                node.ticks_until_flooded = 0

        self.flood_closed_edges: set[str] = set()
        self.spillover_edge_ids: set[str] = set()  # virtual amphibious connector edges
        self.expansion_history: list[list[str]] = []

    def _build_geographic_flood_adj(self, nodes: list[Node]) -> None:
        """
        Add geographic proximity links between nearby nodes for flood spread.
        Flood doesn't follow roads — it spreads by terrain/elevation across nearby nodes.
        Uses node lat/lon (or x/y) to find nodes within ~0.01 degree radius (~1km).
        Tight radius ensures flood spreads gradually ring-by-ring, not all-at-once.
        """
        MAX_DIST_SQ = 0.005 ** 2  # ~500m in degree-space — keeps each ring tight

        coords: list[tuple[str, float, float]] = []
        for n in nodes:
            lat = n.lat if n.lat is not None else n.y
            lon = n.lon if n.lon is not None else n.x
            coords.append((n.id, lat, lon))

        for i, (nid_a, lat_a, lon_a) in enumerate(coords):
            for j, (nid_b, lat_b, lon_b) in enumerate(coords):
                if i >= j:
                    continue
                dist_sq = (lat_a - lat_b) ** 2 + (lon_a - lon_b) ** 2
                if dist_sq <= MAX_DIST_SQ:
                    self._flood_adj.setdefault(nid_a, set()).add(nid_b)
                    self._flood_adj.setdefault(nid_b, set()).add(nid_a)

    @property
    def flood_boundary(self) -> list[str]:
        """Current set of all flooded node IDs."""
        return list(self.flooded_nodes)

    @property
    def flood_ring_count(self) -> int:
        return len(self.expansion_history)

    def should_expand(self, current_tick: int) -> bool:
        if self.spread_ticks == 0:
            return False
        return (current_tick - self.last_spread_tick) >= self.spread_ticks

    def expand(
        self,
        current_tick: int,
        edges: list[Edge],
    ) -> tuple[list[str], list[str]]:
        """
        Expand flood by one BFS ring.
        - Newly flooded road edges: closed=True (trucks blocked) + submerged_navigable=True (boats OK)
        - After expansion, run lookahead to set ticks_until_flooded on nodes/edges.
        - Tag transfer hubs.
        Returns (newly_flooded_nodes, newly_closed_edge_ids).
        """
        # --- Predictive countdown runs BEFORE this expansion ---
        # so ring-1 candidates appear as ticks_until_flooded=1 (not 0)
        self._compute_predictive_countdown(edges)

        new_nodes: list[str] = []

        # BFS: find all non-flooded neighbours using geographic adjacency
        # (includes proximity links so flood crosses water→road component boundary)
        candidates: dict[str, float] = {}
        for flooded_id in self.flooded_nodes:
            for neighbour_id in self._flood_adj.get(flooded_id, set()):
                if neighbour_id not in self.flooded_nodes:
                    elev = get_elevation(neighbour_id)
                    if elev <= FLOOD_INUNDATION_ELEV:
                        if neighbour_id not in candidates or elev < candidates[neighbour_id]:
                            candidates[neighbour_id] = elev

        for node_id in candidates:
            self.flooded_nodes.add(node_id)
            new_nodes.append(node_id)
            # Update node model
            node = self._nodes.get(node_id)
            if node:
                node.flooded = True
                node.flood_depth = round(1.0 + (FLOOD_INUNDATION_ELEV - get_elevation(node_id)) / 50.0, 2)
                node.ticks_until_flooded = 0

        # --- Amphibious flip: handle road edges between flooded nodes ---
        newly_closed: list[str] = []

        for e in edges:
            if e.source in self.flooded_nodes and e.destination in self.flooded_nodes:
                if e.mode in (EdgeMode.ROAD, EdgeMode.BRIDGE):
                    if not e.submerged_navigable:  # only flip once
                        e.open = False                     # trucks blocked
                        e.submerged_navigable = True       # boats can sail over it
                        self.flood_closed_edges.add(e.id)
                        newly_closed.append(e.id)
                # Water edges remain open as-is

        # --- Riverbank spillover: inject virtual edges for new road nodes reachable
        # via geographic proximity (no real edge exists) so boats can sail there ---
        self._inject_spillover_edges(new_nodes, edges)

        # --- Tag transfer hubs after expansion ---
        self._tag_transfer_hubs(edges)

        # --- Update edge ticks_until_flooded after node states are final ---
        for e in edges:
            src_node = self._nodes.get(e.source)
            dst_node = self._nodes.get(e.destination)
            src_ttf = src_node.ticks_until_flooded if src_node else None
            dst_ttf = dst_node.ticks_until_flooded if dst_node else None
            vals = [v for v in (src_ttf, dst_ttf) if v is not None]
            e.ticks_until_flooded = min(vals) if vals else None

        self.expansion_history.append(new_nodes)
        self.last_spread_tick = current_tick

        return new_nodes, newly_closed

    def _compute_predictive_countdown(self, edges: list[Edge]) -> None:
        """
        Multi-source BFS from all currently flooded nodes using GEOGRAPHIC adjacency
        (_flood_adj includes proximity links, not just road/water edges).

        Assigns each non-flooded, below-threshold node a hop distance (1..LOOKAHEAD_TICKS)
        from the nearest flooded node. This is the predictive ticks_until_flooded value.

        Since flood expands one ring per spread_ticks ticks, hop distance = flood arrival ring.
        Nodes further than LOOKAHEAD_TICKS hops get None (safe for now).
        """
        from collections import deque as _deque

        # Multi-source BFS using geographic flood adjacency (crosses water→road boundaries)
        dist: dict[str, int] = {}
        queue = _deque()

        for flooded_id in self.flooded_nodes:
            queue.append((flooded_id, 0))
            dist[flooded_id] = 0  # flooded = distance 0

        while queue:
            node_id, d = queue.popleft()
            if d >= LOOKAHEAD_TICKS:
                continue
            # Use _flood_adj for geographic spread (includes proximity links)
            for nb_id in self._flood_adj.get(node_id, set()):
                if nb_id in dist:
                    continue
                elev = get_elevation(nb_id)
                if elev <= FLOOD_INUNDATION_ELEV:
                    dist[nb_id] = d + 1
                    queue.append((nb_id, d + 1))
                # Nodes above threshold don't propagate but also don't get a countdown

        # Apply to node models
        for node_id, node in self._nodes.items():
            if node_id in self.flooded_nodes:
                node.ticks_until_flooded = 0
            elif node_id in dist and dist[node_id] > 0:
                node.ticks_until_flooded = dist[node_id]
            else:
                node.ticks_until_flooded = None

        # NOTE: edge ticks_until_flooded is updated in expand() after node states finalise

    def _tag_transfer_hubs(self, edges: list[Edge]) -> None:
        """
        Tag nodes as transfer_hub when they sit on the shoreline:
        connected to at least one dry open road edge AND at least one
        water or submerged_navigable edge.
        """
        # Build sets of nodes with each edge-type connectivity
        dry_road_nodes: set[str] = set()
        water_or_sub_nodes: set[str] = set()

        for e in edges:
            is_water_like = (
                e.mode == EdgeMode.WATER
                or (e.submerged_navigable and not e.open)  # submerged road
            )
            is_dry_road = (
                e.mode in (EdgeMode.ROAD, EdgeMode.BRIDGE)
                and e.open
                and not e.submerged_navigable
            )
            if is_dry_road:
                dry_road_nodes.add(e.source)
                dry_road_nodes.add(e.destination)
            if is_water_like:
                water_or_sub_nodes.add(e.source)
                water_or_sub_nodes.add(e.destination)

        hub_candidates = dry_road_nodes & water_or_sub_nodes

        for node_id, node in self._nodes.items():
            node.is_transfer_hub = node_id in hub_candidates

    def _inject_spillover_edges(self, new_nodes: list[str], edges: list[Edge]) -> None:
        """
        When a road node floods via geographic proximity (no real edge from source),
        inject a virtual 'submerged_navigable' Edge so boats can physically route there.

        For each newly-flooded road node `v`, find the nearest already-flooded neighbour `u`
        in `_flood_adj`. If no real edge (u→v) exists, create a virtual spillover edge
        with submerged_navigable=True so _graph_water picks it up on the next rebuild.
        """
        # Build set of existing edge pairs for quick lookup
        existing_pairs: set[tuple[str, str]] = set()
        for e in edges:
            existing_pairs.add((e.source, e.destination))
            existing_pairs.add((e.destination, e.source))

        for v_id in new_nodes:
            v_node = self._nodes.get(v_id)
            if not v_node:
                continue
            # Only inject for road-type nodes (water nodes already have real edges)
            if v_node.node_type and v_node.node_type.value == "water":
                continue

            # Find a flooded neighbour in _flood_adj to serve as source
            for u_id in self._flood_adj.get(v_id, set()):
                if u_id not in self.flooded_nodes:
                    continue
                if (u_id, v_id) in existing_pairs:
                    continue  # real edge exists, no need

                # Compute distance for travel time
                u_node = self._nodes.get(u_id)
                if u_node is None:
                    continue
                u_lat = u_node.lat if u_node.lat is not None else u_node.y
                u_lon = u_node.lon if u_node.lon is not None else u_node.x
                v_lat = v_node.lat if v_node.lat is not None else v_node.y
                v_lon = v_node.lon if v_node.lon is not None else v_node.x
                dist_deg = math.sqrt((u_lat - v_lat) ** 2 + (u_lon - v_lon) ** 2)
                # 1 degree ≈ 111km; travel_time in ticks at 1.0 speed per unit
                travel_time = max(1.0, dist_deg * 111.0)

                spill_id = f"spill_{u_id}_{v_id}"
                if spill_id in self.spillover_edge_ids:
                    break  # already injected

                # Create virtual spillover edge: closed to trucks, open to boats
                spill_edge = Edge(
                    id=spill_id,
                    source=u_id,
                    destination=v_id,
                    mode=EdgeMode.WATER,       # treated as water for graph routing
                    travel_time=round(travel_time, 2),
                    risk=0.3,
                    open=True,
                    submerged_navigable=True,  # boats can traverse
                )
                edges.append(spill_edge)
                self._edges[spill_id] = spill_edge
                existing_pairs.add((u_id, v_id))
                self.spillover_edge_ids.add(spill_id)
                break  # one spillover per new node is enough

    def to_dict(self) -> dict:
        """Serialise for WebSocket broadcast."""
        return {
            "flooded_nodes": list(self.flooded_nodes),
            "flood_closed_edges": list(self.flood_closed_edges),
            "spillover_edges": list(self.spillover_edge_ids),
            "ring_count": self.flood_ring_count,
            "spread_ticks": self.spread_ticks,
            "expansion_history": self.expansion_history[-5:],
        }


def make_flood_events(
    tick: int,
    newly_flooded: list[str],
    newly_closed: list[str],
    log: list[LogEntry],
) -> list[SimulationEvent]:
    """Generate simulation events for a flood expansion."""
    events = []

    if newly_flooded:
        events.append(SimulationEvent(
            tick=tick,
            event_type=EventType.ROUTE_CLOSURE,
            target_id="flood_expansion",
            payload={
                "flooded_nodes": newly_flooded,
                "closed_edges": newly_closed,
                "ring_number": len(newly_flooded),
            },
            description=(
                f"Flood expanded: {len(newly_flooded)} nodes inundated, "
                f"{len(newly_closed)} roads auto-closed (submerged_navigable for boats)"
            ),
        ))
        log.append(LogEntry(
            tick=tick,
            level="warn",
            message=(
                f"🌊 Flood advance: {len(newly_flooded)} new nodes flooded, "
                f"{len(newly_closed)} roads closed/submerged"
            ),
        ))

    return events

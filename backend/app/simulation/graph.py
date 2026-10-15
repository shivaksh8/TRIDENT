"""
Graph engine — wraps NetworkX for routing.
Supports:
  - Dijkstra shortest path on open edges only
  - Two-layer routing: road-only, water-only, or any (helicopter)
  - Amphibious boat routing: boats can traverse submerged_navigable road edges
  - Dead-trap lookahead: check_path_dead_trap detects imminent flood traps for trucks
"""

from __future__ import annotations
from typing import Optional, TYPE_CHECKING
import networkx as nx
from app.simulation.models import Edge, Node, EdgeMode, VehicleType

if TYPE_CHECKING:
    from app.simulation.models import WorldState


# Vehicle mode constraints (base layer — amphibious override applied in _build)
VEHICLE_MODES = {
    "boat":  {EdgeMode.WATER},
    "truck": {EdgeMode.ROAD, EdgeMode.BRIDGE},
    "heli":  {EdgeMode.ROAD, EdgeMode.WATER, EdgeMode.BRIDGE},
}


def get_vehicle_allowed_modes(vehicle_id: str) -> set[EdgeMode]:
    """Return the set of EdgeModes a vehicle can traverse (base, pre-amphibious)."""
    for prefix, modes in VEHICLE_MODES.items():
        if vehicle_id.startswith(prefix):
            return modes
    return {EdgeMode.WATER, EdgeMode.ROAD, EdgeMode.BRIDGE}


def _is_boat(vehicle_id: Optional[str]) -> bool:
    return vehicle_id is not None and vehicle_id.startswith("boat")


def _is_truck(vehicle_id: Optional[str]) -> bool:
    return vehicle_id is not None and vehicle_id.startswith("truck")


def _is_heli(vehicle_id: Optional[str]) -> bool:
    return vehicle_id is not None and vehicle_id.startswith("heli")


class GraphEngine:
    def __init__(self, nodes: list[Node], edges: list[Edge]):
        self.nodes = {n.id: n for n in nodes}
        self.edges = {e.id: e for e in edges}

        # Three separate graphs for fast mode-constrained routing
        self._graph_any      = nx.DiGraph()  # all open edges (helicopter)
        self._graph_road     = nx.DiGraph()  # road + bridge only, DRY (trucks)
        self._graph_water    = nx.DiGraph()  # water only + submerged_navigable (boats)
        self._build()

    def _build(self):
        for g in (self._graph_any, self._graph_road, self._graph_water):
            g.clear()
            for node_id in self.nodes:
                g.add_node(node_id)

        for edge in self.edges.values():
            props = dict(edge_id=edge.id, weight=edge.travel_time, risk=edge.risk)

            # --- Helicopter: all open edges (native water OR dry road OR submerged) ---
            if edge.open or edge.submerged_navigable:
                self._graph_any.add_edge(edge.source, edge.destination, **props)

            # --- Truck: ONLY dry open road/bridge edges (NOT submerged) ---
            if (
                edge.mode in (EdgeMode.ROAD, EdgeMode.BRIDGE)
                and edge.open
                and not edge.submerged_navigable
            ):
                self._graph_road.add_edge(edge.source, edge.destination, **props)

            # --- Boat: native water edges OR submerged_navigable road edges ---
            if edge.mode == EdgeMode.WATER and edge.open:
                self._graph_water.add_edge(edge.source, edge.destination, **props)
            elif edge.submerged_navigable:
                # Road that is now underwater — boats can sail over it
                self._graph_water.add_edge(edge.source, edge.destination, **props)

    def rebuild(self):
        """Call after closing/opening edges or after flood flip."""
        self._build()

    def _graph_for_vehicle(self, vehicle_id: Optional[str]) -> nx.DiGraph:
        """Pick the correct graph based on vehicle type (with amphibious awareness)."""
        if _is_boat(vehicle_id):
            return self._graph_water   # water + submerged_navigable
        if _is_truck(vehicle_id):
            return self._graph_road    # dry road only
        # Helicopter or unknown — any passable edge
        return self._graph_any

    def _graph_for_modes(self, allowed_modes: set[EdgeMode]) -> nx.DiGraph:
        """Backward-compat mode-set selection (used when vehicle_id not provided)."""
        if allowed_modes == {EdgeMode.WATER}:
            return self._graph_water
        if allowed_modes == {EdgeMode.ROAD, EdgeMode.BRIDGE}:
            return self._graph_road
        return self._graph_any

    def shortest_path(
        self,
        source: str,
        target: str,
        vehicle_id: Optional[str] = None,
        allowed_modes: Optional[set[EdgeMode]] = None,
        weight: str = "weight",
    ) -> Optional[list[str]]:
        """
        Returns list of node ids or None if no path exists.
        vehicle_id takes precedence over allowed_modes.
        """
        if vehicle_id is not None:
            graph = self._graph_for_vehicle(vehicle_id)
        elif allowed_modes is not None:
            graph = self._graph_for_modes(allowed_modes)
        else:
            graph = self._graph_any

        try:
            return nx.shortest_path(graph, source, target, weight=weight)
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            return None

    def path_travel_time(
        self,
        path: list[str],
        vehicle_id: Optional[str] = None,
    ) -> float:
        """Sum of edge weights along a node path."""
        graph = self._graph_for_vehicle(vehicle_id) if vehicle_id else self._graph_any

        total = 0.0
        for i in range(len(path) - 1):
            data = graph.get_edge_data(path[i], path[i + 1])
            if data is None:
                data = self._graph_any.get_edge_data(path[i], path[i + 1])
            if data is None:
                return float("inf")
            total += data["weight"]
        return total

    def path_exists(
        self,
        source: str,
        target: str,
        vehicle_id: Optional[str] = None,
    ) -> bool:
        return self.shortest_path(source, target, vehicle_id=vehicle_id) is not None

    def can_reach(
        self,
        source: str,
        target: str,
        vehicle_id: Optional[str] = None,
    ) -> bool:
        return self.path_exists(source, target, vehicle_id=vehicle_id)

    def close_edge(self, edge_id: str):
        edge = self.edges.get(edge_id)
        if edge:
            edge.open = False
            self.rebuild()

    def open_edge(self, edge_id: str):
        edge = self.edges.get(edge_id)
        if edge:
            edge.open = True
            self.rebuild()

    def close_edges_between(self, node_a: str, node_b: str):
        """Close all edges (both directions) between two nodes."""
        for edge in self.edges.values():
            if (edge.source == node_a and edge.destination == node_b) or \
               (edge.source == node_b and edge.destination == node_a):
                edge.open = False
        self.rebuild()

    def close_edge_ids(self, edge_ids: list[str]):
        """Close multiple edges at once, rebuild once."""
        for eid in edge_ids:
            e = self.edges.get(eid)
            if e:
                e.open = False
        self.rebuild()

    def uses_submerged_edge(self, path: list[str]) -> bool:
        """Return True if any edge on the path is submerged_navigable (amphibious route)."""
        for i in range(len(path) - 1):
            eid_fwd = self._edge_id(path[i], path[i + 1])
            eid_rev = self._edge_id(path[i + 1], path[i])
            for eid in (eid_fwd, eid_rev):
                if eid and self.edges.get(eid, None) and self.edges[eid].submerged_navigable:
                    return True
        return False

    def _edge_id(self, src: str, dst: str) -> Optional[str]:
        """Return edge id for a directed src→dst pair, or None."""
        for e in self.edges.values():
            if e.source == src and e.destination == dst:
                return e.id
        return None


# ---------------------------------------------------------------------------
# F1: Dead-trap lookahead for trucks
# ---------------------------------------------------------------------------

def check_path_dead_trap(
    world: "WorldState",
    path: list[str],
    vehicle_type: str,
    current_speed: float = 1.0,
) -> tuple[bool, Optional[str], Optional[int]]:
    """
    Only meaningful for 'truck' vehicles.

    Given a planned node path [n_0, n_1, ..., n_k], estimate arrival tick offset
    at each step (+2 buffer for loading/exiting). If any node or edge along the
    path has ticks_until_flooded <= estimated_arrival + 2, the path is a dead trap.

    Returns:
        (is_dead_trap: bool, blocking_id: Optional[str], ticks_until_flooded: Optional[int])
    """
    if vehicle_type != VehicleType.TRUCK and not str(vehicle_type).startswith("truck"):
        return False, None, None

    if not path or len(path) < 2:
        return False, None, None

    # Build node lookup
    node_map = {n.id: n for n in world.nodes}
    # Build edge lookup for forward direction
    edge_map: dict[tuple[str, str], "Edge"] = {}
    for e in world.edges:
        edge_map[(e.source, e.destination)] = e
        edge_map[(e.destination, e.source)] = e  # treat as bidirectional for lookup

    tick_offset = 0
    buffer = 2  # loading/exit buffer

    for i, node_id in enumerate(path):
        node = node_map.get(node_id)
        if node and node.ticks_until_flooded is not None:
            # Skip ttf=0: node already flooded — truck router won't find a path there
            # anyway (edge is closed). The veto is for IMMINENT future flooding (ttf >= 1).
            if node.ticks_until_flooded > 0 and node.ticks_until_flooded <= tick_offset + buffer:
                return True, node_id, node.ticks_until_flooded

        if i < len(path) - 1:
            edge = edge_map.get((path[i], path[i + 1]))
            if edge and edge.ticks_until_flooded is not None:
                # Same rule: skip 0 (already submerged, truck can't use it)
                if edge.ticks_until_flooded > 0 and edge.ticks_until_flooded <= tick_offset + buffer:
                    return True, edge.id, edge.ticks_until_flooded
            # Advance tick offset by travel time (default 1 tick per edge / speed)
            tick_offset += max(1, int(1.0 / max(current_speed, 0.01)))

    return False, None, None

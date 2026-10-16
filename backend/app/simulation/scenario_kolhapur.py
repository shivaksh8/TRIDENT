"""
Real Kolhapur scenario loader.
Loads OSM graph + IFI flood data into the simulation engine's model format.
Replaces the synthetic scenario with real geographic data.

Vehicle fleet for Kolhapur scenario:
  - 3 rescue boats  (water-only routing, capacity 12)
  - 2 rescue trucks (road-only routing, capacity 8)
  - 1 helicopter    (any-mode routing, capacity 20, fast)
"""

from __future__ import annotations
import json
import os
import random
from typing import Optional

from app.simulation.models import (
    Node, Edge, Boat, RescueRequest, Shelter,
    NodeType, EdgeMode, BoatStatus, RequestStatus, VehicleType,
)

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data")
GRAPH_PATH = os.path.join(DATA_DIR, "kolhapur_graph.json")
REQUESTS_PATH = os.path.join(DATA_DIR, "kolhapur_requests.json")
WEATHER_PATH = os.path.join(DATA_DIR, "weather_cache.json")

# Normalised coordinate space for the engine (0-100 grid)
# Graph JSON already has x/y in 0-100 space from the osm_loader
USE_LATLON = True  # use lat/lon directly in Node (x=lon, y=lat for Leaflet)


def _edge_mode(raw_mode: str) -> EdgeMode:
    if raw_mode == "water":
        return EdgeMode.WATER
    if raw_mode == "bridge":
        return EdgeMode.BRIDGE
    return EdgeMode.ROAD


def _node_type(raw_type: str) -> NodeType:
    if raw_type == "water":
        return NodeType.WATER
    if raw_type == "shelter":
        return NodeType.SHELTER
    if raw_type == "staging":
        return NodeType.STAGING
    return NodeType.LAND


def load_graph() -> tuple[list[Node], list[Edge]]:
    """Load OSM graph from JSON and convert to engine models."""
    with open(GRAPH_PATH) as f:
        graph = json.load(f)

    nodes = []
    for raw in graph["nodes"]:
        # Use lat/lon as y/x for the Leaflet map (x=lon, y=lat)
        nodes.append(Node(
            id=raw["id"],
            x=raw["lon"],
            y=raw["lat"],
            node_type=_node_type(raw.get("node_type", "road")),
            label=raw.get("label") or raw["id"],
            lat=raw["lat"],
            lon=raw["lon"],
            elevation=raw.get("elevation"),
            flood_risk=raw.get("flood_risk", False),
        ))

    edges = []
    for raw in graph["edges"]:
        edges.append(Edge(
            id=raw["id"],
            source=raw["source"],
            destination=raw["destination"],
            travel_time=raw["travel_time"],
            mode=_edge_mode(raw.get("mode", "road")),
            risk=raw.get("risk", 0.2),
            open=raw.get("open", True),
        ))

    return nodes, edges


def load_requests(nodes: list[Node], seed: int = 2019, max_requests: Optional[int] = None) -> list[RescueRequest]:
    """Load IFI rescue requests and snap to graph nodes."""
    with open(REQUESTS_PATH) as f:
        raw_requests = json.load(f)

    rng = random.Random(seed)

    # Build node lookup by id
    node_ids = {n.id for n in nodes}

    req_slice = raw_requests[:max_requests] if max_requests is not None else raw_requests
    requests = []
    for i, raw in enumerate(req_slice):
        node_id = raw.get("node_id")
        if node_id not in node_ids:
            # Snap to any available node (fallback)
            node_id = list(node_ids)[i % len(node_ids)]

        requests.append(RescueRequest(
            id=raw["id"],
            location=node_id,
            people=raw["people"],
            urgency=int(raw["urgency"] * 10),  # convert 0-1 float to 1-10 int
            neighbourhood=raw.get("tehsil", "Karvir"),
            uncertainty=raw.get("uncertainty", 0.1),
            status=RequestStatus.WAITING,
        ))

    return requests


def place_boats(nodes: list[Node], seed: int = 2019) -> list[Boat]:
    """
    Place rescue fleet at realistic Kolhapur locations.
    Boats start on water nodes (Panchaganga/Bhogawati river).
    Trucks start on road nodes near flood-affected areas.
    Helicopter starts at a central road node (makeshift helipad).
    """
    rng = random.Random(seed)

    water_nodes = [n for n in nodes if n.node_type == NodeType.WATER]
    road_nodes = [n for n in nodes if n.node_type == NodeType.LAND]

    if not water_nodes:
        water_nodes = road_nodes  # fallback

    # Sort water nodes by id for reproducibility
    water_nodes_sorted = sorted(water_nodes, key=lambda n: n.id)
    road_nodes_sorted = sorted(road_nodes, key=lambda n: n.id)

    def pick(lst, idx):
        return lst[idx % len(lst)].id

    boats = [
        # Rescue boats on the Panchaganga river (NDRF motorised boat flotillas)
        Boat(id="boat_1", location=pick(water_nodes_sorted, 0),
             capacity=2500, speed=1.0,
             status=BoatStatus.IDLE, vehicle_type=VehicleType.BOAT),
        Boat(id="boat_2", location=pick(water_nodes_sorted, 3),
             capacity=2500, speed=1.0,
             status=BoatStatus.IDLE, vehicle_type=VehicleType.BOAT),
        Boat(id="boat_3", location=pick(water_nodes_sorted, 6),
             capacity=2200, speed=1.2,
             status=BoatStatus.IDLE, vehicle_type=VehicleType.BOAT),
        # Rescue trucks on road network (Army evacuation columns)
        Boat(id="truck_1", location=pick(road_nodes_sorted, 10),
             capacity=2000, speed=0.9,
             status=BoatStatus.IDLE, vehicle_type=VehicleType.TRUCK),
        Boat(id="truck_2", location=pick(road_nodes_sorted, 40),
             capacity=2000, speed=0.9,
             status=BoatStatus.IDLE, vehicle_type=VehicleType.TRUCK),
        # Helicopter (IAF Heavy Airlift Squadron)
        Boat(id="heli_1", location=pick(road_nodes_sorted, 20),
             capacity=3000, speed=2.0,
             status=BoatStatus.IDLE, vehicle_type=VehicleType.HELICOPTER),
    ]
    return boats


def place_shelters(nodes: list[Node]) -> list[Shelter]:
    """
    Place shelters at elevated, road-accessible Kolhapur locations.
    Real 2019 relief camps: Rajaram College, Shahu Stadium, DY Patil College.
    Snapped to nearest road node in the graph.
    """
    # Real relief camp locations (2019 Kolhapur flood)
    relief_camps = [
        ("shelter_rajaram",  "Rajaram College",   16.7021, 74.2489, 35000),
        ("shelter_stadium",  "Shahu Stadium",      16.6981, 74.2312, 30000),
        ("shelter_dypatil",  "DY Patil College",  16.7289, 74.2401, 25000),
    ]

    road_nodes = [n for n in nodes if n.node_type == NodeType.LAND]

    def nearest_road_node(lat: float, lon: float) -> str:
        best = min(road_nodes, key=lambda n: (n.y - lat)**2 + (n.x - lon)**2)
        return best.id

    shelters = []
    for sid, name, lat, lon, cap in relief_camps:
        node_id = nearest_road_node(lat, lon)
        shelters.append(Shelter(
            id=sid,
            location=node_id,
            total_capacity=cap,
            occupied=0,
        ))
    return shelters


def get_weather_severity() -> str:
    """Read severity from weather cache. Returns 'low'|'moderate'|'severe'|'extreme'."""
    try:
        with open(WEATHER_PATH) as f:
            weather = json.load(f)
        return weather.get("summary", {}).get("scenario_severity", "severe")
    except Exception:
        return "severe"  # default to severe for demo


def get_flood_spread_ticks() -> int:
    """How many ticks between flood ring expansions. 0 = no spread."""
    try:
        with open(WEATHER_PATH) as f:
            weather = json.load(f)
        ticks = weather.get("summary", {}).get("flood_spread_ticks", 3)
        # For demo: if weather is actually 'low' (October), use 'severe' scenario
        severity = weather.get("summary", {}).get("scenario_severity", "severe")
        if severity == "low":
            return 3  # force severe scenario for the demo
        return ticks
    except Exception:
        return 3


def generate_kolhapur_scenario(seed: int = 2019, max_requests: Optional[int] = None) -> dict:
    """
    Main entry point. Returns dict compatible with the simulation engine.
    Same interface as scenario.generate_scenario().
    """
    nodes, edges = load_graph()
    requests = load_requests(nodes, seed=seed, max_requests=max_requests)
    boats = place_boats(nodes, seed=seed)
    shelters = place_shelters(nodes)

    print(f"[Kolhapur scenario] {len(nodes)} nodes, {len(edges)} edges, "
          f"{len(boats)} vehicles, {len(requests)} requests, {len(shelters)} shelters")
    print(f"[Kolhapur scenario] Weather severity: {get_weather_severity()}, "
          f"flood spread every {get_flood_spread_ticks()} ticks")

    return {
        "nodes": nodes,
        "edges": edges,
        "boats": boats,
        "requests": requests,
        "shelters": shelters,
    }

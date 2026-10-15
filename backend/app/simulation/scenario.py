"""
Synthetic flood scenario generator.
Creates a realistic-looking flood-affected river-town graph with boats,
rescue requests and shelters — all reproducible from a random seed.
"""

from __future__ import annotations
import random
import uuid
from app.simulation.models import (
    Node, Edge, Boat, RescueRequest, Shelter,
    NodeType, EdgeMode, BoatStatus, RequestStatus
)


def generate_scenario(seed: int = 42) -> dict:
    """
    Returns a dict with keys: nodes, edges, boats, requests, shelters.
    All IDs are stable for a given seed.
    """
    rng = random.Random(seed)

    # -----------------------------------------------------------------------
    # Graph layout — 20 nodes arranged as a river-town
    # River runs horizontally; roads cross it via bridges
    # -----------------------------------------------------------------------
    node_defs = [
        # River nodes (water edges)
        ("river_w",   10.0, 50.0, NodeType.WATER,   "West River"),
        ("river_cw",  25.0, 50.0, NodeType.WATER,   "River Centre-West"),
        ("river_c",   40.0, 50.0, NodeType.WATER,   "River Centre"),
        ("river_ce",  55.0, 50.0, NodeType.WATER,   "River Centre-East"),
        ("river_e",   70.0, 50.0, NodeType.WATER,   "East River"),

        # North bank — residential areas
        ("north_a",   15.0, 65.0, NodeType.LAND,    "North A"),
        ("north_b",   30.0, 68.0, NodeType.LAND,    "North B"),
        ("north_c",   45.0, 65.0, NodeType.LAND,    "North C"),
        ("north_d",   60.0, 67.0, NodeType.LAND,    "North D"),

        # South bank — residential + staging
        ("south_a",   15.0, 35.0, NodeType.LAND,    "South A"),
        ("south_b",   30.0, 32.0, NodeType.LAND,    "South B"),
        ("south_c",   45.0, 35.0, NodeType.LAND,    "South C"),
        ("south_d",   60.0, 33.0, NodeType.LAND,    "South D"),

        # Bridges (crossings)
        ("bridge_w",  17.0, 50.0, NodeType.LAND,    "West Bridge"),
        ("bridge_c",  42.0, 50.0, NodeType.LAND,    "Central Bridge"),
        ("bridge_e",  62.0, 50.0, NodeType.LAND,    "East Bridge"),

        # Shelters (elevated, accessible)
        ("shelter_1", 20.0, 72.0, NodeType.SHELTER, "Highland School"),
        ("shelter_2", 65.0, 28.0, NodeType.SHELTER, "Stadium"),

        # Staging areas (where rescue boats launch from)
        ("staging_w", 10.0, 50.0, NodeType.STAGING, "West Staging"),
        ("staging_e", 70.0, 50.0, NodeType.STAGING, "East Staging"),
    ]

    nodes = [
        Node(id=nid, x=x, y=y, node_type=ntype, label=label)
        for nid, x, y, ntype, label in node_defs
    ]

    # -----------------------------------------------------------------------
    # Edges
    # -----------------------------------------------------------------------
    edge_defs = [
        # River channel (water, fast)
        ("river_w",   "river_cw",  2.0, EdgeMode.WATER,  0.1),
        ("river_cw",  "river_c",   2.0, EdgeMode.WATER,  0.1),
        ("river_c",   "river_ce",  2.0, EdgeMode.WATER,  0.15),
        ("river_ce",  "river_e",   2.0, EdgeMode.WATER,  0.1),

        # North bank roads
        ("north_a",   "north_b",   3.0, EdgeMode.ROAD,   0.3),
        ("north_b",   "north_c",   3.0, EdgeMode.ROAD,   0.3),
        ("north_c",   "north_d",   3.0, EdgeMode.ROAD,   0.25),
        ("north_a",   "shelter_1", 2.0, EdgeMode.ROAD,   0.1),
        ("north_b",   "shelter_1", 2.5, EdgeMode.ROAD,   0.1),

        # South bank roads
        ("south_a",   "south_b",   3.0, EdgeMode.ROAD,   0.3),
        ("south_b",   "south_c",   3.0, EdgeMode.ROAD,   0.35),
        ("south_c",   "south_d",   3.0, EdgeMode.ROAD,   0.25),
        ("south_d",   "shelter_2", 2.0, EdgeMode.ROAD,   0.1),

        # Bridge crossings (flood risk)
        ("bridge_w",  "north_a",   2.0, EdgeMode.BRIDGE, 0.4),
        ("bridge_w",  "south_a",   2.0, EdgeMode.BRIDGE, 0.4),
        ("river_w",   "bridge_w",  1.0, EdgeMode.WATER,  0.2),
        ("bridge_c",  "north_c",   2.0, EdgeMode.BRIDGE, 0.5),
        ("bridge_c",  "south_c",   2.0, EdgeMode.BRIDGE, 0.5),
        ("river_c",   "bridge_c",  1.0, EdgeMode.WATER,  0.2),
        ("bridge_e",  "north_d",   2.0, EdgeMode.BRIDGE, 0.45),
        ("bridge_e",  "south_d",   2.0, EdgeMode.BRIDGE, 0.45),
        ("river_e",   "bridge_e",  1.0, EdgeMode.WATER,  0.2),

        # Staging to river access
        ("staging_w", "river_w",   1.0, EdgeMode.WATER,  0.05),
        ("staging_e", "river_e",   1.0, EdgeMode.WATER,  0.05),

        # River to bank access (boats can pull to shore)
        ("river_cw",  "north_b",   2.5, EdgeMode.WATER,  0.2),
        ("river_cw",  "south_b",   2.5, EdgeMode.WATER,  0.2),
        ("river_ce",  "north_d",   2.5, EdgeMode.WATER,  0.2),
        ("river_ce",  "south_d",   2.5, EdgeMode.WATER,  0.2),
        ("river_c",   "north_c",   2.0, EdgeMode.WATER,  0.25),
        ("river_c",   "south_c",   2.0, EdgeMode.WATER,  0.25),
        # West and east bank access
        ("river_w",   "north_a",   2.5, EdgeMode.WATER,  0.2),
        ("river_w",   "south_a",   2.5, EdgeMode.WATER,  0.2),
        ("river_e",   "north_d",   2.5, EdgeMode.WATER,  0.2),
        ("river_e",   "south_d",   2.5, EdgeMode.WATER,  0.2),
        # Shelters accessible by road from nearby nodes
        ("north_c",   "shelter_1", 3.0, EdgeMode.ROAD,   0.15),
        ("south_d",   "shelter_2", 2.5, EdgeMode.ROAD,   0.15),
        ("south_c",   "shelter_2", 3.5, EdgeMode.ROAD,   0.2),
    ]

    edges = []
    for i, (src, dst, tt, mode, risk) in enumerate(edge_defs):
        edges.append(Edge(
            id=f"e{i:03d}",
            source=src,
            destination=dst,
            travel_time=tt,
            mode=mode,
            risk=risk,
            open=True
        ))
        # undirected — add reverse
        edges.append(Edge(
            id=f"e{i:03d}r",
            source=dst,
            destination=src,
            travel_time=tt,
            mode=mode,
            risk=risk,
            open=True
        ))

    # -----------------------------------------------------------------------
    # Boats — 5 boats, start at staging areas and river nodes
    # -----------------------------------------------------------------------
    boat_starts = ["staging_w", "river_cw", "river_c", "river_ce", "staging_e"]
    boats = [
        Boat(
            id=f"boat_{i+1}",
            location=boat_starts[i],
            capacity=rng.choice([8, 10, 12]),
            speed=rng.uniform(0.8, 1.2)
        )
        for i in range(5)
    ]

    # -----------------------------------------------------------------------
    # Rescue requests — 10 requests across residential nodes
    # -----------------------------------------------------------------------
    residential = ["north_a", "north_b", "north_c", "north_d",
                   "south_a", "south_b", "south_c", "south_d"]
    neighbourhoods = {
        "north_a": "North", "north_b": "North", "north_c": "North", "north_d": "North",
        "south_a": "South", "south_b": "South", "south_c": "South", "south_d": "South",
    }
    requests = []
    for i in range(10):
        loc = rng.choice(residential)
        requests.append(RescueRequest(
            id=f"req_{i+1:02d}",
            location=loc,
            people=rng.randint(2, 12),
            urgency=rng.randint(3, 10),
            neighbourhood=neighbourhoods[loc],
            uncertainty=round(rng.uniform(0.0, 0.3), 2)
        ))

    # -----------------------------------------------------------------------
    # Shelters — 2 shelters
    # -----------------------------------------------------------------------
    shelters = [
        Shelter(id="shelter_1", location="shelter_1", total_capacity=80),
        Shelter(id="shelter_2", location="shelter_2", total_capacity=80),
    ]

    return {
        "nodes": nodes,
        "edges": edges,
        "boats": boats,
        "requests": requests,
        "shelters": shelters,
    }

"""
Step 1: OSM Graph Pipeline
Pulls Kolhapur district road network + Panchaganga river waterways from OSM.
Converts to FloodOps Node/Edge format with mode field (road/water).
Outputs: data/kolhapur_graph.json
"""

import json
import math
import os
import sys
import requests

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "kolhapur_graph.json")

# Kolhapur district bounding box (south, west, north, east)
BBOX = (16.55, 74.0, 16.85, 74.35)

# Coordinate normalisation target (map to 0-100 space for engine)
LAT_MIN, LAT_MAX = BBOX[0], BBOX[2]
LON_MIN, LON_MAX = BBOX[1], BBOX[3]


def latlon_to_xy(lat: float, lon: float) -> tuple[float, float]:
    x = (lon - LON_MIN) / (LON_MAX - LON_MIN) * 100
    y = (lat - LAT_MIN) / (LAT_MAX - LAT_MIN) * 100
    return round(x, 4), round(y, 4)


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))


OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]


def fetch_overpass(query: str) -> dict:
    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            resp = requests.post(
                endpoint,
                data={"data": query},
                headers={"User-Agent": "FloodOps-HackathonProject/1.0 (educational use)"},
                timeout=60,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"  Mirror {endpoint} failed: {e}")
            last_err = e
    raise RuntimeError(f"All Overpass mirrors failed. Last error: {last_err}")


def build_graph() -> dict:
    south, west, north, east = BBOX
    bbox_str = f"{south},{west},{north},{east}"

    print("Fetching road network from Overpass API...")
    road_query = f"""
[out:json][timeout:60];
(
  way["highway"~"primary|secondary|tertiary|residential|trunk"]({bbox_str});
);
out geom;
"""
    road_data = fetch_overpass(road_query)

    print("Fetching waterways from Overpass API...")
    water_query = f"""
[out:json][timeout:60];
(
  way["waterway"~"river|canal|stream"]({bbox_str});
);
out geom;
"""
    water_data = fetch_overpass(water_query)

    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    edge_id_counter = [0]

    def next_edge_id():
        edge_id_counter[0] += 1
        return f"e{edge_id_counter[0]:04d}"

    def add_node(lat: float, lon: float, node_type: str, label: str = "") -> str:
        # Key by rounded coord to merge near-duplicates
        key = f"{round(lat, 4)}_{round(lon, 4)}"
        if key not in nodes:
            x, y = latlon_to_xy(lat, lon)
            node_id = f"n{len(nodes):04d}"
            nodes[key] = {
                "id": node_id,
                "lat": lat,
                "lon": lon,
                "x": x,
                "y": y,
                "node_type": node_type,
                "label": label,
                "_key": key,
            }
        return nodes[key]["id"]

    def get_node_id(lat: float, lon: float) -> str | None:
        key = f"{round(lat, 4)}_{round(lon, 4)}"
        return nodes[key]["id"] if key in nodes else None

    # Process roads
    print(f"  {len(road_data.get('elements', []))} road ways found")
    for way in road_data.get("elements", []):
        if way.get("type") != "way" or not way.get("geometry"):
            continue
        geom = way["geometry"]
        highway = way.get("tags", {}).get("highway", "road")
        risk = 0.1 if highway in ("trunk", "primary") else 0.2 if highway == "secondary" else 0.3

        # Sample every Nth point to keep graph manageable
        step = max(1, len(geom) // 3)
        sampled = [geom[0]] + geom[step::step]
        if geom[-1] not in sampled:
            sampled.append(geom[-1])

        for i, pt in enumerate(sampled):
            add_node(pt["lat"], pt["lon"], "road", "")

        for i in range(len(sampled) - 1):
            a, b = sampled[i], sampled[i+1]
            aid = get_node_id(a["lat"], a["lon"])
            bid = get_node_id(b["lat"], b["lon"])
            if aid and bid and aid != bid:
                dist = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
                travel_time = round(dist / 30 * 60, 2)  # 30 km/h → minutes
                edges.append({
                    "id": next_edge_id(),
                    "source": aid,
                    "destination": bid,
                    "travel_time": max(1, travel_time),
                    "mode": "road",
                    "risk": risk,
                    "open": True,
                    "lat_a": a["lat"], "lon_a": a["lon"],
                    "lat_b": b["lat"], "lon_b": b["lon"],
                })

    # Process waterways
    print(f"  {len(water_data.get('elements', []))} waterway ways found")
    for way in water_data.get("elements", []):
        if way.get("type") != "way" or not way.get("geometry"):
            continue
        geom = way["geometry"]
        wtype = way.get("tags", {}).get("waterway", "river")
        risk = 0.15 if wtype == "river" else 0.25

        step = max(1, len(geom) // 3)
        sampled = [geom[0]] + geom[step::step]
        if geom[-1] not in sampled:
            sampled.append(geom[-1])

        for pt in sampled:
            add_node(pt["lat"], pt["lon"], "water", "")

        for i in range(len(sampled) - 1):
            a, b = sampled[i], sampled[i+1]
            aid = get_node_id(a["lat"], a["lon"])
            bid = get_node_id(b["lat"], b["lon"])
            if aid and bid and aid != bid:
                dist = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
                travel_time = round(dist / 15 * 60, 2)  # 15 km/h for boats
                edges.append({
                    "id": next_edge_id(),
                    "source": aid,
                    "destination": bid,
                    "travel_time": max(1, travel_time),
                    "mode": "water",
                    "risk": risk,
                    "open": True,
                    "lat_a": a["lat"], "lon_a": a["lon"],
                    "lat_b": b["lat"], "lon_b": b["lon"],
                })

    # Thin graph: keep only nodes referenced by edges + largest connected subgraph
    referenced = set()
    for e in edges:
        referenced.add(e["source"])
        referenced.add(e["destination"])

    node_list = [n for n in nodes.values() if n["id"] in referenced]

    # Label road vs water nodes
    water_node_ids = set()
    for e in edges:
        if e["mode"] == "water":
            water_node_ids.add(e["source"])
            water_node_ids.add(e["destination"])

    for n in node_list:
        if n["id"] in water_node_ids:
            n["node_type"] = "water"
        # Remove internal key
        n.pop("_key", None)

    # Limit to at most 200 nodes (keep by connectivity — most-connected first)
    if len(node_list) > 200:
        degree: dict[str, int] = {}
        for e in edges:
            degree[e["source"]] = degree.get(e["source"], 0) + 1
            degree[e["destination"]] = degree.get(e["destination"], 0) + 1
        node_list = sorted(node_list, key=lambda n: -degree.get(n["id"], 0))[:200]
        kept_ids = {n["id"] for n in node_list}
        edges = [e for e in edges if e["source"] in kept_ids and e["destination"] in kept_ids]

    # Deduplicate edges
    seen_pairs: set[tuple] = set()
    deduped_edges = []
    for e in edges:
        pair = (min(e["source"], e["destination"]), max(e["source"], e["destination"]))
        if pair not in seen_pairs:
            seen_pairs.add(pair)
            deduped_edges.append(e)

    print(f"  Graph: {len(node_list)} nodes, {len(deduped_edges)} edges")
    print(f"  Road edges: {sum(1 for e in deduped_edges if e['mode']=='road')}")
    print(f"  Water edges: {sum(1 for e in deduped_edges if e['mode']=='water')}")

    return {
        "district": "Kolhapur",
        "state": "Maharashtra",
        "bbox": {"south": south, "west": west, "north": north, "east": east},
        "nodes": node_list,
        "edges": deduped_edges,
        "meta": {
            "road_nodes": sum(1 for n in node_list if n["node_type"] == "road"),
            "water_nodes": sum(1 for n in node_list if n["node_type"] == "water"),
            "road_edges": sum(1 for e in deduped_edges if e["mode"] == "road"),
            "water_edges": sum(1 for e in deduped_edges if e["mode"] == "water"),
        }
    }


if __name__ == "__main__":
    graph = build_graph()
    with open(OUTPUT_PATH, "w") as f:
        json.dump(graph, f, indent=2)
    print(f"\nSaved to {OUTPUT_PATH}")
    print(f"Nodes: {graph['meta']['road_nodes']} road + {graph['meta']['water_nodes']} water")
    print(f"Edges: {graph['meta']['road_edges']} road + {graph['meta']['water_edges']} water")

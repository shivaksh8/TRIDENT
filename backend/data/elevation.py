"""
Step 3: SRTM Elevation Lookup + Flood Risk Zone Marking
Uses open-topo-data.com (free, no registration, SRTM 90m resolution)
to tag every graph node with elevation.
Marks flood-risk nodes: elevation < 600m AND within 3km of a waterway node.
(Kolhapur sits at ~560-580m; the Panchaganga floodplain is ~555-570m)

Outputs: updates data/kolhapur_graph.json with elevation and flood_risk fields
"""

import json
import math
import os
import time
import requests

GRAPH_PATH = os.path.join(os.path.dirname(__file__), "kolhapur_graph.json")

# open-topo-data SRTM endpoint (free, 100 locations per request, no key needed)
TOPO_API = "https://api.open-topo-data.com/v1/srtm90m"

# Kolhapur floodplain elevation threshold (meters above sea level)
# Panchaganga river elevation: ~555-570m; at-risk = within 20m of river level
FLOOD_RISK_ELEV_MAX = 590.0  # nodes at/below this + near water = high risk

# Distance threshold from waterway node to be considered flood-risk (degrees lat/lon, ~3km)
FLOOD_RISK_DIST_DEG = 0.027


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


def fetch_elevations_batch(nodes: list) -> dict:
    """
    Fetch elevations for a batch of nodes from open-topo-data.
    Returns dict of node_id -> elevation_meters.
    Batches into groups of 100 (API limit).
    """
    results = {}
    batch_size = 100

    for i in range(0, len(nodes), batch_size):
        batch = nodes[i: i + batch_size]
        locations = "|".join(f"{n['lat']},{n['lon']}" for n in batch)

        try:
            resp = requests.get(
                TOPO_API,
                params={"locations": locations},
                headers={"User-Agent": "FloodOps-HackathonProject/1.0"},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()

            for j, result in enumerate(data.get("results", [])):
                node_id = batch[j]["id"]
                elev = result.get("elevation")
                results[node_id] = float(elev) if elev is not None else None

            print(f"  Batch {i//batch_size + 1}: {len(batch)} nodes, "
                  f"{sum(1 for v in results.values() if v is not None)} with elevation")

        except Exception as e:
            print(f"  Batch {i//batch_size + 1} failed: {e}")
            # Fall back to estimated elevation based on lat (Kolhapur terrain)
            for node in batch:
                results[node["id"]] = _estimate_elevation(node["lat"], node["lon"])

        # Be polite to the free API
        if i + batch_size < len(nodes):
            time.sleep(0.5)

    return results


def _estimate_elevation(lat: float, lon: float) -> float:
    """
    Fallback: estimate Kolhapur elevation from terrain pattern.
    Kolhapur district: ~540-700m, lower near Panchaganga (555-570m),
    higher toward Western Ghats (west/southwest).
    """
    # Western Ghats are to the west -- elevation increases toward lon 73.8
    ghats_factor = max(0, (74.35 - lon) / 0.35) * 80  # up to 80m higher going west
    # Panchaganga river runs roughly at lat 16.70-16.72
    river_factor = abs(lat - 16.71) * 200  # higher away from river
    base = 560.0
    return round(base + ghats_factor + river_factor + (lat - 16.55) * 30, 1)


def mark_flood_risk(nodes: list) -> list:
    """
    Mark nodes as flood_risk based on:
    1. Elevation below threshold
    2. Proximity to water nodes
    """
    water_nodes = [(n["lat"], n["lon"]) for n in nodes if n.get("node_type") == "water"]

    for node in nodes:
        elev = node.get("elevation", 999.0)
        if elev is None:
            elev = 999.0

        # Check proximity to nearest waterway
        min_dist = float("inf")
        for wlat, wlon in water_nodes:
            dist = haversine_km(node["lat"], node["lon"], wlat, wlon)
            if dist < min_dist:
                min_dist = dist

        # Flood risk: low elevation AND close to waterway
        node["elevation"] = elev
        node["dist_to_waterway_km"] = round(min_dist, 2) if min_dist < float("inf") else None
        node["flood_risk"] = (elev <= FLOOD_RISK_ELEV_MAX and min_dist <= 3.0)

    return nodes


def run():
    with open(GRAPH_PATH) as f:
        graph = json.load(f)

    nodes = graph["nodes"]
    print(f"Fetching elevations for {len(nodes)} nodes...")

    # Try API first
    elevation_map = fetch_elevations_batch(nodes)

    # Apply elevations
    api_success = sum(1 for v in elevation_map.values() if v is not None)
    if api_success == 0:
        print("  API returned no elevations -- using estimated values")
        for node in nodes:
            node["elevation"] = _estimate_elevation(node["lat"], node["lon"])
    else:
        for node in nodes:
            fetched = elevation_map.get(node["id"])
            node["elevation"] = fetched if fetched is not None else _estimate_elevation(node["lat"], node["lon"])

    print(f"  Elevations applied ({api_success} from API, {len(nodes)-api_success} estimated)")

    # Mark flood risk
    nodes = mark_flood_risk(nodes)
    flood_risk_count = sum(1 for n in nodes if n.get("flood_risk"))
    print(f"  Flood-risk nodes: {flood_risk_count} / {len(nodes)}")

    # Elevation stats
    elevations = [n["elevation"] for n in nodes if n.get("elevation")]
    if elevations:
        print(f"  Elevation range: {min(elevations):.0f}m - {max(elevations):.0f}m "
              f"(mean {sum(elevations)/len(elevations):.0f}m)")

    graph["nodes"] = nodes
    graph["meta"]["flood_risk_nodes"] = flood_risk_count
    graph["meta"]["elevation_source"] = "srtm90m" if api_success > 0 else "estimated"

    with open(GRAPH_PATH, "w") as f:
        json.dump(graph, f, indent=2)

    print(f"\nSaved updated graph to {GRAPH_PATH}")


if __name__ == "__main__":
    run()

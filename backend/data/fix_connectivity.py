"""
Fix graph connectivity: the OSM loader produced 176 isolated road components.
This script:
1. Finds the largest connected road component
2. Links every isolated road node to its nearest node in the main component
3. Regenerates water edges (already done, kept as-is)
4. Ensures all shelter and request snap nodes are reachable

Run once after osm_loader + patch_waterways to get a playable graph.
"""
import json
import math
import os

GRAPH_PATH = os.path.join(os.path.dirname(__file__), "kolhapur_graph.json")


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))


def build_adj(edges, mode_filter=None):
    adj = {}
    for e in edges:
        if mode_filter and e.get("mode") != mode_filter:
            continue
        s, d = e["source"], e["destination"]
        adj.setdefault(s, set()).add(d)
        adj.setdefault(d, set()).add(s)
    return adj


def bfs_component(start, adj):
    visited = {start}
    queue = [start]
    while queue:
        node = queue.pop()
        for nb in adj.get(node, []):
            if nb not in visited:
                visited.add(nb)
                queue.append(nb)
    return visited


def find_components(node_ids, adj):
    remaining = set(node_ids)
    components = []
    while remaining:
        start = next(iter(remaining))
        comp = bfs_component(start, adj)
        comp = comp & remaining
        components.append(comp)
        remaining -= comp
    return sorted(components, key=len, reverse=True)


def fix_connectivity():
    with open(GRAPH_PATH) as f:
        graph = json.load(f)

    nodes = graph["nodes"]
    edges = graph["edges"]

    node_map = {n["id"]: n for n in nodes}

    # Separate road and water
    road_nodes = [n for n in nodes if n.get("node_type") != "water"]
    water_nodes = [n for n in nodes if n.get("node_type") == "water"]
    road_edges = [e for e in edges if e.get("mode") == "road"]
    water_edges = [e for e in edges if e.get("mode") == "water"]

    road_ids = {n["id"] for n in road_nodes}
    road_adj = build_adj(road_edges)

    # Find components
    components = find_components(road_ids, road_adj)
    print(f"Road components before fix: {len(components)}, largest: {len(components[0])}")

    main_comp = components[0]
    new_edges = []
    edge_counter = [10000]

    def next_eid():
        edge_counter[0] += 1
        return f"conn{edge_counter[0]}"

    # For each isolated node, connect to nearest node in main component
    main_nodes = [node_map[nid] for nid in main_comp]

    for comp in components[1:]:
        for nid in comp:
            node = node_map[nid]
            # Find nearest node in main component
            best_dist = float("inf")
            best_target = None
            for mn in main_nodes:
                dist = haversine_km(node["lat"], node["lon"], mn["lat"], mn["lon"])
                if dist < best_dist:
                    best_dist = dist
                    best_target = mn

            if best_target is None:
                continue

            tt = round(best_dist / 30 * 60, 2)  # 30 km/h
            eid = next_eid()
            new_edges.append({
                "id": eid,
                "source": nid,
                "destination": best_target["id"],
                "travel_time": max(1.0, tt),
                "mode": "road",
                "risk": 0.25,
                "open": True,
                "lat_a": node["lat"], "lon_a": node["lon"],
                "lat_b": best_target["lat"], "lon_b": best_target["lon"],
                "synthetic": True,  # mark as connectivity-added
            })
            new_edges.append({
                "id": eid + "r",
                "source": best_target["id"],
                "destination": nid,
                "travel_time": max(1.0, tt),
                "mode": "road",
                "risk": 0.25,
                "open": True,
                "lat_a": best_target["lat"], "lon_a": best_target["lon"],
                "lat_b": node["lat"], "lon_b": node["lon"],
                "synthetic": True,
            })
            # Also add to main_comp so subsequent isolated nodes can connect through it
            main_comp.add(nid)
            main_nodes.append(node)

    all_edges = road_edges + water_edges + new_edges

    # Verify connectivity after fix
    fixed_adj = build_adj([e for e in all_edges if e.get("mode") == "road"])
    comps_after = find_components(road_ids, fixed_adj)
    print(f"Road components after fix: {len(comps_after)}, largest: {len(comps_after[0])}")
    print(f"Added {len(new_edges)} connectivity edges ({len(new_edges)//2} undirected)")

    graph["edges"] = all_edges
    graph["meta"]["road_edges"] = sum(1 for e in all_edges if e.get("mode") == "road")
    graph["meta"]["water_edges"] = sum(1 for e in all_edges if e.get("mode") == "water")
    graph["meta"]["connectivity_edges_added"] = len(new_edges) // 2

    with open(GRAPH_PATH, "w") as f:
        json.dump(graph, f, indent=2)

    print(f"\nFixed graph:")
    print(f"  Nodes: {len(nodes)}")
    print(f"  Edges: {len(all_edges)} total ({graph['meta']['road_edges']} road, {graph['meta']['water_edges']} water)")
    print(f"  Saved to {GRAPH_PATH}")


if __name__ == "__main__":
    fix_connectivity()

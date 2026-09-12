"""Build the street layer: a routable road graph from NYC's street centerlines,
driving paths for every significant taxi-zone pair, and the bridge / tunnel
geometry that gives the surface layer its third dimension.

Source: NYC Open Data "Centerline" (CSCL, dataset inkn-q76z) - 122k roadbed
segments with travel direction, roadway type (street / highway / bridge / tunnel
/ ramp ...), posted speed and *level codes* that say whether a segment is at,
above or below street level. Download once (≈50 MB):

  https://data.cityofnewyork.us/resource/inkn-q76z.json?$limit=130000&$select=
    the_geom,physicalid,trafdir,rw_type,posted_speed,from_level_code,to_level_code,
    full_street_name,segmentlength,boroughcode,number_travel_lanes,streetwidth,status

Outputs (data/streets/):
  streets.bin        all drivable centerlines as one binary PathLayer buffer
                     (uint32 header, uint32 start indices, float32 lon/lat/z)
  crossings.json     bridges, tunnels and elevated ramps as GeoJSON with z
  paths.npy          float32 [N, 3] lon/lat/z vertices of all routed taxi paths
  paths_index.json   "pu-do" -> [[offset, length], ...] one entry per variant

Usage:
  python scripts/build_streets.py               # uses data/streets/cscl.json (downloads if missing)
  python scripts/build_streets.py --min-trips 40 --variants 3
"""
from __future__ import annotations

import argparse
import json
import math
import random
import struct
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import requests
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from subway.geo import M_PER_DEG_LAT, M_PER_DEG_LON, simplify, to_xy  # noqa: E402

DATA = ROOT / "data"
STREETS = DATA / "streets"
CSCL = STREETS / "cscl.json"
CSCL_URL = (
    "https://data.cityofnewyork.us/resource/inkn-q76z.json?$limit=130000&$select="
    "the_geom,physicalid,trafdir,rw_type,posted_speed,from_level_code,to_level_code,"
    "full_street_name,segmentlength,boroughcode,number_travel_lanes,streetwidth,status"
)

RW_STREET, RW_HIGHWAY, RW_BRIDGE, RW_TUNNEL, RW_RAMP = "1", "2", "3", "4", "9"
DRIVABLE = {RW_STREET, RW_HIGHWAY, RW_BRIDGE, RW_TUNNEL, RW_RAMP}
DEFAULT_MPH = {RW_STREET: 25, RW_HIGHWAY: 50, RW_BRIDGE: 35, RW_TUNNEL: 35, RW_RAMP: 30}
INTERSECTION_PENALTY_S = {RW_STREET: 9.0, RW_HIGHWAY: 0.0, RW_BRIDGE: 1.0, RW_TUNNEL: 1.0, RW_RAMP: 2.0}
GROUND_LEVEL = 13  # CSCL level code for street level; each step of 4 is one level up/down
M_PER_LEVEL = 9.0
ANCHORS_PER_ZONE = 3
SIMPLIFY_M = 5.0


def level_z(code: str | None, rw_type: str) -> float:
    try:
        lvl = int(code)
    except (TypeError, ValueError):
        lvl = GROUND_LEVEL
    z = (lvl - GROUND_LEVEL) / 4 * M_PER_LEVEL
    if rw_type == RW_TUNNEL:
        z = min(z, -12.0)
    elif rw_type == RW_BRIDGE:
        z = max(z, 8.0)
    return round(z, 1)


def load_cscl() -> list[dict]:
    if not CSCL.exists():
        STREETS.mkdir(parents=True, exist_ok=True)
        print("downloading NYC street centerlines (≈50 MB) ...", flush=True)
        resp = requests.get(CSCL_URL, timeout=900)
        resp.raise_for_status()
        CSCL.write_bytes(resp.content)
    return json.loads(CSCL.read_text())


def point_in_ring(x: float, y: float, ring: list) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


class Graph:
    """Directed road graph. Node = rounded lon/lat; edge = one CSCL part in one direction."""

    def __init__(self):
        self.node_id: dict[tuple[int, int], int] = {}
        self.node_xy: list[tuple[float, float]] = []
        self.node_ll: list[tuple[float, float]] = []
        self.edges: list[tuple[int, int, float]] = []  # u, v, seconds
        self.edge_geom: dict[tuple[int, int], tuple[int, bool]] = {}  # (u,v) -> (part index, reversed)
        self.parts: list[dict] = []  # {coords: [[lon,lat,z],...], rw, name}
        self.node_rw: dict[int, str] = {}

    def node(self, lon: float, lat: float) -> int:
        key = (round(lon * 1e5), round(lat * 1e5))
        nid = self.node_id.get(key)
        if nid is None:
            nid = len(self.node_xy)
            self.node_id[key] = nid
            self.node_xy.append(to_xy(lat, lon))
            self.node_ll.append((lon, lat))
        return nid

    def add_part(self, coords: list[list[float]], rw: str, trafdir: str, mph: float, z0: float, z1: float, name: str) -> None:
        if len(coords) < 2:
            return
        # length + z per vertex (linear between the segment's two level codes)
        length = 0.0
        cum = [0.0]
        for (alon, alat), (blon, blat) in zip(coords, coords[1:]):
            dx = (blon - alon) * M_PER_DEG_LON
            dy = (blat - alat) * M_PER_DEG_LAT
            length += math.hypot(dx, dy)
            cum.append(length)
        if length < 0.5:
            return
        pts = [[lon, lat, round(z0 + (z1 - z0) * (c / length), 1)] for (lon, lat), c in zip(coords, cum)]
        pidx = len(self.parts)
        self.parts.append({"coords": pts, "rw": rw, "name": name, "len": length})
        u = self.node(coords[0][0], coords[0][1])
        v = self.node(coords[-1][0], coords[-1][1])
        if u == v:
            return
        self.node_rw.setdefault(u, rw)
        self.node_rw.setdefault(v, rw)
        secs = length / (mph * 0.44704) + INTERSECTION_PENALTY_S[rw]
        if trafdir in ("FT", "TW"):
            self.edges.append((u, v, secs))
            self.edge_geom.setdefault((u, v), (pidx, False))
        if trafdir in ("TF", "TW"):
            self.edges.append((v, u, secs))
            self.edge_geom.setdefault((v, u), (pidx, True))

    def matrix(self) -> csr_matrix:
        n = len(self.node_xy)
        rows = np.fromiter((e[0] for e in self.edges), dtype=np.int32, count=len(self.edges))
        cols = np.fromiter((e[1] for e in self.edges), dtype=np.int32, count=len(self.edges))
        w = np.fromiter((e[2] for e in self.edges), dtype=np.float64, count=len(self.edges))
        m = csr_matrix((w, (rows, cols)), shape=(n, n))
        m.sum_duplicates()
        return m

    def path_coords(self, nodes: list[int]) -> list[list[float]]:
        out: list[list[float]] = []
        for u, v in zip(nodes, nodes[1:]):
            g = self.edge_geom.get((u, v))
            if g is None:
                a, b = self.node_ll[u], self.node_ll[v]
                seg = [[a[0], a[1], 0.0], [b[0], b[1], 0.0]]
            else:
                pidx, rev = g
                seg = self.parts[pidx]["coords"]
                seg = seg[::-1] if rev else seg
            if out:
                out.extend(seg[1:])
            else:
                out.extend(seg)
        return out


def build_graph(rows: list[dict]) -> Graph:
    g = Graph()
    skipped = 0
    for r in rows:
        rw = r.get("rw_type")
        trafdir = r.get("trafdir")
        if rw not in DRIVABLE or trafdir not in ("FT", "TF", "TW") or r.get("status") not in ("2", None):
            skipped += 1
            continue
        try:
            mph = float(r.get("posted_speed") or 0) or DEFAULT_MPH[rw]
        except ValueError:
            mph = DEFAULT_MPH[rw]
        z0 = level_z(r.get("from_level_code"), rw)
        z1 = level_z(r.get("to_level_code"), rw)
        for part in r["the_geom"]["coordinates"]:
            g.add_part(part, rw, trafdir, mph, z0, z1, r.get("full_street_name", ""))
    print(f"  graph: {len(g.node_xy)} nodes, {len(g.edges)} directed edges, {len(g.parts)} parts ({skipped} rows skipped)")
    return g


def choose_anchors(g: Graph, zones: list[dict], matrix: csr_matrix, k: int) -> dict[int, list[int]]:
    """k road nodes per taxi zone: nearest to the centroid + farthest-point samples inside."""
    indeg = np.asarray(matrix.astype(bool).sum(axis=0)).ravel()
    outdeg = np.asarray(matrix.astype(bool).sum(axis=1)).ravel()
    good = (indeg > 0) & (outdeg > 0)
    xy = np.array(g.node_xy)
    ll = np.array(g.node_ll)
    good_idx = np.nonzero(good)[0]
    anchors: dict[int, list[int]] = {}
    for z in zones:
        geom = z["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        rings = [p[0] for p in polys]
        # bbox prefilter
        allpts = np.array([pt for r in rings for pt in r])
        lo, hi = allpts.min(axis=0), allpts.max(axis=0)
        cand = good_idx[(ll[good_idx, 0] >= lo[0]) & (ll[good_idx, 0] <= hi[0]) & (ll[good_idx, 1] >= lo[1]) & (ll[good_idx, 1] <= hi[1])]
        inside = [n for n in cand if any(point_in_ring(ll[n, 0], ll[n, 1], r) for r in rings)]
        # prefer ordinary streets (no highway-only anchors: taxis start at the kerb)
        streets = [n for n in inside if g.node_rw.get(n) == RW_STREET]
        pool = streets or inside
        cx, cy = to_xy(z["lat"], z["lon"])
        if not pool:
            # zone without roads (e.g. outside the city): nearest good node within 2 km
            d = np.hypot(xy[good_idx, 0] - cx, xy[good_idx, 1] - cy)
            j = int(d.argmin())
            if d[j] < 2000:
                anchors[z["id"]] = [int(good_idx[j])]
            continue
        pool_xy = xy[pool]
        chosen = [pool[int(np.hypot(pool_xy[:, 0] - cx, pool_xy[:, 1] - cy).argmin())]]
        while len(chosen) < k and len(chosen) < len(pool):
            dmin = np.full(len(pool), np.inf)
            for c in chosen:
                dmin = np.minimum(dmin, np.hypot(pool_xy[:, 0] - xy[c, 0], pool_xy[:, 1] - xy[c, 1]))
            chosen.append(pool[int(dmin.argmax())])
        anchors[z["id"]] = [int(c) for c in chosen]
    print(f"  anchors: {sum(len(v) for v in anchors.values())} nodes for {len(anchors)} / {len(zones)} zones")
    return anchors


def needed_pairs(min_trips: int) -> list[tuple[int, int, int]]:
    import duckdb

    con = duckdb.connect(str(DATA / "taxi_flow.duckdb"), read_only=True)
    rows = con.execute(
        """
        WITH p AS (
          SELECT pu, dropoff, sum(trips) AS t FROM flows
          WHERE pu <> dropoff AND pu BETWEEN 1 AND 263 AND dropoff BETWEEN 1 AND 263
          GROUP BY 1, 2),
        top AS (
          SELECT pu, dropoff FROM (
            SELECT pu, dropoff, row_number() OVER (PARTITION BY dow, hour ORDER BY sum(trips) DESC) AS rn
            FROM flows WHERE pu <> dropoff AND pu BETWEEN 1 AND 263 AND dropoff BETWEEN 1 AND 263
            GROUP BY pu, dropoff, dow, hour) WHERE rn <= 6000)
        SELECT p.pu, p.dropoff, p.t FROM p
        WHERE p.t >= ? OR (p.pu, p.dropoff) IN (SELECT pu, dropoff FROM top)
        ORDER BY p.t DESC
        """,
        [min_trips],
    ).fetchall()
    con.close()
    return [(int(a), int(b), int(t)) for a, b, t in rows]


def write_streets_bin(g: Graph) -> None:
    """All drivable parts as a binary PathLayer buffer for the wireframe street layer."""
    starts = [0]
    pos: list[float] = []
    for part in g.parts:
        pts = simplify([[c[1], c[0], c[2]] for c in part["coords"]], 4.0)  # simplify wants lat, lon first
        for lat, lon, z in pts:
            pos.extend((lon, lat, z))
        starts.append(len(pos) // 3)
    out = STREETS / "streets.bin"
    with out.open("wb") as fh:
        fh.write(struct.pack("<II", len(starts) - 1, len(pos) // 3))
        fh.write(np.asarray(starts, dtype=np.uint32).tobytes())
        fh.write(np.asarray(pos, dtype=np.float32).tobytes())
    print(f"  wrote {out} ({out.stat().st_size / 1e6:.1f} MB): {len(starts) - 1} paths, {len(pos) // 3} vertices")


def write_crossings(rows: list[dict]) -> None:
    feats = []
    for r in rows:
        rw = r.get("rw_type")
        if rw not in (RW_BRIDGE, RW_TUNNEL, RW_HIGHWAY, RW_RAMP):
            continue
        z0 = level_z(r.get("from_level_code"), rw)
        z1 = level_z(r.get("to_level_code"), rw)
        if rw in (RW_HIGHWAY, RW_RAMP) and abs(z0) < 1 and abs(z1) < 1:
            continue  # at-grade highway: nothing to lift
        kind = {RW_BRIDGE: "bridge", RW_TUNNEL: "tunnel", RW_HIGHWAY: "elevated", RW_RAMP: "ramp"}[rw]
        for part in r["the_geom"]["coordinates"]:
            n = len(part)
            coords = [[lon, lat, round(z0 + (z1 - z0) * (i / max(n - 1, 1)), 1)] for i, (lon, lat) in enumerate(part)]
            feats.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": coords},
                    "properties": {"kind": kind, "name": r.get("full_street_name", ""), "z": max(z0, z1, key=abs)},
                }
            )
    out = STREETS / "crossings.json"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    kinds = defaultdict(int)
    for f in feats:
        kinds[f["properties"]["kind"]] += 1
    print(f"  wrote {out} ({out.stat().st_size / 1e6:.1f} MB): {dict(kinds)}")


def route_paths(g: Graph, matrix: csr_matrix, anchors: dict[int, list[int]], pairs, variants: int) -> None:
    rng = random.Random(7)
    # (src_node, dst_node) -> list of (pair key, variant)
    wanted: dict[tuple[int, int], list[tuple[str, int]]] = defaultdict(list)
    for pu, do, _ in pairs:
        a, b = anchors.get(pu), anchors.get(do)
        if not a or not b:
            continue
        combos = [(x, y) for x in a for y in b]
        rng.shuffle(combos)
        combos.sort(key=lambda c: 0 if (c[0] == a[0] and c[1] == b[0]) else 1)  # centroid pair first
        for k, (s, t) in enumerate(combos[:variants]):
            wanted[(s, t)].append((f"{pu}-{do}", k))
    sources = sorted({s for s, _ in wanted})
    by_source: dict[int, list[int]] = defaultdict(list)
    for s, t in wanted:
        by_source[s].append(t)
    print(f"  routing {len(wanted)} anchor pairs from {len(sources)} sources ...", flush=True)

    index: dict[str, list] = defaultdict(list)
    chunks: list[np.ndarray] = []
    offset = 0
    unreachable = 0
    t0 = time.time()
    batch = 64
    for i in range(0, len(sources), batch):
        srcs = sources[i : i + batch]
        _, pred = dijkstra(matrix, directed=True, indices=srcs, return_predecessors=True)
        for row, s in enumerate(srcs):
            p = pred[row]
            for t in by_source[s]:
                nodes = []
                cur = t
                while cur != s and cur >= 0 and len(nodes) < 20000:
                    nodes.append(cur)
                    cur = p[cur]
                if cur != s:
                    unreachable += 1
                    continue
                nodes.append(s)
                nodes.reverse()
                coords = g.path_coords(nodes)
                simp = simplify([[c[1], c[0], c[2]] for c in coords], SIMPLIFY_M)
                arr = np.array([[lon, lat, z] for lat, lon, z in simp], dtype=np.float32)
                chunks.append(arr)
                for key, k in wanted[(s, t)]:
                    index[key].append([offset, len(arr), k])
                offset += len(arr)
        done = min(i + batch, len(sources))
        print(f"    {done}/{len(sources)} sources, {offset} vertices, {time.time() - t0:.0f}s", flush=True)

    allpts = np.concatenate(chunks) if chunks else np.zeros((0, 3), np.float32)
    np.save(STREETS / "paths.npy", allpts)
    for key in index:
        index[key].sort(key=lambda e: e[2])
        index[key] = [[o, n] for o, n, _ in index[key]]
    (STREETS / "paths_index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(
        f"  wrote paths.npy ({allpts.nbytes / 1e6:.1f} MB, {len(allpts)} vertices) and paths_index.json "
        f"({len(index)} zone pairs, {unreachable} unreachable)"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--min-trips", type=int, default=30, help="route zone pairs with at least this many trips/month")
    ap.add_argument("--variants", type=int, default=3, help="distinct paths per zone pair")
    args = ap.parse_args()

    STREETS.mkdir(parents=True, exist_ok=True)
    print("loading centerlines ...")
    rows = load_cscl()
    print(f"  {len(rows)} segments")
    g = build_graph(rows)
    matrix = g.matrix()
    write_streets_bin(g)
    write_crossings(rows)

    zones = json.loads((DATA / "taxi_zones.json").read_text())["zones"]
    anchors = choose_anchors(g, zones, matrix, ANCHORS_PER_ZONE)
    pairs = needed_pairs(args.min_trips)
    print(f"  {len(pairs)} zone pairs to route")
    route_paths(g, matrix, anchors, pairs, args.variants)


if __name__ == "__main__":
    main()

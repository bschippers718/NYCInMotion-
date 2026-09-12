"""Download the MTA static GTFS bundle and compile it into data/static.json.

The compiled file contains everything the realtime server and the browser need:
  routes  - id, name, color
  stops   - every stop (incl. N/S platform ids) with lat/lon, parent station,
            and for stations the structure type (Subway / Elevated / Open Cut / ...)
            and its vertical position in metres relative to the street
  shapes  - per track shape: polyline with a z (metres) per vertex, cumulative
            distance, and the ordered list of stops on that shape with their
            distance along the polyline and scheduled seconds-from-start

Where the vertical profile comes from
  * MTA "Subway Stations" open dataset (data.ny.gov 39hk-dx4f): each station's
    `structure` field - Subway, Open Cut, At Grade, Embankment, Viaduct, Elevated.
  * OpenStreetMap railway=subway ways (optional, data/osm_rail.json from Overpass):
    tunnel / bridge / layer tags refine the profile between stations, e.g. the
    Manhattan Bridge tracks between two underground stations, and stacked tunnels
    at different depths.

Usage:
  python scripts/build_static.py                 # download + build
  python scripts/build_static.py --zip path.zip  # build from an existing zip
"""
from __future__ import annotations

import argparse
import csv
import io
import json

import sys
import zipfile
from collections import defaultdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from subway.geo import GridIndex, cumulative, haversine_m, interp_1d, project_onto_polyline, to_xy  # noqa: E402

GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"
STATIONS_URL = (
    "https://data.ny.gov/resource/39hk-dx4f.json?$limit=1000&$select="
    "gtfs_stop_id,station_id,complex_id,stop_name,borough,line,structure,daytime_routes,gtfs_latitude,gtfs_longitude"
)
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
OVERPASS_QUERY = (
    '[out:json][timeout:240];way["railway"~"^(subway|rail)$"]["service"!~"."](40.49,-74.27,40.93,-73.68);out geom;'
)
DATA_DIR = ROOT / "data"
OUT = DATA_DIR / "static.json"

# vertical position (metres relative to the street) for each MTA structure type
STRUCTURE_Z = {
    "Subway": -16.0,
    "Open Cut": -7.0,
    "At Grade": 0.0,
    "Embankment": 6.0,
    "Viaduct": 13.0,
    "Elevated": 13.0,
}
OSM_LAYER_Z = {"-1": -11.0, "-2": -17.0, "-3": -25.0, "-4": -33.0, "-5": -41.0}
OSM_BRIDGE_Z = 14.0  # generic elevated structure / street bridge
# The two East River suspension bridges that carry the subway are far higher than a
# street el: rail level is ~41 m over the water at mid-span. Heights in metres along the
# axis from anchorage to anchorage; the running mean below turns the ends into ramps.
RIVER_BRIDGES = [
    {
        "name": "Manhattan Bridge",
        "anchorages": [(40.70304, -73.98828), (40.71089, -73.99264)],  # Brooklyn, Manhattan
        "towers": [(40.70512, -73.98944), (40.70881, -73.99149)],
        "z": {"anchorage": 27.0, "tower": 38.0, "mid": 41.0},
        "half_width_m": 90.0,
    },
    {
        "name": "Williamsburg Bridge",
        "anchorages": [(40.70870, -73.96150), (40.71450, -73.97650)],  # Brooklyn, Manhattan
        "towers": [(40.71030, -73.96600), (40.71300, -73.97270)],
        "z": {"anchorage": 27.0, "tower": 38.0, "mid": 41.0},
        "half_width_m": 90.0,
    },
]
OSM_MATCH_M = 22.0  # how close an OSM way has to be to a GTFS shape point to count
Z_SMOOTH_M = 220.0  # ramps: running-mean window for the vertical profile
MAX_SEG_M = 60.0  # densify shapes so the profile can change mid-segment


def read_csv(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as fh:
        yield from csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig"))


def hms_to_sec(s: str) -> int:
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + int(sec)


# ---------------------------------------------------------------------------
# external data
# ---------------------------------------------------------------------------
def fetch_station_structures(path: Path) -> dict[str, dict]:
    if not path.exists():
        print("downloading MTA station structures ...")
        resp = requests.get(STATIONS_URL, timeout=60)
        resp.raise_for_status()
        path.write_bytes(resp.content)
    rows = json.loads(path.read_text())
    return {r["gtfs_stop_id"]: r for r in rows if r.get("gtfs_stop_id")}


def fetch_osm(path: Path) -> list[dict]:
    if not path.exists():
        for ep in OVERPASS:
            try:
                print(f"downloading OSM rail ways from {ep} ...")
                resp = requests.get(ep, params={"data": OVERPASS_QUERY}, timeout=300)
                if resp.ok and resp.text.lstrip().startswith("{"):
                    path.write_bytes(resp.content)
                    break
                print(f"  {ep}: HTTP {resp.status_code} / not JSON, trying next mirror")
            except requests.RequestException as exc:
                print(f"  {ep}: {exc}")
    if not path.exists():
        print("  OSM data unavailable - profile will use station structures only")
        return []
    try:
        return json.loads(path.read_text()).get("elements", [])
    except json.JSONDecodeError:
        print("  OSM file is not JSON (Overpass error page?) - ignoring")
        return []


def osm_index(elements: list[dict]) -> GridIndex:
    """Grid of OSM way segments tagged with their vertical class."""
    idx = GridIndex(cell_m=80)
    for el in elements:
        tags = el.get("tags", {})
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        tunnel = tags.get("tunnel", "no") not in ("no", "")
        bridge = tags.get("bridge", "no") not in ("no", "")
        if not tunnel and not bridge:
            continue  # only explicit tunnel / bridge ways carry information we trust
        if tunnel:
            z = OSM_LAYER_Z.get(tags.get("layer", ""), -16.0)
        else:
            z = OSM_BRIDGE_Z
        pts = [to_xy(g["lat"], g["lon"]) for g in geom]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            idx.add_segment(ax, ay, bx, by, z)
    return idx


def river_bridge_z(lat: float, lon: float) -> float | None:
    """Rail height over a suspension bridge at this point, or None if not on one."""
    x, y = to_xy(lat, lon)
    for b in RIVER_BRIDGES:
        (alat, alon), (blat, blon) = b["anchorages"]
        ax, ay = to_xy(alat, alon)
        bx, by = to_xy(blat, blon)
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = ((x - ax) * dx + (y - ay) * dy) / L2
        if t < -0.02 or t > 1.02:
            continue
        px, py = ax + t * dx, ay + t * dy
        if ((x - px) ** 2 + (y - py) ** 2) ** 0.5 > b["half_width_m"]:
            continue
        knots_t, knots_z = [0.0], [b["z"]["anchorage"]]
        for tlat, tlon in b["towers"]:
            tx, ty = to_xy(tlat, tlon)
            knots_t.append(((tx - ax) * dx + (ty - ay) * dy) / L2)
            knots_z.append(b["z"]["tower"])
        knots_t.insert(2, 0.5)
        knots_z.insert(2, b["z"]["mid"])
        knots_t.append(1.0)
        knots_z.append(b["z"]["anchorage"])
        return interp_1d(knots_t, knots_z, min(1.0, max(0.0, t)))
    return None


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
def vertical_profile(pts, cum, stop_list, stops, osm: GridIndex | None) -> list[float]:
    """z per shape vertex: station structures interpolated along the shape, refined by OSM."""
    knots_d, knots_z = [], []
    for st in stop_list:
        s = stops.get(st["id"])
        parent = stops.get((s or {}).get("parent") or "") or s
        if parent and parent.get("z") is not None:
            if knots_d and abs(knots_d[-1] - st["dist"]) < 1:
                continue
            knots_d.append(st["dist"])
            knots_z.append(parent["z"])
    z = []
    for (lat, lon), d in zip(pts, cum):
        zs = interp_1d(knots_d, knots_z, d) if knots_d else -16.0
        if osm is not None:
            x, y = to_xy(lat, lon)
            _, hit = osm.nearest(x, y, OSM_MATCH_M)
            if hit is not None:
                # OSM says tunnel or bridge here. Keep the station-based depth for
                # tunnels when the station says "Subway" too (their depth is better
                # than a generic layer guess); otherwise trust OSM.
                if hit < 0 and zs < 0:
                    zs = min(zs, hit) if hit <= -17 else zs
                else:
                    zs = hit
                    if hit > 0:
                        bz = river_bridge_z(lat, lon)
                        if bz is not None:
                            zs = bz
        z.append(zs)
    return smooth_profile(cum, z, Z_SMOOTH_M)


def densify(pts: list[tuple[float, float]], max_seg_m: float) -> list[tuple[float, float]]:
    """Insert vertices so no segment is longer than max_seg_m (GTFS shapes can have
    2 km straight runs across bridges, which would hide the vertical profile)."""
    out = [pts[0]]
    for (alat, alon), (blat, blon) in zip(pts, pts[1:]):
        n = int(haversine_m(alat, alon, blat, blon) // max_seg_m)
        for k in range(1, n + 1):
            t = k / (n + 1)
            out.append((alat + (blat - alat) * t, alon + (blon - alon) * t))
        out.append((blat, blon))
    return out


def smooth_profile(cum: list[float], z: list[float], window_m: float) -> list[float]:
    """Running mean over ±window/2 metres so level changes become ramps."""
    n = len(z)
    if n < 3:
        return z
    out = []
    half = window_m / 2
    j0 = 0
    j1 = 0
    for i in range(n):
        while cum[j0] < cum[i] - half:
            j0 += 1
        while j1 < n - 1 and cum[j1 + 1] <= cum[i] + half:
            j1 += 1
        seg = z[j0 : j1 + 1]
        out.append(sum(seg) / len(seg))
    return out


def build(zip_path: Path, structures: dict[str, dict], osm_elements: list[dict]) -> dict:
    zf = zipfile.ZipFile(zip_path)

    routes = {}
    for r in read_csv(zf, "routes.txt"):
        routes[r["route_id"]] = {
            "id": r["route_id"],
            "short_name": r["route_short_name"] or r["route_id"],
            "long_name": r["route_long_name"],
            "color": "#" + (r.get("route_color") or "808183"),
            "text_color": "#" + (r.get("route_text_color") or "FFFFFF"),
        }

    stops = {}
    for s in read_csv(zf, "stops.txt"):
        stop = {
            "id": s["stop_id"],
            "name": s["stop_name"],
            "lat": float(s["stop_lat"]),
            "lon": float(s["stop_lon"]),
            "parent": s.get("parent_station") or None,
            "is_station": s.get("location_type") == "1",
        }
        if stop["is_station"]:
            meta = structures.get(s["stop_id"])
            structure = (meta or {}).get("structure")
            stop["structure"] = structure
            stop["z"] = STRUCTURE_Z.get(structure, -16.0)
            stop["borough"] = (meta or {}).get("borough")
            stop["line"] = (meta or {}).get("line")
            stop["complex"] = (meta or {}).get("complex_id")
        stops[s["stop_id"]] = stop
    matched = sum(1 for s in stops.values() if s.get("structure"))
    print(f"  station structures matched: {matched} / {sum(1 for s in stops.values() if s['is_station'])}")

    shape_pts = defaultdict(list)
    for p in read_csv(zf, "shapes.txt"):
        shape_pts[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))

    # One representative trip per shape (used for stop order + scheduled times).
    shape_route = {}
    rep_trip = {}
    for t in read_csv(zf, "trips.txt"):
        sid = t.get("shape_id")
        if not sid or sid not in shape_pts:
            continue
        shape_route.setdefault(sid, t["route_id"])
        if sid not in rep_trip or ("Weekday" in t["service_id"] and "Weekday" not in rep_trip[sid][1]):
            rep_trip[sid] = (t["trip_id"], t["service_id"])
    trip_to_shape = {tid: sid for sid, (tid, _) in rep_trip.items()}

    trip_stops = defaultdict(list)
    for st in read_csv(zf, "stop_times.txt"):
        sid = trip_to_shape.get(st["trip_id"])
        if sid is None:
            continue
        trip_stops[sid].append((int(st["stop_sequence"]), st["stop_id"], hms_to_sec(st["arrival_time"] or st["departure_time"])))

    osm = osm_index(osm_elements) if osm_elements else None
    if osm is not None:
        print(f"  OSM tunnel/bridge segments indexed: {sum(len(v) for v in osm.cells.values())}")

    shapes = {}
    for sid, raw in shape_pts.items():
        raw.sort()
        pts = densify([(lat, lon) for _, lat, lon in raw], MAX_SEG_M)
        cum = cumulative(pts)

        stop_list = []
        seq = sorted(trip_stops.get(sid, []))
        t0 = seq[0][2] if seq else 0
        last_dist = -1.0
        for _, stop_id, t in seq:
            s = stops.get(stop_id)
            if not s:
                continue
            d, _ = project_onto_polyline(pts, cum, s["lat"], s["lon"])
            if d < last_dist:  # keep monotonic along the shape
                d = last_dist
            last_dist = d
            stop_list.append({"id": stop_id, "dist": round(d, 1), "sched": t - t0})

        z = vertical_profile(pts, cum, stop_list, stops, osm)
        shapes[sid] = {
            "id": sid,
            "route": shape_route.get(sid, sid.split(".")[0]),
            "length": round(cum[-1], 1),
            "points": [[round(lat, 6), round(lon, 6), round(zz, 1)] for (lat, lon), zz in zip(pts, z)],
            "cum": [round(c, 1) for c in cum],
            "stops": stop_list,
        }

    return {"routes": routes, "stops": stops, "shapes": shapes, "structure_z": STRUCTURE_Z}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--zip", help="use an already-downloaded gtfs_subway.zip")
    ap.add_argument("--no-osm", action="store_true", help="skip the OpenStreetMap tunnel/bridge refinement")
    args = ap.parse_args()

    DATA_DIR.mkdir(exist_ok=True)
    zip_path = Path(args.zip) if args.zip else DATA_DIR / "gtfs_subway.zip"
    if not args.zip:
        print(f"downloading {GTFS_URL} ...")
        resp = requests.get(GTFS_URL, timeout=120)
        resp.raise_for_status()
        zip_path.write_bytes(resp.content)
        print(f"  {len(resp.content) / 1e6:.1f} MB")

    structures = fetch_station_structures(DATA_DIR / "stations_structure.json")
    osm_elements = [] if args.no_osm else fetch_osm(DATA_DIR / "osm_rail.json")

    data = build(zip_path, structures, osm_elements)
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    n_pts = sum(len(s["points"]) for s in data["shapes"].values())
    above = sum(1 for s in data["shapes"].values() for p in s["points"] if p[2] > 3)
    print(
        f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB): "
        f"{len(data['routes'])} routes, {len(data['stops'])} stops, "
        f"{len(data['shapes'])} shapes, {n_pts} shape points ({above / max(n_pts, 1):.0%} above ground)"
    )


if __name__ == "__main__":
    main()

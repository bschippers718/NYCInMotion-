"""Compile the NYC Ferry GTFS into data/ferry_network.json (routes, shapes, trip -> shape).

NYC Ferry publishes a tiny static GTFS and a public GTFS-Realtime vehicle feed
(no key). Usage: python scripts/build_ferry_static.py
"""
from __future__ import annotations

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
from subway.geo import simplify  # noqa: E402

URL = "http://nycferry.connexionz.net/rtt/public/resource/gtfs.zip"
DATA = ROOT / "data"
OUT = DATA / "ferry_network.json"


def read_csv(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as fh:
        yield from csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig"))


def main() -> None:
    print(f"downloading {URL} ...")
    resp = requests.get(URL, timeout=60, allow_redirects=True)
    resp.raise_for_status()
    zf = zipfile.ZipFile(io.BytesIO(resp.content))

    routes = {
        r["route_id"]: {
            "id": r["route_id"],
            "short_name": r["route_short_name"] or r["route_id"],
            "long_name": r["route_long_name"],
            "color": "#" + (r.get("route_color") or "00839C"),
            "text_color": "#" + (r.get("route_text_color") or "FFFFFF"),
        }
        for r in read_csv(zf, "routes.txt")
    }
    pts = defaultdict(list)
    for p in read_csv(zf, "shapes.txt"):
        pts[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))
    shapes, index, trips = [], {}, {}
    for t in read_csv(zf, "trips.txt"):
        sid = t.get("shape_id")
        if not sid or sid not in pts:
            continue
        if sid not in index:
            index[sid] = len(shapes)
            raw = sorted(pts[sid])
            poly = simplify([[lat, lon] for _, lat, lon in raw], 5.0)
            shapes.append({"id": sid, "route": t["route_id"], "points": [[round(a, 6), round(b, 6)] for a, b in poly]})
        trips[t["trip_id"]] = index[sid]
    stops = [
        {"id": s["stop_id"], "name": s["stop_name"], "lat": float(s["stop_lat"]), "lon": float(s["stop_lon"])}
        for s in read_csv(zf, "stops.txt")
    ]
    OUT.write_text(json.dumps({"routes": routes, "shapes": shapes, "trips": trips, "stops": stops}, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} kB): {len(routes)} routes, {len(shapes)} shapes, {len(trips)} trips, {len(stops)} landings")


if __name__ == "__main__":
    main()

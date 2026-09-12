"""Compile the MTA bus GTFS bundles into the two files the bus layer needs.

  data/bus_network.json   routes (name, color) + every route shape as a simplified
                          [lat, lon] polyline - sent to the browser so live GPS
                          positions can be snapped to, and animated along, the
                          street route the bus actually drives
  data/bus_trips.json     trip_id -> shape index, used by the server to tag each
                          live vehicle with its shape

The MTA publishes one bundle per borough plus one for MTA Bus Company routes:
https://rrgtfsfeeds.s3.amazonaws.com/gtfs_{b,bx,m,q,si,busco}.zip

Usage:
  python scripts/build_bus_static.py            # download (≈60 MB) + build
  python scripts/build_bus_static.py --no-download
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
from subway.geo import simplify  # noqa: E402

BUNDLES = ["b", "bx", "m", "q", "si", "busco"]
URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_{}.zip"
DATA = ROOT / "data"
GTFS_DIR = DATA / "bus_gtfs"
NETWORK_OUT = DATA / "bus_network.json"
TRIPS_OUT = DATA / "bus_trips.json"
SIMPLIFY_M = 3.0


def read_csv(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as fh:
        yield from csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig"))


def download(tag: str) -> Path:
    dest = GTFS_DIR / f"gtfs_{tag}.zip"
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    print(f"  downloading {URL.format(tag)} ...", flush=True)
    resp = requests.get(URL.format(tag), timeout=300)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--no-download", action="store_true", help="only use bundles already in data/bus_gtfs")
    args = ap.parse_args()
    GTFS_DIR.mkdir(parents=True, exist_ok=True)

    routes: dict[str, dict] = {}
    shapes: list[dict] = []
    shape_index: dict[str, int] = {}
    trips: dict[str, int] = {}
    n_raw_pts = 0

    for tag in BUNDLES:
        path = GTFS_DIR / f"gtfs_{tag}.zip"
        if not path.exists():
            if args.no_download:
                print(f"  missing {path.name}, skipping")
                continue
            download(tag)
        print(f"{path.name}:", flush=True)
        zf = zipfile.ZipFile(path)

        for r in read_csv(zf, "routes.txt"):
            routes[r["route_id"]] = {
                "id": r["route_id"],
                "short_name": r["route_short_name"] or r["route_id"],
                "long_name": r["route_long_name"],
                "color": "#" + (r.get("route_color") or "f28c28"),
                "text_color": "#" + (r.get("route_text_color") or "FFFFFF"),
                "bundle": tag,
            }

        pts = defaultdict(list)
        for p in read_csv(zf, "shapes.txt"):
            pts[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))

        shape_route: dict[str, str] = {}
        n_trips = 0
        for t in read_csv(zf, "trips.txt"):
            sid = t.get("shape_id")
            if not sid or sid not in pts:
                continue
            shape_route.setdefault(sid, t["route_id"])
            if sid not in shape_index:
                shape_index[sid] = len(shapes)
                shapes.append(None)  # placeholder, filled below
            trips[t["trip_id"]] = shape_index[sid]
            n_trips += 1

        for sid, raw in pts.items():
            if sid not in shape_index:
                continue
            raw.sort()
            poly = [[lat, lon] for _, lat, lon in raw]
            n_raw_pts += len(poly)
            simp = simplify(poly, SIMPLIFY_M)
            shapes[shape_index[sid]] = {
                "id": sid,
                "route": shape_route.get(sid, ""),
                "points": [[round(lat, 6), round(lon, 6)] for lat, lon in simp],
            }
        print(f"  {n_trips} trips, {len(pts)} shapes")

    shapes = [s for s in shapes if s]
    n_pts = sum(len(s["points"]) for s in shapes)
    NETWORK_OUT.write_text(json.dumps({"routes": routes, "shapes": shapes}, separators=(",", ":")))
    TRIPS_OUT.write_text(json.dumps(trips, separators=(",", ":")))
    print(
        f"\nwrote {NETWORK_OUT} ({NETWORK_OUT.stat().st_size / 1e6:.1f} MB): {len(routes)} routes, "
        f"{len(shapes)} shapes, {n_pts} points (from {n_raw_pts})"
    )
    print(f"wrote {TRIPS_OUT} ({TRIPS_OUT.stat().st_size / 1e6:.1f} MB): {len(trips)} trips")


if __name__ == "__main__":
    main()

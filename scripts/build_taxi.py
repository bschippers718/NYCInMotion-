"""Compile NYC TLC taxi / Uber / Lyft trip records into an hourly zone-to-zone flow table.

There is no realtime feed for taxis or ride-hail in NYC. The TLC publishes every
trip (yellow, green, and High-Volume FHV = Uber/Lyft/Via) as monthly parquet files
with a ~2 month lag, located only to one of 263 taxi zones. This script turns the
latest month into a "typical day" model:

  data/taxi_flow.duckdb   flows(service, dow, hour, pu, dropoff, trips, avg_secs)
                          zones(id, zone, borough, lon, lat)
  data/taxi_zones.json    zone centroids + simplified polygons (WGS84) for the map

Usage:
  python scripts/build_taxi.py                  # auto-detect newest month with both files
  python scripts/build_taxi.py --month 2026-05
Files are downloaded to data/tlc/ (about 600 MB) and kept for re-runs.
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from datetime import date
from pathlib import Path

import duckdb
import requests

CDN = "https://d37ci6vzurychx.cloudfront.net"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TLC = DATA / "tlc"
DB = DATA / "taxi_flow.duckdb"
ZONES_JSON = DATA / "taxi_zones.json"

SERVICES = {  # hvfhs_license_num -> service label
    "HV0003": "uber",
    "HV0005": "lyft",
    "HV0002": "juno",
    "HV0004": "via",
}


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  have {dest.name} ({dest.stat().st_size / 1e6:.0f} MB)")
        return
    print(f"  downloading {url} ...", flush=True)
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(".part")
        with tmp.open("wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
        tmp.rename(dest)
    print(f"  {dest.name}: {dest.stat().st_size / 1e6:.0f} MB")


def newest_month() -> str:
    """Newest month for which both the HVFHV and yellow files exist."""
    y, m = date.today().year, date.today().month
    for _ in range(12):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        tag = f"{y}-{m:02d}"
        ok = all(
            requests.head(f"{CDN}/trip-data/{kind}_tripdata_{tag}.parquet", timeout=30).status_code == 200
            for kind in ("fhvhv", "yellow")
        )
        if ok:
            return tag
    raise SystemExit("could not find a month with both fhvhv and yellow files")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--month", help="YYYY-MM (default: newest available)")
    args = ap.parse_args()

    TLC.mkdir(parents=True, exist_ok=True)
    month = args.month or newest_month()
    print(f"month: {month}")
    hv = TLC / f"fhvhv_tripdata_{month}.parquet"
    yellow = TLC / f"yellow_tripdata_{month}.parquet"
    zones_zip = TLC / "taxi_zones.zip"
    download(f"{CDN}/trip-data/fhvhv_tripdata_{month}.parquet", hv)
    download(f"{CDN}/trip-data/yellow_tripdata_{month}.parquet", yellow)
    download(f"{CDN}/misc/taxi_zones.zip", zones_zip)
    zdir = TLC / "taxi_zones"
    if not list(zdir.glob("**/*.shp")):
        zipfile.ZipFile(zones_zip).extractall(zdir)
    shp = next(zdir.glob("**/*.shp"))

    if DB.exists():
        DB.unlink()
    con = duckdb.connect(str(DB))
    con.execute("INSTALL spatial; LOAD spatial;")

    print("zones ...")
    con.execute(
        f"""
        CREATE TABLE zones AS
        SELECT LocationID::INTEGER AS id, zone, borough,
               ST_X(ST_Centroid(g)) AS lon, ST_Y(ST_Centroid(g)) AS lat,
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(g, 0.0004)) AS geojson
        FROM (SELECT *, ST_Transform(geom, 'EPSG:2263', 'EPSG:4326', always_xy := true) AS g
              FROM ST_Read('{shp}'))
        """
    )

    print("flows: uber / lyft / other ride-hail ...", flush=True)
    svc_case = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in SERVICES.items())
    con.execute(
        f"""
        CREATE TABLE flows AS
        SELECT CASE hvfhs_license_num {svc_case} ELSE 'other_hv' END AS service,
               (dayofweek(pickup_datetime) + 6) % 7 AS dow,      -- 0 = Monday
               hour(pickup_datetime) AS hour,
               PULocationID::INTEGER AS pu, DOLocationID::INTEGER AS dropoff,
               count(*)::INTEGER AS trips,
               avg(trip_time)::INTEGER AS avg_secs
        FROM read_parquet('{hv}')
        WHERE pickup_datetime >= '{month}-01' AND pickup_datetime < ('{month}-01'::DATE + INTERVAL 1 MONTH)
          AND trip_time BETWEEN 60 AND 3*3600
        GROUP BY ALL
        """
    )
    print("flows: yellow taxi ...", flush=True)
    con.execute(
        f"""
        INSERT INTO flows
        SELECT 'yellow', (dayofweek(tpep_pickup_datetime) + 6) % 7, hour(tpep_pickup_datetime),
               PULocationID::INTEGER, DOLocationID::INTEGER, count(*)::INTEGER,
               avg(epoch(tpep_dropoff_datetime - tpep_pickup_datetime))::INTEGER
        FROM read_parquet('{yellow}')
        WHERE tpep_pickup_datetime >= '{month}-01' AND tpep_pickup_datetime < ('{month}-01'::DATE + INTERVAL 1 MONTH)
          AND epoch(tpep_dropoff_datetime - tpep_pickup_datetime) BETWEEN 60 AND 3*3600
        GROUP BY ALL
        """
    )

    # how many of each weekday the month had, so we can turn totals into per-day averages
    con.execute(
        f"""
        CREATE TABLE meta AS
        SELECT '{month}' AS month, dow, count(*)::INTEGER AS days
        FROM (SELECT (dayofweek(d) + 6) % 7 AS dow
              FROM generate_series('{month}-01'::DATE, ('{month}-01'::DATE + INTERVAL 1 MONTH - INTERVAL 1 DAY)::DATE, INTERVAL 1 DAY) t(d))
        GROUP BY dow
        """
    )
    con.execute("CREATE INDEX flows_idx ON flows(dow, hour)")

    zones = [
        {"id": r[0], "zone": r[1], "borough": r[2], "lon": r[3], "lat": r[4], "geometry": json.loads(r[5])}
        for r in con.execute("SELECT id, zone, borough, lon, lat, geojson FROM zones ORDER BY id").fetchall()
    ]
    ZONES_JSON.write_text(json.dumps({"month": month, "zones": zones}, separators=(",", ":")))

    tot = con.execute("SELECT service, sum(trips) FROM flows GROUP BY 1 ORDER BY 2 DESC").fetchall()
    n = con.execute("SELECT count(*) FROM flows").fetchone()[0]
    con.close()
    print(f"\nwrote {DB} ({DB.stat().st_size / 1e6:.0f} MB, {n:,} flow rows) and {ZONES_JSON}")
    for s, t in tot:
        print(f"  {int(t):>12,}  {s}")


if __name__ == "__main__":
    main()

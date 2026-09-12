"""Download every NYC 311 service request tied to the subway system.

Source: NYC Open Data, "311 Service Requests from 2020 to Present" (erm2-nwe9),
queried through the Socrata SODA API. Records are selected by location_type
("Subway" / "Subway Station"), which is how 311 tags complaints that occur on
trains, platforms and in stations.

Output:
  data/311_subway.csv    - flat table, one row per service request
  data/311_subway.json   - same rows as a JSON array (used by the web UI)
  data/311_summary.json  - counts by complaint_type / borough / year

Usage:
  python scripts/fetch_311.py            # full download (~100k rows)
  python scripts/fetch_311.py --since 2025-01-01
  SOCRATA_APP_TOKEN=... python scripts/fetch_311.py   # optional, raises rate limits
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

import requests

DATASET = "https://data.cityofnewyork.us/resource/erm2-nwe9.json"
PAGE_SIZE = 25000
FIELDS = [
    "unique_key",
    "created_date",
    "closed_date",
    "agency",
    "agency_name",
    "complaint_type",
    "descriptor",
    "location_type",
    "status",
    "resolution_description",
    "resolution_action_updated_date",
    "incident_zip",
    "incident_address",
    "street_name",
    "cross_street_1",
    "cross_street_2",
    "city",
    "borough",
    "community_board",
    "open_data_channel_type",
    "latitude",
    "longitude",
]
WHERE = "location_type in ('Subway', 'Subway Station')"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


def fetch_page(session: requests.Session, where: str, offset: int) -> list[dict]:
    params = {
        "$select": ",".join(FIELDS),
        "$where": where,
        "$order": "unique_key",
        "$limit": PAGE_SIZE,
        "$offset": offset,
    }
    for attempt in range(6):
        try:
            resp = session.get(DATASET, params=params, timeout=300)
            if resp.status_code == 200:
                return resp.json()
            print(f"  HTTP {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
        except requests.RequestException as exc:
            print(f"  request failed: {exc}", file=sys.stderr)
        wait = 5 * (attempt + 1)
        print(f"  retrying in {wait}s", file=sys.stderr)
        time.sleep(wait)
    raise SystemExit("giving up after repeated failures")


def summarize(rows: list[dict]) -> dict:
    by_type = Counter(r.get("complaint_type", "") for r in rows)
    by_desc = Counter(
        (r.get("complaint_type", ""), r.get("descriptor", "")) for r in rows
    )
    by_borough = Counter(r.get("borough", "") for r in rows)
    by_year = Counter((r.get("created_date") or "")[:4] for r in rows)
    by_agency = Counter(r.get("agency", "") for r in rows)
    with_coords = sum(1 for r in rows if r.get("latitude") and r.get("longitude"))
    dates = sorted(r["created_date"] for r in rows if r.get("created_date"))
    return {
        "total": len(rows),
        "with_coordinates": with_coords,
        "first_created": dates[0] if dates else None,
        "last_created": dates[-1] if dates else None,
        "by_complaint_type": dict(by_type.most_common()),
        "by_complaint_descriptor": [
            {"complaint_type": t, "descriptor": d, "count": n}
            for (t, d), n in by_desc.most_common()
        ],
        "by_borough": dict(by_borough.most_common()),
        "by_agency": dict(by_agency.most_common()),
        "by_year": dict(sorted(by_year.items())),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--since", help="only rows created on/after YYYY-MM-DD")
    args = parser.parse_args()

    where = WHERE
    if args.since:
        where += f" AND created_date >= '{args.since}T00:00:00'"

    session = requests.Session()
    token = os.environ.get("SOCRATA_APP_TOKEN")
    if token:
        session.headers["X-App-Token"] = token

    DATA_DIR.mkdir(exist_ok=True)
    rows: list[dict] = []
    offset = 0
    started = time.time()
    while True:
        print(f"fetching offset={offset} ...", flush=True)
        page = fetch_page(session, where, offset)
        rows.extend(page)
        print(f"  got {len(page)} rows (total {len(rows)}, {time.time() - started:.0f}s)", flush=True)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    for r in rows:
        for k in ("latitude", "longitude"):
            if k in r:
                try:
                    r[k] = float(r[k])
                except (TypeError, ValueError):
                    r.pop(k, None)

    csv_path = DATA_DIR / "311_subway.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    (DATA_DIR / "311_subway.json").write_text(json.dumps(rows, separators=(",", ":")))
    summary = summarize(rows)
    (DATA_DIR / "311_summary.json").write_text(json.dumps(summary, indent=2))

    print(f"\nwrote {len(rows)} rows to {csv_path} and 311_subway.json")
    print(f"summary -> {DATA_DIR / '311_summary.json'}")
    print(f"date range: {summary['first_created']} .. {summary['last_created']}")
    print("top complaint types:")
    for t, n in list(summary["by_complaint_type"].items())[:10]:
        print(f"  {n:>7}  {t}")


if __name__ == "__main__":
    main()

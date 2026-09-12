"""Taxi / ride-hail: the zone-to-zone flow model (scripts/build_taxi.py) and the
street paths for each zone pair (scripts/build_streets.py).

There is no realtime feed for cabs, so the browser replays a "typical hour" of
trips as particles. Each particle follows an actual driving route between its
pickup and drop-off zones, including going over bridges and through tunnels.
"""
from __future__ import annotations

import json
import struct
import threading
from collections import OrderedDict
from pathlib import Path

try:
    import duckdb
except ImportError:  # pragma: no cover - optional dependency
    duckdb = None

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

SERVICES = ("uber", "lyft", "yellow", "other_hv")
TRIPS_MAGIC = 0x51495854  # "TXIQ"


class StreetPaths:
    """Memory-mapped routed paths for zone pairs."""

    def __init__(self, streets_dir: Path):
        self.dir = Path(streets_dir)
        self.index: dict[str, list[list[int]]] = {}
        self.verts = None
        idx, npy = self.dir / "paths_index.json", self.dir / "paths.npy"
        if np is not None and idx.exists() and npy.exists():
            self.index = json.loads(idx.read_text())
            self.verts = np.load(npy, mmap_mode="r")

    @property
    def available(self) -> bool:
        return self.verts is not None and bool(self.index)

    def variants(self, pu: int, do: int) -> list[list[int]]:
        return self.index.get(f"{pu}-{do}", [])


class TaxiFlow:
    def __init__(self, db_path: Path, zones_path: Path, streets_dir: Path):
        self.db_path = Path(db_path)
        self.zones_path = Path(zones_path)
        self.paths = StreetPaths(streets_dir)
        self._lock = threading.Lock()
        self._con = None
        self._zones_bytes: bytes | None = None
        self._meta: dict | None = None
        self._cache: OrderedDict[tuple, dict] = OrderedDict()

    @property
    def available(self) -> bool:
        return duckdb is not None and self.db_path.exists() and self.zones_path.exists()

    def _connect(self):
        if self._con is None:
            self._con = duckdb.connect(str(self.db_path), read_only=True)
            rows = self._con.execute("SELECT month, dow, days FROM meta").fetchall()
            self._meta = {"month": rows[0][0] if rows else None, "days": {int(d): int(n) for _, d, n in rows}}
        return self._con

    def status(self) -> dict:
        if not self.available:
            return {"available": False, "hint": "run: python scripts/build_taxi.py (downloads ~600 MB of TLC data)"}
        with self._lock:
            self._connect()
            return {
                "available": True,
                "month": self._meta["month"],
                "services": list(SERVICES),
                "realtime": False,
                "street_paths": self.paths.available,
            }

    def zones_bytes(self) -> bytes:
        if self._zones_bytes is None:
            self._zones_bytes = self.zones_path.read_bytes() if self.zones_path.exists() else b'{"zones":[]}'
        return self._zones_bytes

    # ---- flows ------------------------------------------------------------------
    def flow(self, dow: int, hour: int, services: list[str], top: int = 4000) -> dict:
        """Per-day-average flows for a weekday (0=Mon) and hour, for the chosen services."""
        if not self.available:
            return {"available": False, "hint": "run: python scripts/build_taxi.py", "flows": [], "zones": []}
        dow, hour = dow % 7, hour % 24
        services = sorted(s for s in services if s in SERVICES) or list(SERVICES)
        key = (dow, hour, tuple(services), top)
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                self._cache.move_to_end(key)
                return cached
            result = self._query(dow, hour, services, top)
            self._cache[key] = result
            while len(self._cache) > 12:
                self._cache.popitem(last=False)
            return result

    def _rows(self, dow: int, hour: int, services: list[str]) -> list[tuple]:
        """Every drawable flow row for that hour: (pu, dropoff, trips, avg_secs, service)."""
        con = self._connect()
        placeholders = ",".join("?" * len(services))
        return con.execute(
            f"""
            SELECT pu, dropoff, trips, avg_secs, service
            FROM flows WHERE dow = ? AND hour = ? AND service IN ({placeholders})
              AND pu BETWEEN 1 AND 263 AND dropoff BETWEEN 1 AND 263 AND pu <> dropoff
            ORDER BY trips DESC, pu, dropoff, service
            """,
            [dow, hour, *services],
        ).fetchall()

    def _query(self, dow: int, hour: int, services: list[str], top: int) -> dict:
        con = self._connect()
        placeholders = ",".join("?" * len(services))
        days = max(1, self._meta["days"].get(dow, 4))
        flows = self._rows(dow, hour, services)[:top]
        # trips we cannot draw: unknown zones (264/265) and trips that start and end in one zone
        undrawn = con.execute(
            f"""
            SELECT coalesce(sum(CASE WHEN pu = dropoff THEN trips END), 0)::INTEGER,
                   coalesce(sum(CASE WHEN pu NOT BETWEEN 1 AND 263 OR dropoff NOT BETWEEN 1 AND 263 THEN trips END), 0)::INTEGER
            FROM flows WHERE dow = ? AND hour = ? AND service IN ({placeholders})
            """,
            [dow, hour, *services],
        ).fetchone()
        zones = con.execute(
            f"""
            WITH f AS (SELECT * FROM flows WHERE dow = ? AND hour = ? AND service IN ({placeholders}))
            SELECT z.id,
                   coalesce((SELECT sum(trips) FROM f WHERE f.pu = z.id), 0)::INTEGER AS pickups,
                   coalesce((SELECT sum(trips) FROM f WHERE f.dropoff = z.id), 0)::INTEGER AS dropoffs
            FROM zones z
            """,
            [dow, hour, *services],
        ).fetchall()
        by_service = con.execute(
            f"""
            SELECT service, sum(trips)::INTEGER FROM flows
            WHERE dow = ? AND hour = ? AND service IN ({placeholders}) GROUP BY service
            """,
            [dow, hour, *services],
        ).fetchall()
        total = sum(n for _, n in by_service)
        return {
            "available": True,
            "month": self._meta["month"],
            "dow": dow,
            "hour": hour,
            "days_in_sample": days,
            "services": services,
            "street_paths": self.paths.available,
            # everything below is divided by the number of such weekdays in the
            # month, i.e. it's the average for ONE such hour.
            "trips_per_hour": round(total / days),
            "by_service": {s: round(n / days) for s, n in by_service},
            # trips in the hour that the particles cannot show
            "same_zone_per_hour": round(undrawn[0] / days),
            "unknown_zone_per_hour": round(undrawn[1] / days),
            "drawable_per_hour": round((total - undrawn[0] - undrawn[1]) / days),
            # [pickup_zone, dropoff_zone, trips_per_hour, avg_trip_seconds, service, n_path_variants]  (busiest pairs)
            "flows": [
                [pu, do, round(n / days, 2), secs, svc, len(self.paths.variants(pu, do))] for pu, do, n, secs, svc in flows
            ],
            "zones": [[zid, round(p / days, 1), round(d / days, 1)] for zid, p, d in zones],
        }

    # ---- sampled trips with their street paths -------------------------------------
    def trips_bytes(self, dow: int, hour: int, services: list[str], n: int) -> bytes:
        """`n` trips drawn from the WHOLE zone-to-zone distribution for that hour.

        Systematic sampling (evenly spaced points along the cumulative trip count, with
        a seeded offset) so every pair gets particles in proportion to its trips - a pair
        with 0.3 trips/hour gets a particle 30 % of the time - and the same hour always
        looks the same. Each particle stands for `tripsPerDot` real trips per hour.

        Layout (little-endian):
          uint32 magic 'TXIQ', uint32 nTrips, uint32 nPaths, uint32 nVerts,
          float32 tripsPerDot, uint32 daysInSample
          uint32 pathVertStart[nPaths + 1]        vertices of path j are [start[j], start[j+1])
          {uint16 pu, uint16 dropoff, uint16 service, uint16 avg_secs, int32 path} [nTrips]
          float32 verts[nVerts * 3]               lon, lat, z (metres relative to street level)
        `service` indexes SERVICES; `path` is -1 when the pair has no routed street path.
        """
        rows = self._rows(dow, hour, services) if self.available else []
        days = max(1, self._meta["days"].get(dow, 4)) if rows else 1
        n = max(1, min(int(n), 80000))
        if not rows:
            return struct.pack("<IIIIfI", TRIPS_MAGIC, 0, 0, 0, 0.0, days) + struct.pack("<I", 0)

        trips = np.array([r[2] for r in rows], dtype=np.float64)
        cum = np.cumsum(trips)
        total = float(cum[-1])
        step = total / n
        rng = np.random.default_rng(dow * 24 + hour)
        points = rng.random() * step + step * np.arange(n)
        idx = np.minimum(np.searchsorted(cum, points, side="right"), len(rows) - 1)
        counts = np.bincount(idx, minlength=len(rows))

        svc_index = {s: i for i, s in enumerate(SERVICES)}
        path_ids: dict[tuple[int, int], int] = {}
        path_chunks: list = []
        path_start = [0]
        n_verts = 0
        recs = np.zeros(n, dtype=[("pu", "<u2"), ("do", "<u2"), ("svc", "<u2"), ("secs", "<u2"), ("path", "<i4")])
        k = 0
        for i in np.nonzero(counts)[0]:
            pu, do, _, secs, svc = rows[i]
            variants = self.paths.variants(pu, do) if self.paths.available else []
            for j in range(int(counts[i])):
                pid = -1
                if variants:
                    off, ln = variants[j % len(variants)]
                    key = (off, ln)
                    pid = path_ids.get(key)
                    if pid is None:
                        pid = len(path_start) - 1
                        path_ids[key] = pid
                        path_chunks.append(self.paths.verts[off : off + ln])
                        n_verts += ln
                        path_start.append(n_verts)
                recs[k] = (pu, do, svc_index.get(svc, 3), min(int(secs or 0), 65535), pid)
                k += 1
        recs = recs[:k]
        verts = np.concatenate(path_chunks) if path_chunks else np.zeros((0, 3), np.float32)
        head = struct.pack("<IIIIfI", TRIPS_MAGIC, len(recs), len(path_start) - 1, n_verts, step / days, days)
        return (
            head
            + np.asarray(path_start, dtype=np.uint32).tobytes()
            + recs.tobytes()
            + np.ascontiguousarray(verts, dtype=np.float32).tobytes()
        )

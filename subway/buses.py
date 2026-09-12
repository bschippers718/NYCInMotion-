"""MTA Bus Time GTFS-Realtime vehicle positions.

Unlike the subway, buses report real GPS: latitude, longitude and bearing for
every vehicle in service (~3,500-5,000). The feed is public; a developer key
(https://register.developer.obanyc.com/) is optional and is sent if MTA_BUS_KEY
is set. Each vehicle is tagged with the index of its route shape from
data/bus_network.json (built by scripts/build_bus_static.py) so the browser can
snap the GPS fix to the street route and animate along it.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import requests
from google.transit import gtfs_realtime_pb2 as rt

from .poller import Poller

log = logging.getLogger(__name__)

VEHICLES_URL = "https://gtfsrt.prod.obanyc.com/vehiclePositions"
STATUS = {0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO"}
PREFIXES = ("MTA NYCT_", "MTABC_", "MTA_")
OCCUPANCY = {0: "empty", 1: "many seats", 2: "few seats", 3: "standing", 4: "crushed", 5: "full", 6: "not accepting"}


def strip_prefix(s: str) -> str:
    for p in PREFIXES:
        if s.startswith(p):
            return s[len(p):]
    return s


class BusNetwork:
    """Static bus routes/shapes (optional - the live layer works without them)."""

    def __init__(self, data_dir: Path):
        self.network_path = data_dir / "bus_network.json"
        self.trips_path = data_dir / "bus_trips.json"
        self.trip_shape: dict[str, int] = {}
        self.routes: dict[str, dict] = {}
        self._network_bytes: bytes | None = None
        if self.trips_path.exists():
            self.trip_shape = json.loads(self.trips_path.read_text())
        if self.network_path.exists():
            self.routes = json.loads(self.network_path.read_text())["routes"]

    @property
    def available(self) -> bool:
        return bool(self.trip_shape) and self.network_path.exists()

    def network_bytes(self) -> bytes:
        if self._network_bytes is None:
            self._network_bytes = self.network_path.read_bytes() if self.network_path.exists() else b'{"routes":{},"shapes":[]}'
        return self._network_bytes


class BusPoller(Poller):
    name = "bus-poller"

    def __init__(self, network: BusNetwork, key: str | None = None, interval: float = 10.0, timeout: float = 30.0):
        super().__init__(interval)
        self.network = network
        self.key = key or os.environ.get("MTA_BUS_KEY")
        self.timeout = timeout
        self._buses: list[dict] = []
        self._header_ts: int | None = None
        self._session = requests.Session()
        self._session.headers["User-Agent"] = "nyc-in-motion/1.0"

    def decode(self, raw: bytes) -> tuple[list[dict], int | None]:
        msg = rt.FeedMessage()
        msg.ParseFromString(raw)
        out = []
        for ent in msg.entity:
            if not ent.HasField("vehicle"):
                continue
            v = ent.vehicle
            if not v.HasField("position"):
                continue
            has_trip = v.HasField("trip")
            route = strip_prefix(v.trip.route_id) if has_trip else ""
            trip_id = strip_prefix(v.trip.trip_id) if has_trip else None
            meta = self.network.routes.get(route, {})
            out.append(
                {
                    "id": strip_prefix(v.vehicle.id) or ent.id,
                    "route": route,
                    "trip_id": trip_id,
                    "shape": self.network.trip_shape.get(trip_id) if trip_id else None,
                    "direction": v.trip.direction_id if has_trip and v.trip.HasField("direction_id") else None,
                    "lat": round(v.position.latitude, 6),
                    "lon": round(v.position.longitude, 6),
                    "bearing": round(v.position.bearing, 1) if v.position.HasField("bearing") else None,
                    "speed_mps": round(v.position.speed, 1) if v.position.HasField("speed") else None,
                    "status": STATUS.get(v.current_status, "IN_TRANSIT_TO"),
                    "stop_id": strip_prefix(v.stop_id) or None,
                    "ts": v.timestamp or None,
                    "occupancy": OCCUPANCY.get(v.occupancy_status) if v.HasField("occupancy_status") else None,
                    "color": meta.get("color", "#f28c28"),
                }
            )
        return out, (msg.header.timestamp or None)

    def fetch(self) -> None:
        params = {"key": self.key} if self.key else None
        resp = self._session.get(VEHICLES_URL, params=params, timeout=self.timeout)
        if resp.status_code in (401, 403):
            raise RuntimeError(f"MTA Bus Time rejected the request (HTTP {resp.status_code})")
        resp.raise_for_status()
        buses, header_ts = self.decode(resp.content)
        with self._lock:
            self._buses, self._header_ts = buses, header_ts

    def snapshot(self) -> dict:
        with self._lock:
            now = time.time()
            return {
                "available": True,
                "error": self.last_error,
                "header_ts": self._header_ts,
                "age_s": int(now - self._header_ts) if self._header_ts else None,
                "count": len(self._buses),
                "has_shapes": self.network.available,
                "buses": list(self._buses),
            }

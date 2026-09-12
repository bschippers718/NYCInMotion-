"""NYC Ferry GTFS-Realtime vehicle positions (public, no key)."""
from __future__ import annotations

import json
import time
from pathlib import Path

import requests
from google.transit import gtfs_realtime_pb2 as rt

from .poller import Poller

VEHICLES_URL = "https://nycferry.connexionz.net/rtt/public/utility/gtfsrealtime.aspx/vehicleposition"
STATUS = {0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO"}


class FerryPoller(Poller):
    name = "ferry-poller"

    def __init__(self, data_dir: Path, interval: float = 15.0, timeout: float = 20.0):
        super().__init__(interval)
        self.timeout = timeout
        self.path = data_dir / "ferry_network.json"
        self.network = json.loads(self.path.read_text()) if self.path.exists() else {"routes": {}, "shapes": [], "trips": {}}
        self._network_bytes: bytes | None = None
        self._vessels: list[dict] = []
        self._header_ts: int | None = None
        self._session = requests.Session()

    @property
    def available(self) -> bool:
        return self.path.exists()

    def network_bytes(self) -> bytes:
        if self._network_bytes is None:
            self._network_bytes = self.path.read_bytes() if self.path.exists() else b'{"routes":{},"shapes":[],"trips":{}}'
        return self._network_bytes

    def fetch(self) -> None:
        resp = self._session.get(VEHICLES_URL, timeout=self.timeout)
        resp.raise_for_status()
        msg = rt.FeedMessage()
        msg.ParseFromString(resp.content)
        out = []
        for ent in msg.entity:
            if not ent.HasField("vehicle") or not ent.vehicle.HasField("position"):
                continue
            v = ent.vehicle
            trip_id = v.trip.trip_id if v.HasField("trip") else None
            shape = self.network["trips"].get(trip_id) if trip_id else None
            route = self.network["shapes"][shape]["route"] if shape is not None else None
            out.append(
                {
                    "id": v.vehicle.id or ent.id,
                    "label": v.vehicle.label or None,
                    "trip_id": trip_id,
                    "shape": shape,
                    "route": route,
                    "color": self.network["routes"].get(route, {}).get("color", "#00839C"),
                    "lat": round(v.position.latitude, 6),
                    "lon": round(v.position.longitude, 6),
                    "bearing": round(v.position.bearing, 1) if v.position.HasField("bearing") else None,
                    "speed_mps": round(v.position.speed, 1) if v.position.HasField("speed") else None,
                    "status": STATUS.get(v.current_status, "IN_TRANSIT_TO"),
                    "ts": v.timestamp or None,
                }
            )
        with self._lock:
            self._vessels, self._header_ts = out, (msg.header.timestamp or None)

    def snapshot(self) -> dict:
        with self._lock:
            now = time.time()
            return {
                "available": True,
                "error": self.last_error,
                "header_ts": self._header_ts,
                "age_s": int(now - self._header_ts) if self._header_ts else None,
                "count": len(self._vessels),
                "vessels": list(self._vessels),
            }

"""Fetch and decode the MTA's GTFS-Realtime subway feeds.

The MTA publishes eight protobuf feeds (one per line group) with no API key
required. Each feed carries a TripUpdate (upcoming stops + predicted times) and a
VehiclePosition (current stop / status) for every active train.
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import requests
from google.transit import gtfs_realtime_pb2 as rt

log = logging.getLogger(__name__)

BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F"
FEEDS = {
    "1234567S": BASE + "gtfs",
    "ACE": BASE + "gtfs-ace",
    "BDFM": BASE + "gtfs-bdfm",
    "G": BASE + "gtfs-g",
    "JZ": BASE + "gtfs-jz",
    "L": BASE + "gtfs-l",
    "NQRW": BASE + "gtfs-nqrw",
    "SIR": BASE + "gtfs-si",
}

STATUS = {0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO"}


@dataclass
class StopTime:
    stop_id: str
    time: int  # unix seconds (arrival if present, else departure)
    departure: int = 0  # unix seconds, 0 if the feed has none


@dataclass
class Trip:
    key: str
    trip_id: str
    route_id: str
    start_date: str
    start_time: str
    direction: str  # "N" / "S" / ""
    feed: str
    upcoming: list[StopTime] = field(default_factory=list)
    status: str | None = None
    vehicle_stop: str | None = None
    vehicle_ts: int | None = None
    stop_sequence: int | None = None
    trip_update_ts: int | None = None

    @property
    def shape_id(self) -> str | None:
        # NYCT trip ids look like "097400_A..N55R"; the suffix is a static shape id.
        return self.trip_id.split("_", 1)[1] if "_" in self.trip_id else None


@dataclass
class FeedStatus:
    name: str
    ok: bool
    fetched_at: float
    header_ts: int | None
    n_trips: int
    error: str | None = None
    latency_ms: int = 0


def _direction_from(trip_id: str, upcoming: list[StopTime], vehicle_stop: str | None) -> str:
    for sid in ([vehicle_stop] if vehicle_stop else []) + [s.stop_id for s in upcoming]:
        if sid and sid[-1] in "NS":
            return sid[-1]
    if ".." in trip_id:
        tail = trip_id.split("..", 1)[1]
        if tail and tail[0] in "NS":
            return tail[0]
    return ""


def decode(name: str, raw: bytes) -> tuple[dict[str, Trip], int | None]:
    msg = rt.FeedMessage()
    msg.ParseFromString(raw)
    trips: dict[str, Trip] = {}

    def get(desc) -> Trip:
        key = f"{desc.start_date}|{desc.trip_id}"
        t = trips.get(key)
        if t is None:
            t = Trip(
                key=key,
                trip_id=desc.trip_id,
                route_id=desc.route_id,
                start_date=desc.start_date,
                start_time=desc.start_time,
                direction="",
                feed=name,
            )
            trips[key] = t
        return t

    for ent in msg.entity:
        if ent.HasField("trip_update"):
            tu = ent.trip_update
            t = get(tu.trip)
            t.trip_update_ts = tu.timestamp or None
            t.upcoming = [
                StopTime(
                    stu.stop_id,
                    (stu.arrival.time if stu.HasField("arrival") and stu.arrival.time else stu.departure.time),
                    stu.departure.time if stu.HasField("departure") else 0,
                )
                for stu in tu.stop_time_update
                if stu.stop_id
            ]
        if ent.HasField("vehicle"):
            v = ent.vehicle
            t = get(v.trip)
            t.status = STATUS.get(v.current_status, "IN_TRANSIT_TO")
            t.vehicle_stop = v.stop_id or None
            t.vehicle_ts = v.timestamp or None
            t.stop_sequence = v.current_stop_sequence or None

    for t in trips.values():
        t.direction = _direction_from(t.trip_id, t.upcoming, t.vehicle_stop)

    return trips, (msg.header.timestamp or None)


class FeedPoller:
    """Polls all feeds on a background thread and keeps the latest decoded trips."""

    def __init__(self, interval: float = 15.0, timeout: float = 20.0):
        self.interval = interval
        self.timeout = timeout
        self._lock = threading.Lock()
        self._trips: dict[str, Trip] = {}
        self._status: dict[str, FeedStatus] = {}
        self._session = requests.Session()
        self._session.headers["User-Agent"] = "subway-live-map/0.1"
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _fetch_one(self, name: str, url: str) -> tuple[str, dict[str, Trip], FeedStatus]:
        t0 = time.time()
        try:
            resp = self._session.get(url, timeout=self.timeout)
            resp.raise_for_status()
            trips, header_ts = decode(name, resp.content)
            st = FeedStatus(name, True, time.time(), header_ts, len(trips), latency_ms=int((time.time() - t0) * 1000))
            return name, trips, st
        except Exception as exc:  # noqa: BLE001 - keep polling on any failure
            log.warning("feed %s failed: %s", name, exc)
            st = FeedStatus(name, False, time.time(), None, 0, error=str(exc), latency_ms=int((time.time() - t0) * 1000))
            return name, {}, st

    def refresh(self) -> None:
        with ThreadPoolExecutor(max_workers=len(FEEDS)) as ex:
            results = list(ex.map(lambda kv: self._fetch_one(*kv), FEEDS.items()))
        with self._lock:
            for name, trips, st in results:
                self._status[name] = st
                if st.ok:
                    # replace this feed's trips wholesale
                    self._trips = {k: v for k, v in self._trips.items() if v.feed != name}
                    self._trips.update(trips)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.refresh()
            except Exception:  # noqa: BLE001
                log.exception("refresh failed")
            self._stop.wait(self.interval)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="feed-poller", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def snapshot(self) -> tuple[list[Trip], dict[str, FeedStatus]]:
        with self._lock:
            return list(self._trips.values()), dict(self._status)

"""Turn GTFS-RT trip/vehicle records into a *motion model* for every train.

The MTA feeds do not include GPS coordinates. What they give us per train is:
  * the stop the train is at (STOPPED_AT) or heading to (IN_TRANSIT_TO / INCOMING_AT)
  * predicted arrival / departure times at each upcoming stop

Each train is snapped onto its track shape (from the static GTFS) and described
as a point moving along that shape:

    shape     the track polyline it is on
    dist      metres along the shape right now (server's best estimate)
    dist_to   metres along the shape of the next stop
    eta       when it should reach `dist_to` (unix seconds) - may be None
    dwell     when a stopped train is expected to leave (unix seconds) - may be None

The browser also has the shapes, so it can move the train along the real track
every frame between server updates instead of drawing straight lines between
two snapshots. The server keeps a little state per trip so that the estimate is
monotonic (trains never slide backwards when a prediction is revised) and so
that a train we watched leave a station is interpolated on elapsed time rather
than on the timetable.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta

from .feeds import Trip
from .network import Shape, StaticData, canonical_route

ARRIVAL_HOLD = 0.985  # stop interpolating a few metres before the platform until the feed confirms arrival
BACKWARD_SNAP_M = 350.0  # a revision larger than this is a re-identification, not jitter: snap to it
DEFAULT_RUN_S = 120  # scheduled running time fallback between two stops
STOP_FRESH_S = 12  # a STOPPED_AT observed this recently is believed even if ETAs disagree


@dataclass
class TrackState:
    shape_id: str
    dist: float
    ts: float


class PositionEstimator:
    def __init__(self, static: StaticData):
        self.static = static
        # trip key -> (stop_id, ts) of the last stop we saw the train STOPPED_AT
        self._last_stopped: dict[str, tuple[str, int]] = {}
        # trip key -> (next_stop_id, departed_at, trusted). The MTA's vehicle
        # timestamp is "last observed", not "departed", so we detect departures
        # ourselves: the moment a train's next stop changes (or it leaves
        # STOPPED_AT). `trusted` is False for the first observation of a trip,
        # when we can't know how long it has already been moving.
        self._segment: dict[str, tuple[str, float, bool]] = {}
        # trip key -> last published distance along its shape (monotonic filter)
        self._track: dict[str, TrackState] = {}

    # ---- helpers -------------------------------------------------------------
    @staticmethod
    def _upcoming_of(t: Trip, now: float) -> list:
        """Upcoming stops with stale (already passed) entries dropped; keeps at least one."""
        return [s for s in t.upcoming if s.time == 0 or s.time >= now - 15] or t.upcoming[-1:]

    def _next_stop_of(self, t: Trip, now: float) -> str | None:
        upcoming = self._upcoming_of(t, now)
        nxt = upcoming[0].stop_id if upcoming else t.vehicle_stop
        # the vehicle record says which stop it's heading to; trust it when upcoming
        if t.vehicle_stop and t.vehicle_stop != nxt and any(s.stop_id == t.vehicle_stop for s in upcoming):
            nxt = t.vehicle_stop
        return nxt

    def _remember(self, trips: list[Trip], now: float) -> None:
        seen = set()
        for t in trips:
            seen.add(t.key)
            at = t.vehicle_stop if t.status == "STOPPED_AT" and t.vehicle_stop else None
            if at:
                self._last_stopped[t.key] = (at, int(now))
                after = [s for s in self._upcoming_of(t, now) if s.stop_id != at]
                nxt = after[0].stop_id if after else None
            else:
                nxt = self._next_stop_of(t, now)
            if not nxt:
                continue
            prev = self._segment.get(t.key)
            if prev is None:
                self._segment[t.key] = (nxt, now, False)
            elif prev[0] != nxt:
                # the train's next stop just changed: it passed / left a stop about now
                self._segment[t.key] = (nxt, now, True)
        for store in (self._last_stopped, self._segment, self._track):
            for k in [k for k in store if k not in seen]:
                del store[k]

    @staticmethod
    def origin_time(t: Trip) -> float | None:
        """Scheduled departure from the origin terminal, as unix seconds.

        NYCT trip ids start with the origin time in hundredths of a minute past
        midnight (e.g. "097400_A..N55R" -> 974.00 min -> 16:14:00).
        """
        try:
            day = datetime.strptime(t.start_date, "%Y%m%d")
        except ValueError:
            return None
        prefix = t.trip_id.split("_", 1)[0]
        if prefix.isdigit():
            return (day + timedelta(minutes=int(prefix) / 100)).timestamp()
        if t.start_time:
            try:
                h, m, s = (int(x) for x in t.start_time.split(":"))
                return (day + timedelta(hours=h, minutes=m, seconds=s)).timestamp()
            except ValueError:
                return None
        return None

    def _filter_dist(self, key: str, shape: Shape, raw: float, dist_to: float | None, now: float) -> float:
        """Monotonic filter: don't publish a train sliding backwards because an ETA was revised."""
        st = self._track.get(key)
        dist = raw
        if st and st.shape_id == shape.id:
            if raw < st.dist:
                behind_target = dist_to is not None and dist_to < st.dist - 1
                if st.dist - raw < BACKWARD_SNAP_M and not behind_target:
                    dist = st.dist  # hold until the estimate catches up
        self._track[key] = TrackState(shape.id, dist, now)
        return dist

    # ---- main entry point ----------------------------------------------------
    def estimate(self, trips: list[Trip], now: float | None = None, include_scheduled: bool = False) -> list[dict]:
        now = now or time.time()
        self._remember(trips, now)
        out = []
        for t in trips:
            pos = self._estimate_one(t, now)
            if pos and (include_scheduled or not pos["scheduled"]):
                out.append(pos)
        return out

    def _estimate_one(self, t: Trip, now: float) -> dict | None:
        st = self.static
        route_id = canonical_route(t.route_id)
        route = st.route(route_id)
        shape = st.find_shape(t)
        origin = self.origin_time(t)
        # A trip is "scheduled" (not yet departed) if its origin time is still in
        # the future and the feed hasn't shown it stopped anywhere yet.
        scheduled = bool(origin and origin > now + 30 and t.status != "STOPPED_AT")

        upcoming = self._upcoming_of(t, now)
        next_stop = self._next_stop_of(t, now)
        next_eta = next((s.time for s in upcoming if s.stop_id == next_stop and s.time), None)

        status = t.status or "IN_TRANSIT_TO"
        prev_stop = None
        progress = 0.0
        lat = lon = z = bearing = None
        dist = dist_to = dwell = None
        method = "none"

        # The vehicle record's STOPPED_AT lingers long after the train has left
        # (the MTA only refreshes it at the next stop), so the trip update's ETAs
        # are the primary signal. "at" is the stop the train is (or was) standing at.
        at = t.vehicle_stop if status == "STOPPED_AT" and t.vehicle_stop else None
        if at:
            here = next((s for s in upcoming if s.stop_id == at), None)
            after = [s for s in upcoming if s.stop_id != at]
            if after:
                next_stop, next_eta = after[0].stop_id, after[0].time or None
            else:
                next_stop, next_eta = at, None  # terminal
            if here and here.departure and here.departure > now - 5:
                dwell = here.departure  # the feed tells us when it leaves
            if t.vehicle_ts and now - t.vehicle_ts < STOP_FRESH_S:
                dwell = max(dwell or 0, now + STOP_FRESH_S - (now - t.vehicle_ts))  # just observed standing there

        if shape and next_stop in shape.stop_dist:
            dist_to = shape.stop_dist[next_stop]
            if at and at in shape.stop_dist and shape.stop_dist[at] <= dist_to:
                prev_stop = at
            else:
                # previous stop: last observed stop if it is behind us on this shape,
                # else the stop immediately before `next_stop` on the shape
                remembered = self._last_stopped.get(t.key)
                if remembered and remembered[0] in shape.stop_dist and shape.stop_dist[remembered[0]] < dist_to:
                    prev_stop = remembered[0]
                else:
                    prev_stop = shape.stop_before(next_stop)

            if prev_stop is None or dist_to <= shape.stop_dist[prev_stop]:
                progress, raw, method = 1.0, dist_to, "shape-terminal"
                prev_stop = prev_stop if prev_stop != next_stop else None
            else:
                d_prev = shape.stop_dist[prev_stop]
                seg = self._segment.get(t.key)
                dep = seg[1] if seg and seg[2] and seg[0] == next_stop else None
                travel = shape.stop_sched.get(next_stop, 0) - shape.stop_sched.get(prev_stop, 0)
                travel = travel if travel > 0 else DEFAULT_RUN_S
                # Effective departure from prev_stop: the latest of (a) when it must
                # leave to make its ETA at scheduled speed, (b) when we saw its next
                # stop change, (c) the feed's own departure time / a fresh STOPPED_AT.
                dep_eff = next_eta - travel if next_eta else None
                if dep is not None:
                    dep_eff = dep if dep_eff is None else max(dep_eff, dep)
                if dwell and dwell > now:
                    dep_eff = dwell if dep_eff is None else max(dep_eff, dwell)
                if dep_eff is None:
                    progress, method = (0.0, "shape-stop") if at else (0.5, "shape-mid")
                elif dep_eff >= now:
                    progress, method = 0.0, "shape-stop"  # standing at the platform
                    if at or dep_eff - now < 90:
                        dwell = dep_eff
                elif next_eta and next_eta > dep_eff + 5:
                    progress, method = (now - dep_eff) / (next_eta - dep_eff), "shape-interp-eta"
                else:
                    progress, method = (now - dep_eff) / travel, "shape-interp-sched"
                progress = max(0.0, min(ARRIVAL_HOLD, progress))
                raw = d_prev + (dist_to - d_prev) * progress
            dist = self._filter_dist(t.key, shape, raw, dist_to, now)
            lat, lon, z, bearing = shape.point_at(dist)
        else:
            c = st.stop_coords(at or next_stop)
            if c:
                lat, lon, z = c
                method = "stop"
                prev_stop = at

        if lat is None:
            return None

        # what the train is actually doing right now (the feed's status is stale)
        if method in ("shape-stop", "stop", "shape-terminal"):
            status = "STOPPED_AT"
        elif progress >= ARRIVAL_HOLD:
            status = "INCOMING_AT"
        else:
            status = "IN_TRANSIT_TO"

        return {
            "id": t.key,
            "trip_id": t.trip_id,
            "route": route_id,
            "route_color": route.get("color", "#808183"),
            "route_text_color": route.get("text_color", "#FFFFFF"),
            "direction": t.direction,
            "status": status,
            "feed_status": t.status,
            "scheduled": scheduled,
            "origin_time": int(origin) if origin else None,
            # --- motion model (what the browser animates with) ---
            "shape": shape.id if shape else None,
            "dist": round(dist, 1) if dist is not None else None,
            "dist_to": round(dist_to, 1) if dist_to is not None else None,
            "eta": next_eta,
            "dwell": int(dwell) if dwell else None,
            # --- instantaneous estimate (2D map, tooltips, non-shape fallbacks) ---
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "z": round(z, 1) if z is not None else None,
            "bearing": round(bearing, 1) if bearing is not None else None,
            "progress": round(progress, 3),
            "prev_stop": prev_stop,
            "prev_stop_name": st.stop_name(prev_stop),
            "next_stop": next_stop,
            "next_stop_name": st.stop_name(next_stop),
            "eta_s": (int(next_eta - now) if next_eta else None),
            "vehicle_ts": t.vehicle_ts,
            "method": method,
            "upcoming": [
                {"stop": s.stop_id, "name": st.stop_name(s.stop_id), "time": s.time or None} for s in upcoming[:8]
            ],
        }

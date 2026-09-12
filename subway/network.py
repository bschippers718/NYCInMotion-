"""The static subway network compiled by scripts/build_static.py."""
from __future__ import annotations

import bisect
import json
from dataclasses import dataclass
from pathlib import Path

from .feeds import Trip
from .geo import bearing_deg

# Route ids that appear in the realtime feeds under a different name than in the
# static GTFS.
ROUTE_ALIASES = {"SS": "SI", "S": "GS"}


def canonical_route(route_id: str) -> str:
    return ROUTE_ALIASES.get(route_id, route_id)


@dataclass
class Shape:
    id: str
    route: str
    points: list[list[float]]  # [lat, lon, z]
    cum: list[float]
    stop_dist: dict[str, float]
    stop_sched: dict[str, int]
    stop_order: list[str]

    @property
    def length(self) -> float:
        return self.cum[-1]

    def point_at(self, dist: float) -> tuple[float, float, float, float]:
        """(lat, lon, z, bearing_deg) at `dist` metres along the shape."""
        pts = self.points
        if dist <= 0:
            i, t = 0, 0.0
        elif dist >= self.cum[-1]:
            i, t = len(pts) - 2, 1.0
        else:
            i = bisect.bisect_right(self.cum, dist) - 1
            seg = self.cum[i + 1] - self.cum[i]
            t = (dist - self.cum[i]) / seg if seg > 0 else 0.0
        a, b = pts[i], pts[i + 1]
        lat = a[0] + (b[0] - a[0]) * t
        lon = a[1] + (b[1] - a[1]) * t
        z = a[2] + (b[2] - a[2]) * t
        j = min(i + 3, len(pts) - 1)
        return lat, lon, z, bearing_deg(a[0], a[1], pts[j][0], pts[j][1])

    def stop_before(self, stop_id: str) -> str | None:
        idx = self.stop_order.index(stop_id)
        return self.stop_order[idx - 1] if idx > 0 else None


class StaticData:
    def __init__(self, path: Path):
        raw = json.loads(Path(path).read_text())
        self.routes: dict[str, dict] = raw["routes"]
        self.stops: dict[str, dict] = raw["stops"]
        self.structure_z: dict[str, float] = raw.get("structure_z", {})
        self.shapes: dict[str, Shape] = {}
        self.shapes_by_route: dict[str, list[Shape]] = {}
        for sid, s in raw["shapes"].items():
            pts = [p if len(p) == 3 else [p[0], p[1], -16.0] for p in s["points"]]
            shape = Shape(
                id=sid,
                route=s["route"],
                points=pts,
                cum=s["cum"],
                stop_dist={st["id"]: st["dist"] for st in s["stops"]},
                stop_sched={st["id"]: st["sched"] for st in s["stops"]},
                stop_order=[st["id"] for st in s["stops"]],
            )
            self.shapes[sid] = shape
            self.shapes_by_route.setdefault(shape.route, []).append(shape)

    # ---- lookups ------------------------------------------------------------
    def route(self, route_id: str) -> dict:
        rid = canonical_route(route_id)
        return self.routes.get(rid) or self.routes.get(rid.rstrip("X")) or {}

    def station_of(self, stop_id: str | None) -> dict | None:
        s = self.stops.get(stop_id or "")
        if not s:
            return None
        return self.stops.get(s.get("parent") or "") or s

    def stop_name(self, stop_id: str | None) -> str | None:
        st = self.station_of(stop_id)
        return st["name"] if st else None

    def stop_coords(self, stop_id: str | None):
        s = self.stops.get(stop_id or "")
        if not s:
            return None
        st = self.station_of(stop_id) or s
        return s["lat"], s["lon"], st.get("z", -16.0)

    def find_shape(self, trip: Trip) -> Shape | None:
        """Best shape for a trip: exact id from the trip_id, else best stop overlap."""
        sid = trip.shape_id
        if sid and sid in self.shapes:
            return self.shapes[sid]
        wanted = [s.stop_id for s in trip.upcoming]
        if trip.vehicle_stop:
            wanted.insert(0, trip.vehicle_stop)
        if not wanted:
            return None
        route_id = canonical_route(trip.route_id)
        candidates = self.shapes_by_route.get(route_id) or self.shapes_by_route.get(route_id.rstrip("X"), [])
        best, best_score = None, 0
        for sh in candidates:
            if trip.direction and not sh.id.split("..", 1)[-1].startswith(trip.direction):
                continue
            score = sum(1 for w in wanted if w in sh.stop_dist)
            if wanted[0] in sh.stop_dist and score > best_score:  # must contain the very next stop
                best, best_score = sh, score
        return best

    # ---- payload for the browser --------------------------------------------
    def network_payload(self) -> dict:
        stations = [
            {
                "id": s["id"],
                "name": s["name"],
                "lat": s["lat"],
                "lon": s["lon"],
                "z": s.get("z", -16.0),
                "structure": s.get("structure"),
                "borough": s.get("borough"),
                "complex": s.get("complex"),
            }
            for s in self.stops.values()
            if s["is_station"]
        ]
        shapes = [
            {
                "id": sh.id,
                "route": sh.route,
                "points": sh.points,
                "stops": [{"id": sid, "dist": sh.stop_dist[sid]} for sid in sh.stop_order],
            }
            for sh in self.shapes.values()
        ]
        return {"routes": self.routes, "stations": stations, "shapes": shapes, "structure_z": self.structure_z}

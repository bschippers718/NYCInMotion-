"""Small geometry helpers shared by the build scripts and the server.

Everything works in WGS84 degrees for storage and in metres for distances. For
"local" planar maths we use an equirectangular projection around New York, which
is accurate to well under a metre at city scale.
"""
from __future__ import annotations

import bisect
import math
from typing import Iterable, Sequence

EARTH_R = 6371000.0
NYC_LAT = 40.73
M_PER_DEG_LAT = math.pi / 180 * EARTH_R
M_PER_DEG_LON = M_PER_DEG_LAT * math.cos(math.radians(NYC_LAT))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def to_xy(lat: float, lon: float) -> tuple[float, float]:
    """Local planar metres (x east, y north) relative to the NYC origin."""
    return (lon + 73.94) * M_PER_DEG_LON, (lat - NYC_LAT) * M_PER_DEG_LAT


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) - math.sin(math.radians(lat1)) * math.cos(
        math.radians(lat2)
    ) * math.cos(math.radians(lon2 - lon1))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def cumulative(points: Sequence[Sequence[float]]) -> list[float]:
    """Cumulative metres along a [[lat, lon], ...] polyline."""
    cum = [0.0]
    for i in range(1, len(points)):
        cum.append(cum[-1] + haversine_m(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]))
    return cum


def project_onto_polyline(points: Sequence[Sequence[float]], cum: Sequence[float], lat: float, lon: float) -> tuple[float, float]:
    """(distance along polyline, offset metres) of the closest point to (lat, lon)."""
    best_d2 = float("inf")
    best_dist = 0.0
    px, py = to_xy(lat, lon)
    ax, ay = to_xy(points[0][0], points[0][1])
    for i in range(len(points) - 1):
        bx, by = to_xy(points[i + 1][0], points[i + 1][1])
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
        qx, qy = ax + t * dx, ay + t * dy
        d2 = (px - qx) ** 2 + (py - qy) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best_dist = cum[i] + t * (cum[i + 1] - cum[i])
        ax, ay = bx, by
    return best_dist, math.sqrt(best_d2)


def point_at(points: Sequence[Sequence[float]], cum: Sequence[float], dist: float) -> tuple[float, float, float]:
    """(lat, lon, bearing) at `dist` metres along the polyline (clamped to its ends)."""
    n = len(points)
    if n == 1:
        return points[0][0], points[0][1], 0.0
    if dist <= 0:
        i, t = 0, 0.0
    elif dist >= cum[-1]:
        i, t = n - 2, 1.0
    else:
        i = bisect.bisect_right(cum, dist) - 1
        seg = cum[i + 1] - cum[i]
        t = (dist - cum[i]) / seg if seg > 0 else 0.0
    a, b = points[i], points[i + 1]
    lat = a[0] + (b[0] - a[0]) * t
    lon = a[1] + (b[1] - a[1]) * t
    j = min(i + 2, n - 1)  # look a little ahead for a stable heading
    return lat, lon, bearing_deg(a[0], a[1], points[j][0], points[j][1])


def interp_1d(xs: Sequence[float], ys: Sequence[float], x: float) -> float:
    """Piecewise-linear interpolation with flat extrapolation."""
    if not xs:
        return 0.0
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    i = bisect.bisect_right(xs, x) - 1
    span = xs[i + 1] - xs[i]
    t = (x - xs[i]) / span if span > 0 else 0.0
    return ys[i] + (ys[i + 1] - ys[i]) * t


def simplify(points: Sequence[Sequence[float]], tolerance_m: float) -> list:
    """Douglas-Peucker on [[lat, lon, ...], ...] keeping extra per-point fields."""
    if len(points) <= 2:
        return list(points)
    xy = [to_xy(p[0], p[1]) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tol2 = tolerance_m * tolerance_m
    while stack:
        s, e = stack.pop()
        ax, ay = xy[s]
        bx, by = xy[e]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        worst, worst_i = 0.0, -1
        for i in range(s + 1, e):
            px, py = xy[i]
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
            d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > worst:
                worst, worst_i = d2, i
        if worst > tol2 and worst_i > 0:
            keep[worst_i] = True
            stack.append((s, worst_i))
            stack.append((worst_i, e))
    return [p for p, k in zip(points, keep) if k]


class GridIndex:
    """Uniform grid over local xy metres for nearest-segment queries."""

    def __init__(self, cell_m: float = 60.0):
        self.cell = cell_m
        self.cells: dict[tuple[int, int], list] = {}

    def _key(self, x: float, y: float) -> tuple[int, int]:
        return int(math.floor(x / self.cell)), int(math.floor(y / self.cell))

    def add_segment(self, ax: float, ay: float, bx: float, by: float, payload) -> None:
        # rasterise the segment's bounding box (segments are short; fine)
        x0, x1 = sorted((ax, bx))
        y0, y1 = sorted((ay, by))
        kx0, ky0 = self._key(x0, y0)
        kx1, ky1 = self._key(x1, y1)
        item = (ax, ay, bx, by, payload)
        for kx in range(kx0, kx1 + 1):
            for ky in range(ky0, ky1 + 1):
                self.cells.setdefault((kx, ky), []).append(item)

    def nearest(self, x: float, y: float, max_dist_m: float):
        """(distance, payload) of the nearest segment within max_dist_m, else (None, None)."""
        r = int(math.ceil(max_dist_m / self.cell))
        kx, ky = self._key(x, y)
        best_d2, best = max_dist_m * max_dist_m, None
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                for ax, ay, bx, by, payload in self.cells.get((kx + dx, ky + dy), ()):
                    sx, sy = bx - ax, by - ay
                    seg2 = sx * sx + sy * sy
                    t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((x - ax) * sx + (y - ay) * sy) / seg2))
                    d2 = (x - ax - t * sx) ** 2 + (y - ay - t * sy) ** 2
                    if d2 < best_d2:
                        best_d2, best = d2, payload
        return (math.sqrt(best_d2), best) if best is not None else (None, None)


def iter_pairs(seq: Iterable):
    it = iter(seq)
    prev = next(it, None)
    for cur in it:
        yield prev, cur
        prev = cur

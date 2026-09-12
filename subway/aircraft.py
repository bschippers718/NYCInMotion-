"""Live aircraft over New York from community ADS-B networks (public, no key).

adsb.fi and adsb.lol both expose the readsb "aircraft.json" format for a point +
radius. We ask for everything within AIRCRAFT_RADIUS_NM of the city, which covers
JFK, LGA and EWR approaches plus the overflights, and normalise it to metric units.
Both networks ask for at most one request per second; we poll every few seconds.
"""
from __future__ import annotations

import time

import requests

from .poller import Poller

CENTER = (40.72, -73.95)
AIRCRAFT_RADIUS_NM = 45
SOURCES = [
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}", "aircraft"),
    ("adsb.lol", "https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}", "ac"),
]
FT = 0.3048
KN = 0.514444
FPM = 0.3048 / 60

# ADS-B emitter category -> rough size class we draw with
CATEGORY = {
    "A1": "light", "A2": "small", "A3": "large", "A4": "large", "A5": "heavy", "A6": "fast",
    "A7": "rotorcraft", "B1": "glider", "B2": "balloon", "B4": "ultralight", "B6": "drone",
}


def _num(v):
    return v if isinstance(v, (int, float)) else None


class AircraftPoller(Poller):
    name = "aircraft-poller"

    def __init__(self, interval: float = 5.0, timeout: float = 10.0):
        super().__init__(interval)
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers["User-Agent"] = "nyc-in-motion/1.0 (art project; local viewer)"
        self._aircraft: list[dict] = []
        self._header_ts: float | None = None
        self.source: str | None = None
        self._fail = 0  # consecutive failures of the preferred source -> rotate

    def fetch(self) -> None:
        errors = []
        order = SOURCES[self._fail % len(SOURCES):] + SOURCES[: self._fail % len(SOURCES)]
        for name, url, key in order:
            try:
                resp = self._session.get(url.format(lat=CENTER[0], lon=CENTER[1], nm=AIRCRAFT_RADIUS_NM), timeout=self.timeout)
                resp.raise_for_status()
                data = resp.json()
                raw = data.get(key) or []
                now = data.get("now")
                now = now / 1000 if now and now > 1e11 else now  # adsb.lol reports ms
                out = [a for a in (self._decode(a) for a in raw) if a]
                with self._lock:
                    self._aircraft, self._header_ts, self.source = out, now or time.time(), name
                return
            except Exception as exc:  # noqa: BLE001 - try the next network
                errors.append(f"{name}: {exc}")
                self._fail += 1
        raise RuntimeError("; ".join(errors))

    @staticmethod
    def _decode(a: dict) -> dict | None:
        lat, lon = _num(a.get("lat")), _num(a.get("lon"))
        if lat is None or lon is None:
            return None
        alt = a.get("alt_geom") if _num(a.get("alt_geom")) is not None else a.get("alt_baro")
        on_ground = alt == "ground"
        alt_m = 0.0 if on_ground or _num(alt) is None else max(0.0, alt * FT)
        rate = _num(a.get("geom_rate")) if _num(a.get("geom_rate")) is not None else _num(a.get("baro_rate"))
        return {
            "id": a.get("hex"),
            "callsign": (a.get("flight") or "").strip() or None,
            "reg": a.get("r"),
            "type": a.get("t"),
            "desc": a.get("desc"),
            "operator": a.get("ownOp"),
            "category": a.get("category"),
            "size": CATEGORY.get(a.get("category") or "", "small"),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "alt_m": round(alt_m, 1),
            "on_ground": on_ground,
            "speed_mps": round(_num(a.get("gs")) * KN, 1) if _num(a.get("gs")) is not None else None,
            "track": _num(a.get("track")),
            "vrate_mps": round(rate * FPM, 2) if rate is not None else None,
            "squawk": a.get("squawk"),
            "emergency": a.get("emergency") if a.get("emergency") not in (None, "none") else None,
            "seen_pos_s": _num(a.get("seen_pos")),
        }

    def snapshot(self) -> dict:
        with self._lock:
            now = time.time()
            return {
                "available": True,
                "error": self.last_error,
                "source": self.source,
                "header_ts": self._header_ts,
                "age_s": int(now - self._header_ts) if self._header_ts else None,
                "count": len(self._aircraft),
                "aircraft": list(self._aircraft),
            }

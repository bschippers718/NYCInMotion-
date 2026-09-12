"""Live weather for the city from the National Weather Service (free, no key).

Central Park (KNYC) is the reference station; LaGuardia (KLGA) is the fallback when
Central Park's ASOS is late, which it often is. The browser uses this to pick a sky,
add rain to the windshield in the cab view and fog on the bridge.
"""
from __future__ import annotations

import logging
import threading
import time

import requests

log = logging.getLogger("weather")

STATIONS = ["KNYC", "KLGA"]
URL = "https://api.weather.gov/stations/{station}/observations/latest"
HEADERS = {"User-Agent": "nyc-in-motion (local art project)", "Accept": "application/geo+json"}
TTL_S = 300


def _num(field):
    return None if not field or field.get("value") is None else field["value"]


def classify(props: dict) -> dict:
    """Reduce an NWS observation to what the renderer needs."""
    desc = (props.get("textDescription") or "").strip()
    present = " ".join(str(w.get("weather") or w.get("rawString") or "") for w in props.get("presentWeather") or []).lower()
    text = f"{desc} {present}".lower()
    vis = _num(props.get("visibility"))
    precip = _num(props.get("precipitationLastHour")) or 0.0
    kind = "clear"
    if any(k in text for k in ("thunder", "tstm")):
        kind = "storm"
    elif any(k in text for k in ("snow", "sleet", "ice", "freezing")):
        kind = "snow"
    elif any(k in text for k in ("rain", "drizzle", "shower")) or precip > 0.2:
        kind = "rain"
    elif any(k in text for k in ("fog", "mist", "haze")) or (vis is not None and vis < 3000):
        kind = "fog"
    elif "overcast" in text or "cloudy" in text and "partly" not in text:
        kind = "overcast"
    elif "cloud" in text:
        kind = "clouds"
    intensity = 0.0
    if kind in ("rain", "snow", "storm"):
        intensity = 1.0 if "heavy" in text else 0.35 if "light" in text else 0.65
        if precip > 3:
            intensity = 1.0
    cloud = 0.0
    for layer in props.get("cloudLayers") or []:
        cloud = max(cloud, {"CLR": 0, "SKC": 0, "FEW": 0.2, "SCT": 0.45, "BKN": 0.75, "OVC": 1.0, "VV": 1.0}.get(layer.get("amount"), 0))
    return {
        "kind": kind,
        "intensity": intensity,
        "cloud": cloud,
        "description": desc,
        "temp_c": _num(props.get("temperature")),
        "wind_kmh": _num(props.get("windSpeed")),
        "wind_dir": _num(props.get("windDirection")),
        "visibility_m": vis,
        "humidity": _num(props.get("relativeHumidity")),
        "observed": props.get("timestamp"),
    }


class Weather:
    def __init__(self):
        self._lock = threading.Lock()
        self._cache: dict | None = None
        self._at = 0.0
        self.last_error: str | None = None

    def current(self) -> dict:
        with self._lock:
            if self._cache and time.time() - self._at < TTL_S:
                return self._cache
        obs = None
        for station in STATIONS:
            try:
                r = requests.get(URL.format(station=station), headers=HEADERS, timeout=8)
                r.raise_for_status()
                props = r.json().get("properties") or {}
                if props.get("temperature", {}).get("value") is None and props.get("textDescription") in (None, ""):
                    continue  # empty observation; try the next station
                obs = classify(props)
                obs["station"] = station
                self.last_error = None
                break
            except Exception as e:  # noqa: BLE001
                self.last_error = f"{station}: {e}"
                log.warning("weather %s failed: %s", station, e)
        if obs is None:
            obs = {"kind": "unknown", "intensity": 0.0, "cloud": 0.0, "description": "", "error": self.last_error}
        with self._lock:
            self._cache = obs
            self._at = time.time()
        return obs

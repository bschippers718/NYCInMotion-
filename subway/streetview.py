"""Street-level photos along a followed bus, from Mapillary (CC BY-SA, free client token).

Mapillary's Graph API needs a client token (create an app at mapillary.com/dashboard/developers;
the token starts with "MLY|"). Put it in data/keys.json as {"mapillary": "MLY|..."} or the
MAPILLARY_TOKEN environment variable; the browser may also send one it holds in localStorage.
Without a token /api/streetview answers {"available": false} and the UI explains what to do.
"""
from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from pathlib import Path

import requests

log = logging.getLogger("streetview")
GRAPH = "https://graph.mapillary.com/images"
FIELDS = "id,thumb_1024_url,thumb_256_url,computed_geometry,geometry,compass_angle,captured_at,is_pano,sequence"
TTL_S = 3600
# Mapillary publishes this client token in its own open-source API demo
# (github.com/mapillary/api-demo, MIT) so the demo works without sign-up. We fall back to
# it when no token is configured; register your own for anything beyond casual use.
DEMO_TOKEN = "MLY|26275324248758064|7819d63bee8179a083cdd76e20557967"


def load_keys(path: Path) -> dict:
    keys = {}
    if path.exists():
        try:
            keys = json.loads(path.read_text())
        except Exception as e:  # noqa: BLE001
            log.warning("keys.json unreadable: %s", e)
    if os.environ.get("MAPILLARY_TOKEN"):
        keys["mapillary"] = os.environ["MAPILLARY_TOKEN"]
    if os.environ.get("GOOGLE_MAPS_KEY"):
        keys["google_maps"] = os.environ["GOOGLE_MAPS_KEY"]
    return keys


def _ang_diff(a: float, b: float) -> float:
    d = abs((a - b + 180) % 360 - 180)
    return d


class StreetView:
    def __init__(self, keys_path: Path):
        self.keys_path = keys_path
        self._cache: dict[str, tuple[float, dict]] = {}
        self._lock = threading.Lock()

    @property
    def token(self) -> str | None:
        return load_keys(self.keys_path).get("mapillary")

    def nearest(self, lon: float, lat: float, heading: float | None, token: str | None = None, radius_m: float = 45.0) -> dict:
        tok = token or self.token or DEMO_TOKEN
        demo = tok == DEMO_TOKEN
        # cache on a ~20 m grid and 45° heading sector so a slow bus does not re-query every tick
        key = f"{round(lon * 5000)}:{round(lat * 5000)}:{int(((heading or 0) % 360) // 45)}"
        with self._lock:
            hit = self._cache.get(key)
            if hit and time.time() - hit[0] < TTL_S:
                return hit[1]
        dlat = radius_m / 111000.0
        dlon = radius_m / (111000.0 * math.cos(math.radians(lat)))
        bbox = f"{lon - dlon:.6f},{lat - dlat:.6f},{lon + dlon:.6f},{lat + dlat:.6f}"
        try:
            r = requests.get(GRAPH, params={"access_token": tok, "fields": FIELDS, "bbox": bbox, "limit": 40}, timeout=8)
            if r.status_code in (400, 401, 403) and ("oauth" in r.text.lower() or "token" in r.text.lower()):
                msg = ""
                try:
                    msg = r.json().get("error", {}).get("message", "")
                except Exception:  # noqa: BLE001
                    pass
                out = {"available": False, "reason": f"Mapillary rejected the token ({msg or r.status_code}) — check the key under Keys"}
                if demo:
                    out["reason"] = "Mapillary's public demo token no longer works — add your own token under Keys"
            else:
                r.raise_for_status()
                out = self._pick(r.json().get("data", []), lon, lat, heading)
                out["demo"] = demo
        except Exception as e:  # noqa: BLE001
            log.warning("mapillary: %s", e)
            out = {"available": True, "image": None, "error": str(e)[:120]}
        with self._lock:
            self._cache[key] = (time.time(), out)
            if len(self._cache) > 5000:
                self._cache.clear()
        return out

    @staticmethod
    def _pick(images: list[dict], lon: float, lat: float, heading: float | None) -> dict:
        best, best_score = None, 1e9
        for im in images:
            g = (im.get("computed_geometry") or im.get("geometry") or {}).get("coordinates")
            if not g:
                continue
            d = math.hypot((g[0] - lon) * 111000 * math.cos(math.radians(lat)), (g[1] - lat) * 111000)
            ang = _ang_diff(im.get("compass_angle") or 0, heading) if heading is not None and not im.get("is_pano") else 0
            age_days = (time.time() * 1000 - (im.get("captured_at") or 0)) / 86400000
            score = d + ang * 0.6 + min(age_days, 3650) * 0.01  # metres, degrees, days
            if im.get("is_pano"):
                score -= 8
            if score < best_score:
                best, best_score = im, score
        if not best:
            return {"available": True, "image": None}
        g = (best.get("computed_geometry") or best.get("geometry") or {}).get("coordinates")
        return {
            "available": True,
            "image": {
                "id": best["id"],
                "url": best.get("thumb_1024_url"),
                "thumb": best.get("thumb_256_url"),
                "lon": g[0],
                "lat": g[1],
                "heading": best.get("compass_angle"),
                "pano": bool(best.get("is_pano")),
                "captured_at": best.get("captured_at"),
                "link": f"https://www.mapillary.com/app/?pKey={best['id']}&focus=photo",
            },
        }

"""A handful of hand-picked live traffic cameras with a view worth watching.

511NY (NYSDOT)                      https://511ny.org/api/getcameras
    The state's camera index carries ~310 NYSDOT "Skyline" cameras inside the city, each with
    a live HLS stream (.m3u8, CORS-open) the browser plays directly. Two thirds of them are
    352x240 and most point at a stretch of pavement, so instead of pinning all of them we keep
    PICKS: ten cameras chosen by hand for picture quality (640x352 up to 1080p) and for what
    is in the frame - the harbour, the skyline, the Harlem River, a J/M/Z train crossing the
    BQE. The picks are self-contained (position + last known stream url) so the layer works
    offline; every 12 h we ask 511NY for the current stream urls and which picks are online,
    since NYSDOT moves streams between CDN hosts now and then. A free developer key
    (511ny.org/developers/help) can go in data/keys.json as {"ny511": "..."} or NY511_KEY;
    the list currently answers without one. The refreshed list is cached in data/cameras.json.

NYC DOT's ~970 street cameras (JPEG stills, 352x240) used to be on the map too; they were
dropped for adding a thousand pins and very little picture.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import requests

from subway.poller import Poller

log = logging.getLogger("cameras")

NY511_LIST = "https://511ny.org/api/getcameras"
HEADERS = {"User-Agent": "nyc-in-motion (local art project)"}
LIST_REFRESH_S = 12 * 3600
SOURCE = "NYSDOT via 511NY"

# id (511NY camera ID) -> what and where. `video` is the stream url last seen; the fetch keeps it current.
PICKS: list[dict] = [
    {
        "id": "Skyline-16228",
        "title": "Gowanus Expressway over Red Hook",
        "view": "The Upper Bay and the Red Hook piers from the top deck of the Gowanus. 1280×720, and the best sunsets of the lot.",
        "area": "Brooklyn", "lat": 40.66954, "lon": -73.99682,
        "video": "https://s7.nysdot.skyvdn.com/rtplive/R11_286/playlist.m3u8", "link": "https://511ny.org/map/Cctv/5194",
    },
    {
        "id": "Skyline-14166",
        "title": "Gowanus Expressway at the canal",
        "view": "Looking up the expressway toward Lower Manhattan: the whole downtown skyline stands behind the traffic.",
        "area": "Brooklyn", "lat": 40.67174, "lon": -73.99875,
        "video": "https://s7.nysdot.skyvdn.com/rtplive/R11_234/playlist.m3u8", "link": "https://511ny.org/map/Cctv/4697",
    },
    {
        "id": "Skyline-2302",
        "title": "BQE at Hamilton Avenue",
        "view": "Red Hook's rooftops and church spires with Lower Manhattan's towers on the horizon.",
        "area": "Brooklyn", "lat": 40.67971, "lon": -74.00371,
        "video": "https://s53.nysdot.skyvdn.com/rtplive/R11_058/playlist.m3u8", "link": "https://511ny.org/map/Cctv/5718",
    },
    {
        "id": "Skyline-1998",
        "title": "BQE in the Brooklyn Heights trench",
        "view": "The expressway squeezed between Brooklyn Heights and downtown Brooklyn, a block from the Brooklyn Bridge ramps.",
        "area": "Brooklyn", "lat": 40.70152, "lon": -73.98882,
        "video": "https://s52.nysdot.skyvdn.com/rtplive/R11_072/playlist.m3u8", "link": "https://511ny.org/map/Cctv/5493",
    },
    {
        "id": "Skyline-2004",
        "title": "BQE under the Williamsburg el",
        "view": "J, M and Z trains cross the frame on the Broadway elevated as they come off the Williamsburg Bridge. 896×504.",
        "area": "Brooklyn", "lat": 40.7076, "lon": -73.9574,
        "video": "https://s52.nysdot.skyvdn.com/rtplive/R11_078/playlist.m3u8", "link": "https://511ny.org/map/Cctv/5499",
    },
    {
        "id": "Skyline-16095",
        "title": "West Street at Vestry Street",
        "view": "Tribeca's brick warehouses in front, the Hudson Yards towers on the skyline behind; the West Side Highway runs north through it.",
        "area": "Manhattan", "lat": 40.72291, "lon": -74.01164,
        "video": "https://s9.nysdot.skyvdn.com/rtplive/R11_277/playlist.m3u8", "link": "https://511ny.org/map/Cctv/5061",
    },
    {
        "id": "Skyline-15939",
        "title": "Harlem River Drive at 164th Street",
        "view": "The Harlem River alongside the drive, the Bronx bank on the right and the bridges upriver. 720×480.",
        "area": "Manhattan", "lat": 40.83606, "lon": -73.93503,
        "video": "https://s9.nysdot.skyvdn.com/rtplive/R11_252/playlist.m3u8", "link": "https://511ny.org/map/Cctv/4927",
    },
    {
        "id": "Skyline-16118",
        "title": "Harlem River Drive at 130th Street",
        "view": "The drive along the river with the Harlem River lift bridges ahead and the Bronx across the water. 720×480.",
        "area": "Manhattan", "lat": 40.80845, "lon": -73.93479,
        "video": "https://s9.nysdot.skyvdn.com/rtplive/R11_291/playlist.m3u8", "link": "https://511ny.org/map/Cctv/5084",
    },
    {
        "id": "Skyline-2035",
        "title": "Van Wyck Expressway at 101st Avenue",
        "view": "The sharpest stream NYSDOT has in the city, 1920×1080: the Van Wyck from above, heading south toward JFK.",
        "area": "Queens", "lat": 40.6943, "lon": -73.81163,
        "video": "https://s52.nysdot.skyvdn.com/rtplive/R11_169/playlist.m3u8", "link": "https://511ny.org/map/Cctv/5528",
    },
    {
        "id": "Skyline-1986",
        "title": "Cross Bronx Expressway at Arthur Avenue",
        "view": "The road regularly ranked the most congested in the country, seen from above at 720×480. It is never not like this.",
        "area": "Bronx", "lat": 40.84385, "lon": -73.89511,
        "video": "https://s52.nysdot.skyvdn.com/rtplive/R11_020/playlist.m3u8", "link": "https://511ny.org/map/Cctv/5482",
    },
]


def _base(p: dict) -> dict:
    """A pick as served, before 511NY has been asked about it."""
    return {
        "id": f"ny511:{p['id']}",
        "name": p["title"],
        "title": p["title"],
        "view": p["view"],
        "road": "",
        "direction": "",
        "lat": p["lat"],
        "lon": p["lon"],
        "area": p["area"],
        "source": SOURCE,
        "online": True,
        "video": p["video"],
        "link": p["link"],
    }


class Cameras(Poller):
    name = "cameras"

    def __init__(self, data_dir: Path, keys_path: Path):
        super().__init__(interval=LIST_REFRESH_S)
        self.cache_path = data_dir / "cameras.json"
        self.keys_path = keys_path
        self._cams: list[dict] = []
        self._payload: bytes | None = None
        self.generated_at = 0.0
        self.sources: dict[str, dict] = {}
        self._set([_base(p) for p in PICKS], 0.0, {"ny511": {"ok": False, "error": "not fetched yet"}})
        self._load_cache()

    # ---- list ----------------------------------------------------------------
    def _load_cache(self) -> None:
        if not self.cache_path.exists():
            return
        try:
            d = json.loads(self.cache_path.read_text())
            cams = d.get("cameras", [])
            wanted = {f"ny511:{p['id']}" for p in PICKS}
            if {c["id"] for c in cams} != wanted:  # picks changed since the cache was written
                log.info("cameras cache is for a different pick list; ignoring it")
                return
            self._set(cams, d.get("generated_at", 0.0), d.get("sources", {}))
            log.info("loaded %d cameras from %s", len(self._cams), self.cache_path.name)
        except Exception as e:  # noqa: BLE001
            log.warning("cameras cache unreadable: %s", e)

    def _set(self, cams: list[dict], generated_at: float, sources: dict) -> None:
        with self._lock:
            self._cams = cams
            self._payload = None
            self.generated_at = generated_at
            self.sources = sources

    def _ny511_key(self) -> str | None:
        if os.environ.get("NY511_KEY"):
            return os.environ["NY511_KEY"]
        try:
            return json.loads(self.keys_path.read_text()).get("ny511") if self.keys_path.exists() else None
        except Exception:  # noqa: BLE001
            return None

    def fetch(self) -> None:
        params = {"format": "json"}
        key = self._ny511_key()
        if key:
            params["key"] = key
        r = requests.get(NY511_LIST, params=params, headers=HEADERS, timeout=30)
        r.raise_for_status()
        live = {str(c.get("ID")): c for c in r.json()}

        cams, missing = [], []
        for p in PICKS:
            cam = _base(p)
            c = live.get(p["id"])
            if c is None:
                missing.append(p["id"])
                cam["online"] = False
            else:
                cam["online"] = not (c.get("Disabled") or c.get("Blocked")) and bool(c.get("VideoUrl"))
                if c.get("VideoUrl"):
                    cam["video"] = c["VideoUrl"]
                cam["road"] = (c.get("RoadwayName") or "").strip()
                d = (c.get("DirectionOfTravel") or "").strip()
                cam["direction"] = "" if d.lower() == "unknown" else d
                if c.get("Latitude") and c.get("Longitude"):
                    cam["lat"], cam["lon"] = float(c["Latitude"]), float(c["Longitude"])
                if c.get("Url"):
                    cam["link"] = c["Url"]
            cams.append(cam)

        sources = {"ny511": {"ok": True, "key": bool(key), "index_size": len(live), "missing": missing}}
        now = time.time()
        self._set(cams, now, sources)
        try:
            self.cache_path.write_text(json.dumps({"generated_at": now, "sources": sources, "cameras": cams}, indent=1))
        except OSError as e:
            log.warning("could not write %s: %s", self.cache_path, e)
        online = sum(1 for c in cams if c["online"])
        log.info("cameras: %d picks, %d online%s", len(cams), online, f", missing from 511NY: {', '.join(missing)}" if missing else "")

    @property
    def available(self) -> bool:
        return bool(self._cams)

    def get(self, cam_id: str) -> dict | None:
        with self._lock:
            return next((c for c in self._cams if c["id"] == cam_id), None)

    def list_bytes(self) -> bytes:
        with self._lock:
            if self._payload is None:
                self._payload = json.dumps(
                    {
                        "generated_at": self.generated_at,
                        "count": len(self._cams),
                        "online": sum(1 for c in self._cams if c["online"]),
                        "sources": self.sources,
                        "cameras": self._cams,
                    },
                    separators=(",", ":"),
                ).encode()
            return self._payload

    def status(self) -> dict:
        return {"available": self.available, "count": len(self._cams), "sources": self.sources, "last_ok": self.last_ok, "error": self.last_error}

"""NYC in Motion - realtime, layered 3D view of the city's transit.

  python server.py                 # http://localhost:8000
  python server.py --port 9000 --interval 10

Endpoints
  /                       3D city view (web/index.html); /2d.html is the flat top-down map
  /api/trains             motion model + estimated position of every active subway train
  /api/network            subway routes, stations (with structure / depth) and 3D track shapes
  /api/buses              live bus GPS positions tagged with their route shape
  /api/buses/network      bus routes + street shapes
  /api/ferries            live NYC Ferry positions;  /api/ferries/network  routes + shapes
  /api/aircraft           live aircraft over the city (ADS-B via adsb.fi / adsb.lol)
  /api/taxi/zones         TLC taxi zones (centroids + polygons)
  /api/taxi/flow          zone-to-zone taxi / Uber / Lyft flows for a weekday+hour
  /api/taxi/trips         n sampled trips for that hour with their street paths (binary, see subway/taxi.py)
  /api/streets            binary street centerlines with elevation (bridges / tunnels)
  /api/streets/crossings  bridges, tunnels, elevated highways as GeoJSON
  /api/311?days=30        subway-related 311 service requests with coordinates
  /api/311/summary        aggregate counts from data/311_summary.json
  /api/streetview         nearest Mapillary street photo to lon/lat/heading (needs a token)
  /api/keys               which optional keys are configured (Google Maps key is sent to the browser)
  /api/photos             a Wikipedia/Commons photo per station (scripts/build_station_photos.py)
  /api/weather            current NWS observation (Central Park), classified for the renderer
  /api/cameras            ten hand-picked NYSDOT live video cameras (511NY): harbour, skyline, river views
  /api/layers             which data layers are available and why not
  /api/health             feed status

Share links
  /train/<id> /bus/<id> /ferry/<id> /plane/<id>   the map, already following that vehicle; the page
                          carries Open Graph tags so the link unfurls with a live picture of it
  /og/<kind>/<id>.png     that picture (1200x630, drawn from the feeds);  /og/city.png  the front page's
"""
from __future__ import annotations

import argparse
import gzip
import json
import logging
import mimetypes
import os
import threading
import time
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from zoneinfo import ZoneInfo

from subway.aircraft import AircraftPoller
from subway.buses import BusNetwork, BusPoller
from subway.cameras import Cameras
from subway.feeds import FeedPoller
from subway.ferries import FerryPoller
from subway.network import StaticData
from subway.positions import PositionEstimator
from subway.share import KIND_PATH, PATH_KIND, ShareCards, og_tags
from subway.taxi import TaxiFlow
from subway.streetview import StreetView, load_keys
from subway.weather import Weather

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
STREETS = DATA / "streets"
WEB = ROOT / "web"

NYC = ZoneInfo("America/New_York")

log = logging.getLogger("server")


class App:
    def __init__(self, interval: float):
        static_path = DATA / "static.json"
        if not static_path.exists():
            raise SystemExit("data/static.json missing - run: python scripts/build_static.py")
        log.info("loading %s", static_path)
        self.static = StaticData(static_path)
        self.estimator = PositionEstimator(self.static)
        self.subway = FeedPoller(interval=interval)
        self.bus_network = BusNetwork(DATA)
        self.buses = BusPoller(self.bus_network, interval=max(interval, 10))
        self.ferries = FerryPoller(DATA, interval=15)
        self.aircraft = AircraftPoller(interval=5)
        self.weather = Weather()
        self.streetview = StreetView(DATA / "keys.json")
        self.cameras = Cameras(DATA, DATA / "keys.json")
        self.taxi = TaxiFlow(DATA / "taxi_flow.duckdb", DATA / "taxi_zones.json", STREETS)
        self.share = ShareCards(self)
        self._lock = threading.Lock()
        self._network_bytes: bytes | None = None
        self._311: list[dict] | None = None
        self._311_mtime = 0.0

    def start(self):
        log.info("first subway fetch ...")
        self.subway.refresh()
        self.subway.start()
        self.buses.start()
        self.ferries.start()
        self.aircraft.start()
        self.cameras.start()  # refreshes the picked cameras' stream urls in the background, then every 12 h
        if not self.bus_network.available:
            log.info("bus route shapes missing - run scripts/build_bus_static.py for buses that follow their routes")
        log.info("taxi flow model: %s", "loaded" if self.taxi.available else "missing (run scripts/build_taxi.py)")
        log.info("street paths: %s", "loaded" if self.taxi.paths.available else "missing (run scripts/build_streets.py)")

    def stop(self):
        for p in (self.subway, self.buses, self.ferries, self.aircraft, self.cameras):
            p.stop()

    # ---- payload builders -------------------------------------------------
    def layers(self) -> dict:
        b = self.buses.snapshot()
        f = self.ferries.snapshot()
        a = self.aircraft.snapshot()
        return {
            "subway": {"available": True},
            "buses": {"available": True, "error": b["error"], "count": b["count"], "age_s": b["age_s"], "has_shapes": b["has_shapes"]},
            "ferries": {"available": True, "error": f["error"], "count": f["count"], "has_shapes": self.ferries.available},
            "aircraft": {"available": True, "error": a["error"], "count": a["count"], "age_s": a["age_s"], "source": a["source"]},
            "taxi": self.taxi.status(),
            "streets": {
                "available": (STREETS / "streets.bin").exists(),
                "crossings": (STREETS / "crossings.json").exists(),
                "hint": "run: python scripts/build_streets.py",
            },
            "complaints": {"available": (DATA / "311_subway.json").exists(), "hint": "run: python scripts/fetch_311.py"},
            "cameras": self.cameras.status(),
        }

    def trains(self, include_scheduled: bool = False) -> dict:
        trips, status = self.subway.snapshot()
        now = time.time()
        with self._lock:
            trains = self.estimator.estimate(trips, now, include_scheduled=True)
        scheduled = sum(1 for t in trains if t["scheduled"])
        if not include_scheduled:
            trains = [t for t in trains if not t["scheduled"]]
        by_route: dict[str, int] = {}
        for t in trains:
            by_route[t["route"]] = by_route.get(t["route"], 0) + 1
        return {
            "generated_at": now,
            "count": len(trains),
            "scheduled_count": scheduled,
            "trips_in_feed": len(trips),
            "by_route": dict(sorted(by_route.items())),
            "feeds": {
                k: {
                    "ok": v.ok,
                    "header_ts": v.header_ts,
                    "age_s": int(now - v.header_ts) if v.header_ts else None,
                    "trips": v.n_trips,
                    "error": v.error,
                    "latency_ms": v.latency_ms,
                }
                for k, v in sorted(status.items())
            },
            "trains": trains,
        }

    def network_bytes(self) -> bytes:
        if self._network_bytes is None:
            self._network_bytes = json.dumps(self.static.network_payload(), separators=(",", ":")).encode()
        return self._network_bytes

    def _load_311(self) -> list[dict]:
        path = DATA / "311_subway.json"
        if not path.exists():
            return []
        mtime = path.stat().st_mtime
        with self._lock:
            if self._311 is None or mtime != self._311_mtime:
                log.info("loading %s", path)
                rows = json.loads(path.read_text())
                rows.sort(key=lambda r: r.get("created_date", ""), reverse=True)
                self._311 = rows
                self._311_mtime = mtime
            return self._311

    def complaints(self, days: int, limit: int) -> dict:
        rows = self._load_311()
        if not rows:
            return {"available": False, "hint": "run: python scripts/fetch_311.py", "rows": []}
        since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
        out = []
        for r in rows:
            if r.get("created_date", "") < since:
                break
            if r.get("latitude") is None or r.get("longitude") is None:
                continue
            out.append(
                {
                    "id": r.get("unique_key"),
                    "created": r.get("created_date"),
                    "type": r.get("complaint_type"),
                    "descriptor": r.get("descriptor"),
                    "agency": r.get("agency"),
                    "status": r.get("status"),
                    "address": r.get("incident_address"),
                    "borough": r.get("borough"),
                    "lat": r["latitude"],
                    "lon": r["longitude"],
                }
            )
            if len(out) >= limit:
                break
        return {"available": True, "days": days, "total_loaded": len(rows), "rows": out}

    def complaints_summary(self) -> dict:
        path = DATA / "311_summary.json"
        if not path.exists():
            return {"available": False, "hint": "run: python scripts/fetch_311.py"}
        d = json.loads(path.read_text())
        d["available"] = True
        return d


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def _q(qs: dict, name: str, default, cast=str):
    try:
        return cast(qs.get(name, [default])[0])
    except (ValueError, TypeError):
        return default


def _taxi_params(qs: dict) -> tuple[int, int, list[str], int]:
    now = datetime.now(NYC)
    dow = _q(qs, "dow", now.weekday(), int)
    hour = _q(qs, "hour", now.hour, int)
    services = [s for s in _q(qs, "services", "uber,lyft,yellow,other_hv").split(",") if s]
    top = min(_q(qs, "top", 4000, int), 20000)
    return dow, hour, services, top


class Handler(SimpleHTTPRequestHandler):
    app: App  # set on the class before serving
    server_version = "nyc-in-motion/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        msg = args[0] if args else ""
        if not any(k in msg for k in ("/api/trains", "/api/buses", "/api/ferries", "/api/aircraft")):
            log.debug(fmt, *args)

    def _send(self, body: bytes, ctype: str, status: int = 200, cache: str = "no-store"):
        compressible = ctype.startswith(("application/json", "text/", "application/javascript"))
        accept_gzip = compressible and "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024
        if accept_gzip:
            body = gzip.compress(body, compresslevel=4)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        if accept_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status: int = 200, cache: str = "no-store"):
        self._send(json.dumps(obj, separators=(",", ":")).encode(), "application/json", status, cache)

    def _file(self, path: Path, ctype: str, cache: str):
        if not path.exists():
            return self._json({"error": f"{path.name} not built"}, 404)
        return self._send(path.read_bytes(), ctype, cache=cache)

    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        path = url.path
        try:
            handler = self.API.get(path)
            if handler is not None:
                return handler(self, qs)
            if path.startswith("/api/"):
                return self._json({"error": "not found"}, 404)
            if path.startswith("/og/"):
                return self.og_image(path)
            share = self._share_path(path)
            if path in ("", "/", "/index.html") or share:
                return self.index_page(share)
            # static web files
            rel = path.lstrip("/")
            file = (WEB / rel).resolve()
            if WEB.resolve() not in file.parents or not file.is_file():
                return self._json({"error": "not found"}, 404)
            ctype = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
            if file.suffix == ".js":
                ctype = "application/javascript"
            return self._send(file.read_bytes(), ctype, cache="no-cache")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            log.exception("request failed: %s", self.path)
            try:
                self._json({"error": str(exc)}, 500)
            except OSError:
                pass

    # ---- share links -----------------------------------------------------------
    @staticmethod
    def _share_path(path: str):
        """/train/<id> -> ("train", id); the id may hold anything but a slash."""
        parts = path.split("/", 2)
        if len(parts) == 3 and parts[1] in PATH_KIND and parts[2]:
            return PATH_KIND[parts[1]], unquote(parts[2])
        return None

    def _public_base(self) -> str:
        base = os.environ.get("PUBLIC_URL")
        if base:
            return base.rstrip("/")
        proto = self.headers.get("X-Forwarded-Proto", "http").split(",")[0].strip()
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "localhost"
        return f"{proto}://{host}"

    def index_page(self, share):
        """index.html with Open Graph tags for the front page or for one vehicle."""
        html = (WEB / "index.html").read_text()
        base = self._public_base()
        if share:
            kind, vid = share
            d = self.app.share.describe(kind, vid)
            url = f"{base}/{KIND_PATH[kind]}/{quote(vid, safe='')}"
            image = f"{base}/og/{KIND_PATH[kind]}/{quote(vid, safe='')}.png"
            tags = og_tags(d["title"], d["description"], url, image)
        else:
            c = self.app.share.city()
            tags = og_tags(c["title"], c["description"], f"{base}/", f"{base}/og/city.png")
        html = html.replace("<!--og-->", tags, 1)
        self._send(html.encode(), "text/html; charset=utf-8", cache="no-cache")

    def og_image(self, path: str):
        if path == "/og/city.png":
            return self._send(self.app.share.city_image(), "image/png", cache="public, max-age=60")
        m = path[len("/og/"):]
        if not m.endswith(".png"):
            return self._json({"error": "not found"}, 404)
        share = self._share_path("/" + m[: -len(".png")])
        if not share:
            return self._json({"error": "not found"}, 404)
        self._send(self.app.share.image(*share), "image/png", cache="public, max-age=30")

    # ---- API table ------------------------------------------------------------
    def api_trains(self, qs):
        self._json(self.app.trains(include_scheduled=_q(qs, "scheduled", "0") in ("1", "true")))

    def api_network(self, qs):
        self._send(self.app.network_bytes(), "application/json", cache="max-age=3600")

    def api_buses(self, qs):
        self._json(self.app.buses.snapshot())

    def api_buses_network(self, qs):
        self._send(self.app.bus_network.network_bytes(), "application/json", cache="max-age=3600")

    def api_ferries(self, qs):
        self._json(self.app.ferries.snapshot())

    def api_ferries_network(self, qs):
        self._send(self.app.ferries.network_bytes(), "application/json", cache="max-age=3600")

    def api_aircraft(self, qs):
        self._json(self.app.aircraft.snapshot())

    def api_taxi_zones(self, qs):
        self._send(self.app.taxi.zones_bytes(), "application/json", cache="max-age=3600")

    def api_taxi_flow(self, qs):
        self._json(self.app.taxi.flow(*_taxi_params(qs)), cache="max-age=300")

    def api_taxi_trips(self, qs):
        dow, hour, services, _ = _taxi_params(qs)
        n = min(max(_q(qs, "n", 7000, int), 1), 80000)
        self._send(self.app.taxi.trips_bytes(dow, hour, services, n), "application/octet-stream", cache="max-age=300")

    def api_streets(self, qs):
        self._file(STREETS / "streets.bin", "application/octet-stream", "max-age=86400")

    def api_crossings(self, qs):
        self._file(STREETS / "crossings.json", "application/json", "max-age=86400")

    def api_311(self, qs):
        self._json(self.app.complaints(_q(qs, "days", 30, int), _q(qs, "limit", 5000, int)), cache="max-age=60")

    def api_311_summary(self, qs):
        self._json(self.app.complaints_summary(), cache="max-age=60")

    def api_photos(self, qs):
        f = DATA / "station_photos.json"
        if not f.exists():
            return self._json({}, cache="max-age=60")
        self._send(f.read_bytes(), "application/json", cache="max-age=300")

    def api_streetview(self, qs):
        lon, lat = _q(qs, "lon", None, float), _q(qs, "lat", None, float)
        if lon is None or lat is None:
            return self._json({"error": "lon and lat required"}, status=400)
        heading = _q(qs, "heading", None, float)
        self._json(self.app.streetview.nearest(lon, lat, heading, token=_q(qs, "token", "") or None), cache="max-age=60")

    def api_keys(self, qs):
        # which optional services are configured server-side (never the keys themselves)
        keys = load_keys(DATA / "keys.json")
        self._json({"mapillary": bool(keys.get("mapillary")), "google_maps": keys.get("google_maps") or None})

    def api_weather(self, qs):
        self._json(self.app.weather.current(), cache="max-age=120")

    def api_cameras(self, qs):
        if not self.app.cameras.available:
            return self._json({"available": False, "count": 0, "cameras": [], "error": self.app.cameras.last_error or "camera index not fetched yet"}, cache="max-age=10")
        self._send(self.app.cameras.list_bytes(), "application/json", cache="max-age=600")

    def api_layers(self, qs):
        self._json(self.app.layers())

    def api_health(self, qs):
        _, status = self.app.subway.snapshot()
        self._json(
            {
                "subway": {k: v.__dict__ for k, v in status.items()},
                "buses": {"last_ok": self.app.buses.last_ok, "error": self.app.buses.last_error},
                "ferries": {"last_ok": self.app.ferries.last_ok, "error": self.app.ferries.last_error},
                "aircraft": {"last_ok": self.app.aircraft.last_ok, "error": self.app.aircraft.last_error, "source": self.app.aircraft.source},
                "cameras": self.app.cameras.status(),
            }
        )

    API = {
        "/api/trains": api_trains,
        "/api/network": api_network,
        "/api/buses": api_buses,
        "/api/buses/network": api_buses_network,
        "/api/ferries": api_ferries,
        "/api/ferries/network": api_ferries_network,
        "/api/aircraft": api_aircraft,
        "/api/taxi/zones": api_taxi_zones,
        "/api/taxi/flow": api_taxi_flow,
        "/api/taxi/trips": api_taxi_trips,
        "/api/streets": api_streets,
        "/api/streets/crossings": api_crossings,
        "/api/311": api_311,
        "/api/311/summary": api_311_summary,
        "/api/photos": api_photos,
        "/api/streetview": api_streetview,
        "/api/keys": api_keys,
        "/api/weather": api_weather,
        "/api/cameras": api_cameras,
        "/api/layers": api_layers,
        "/api/health": api_health,
    }


def main():
    ap = argparse.ArgumentParser(description="NYC in Motion - realtime layered 3D transit view")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--interval", type=float, default=10, help="seconds between MTA feed polls")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = App(interval=args.interval)
    app.start()
    Handler.app = app
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    trips, _ = app.subway.snapshot()
    log.info("tracking %d subway trips; serving http://%s:%d", len(trips), args.host, args.port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()


if __name__ == "__main__":
    main()

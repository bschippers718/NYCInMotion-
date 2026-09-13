"""Share links and their pictures.

Every vehicle on the map has an address - /train/<id>, /bus/<id>, /ferry/<id>,
/plane/<id> - that opens the map already following it. When one of those links is
pasted into iMessage, Slack, X or anywhere that unfurls links, the crawler gets the same
page with Open Graph tags whose picture is drawn here, on the spot, from the live feeds:
"Follow this Q train · 96 St → Coney Island", the route lit up on a map of the city, a dot
where the train is right now. The front page gets a card of the whole city with every train
and plane on it.

  ShareCards(app).describe(kind, vid)  -> the words (title / description / found)
  ShareCards(app).image(kind, vid)     -> PNG bytes, 1200 x 630
  ShareCards(app).city_image()         -> PNG bytes for the front page

Drawn with Pillow. The subway network is rendered once as a backdrop and reused; a card
takes a few tens of milliseconds and is cached for a short while per vehicle, so a link
that gets pasted into a busy group chat does not cost a render per crawler.
"""
from __future__ import annotations

import io
import math
import re
import threading
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 630
BG = (11, 13, 19)
FG = (255, 255, 255)
MUTED = (150, 158, 176)
DIM = (96, 104, 124)
ACCENT = (255, 212, 0)
FONT = Path(__file__).resolve().parent.parent / "web" / "fonts" / "Inter.ttf"

KIND_PATH = {"train": "train", "bus": "bus", "ferry": "ferry", "aircraft": "plane"}
PATH_KIND = {v: k for k, v in KIND_PATH.items()}
COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
WX_WORD = {"clear": "clear skies", "clouds": "some cloud", "overcast": "overcast", "fog": "fog", "rain": "rain", "snow": "snow", "storm": "a thunderstorm"}

_font_cache: dict[tuple[int, int], ImageFont.FreeTypeFont] = {}


def font(size: int, weight: int = 400) -> ImageFont.FreeTypeFont:
    key = (size, weight)
    f = _font_cache.get(key)
    if f is None:
        try:
            f = ImageFont.truetype(str(FONT), size)
            try:
                f.set_variation_by_axes([min(32, max(14, size)), weight])
            except OSError:
                pass
        except OSError:
            f = ImageFont.load_default(size=size)
        _font_cache[key] = f
    return f


def hex_rgb(h: str | None, default=(200, 200, 200)) -> tuple[int, int, int]:
    if not h:
        return default
    h = h.lstrip("#")
    if len(h) != 6:
        return default
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def nice_name(s: str | None) -> str:
    """'DELTA AIR LINES INC' -> 'Delta Air Lines'; words with digits are left alone."""
    if not s:
        return ""
    words = [w for w in s.replace("_", " ").split() if w.upper() not in ("INC", "LLC", "LTD", "CORP", "CO", "INC.", "LLC.")]
    out = []
    for w in words:
        if any(ch.isdigit() for ch in w) or len(w) <= 2:
            out.append(w)
        elif w.lower() in ("of", "and", "the", "de", "du"):
            out.append(w.lower())
        else:
            out.append(w[0].upper() + w[1:].lower())
    return " ".join(out)


def article(word: str) -> str:
    """'a Q', 'an N', 'an 8', 'an F': the article that sounds right before a route letter or number."""
    return "an" if word[:1].upper() in set("AEFHILMNORSX8") else "a"


def compass(deg: float | None) -> str:
    if deg is None:
        return ""
    return COMPASS[int(((deg % 360) + 22.5) // 45) % 8]


# ---- geometry ---------------------------------------------------------------------------------
class Proj:
    """Fit a lon/lat box into a pixel box, keeping shapes true (lon scaled by cos lat)."""

    def __init__(self, bbox, px, pad=0.04):
        lon0, lat0, lon1, lat1 = bbox
        x0, y0, x1, y1 = px
        self.k = math.cos(math.radians((lat0 + lat1) / 2))
        dlon, dlat = max(1e-6, (lon1 - lon0) * self.k), max(1e-6, lat1 - lat0)
        pw, ph = (x1 - x0) * (1 - 2 * pad), (y1 - y0) * (1 - 2 * pad)
        self.s = min(pw / dlon, ph / dlat)
        self.cx, self.cy = (x0 + x1) / 2, (y0 + y1) / 2
        self.mlon, self.mlat = (lon0 + lon1) / 2, (lat0 + lat1) / 2

    def __call__(self, lon: float, lat: float) -> tuple[float, float]:
        return (self.cx + (lon - self.mlon) * self.k * self.s, self.cy - (lat - self.mlat) * self.s)


def bbox_of(points) -> tuple[float, float, float, float]:
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    return min(lons), min(lats), max(lons), max(lats)


def grow(bbox, lon, lat, margin=0.02):
    lon0, lat0, lon1, lat1 = bbox
    return min(lon0, lon - margin), min(lat0, lat - margin), max(lon1, lon + margin), max(lat1, lat + margin)


def thin(points, every: int):
    if every <= 1 or len(points) <= 3:
        return points
    out = points[::every]
    if out[-1] is not points[-1]:
        out.append(points[-1])
    return out


# ---- the renderer -------------------------------------------------------------------------------
class ShareCards:
    def __init__(self, app):
        self.app = app
        self.static = app.static
        self._lock = threading.Lock()
        self._backdrop: dict[str, Image.Image] = {}
        self._cache: dict[str, tuple[float, bytes]] = {}
        # subway network as lon/lat polylines by route, thinned: the backdrop of every card
        self.routes: dict[str, list[list[tuple[float, float]]]] = {}
        seen: set[tuple] = set()
        for sh in self.static.shapes.values():
            pts = [(p[1], p[0]) for p in thin(sh.points, 4)]
            key = (sh.route, round(pts[0][0], 3), round(pts[0][1], 3), round(pts[-1][0], 3), round(pts[-1][1], 3), len(pts))
            if key in seen:
                continue
            seen.add(key)
            self.routes.setdefault(sh.route, []).append(pts)
        # the framing: the network without the Staten Island Railway, which would push everything else into a corner
        allpts = [p for r, runs in self.routes.items() if not r.upper().startswith("SI") for run in runs for p in run]
        self.city_bbox = bbox_of(allpts) if allpts else (-74.05, 40.57, -73.75, 40.91)
        bus = app.bus_network
        try:
            import json

            self.bus_shapes = json.loads(bus.network_path.read_text())["shapes"] if bus.network_path.exists() else []
        except (OSError, ValueError, KeyError):
            self.bus_shapes = []
        self.ferry = app.ferries.network

    # ---- words -------------------------------------------------------------------------------
    def describe(self, kind: str, vid: str) -> dict:
        """Title, description and drawing hints for a vehicle - or for what is left of it."""
        w = self.app.weather.current() if hasattr(self.app, "weather") else None
        d = {"kind": kind, "id": vid, "found": False, "title": "", "description": "", "lines": [], "color": (200, 200, 200), "text": (0, 0, 0), "bullet": "", "pos": None, "bearing": None, "route_runs": [], "weather": w}
        try:
            getattr(self, f"_describe_{kind}")(vid, d)
        except Exception:  # noqa: BLE001 - a bad id must never break the page
            pass
        if not d["title"]:
            d["title"] = {"train": "Follow a train through New York", "bus": "Follow a bus through New York", "ferry": "Follow a ferry across the harbour", "aircraft": "Follow a plane over New York"}.get(kind, "NYC in Motion")
            d["description"] = "The city, live, in 3D: every subway train, bus, ferry and plane, moving as it moves."
        return d

    def _describe_train(self, vid, d):
        trains = self.app.trains(include_scheduled=True)["trains"]
        t = next((x for x in trains if x["id"] == vid), None)
        route = None
        if t is None:
            m = re.search(r"_([A-Z0-9]+)\.\.([NS])", vid)
            if m:
                route = m.group(1)
        else:
            route = t["route"]
        if not route:
            return
        rid = route.rstrip("X")
        rinfo = self.static.route(route)
        d["color"] = hex_rgb(rinfo.get("color"), (110, 110, 110))
        d["text"] = hex_rgb(rinfo.get("text_color"), (0, 0, 0))
        d["bullet"] = rid
        d["route_runs"] = self.routes.get(route, []) or self.routes.get(rid, [])
        if t is None:
            d["title"] = f"Follow {article(rid)} {rid} train"
            d["lines"] = ["This one has finished its run.", f"The link picks up another {rid} on the line, live."]
            d["description"] = f"That {rid} has reached the end of its run - open the map and it hands you another {rid}, moving live through New York."
            return
        d["found"] = True
        d["pos"] = (t["lon"], t["lat"])
        d["bearing"] = t.get("bearing")
        sh = self.static.shapes.get(t.get("shape") or "")
        origin = dest = None
        if sh and sh.stop_order:
            origin = self.static.stop_name(sh.stop_order[0])
            dest = self.static.stop_name(sh.stop_order[-1])
            d["route_runs"] = [[(p[1], p[0]) for p in thin(sh.points, 3)]]
        if t["status"] == "STOPPED_AT":
            now = f"standing at {t.get('prev_stop_name') or t.get('next_stop_name') or 'a station'}"
        elif t.get("prev_stop_name") and t.get("next_stop_name"):
            now = f"between {t['prev_stop_name']} and {t['next_stop_name']}"
        elif t.get("next_stop_name"):
            now = f"next stop {t['next_stop_name']}"
        else:
            now = "on its way"
        eta = t.get("eta_s")
        if eta and t["status"] != "STOPPED_AT" and t.get("next_stop_name"):
            now += f" · {t['next_stop_name']} in {max(1, round(eta / 60))} min"
        d["title"] = f"Follow this {rid} train"
        d["lines"] = [f"{origin} → {dest}" if origin and dest else "", f"Right now {now}"]
        d["description"] = (f"{article(rid).capitalize()} {rid} train from {origin} to {dest}, " if origin and dest else f"{article(rid).capitalize()} {rid} train, ") + f"{now}. Open the link and the 3D map rides along behind it, live."

    def _describe_bus(self, vid, d):
        snap = self.app.buses.snapshot()
        b = next((x for x in snap.get("buses", []) if str(x["id"]) == str(vid)), None)
        d["color"] = (242, 140, 40)
        d["bullet"] = "B"
        if b is None:
            d["title"] = "Follow a bus through New York"
            d["lines"] = ["This bus has gone off shift.", "Open the map and pick another of the 1,600-odd out there."]
            d["description"] = "That bus has gone off shift. Open the map and every other bus in the city is out there to follow, live."
            return
        d["found"] = True
        route = b.get("route") or "bus"
        rinfo = self.app.bus_network.routes.get(route, {})
        d["color"] = hex_rgb(b.get("color") or rinfo.get("color"), (242, 140, 40))
        d["text"] = hex_rgb(rinfo.get("text_color"), (255, 255, 255))
        d["bullet"] = route
        d["pos"] = (b["lon"], b["lat"])
        d["bearing"] = b.get("bearing")
        si = b.get("shape")
        if isinstance(si, int) and 0 <= si < len(self.bus_shapes):
            d["route_runs"] = [[(p[1], p[0]) for p in thin(self.bus_shapes[si]["points"], 2)]]
        long_name = rinfo.get("long_name") or ""
        status = {"STOPPED_AT": "at a stop", "INCOMING_AT": "pulling in to a stop", "IN_TRANSIT_TO": "on its way"}.get(b.get("status") or "", "on its way")
        occ = b.get("occupancy")
        d["title"] = f"Follow the {route} bus"
        d["lines"] = [long_name.replace(" - ", " ↔ "), f"Right now {status}" + (f" · {occ}" if occ else "") + f" · bus {b['id']}"]
        d["description"] = f"The {route}" + (f" ({long_name})" if long_name else "") + f", {status}" + (f", {occ}" if occ else "") + ". Open the link and the 3D map rides along behind it, live."

    def _describe_ferry(self, vid, d):
        snap = self.app.ferries.snapshot()
        v = next((x for x in snap.get("vessels", []) if str(x["id"]) == str(vid)), None)
        d["color"] = (63, 193, 201)
        d["bullet"] = "F"
        if v is None:
            d["title"] = "Follow a ferry across the harbour"
            d["lines"] = ["This boat has tied up for now.", "Open the map and pick another NYC Ferry."]
            d["description"] = "That ferry has tied up for now. Open the map and every other NYC Ferry is out on the water to follow, live."
            return
        d["found"] = True
        route = v.get("route") or ""
        rinfo = self.ferry.get("routes", {}).get(route, {})
        d["color"] = hex_rgb(v.get("color") or rinfo.get("color"), (63, 193, 201))
        d["text"] = hex_rgb(rinfo.get("text_color"), (255, 255, 255))
        d["bullet"] = route or "F"
        d["pos"] = (v["lon"], v["lat"])
        d["bearing"] = v.get("bearing")
        shapes = self.ferry.get("shapes", [])
        si = v.get("shape")
        ends = ""
        if isinstance(si, int) and 0 <= si < len(shapes):
            pts = shapes[si]["points"]
            d["route_runs"] = [[(p[1], p[0]) for p in pts]]
            stops = self.ferry.get("stops", [])
            if stops:
                near = lambda p: min(stops, key=lambda s: (s["lat"] - p[0]) ** 2 + (s["lon"] - p[1]) ** 2)["name"]  # noqa: E731
                a, b = near(pts[0]), near(pts[-1])
                ends = f"{a} → {b}" if a != b else a
        kn = v.get("speed_mps")
        speed = f" · {kn * 1.944:.0f} kn" if kn else ""
        name = v.get("label") or f"boat {v['id']}"
        d["title"] = f"Follow NYC Ferry {name}"
        d["lines"] = [f"{rinfo.get('long_name') or route} route" + (f" · {ends}" if ends else ""), "Right now " + ("underway" if kn and kn > 1 else "at the landing") + speed]
        d["description"] = f"NYC Ferry {name} on the {rinfo.get('long_name') or route} route" + (f", {ends}" if ends else "") + f"{speed}. Open the link and the 3D map rides along behind it, live."

    def _describe_aircraft(self, vid, d):
        snap = self.app.aircraft.snapshot()
        a = next((x for x in snap.get("aircraft", []) if x["id"] == vid), None)
        d["color"] = (223, 230, 255)
        d["bullet"] = "✈"
        if a is None:
            d["title"] = "Follow a plane over New York"
            d["lines"] = ["This flight has left the city's airspace.", "Open the map: there are usually 150 aircraft over it."]
            d["description"] = "That flight has left the city's airspace. Open the map and everything else over New York is there to follow, live."
            return
        d["found"] = True
        d["pos"] = (a["lon"], a["lat"])
        d["bearing"] = a.get("track")
        d["speed_mps"] = a.get("speed_mps") or 0
        d["plane"] = True
        name = a.get("callsign") or a.get("reg") or a["id"]
        what = " · ".join(x for x in (nice_name(a.get("operator")), nice_name(a.get("desc")) or a.get("type")) if x)
        alt_ft = round((a.get("alt_m") or 0) * 3.281 / 100) * 100
        mph = round((a.get("speed_mps") or 0) * 2.237)
        vr = a.get("vrate_mps") or 0
        phase = "climbing" if vr > 2.5 else "descending" if vr < -2.5 else "level"
        d["title"] = f"Follow {name}"
        d["lines"] = [what, f"{alt_ft:,} ft · {mph} mph · {phase}, heading {compass(a.get('track'))}"]
        d["description"] = f"{name}" + (f", {what}" if what else "") + f": {alt_ft:,} ft, {mph} mph, {phase}, heading {compass(a.get('track'))}. Open the link and the 3D map flies along behind it, live."

    def city(self) -> dict:
        """Words for the front page."""
        t = self.app.trains()
        b = self.app.buses.snapshot()
        f = self.app.ferries.snapshot()
        a = self.app.aircraft.snapshot()
        parts = [f"{t['count']:,} subway trains"]
        if b.get("count"):
            parts.append(f"{b['count']:,} buses")
        if f.get("count"):
            parts.append(f"{f['count']} ferries")
        if a.get("count"):
            parts.append(f"{a['count']} aircraft")
        return {
            "title": "NYC in Motion",
            "description": "New York, live, in 3D: " + ", ".join(parts) + " moving right now - click any of them and ride along.",
            "counts": parts,
            "trains": [(x["lon"], x["lat"], x["route"]) for x in t["trains"]],
            "aircraft": [(x["lon"], x["lat"], x.get("track") or 0) for x in a.get("aircraft", []) if not x.get("on_ground")],
            "weather": self.app.weather.current() if hasattr(self.app, "weather") else None,
        }

    # ---- pictures -------------------------------------------------------------------------------
    def image(self, kind: str, vid: str) -> bytes:
        key = f"{kind}/{vid}"
        with self._lock:
            hit = self._cache.get(key)
            if hit and time.time() - hit[0] < 20:
                return hit[1]
        d = self.describe(kind, vid)
        png = self._render(d)
        with self._lock:
            if len(self._cache) > 200:
                self._cache.clear()
            self._cache[key] = (time.time(), png)
        return png

    def city_image(self) -> bytes:
        with self._lock:
            hit = self._cache.get("city")
            if hit and time.time() - hit[0] < 60:
                return hit[1]
        png = self._render_city(self.city())
        with self._lock:
            self._cache["city"] = (time.time(), png)
        return png

    # the map panel on the right of a vehicle card
    MAP = (620, 24, 1180, 612)

    def _backdrop_for(self, bbox, box=MAP) -> Image.Image:
        key = f"{box}:{','.join(f'{v:.3f}' for v in bbox)}"
        with self._lock:
            im = self._backdrop.get(key)
        if im is not None:
            return im
        im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dr = ImageDraw.Draw(im)
        proj = Proj(bbox, box)
        for route, runs in self.routes.items():
            c = hex_rgb(self.static.route(route).get("color"), (120, 120, 120))
            c = mix(c, BG, 0.45) + (255,)
            for run in runs:
                dr.line([proj(*p) for p in run], fill=c, width=2, joint="curve")
        with self._lock:
            if len(self._backdrop) > 12:
                self._backdrop.clear()
            self._backdrop[key] = im
        return im

    def _base(self) -> Image.Image:
        im = Image.new("RGB", (W, H), BG)
        # a soft glow bottom-right, the app's own night palette
        glow = Image.new("RGB", (W, H), BG)
        gd = ImageDraw.Draw(glow)
        gd.ellipse((700, 250, 1500, 1000), fill=(22, 28, 44))
        glow = glow.filter(ImageFilter.GaussianBlur(120))
        im.paste(glow)
        return im

    def _draw_map(self, card: Image.Image, bbox, runs, color, pos, bearing, box=MAP, speed_mps=0.0, plane=False):
        im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        im.alpha_composite(self._backdrop_for(bbox, box))
        proj = Proj(bbox, box)
        far = None  # (miles, direction) when the vehicle sits outside the map and is pinned to its edge
        if pos:
            x, y = proj(*pos)
            x0, y0, x1, y1 = box[0] + 24, box[1] + 24, box[2] - 24, box[3] - 24
            if not (x0 <= x <= x1 and y0 <= y <= y1):
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                dx, dy = x - cx, y - cy
                k = min((x1 - x0) / 2 / abs(dx) if dx else 9e9, (y1 - y0) / 2 / abs(dy) if dy else 9e9)
                mlon, mlat = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
                km = math.hypot((pos[0] - mlon) * 111.32 * math.cos(math.radians(mlat)), (pos[1] - mlat) * 110.57)
                far = (km / 1.609, compass(math.degrees(math.atan2(pos[0] - mlon, pos[1] - mlat))))
                pos = None
                x, y = cx + dx * k, cy + dy * k
                pin = (x, y)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dr = ImageDraw.Draw(layer)
        # the followed line: a glow, then the line itself
        for run in runs:
            pts = [proj(*p) for p in run]
            dr.line(pts, fill=color + (70,), width=14, joint="curve")
        layer = layer.filter(ImageFilter.GaussianBlur(6))
        dr = ImageDraw.Draw(layer)
        for run in runs:
            pts = [proj(*p) for p in run]
            dr.line(pts, fill=color + (255,), width=4, joint="curve")
        im.alpha_composite(layer)
        if far:
            x, y = pin
            dd = ImageDraw.Draw(im)
            dd.ellipse((x - 7, y - 7, x + 7, y + 7), outline=FG + (220,), width=2)
            f = font(15, 600)
            label = f"{far[0]:.0f} mi {far[1]} of the city"
            tw = dd.textlength(label, font=f)
            lx = min(max(x - tw / 2, box[0] + 6), box[2] - tw - 6)
            ly = y + 14 if y < (box[1] + box[3]) / 2 else y - 34
            dd.text((lx, ly), label, font=f, fill=(205, 211, 226, 255))
        if pos and plane and bearing is not None and speed_mps:
            # a trail: where it was a minute and a half ago
            x, y = proj(*pos)
            th = math.radians(bearing)
            back = speed_mps * 90
            bx, by = proj(pos[0] - math.sin(th) * back / (111320 * math.cos(math.radians(pos[1]))), pos[1] - math.cos(th) * back / 110570)
            trail = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            td = ImageDraw.Draw(trail)
            for i in range(8):
                t0, t1 = i / 8, (i + 1) / 8
                td.line((bx + (x - bx) * t0, by + (y - by) * t0, bx + (x - bx) * t1, by + (y - by) * t1), fill=color + (int(30 + 170 * t1),), width=3)
            im.alpha_composite(trail)
        if pos:
            x, y = proj(*pos)
            dot = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            dd = ImageDraw.Draw(dot)
            dd.ellipse((x - 26, y - 26, x + 26, y + 26), fill=color + (110,))
            dot = dot.filter(ImageFilter.GaussianBlur(10))
            im.alpha_composite(dot)
            dd = ImageDraw.Draw(im)
            if bearing is not None:
                th = math.radians(bearing)
                dd.line((x, y, x + math.sin(th) * 30, y - math.cos(th) * 30), fill=FG + (200,), width=3)
            dd.ellipse((x - 11, y - 11, x + 11, y + 11), fill=FG + (255,))
            dd.ellipse((x - 8, y - 8, x + 8, y + 8), fill=color + (255,))
        # keep the map to its panel: a hard edge at the card's sides, a soft one toward the words
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).rectangle((box[0] - 10, -60, W + 60, H + 60), fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(28))
        im.putalpha(ImageChops.multiply(im.getchannel("A"), mask))
        card.alpha_composite(im)

    def _text_block(self, dr: ImageDraw.ImageDraw, d: dict, weather):
        x = 64
        # eyebrow
        dr.text((x, 58), "NYC IN MOTION", font=font(18, 700), fill=ACCENT)
        dr.text((x + 170, 58), "· LIVE", font=font(18, 600), fill=MUTED)
        # bullet + title
        y = 118
        bullet = d.get("bullet") or ""
        col = d["color"]
        if bullet:
            r = 34
            dr.ellipse((x, y, x + 2 * r, y + 2 * r), fill=col)
            if bullet == "✈":
                plane_icon(dr, x + r, y + r, 22, d["text"], d.get("bearing"))
            else:
                bf = font(30 if len(bullet) <= 2 else 20 if len(bullet) <= 4 else 15, 800)
                dr.text((x + r, y + r + 1), bullet, font=bf, fill=d["text"], anchor="mm")
            tx = x + 2 * r + 20
        else:
            tx = x
        title_font = font(48, 800)
        maxw = 610 - tx
        lines = wrap(dr, d["title"], title_font, maxw)
        if len(lines) > 2:
            title_font = font(40, 800)
            lines = wrap(dr, d["title"], title_font, maxw)[:2]
        ty = y + (68 - len(lines) * 54) / 2 if len(lines) == 1 else y - 4
        for ln in lines:
            dr.text((tx, ty), ln, font=title_font, fill=FG)
            ty += 54
        y = max(y + 90, ty + 12)
        # the two lines
        for i, ln in enumerate(d.get("lines") or []):
            if not ln:
                continue
            f = font(27 if i == 0 else 22, 600 if i == 0 else 400)
            colr = FG if i == 0 else (205, 211, 226)
            for sub in wrap(dr, ln, f, 560)[:2]:
                dr.text((x, y), sub, font=f, fill=colr)
                y += 36 if i == 0 else 31
            y += 6
        # footer
        foot = ["nyc.benschippers.com"]
        if weather and weather.get("temp_c") is not None and weather.get("kind") not in (None, "unknown"):
            f_deg = round(weather["temp_c"] * 9 / 5 + 32)
            foot.append(f"{f_deg}°F, {WX_WORD.get(weather['kind'], weather['kind'])} over the city")
        dr.text((x, H - 72), "  ·  ".join(foot), font=font(18, 500), fill=MUTED)
        dr.text((x, H - 46), "Open the link and the 3D map rides along behind it", font=font(16, 400), fill=DIM)

    def _render(self, d: dict) -> bytes:
        im = self._base().convert("RGBA")
        bbox = self.city_bbox
        runs = d.get("route_runs") or []
        if d.get("pos") and not d.get("plane"):
            bbox = grow(bbox, *d["pos"])
        if runs and d["kind"] in ("bus", "ferry"):
            # zoom to the route, with room around it so the rest of the city still says where it is
            lon0, lat0, lon1, lat1 = bbox_of([p for run in runs for p in run] + ([d["pos"]] if d.get("pos") else []))
            span = max(lon1 - lon0, lat1 - lat0, 0.05)
            bbox = (lon0 - span * 0.45, lat0 - span * 0.45, lon1 + span * 0.45, lat1 + span * 0.45)
        if d.get("plane") and d.get("pos"):
            # planes: the city stays the picture; the plane comes into it if it is close, or pins to the edge
            bbox = grow(self.city_bbox, min(max(d["pos"][0], self.city_bbox[0] - 0.12), self.city_bbox[2] + 0.12), min(max(d["pos"][1], self.city_bbox[1] - 0.08), self.city_bbox[3] + 0.08), 0.01)
        self._draw_map(im, bbox, runs, d["color"], d.get("pos"), d.get("bearing"), speed_mps=d.get("speed_mps", 0), plane=d.get("plane", False))
        dr = ImageDraw.Draw(im)
        self._text_block(dr, d, d.get("weather"))
        return to_png(im)

    def _render_city(self, c: dict) -> bytes:
        im = self._base().convert("RGBA")
        box = (600, 30, 1180, 610)
        bbox = self.city_bbox
        backdrop = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dr = ImageDraw.Draw(backdrop)
        proj = Proj(bbox, box, pad=0.04)
        for route, runs in self.routes.items():
            col = hex_rgb(self.static.route(route).get("color"), (120, 120, 120))
            for run in runs:
                dr.line([proj(*p) for p in run], fill=mix(col, BG, 0.25) + (255,), width=3, joint="curve")
        im.alpha_composite(backdrop)
        dots = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dd = ImageDraw.Draw(dots)
        for lon, lat, route in c["trains"]:
            x, y = proj(lon, lat)
            dd.ellipse((x - 4, y - 4, x + 4, y + 4), fill=FG + (90,))
        dots = dots.filter(ImageFilter.GaussianBlur(3))
        im.alpha_composite(dots)
        dd = ImageDraw.Draw(im)
        for lon, lat, route in c["trains"]:
            x, y = proj(lon, lat)
            dd.ellipse((x - 2.6, y - 2.6, x + 2.6, y + 2.6), fill=FG + (255,))
        for lon, lat, track in c["aircraft"]:
            x, y = proj(lon, lat)
            if box[0] < x < box[2] and box[1] < y < box[3]:
                plane_icon(dd, x, y, 7, (186, 214, 255, 235), track)
        # words
        x = 64
        dd.text((x, 58), "LIVE · RIGHT NOW", font=font(18, 700), fill=ACCENT)
        dd.text((x, 112), "NYC in", font=font(84, 800), fill=FG)
        dd.text((x, 196), "Motion", font=font(84, 800), fill=FG)
        y = 318
        for ln in wrap(dd, "Every subway train, bus, ferry and plane over New York, moving as it moves - in 3D.", font(26, 500), 480):
            dd.text((x, y), ln, font=font(26, 500), fill=(205, 211, 226))
            y += 35
        y += 14
        for part in c["counts"]:
            n, _, what = part.partition(" ")
            dd.text((x, y), n, font=font(24, 700), fill=FG)
            dd.text((x + dd.textlength(n, font=font(24, 700)) + 8, y + 3), what, font=font(20, 400), fill=MUTED)
            y += 32
        foot = ["nyc.benschippers.com"]
        w = c.get("weather")
        if w and w.get("temp_c") is not None and w.get("kind") not in (None, "unknown"):
            foot.append(f"{round(w['temp_c'] * 9 / 5 + 32)}°F, {WX_WORD.get(w['kind'], w['kind'])}")
        dd.text((x, H - 60), "  ·  ".join(foot), font=font(18, 500), fill=MUTED)
        return to_png(im)


def plane_icon(dr: ImageDraw.ImageDraw, cx: float, cy: float, size: float, fill, heading: float | None = None):
    """A small airliner silhouette, nose up, turned to `heading`."""
    th = math.radians(heading or 0)
    pts = [(0, -1), (0.12, -0.55), (0.95, 0.05), (0.95, 0.22), (0.12, -0.02), (0.1, 0.55), (0.42, 0.78), (0.42, 0.9), (0, 0.78), (-0.42, 0.9), (-0.42, 0.78), (-0.1, 0.55), (-0.12, -0.02), (-0.95, 0.22), (-0.95, 0.05), (-0.12, -0.55)]
    poly = [(cx + (px * math.cos(th) - py * math.sin(th)) * size, cy + (px * math.sin(th) + py * math.cos(th)) * size) for px, py in pts]
    dr.polygon(poly, fill=fill)


def wrap(dr: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, maxw: float) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for wd in words:
        trial = (cur + " " + wd).strip()
        if dr.textlength(trial, font=f) <= maxw or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines


def to_png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.convert("RGB").save(buf, "PNG", optimize=False, compress_level=6)
    return buf.getvalue()


# ---- the page --------------------------------------------------------------------------------
def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def og_tags(title: str, description: str, url: str, image: str) -> str:
    """Open Graph + Twitter card tags for the head of index.html."""
    return "\n".join(
        [
            f'<title>{esc(title)} — NYC in Motion</title>' if title != "NYC in Motion" else "<title>NYC in Motion — the city in layers</title>",
            f'<meta name="description" content="{esc(description)}" />',
            '<meta property="og:type" content="website" />',
            '<meta property="og:site_name" content="NYC in Motion" />',
            f'<meta property="og:title" content="{esc(title)}" />',
            f'<meta property="og:description" content="{esc(description)}" />',
            f'<meta property="og:url" content="{esc(url)}" />',
            f'<meta property="og:image" content="{esc(image)}" />',
            '<meta property="og:image:width" content="1200" />',
            '<meta property="og:image:height" content="630" />',
            '<meta property="og:image:type" content="image/png" />',
            '<meta name="twitter:card" content="summary_large_image" />',
            f'<meta name="twitter:title" content="{esc(title)}" />',
            f'<meta name="twitter:description" content="{esc(description)}" />',
            f'<meta name="twitter:image" content="{esc(image)}" />',
        ]
    )

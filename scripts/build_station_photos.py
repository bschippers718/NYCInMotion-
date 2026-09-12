"""Find a real photograph of every subway station and write data/station_photos.json.

Source: the English Wikipedia article for each station (found by search, using the
MTA name expanded to full words plus the line it is on to disambiguate the many
"Canal Street"s), and its lead image, which for station articles is almost always a
platform or entrance photo. The image's licence and author come from Wikimedia
Commons so the browser can show the credit the licence requires.

Usage:
  python scripts/build_station_photos.py            # all stations (a few minutes; cached)
  python scripts/build_station_photos.py --limit 20 # try a few first
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
DATA = ROOT / "data"
OUT = DATA / "station_photos.json"
WIKI = "https://en.wikipedia.org/w/api.php"
COMMONS = "https://commons.wikimedia.org/w/api.php"
HEADERS = {"User-Agent": "nyc-in-motion/1.0 (local art project; station photo index)"}
THUMB_PX = 1280
# Where the search lands on the wrong page (list articles, look-alike names), the title we want.
OVERRIDES = {
    "213": "East 180th Street station",
    "214": "West Farms Square–East Tremont Avenue station",
    "609": "St. Lawrence Avenue station",
    "A17": "Cathedral Parkway–110th Street station (IND Eighth Avenue Line)",
    "D06": "182nd–183rd Streets station",
    "G10": "63rd Drive–Rego Park station",
    "615": "East 149th Street station",
    "D42": "West Eighth Street–New York Aquarium station",
    "R33": "Fourth Avenue/Ninth Street station",
    "S31": "St. George Terminal",
}
BAD_TITLES = ("List of",)

ABBR = {
    "St": "Street", "Sts": "Streets", "Av": "Avenue", "Avs": "Avenues", "Sq": "Square", "Pkwy": "Parkway", "Blvd": "Boulevard",
    "Rd": "Road", "Ctr": "Center", "Hts": "Heights", "Pl": "Place", "Ln": "Lane", "Jct": "Junction", "Ft": "Fort",
    "Pk": "Park", "Bch": "Beach", "Ter": "Terrace", "Expwy": "Expressway", "Hwy": "Highway", "Tpke": "Turnpike",
    "Cir": "Circle", "Pt": "Point", "Mt": "Mount", "Wash": "Washington", "Pkway": "Parkway", "Ctr-": "Center-",
}
LINE_HINT = {
    "Broadway - 7Av": "IRT Broadway–Seventh Avenue Line", "Lexington Av": "IRT Lexington Avenue Line", "Lenox - White Plains Rd": "IRT White Plains Road Line",
    "Jerome Av": "IRT Jerome Avenue Line", "Pelham": "IRT Pelham Line", "Dyre Av": "IRT Dyre Avenue Line", "Flushing": "IRT Flushing Line",
    "Eastern Pky": "IRT Eastern Parkway Line", "Nostrand": "IRT Nostrand Avenue Line", "Clark St": "IRT Broadway–Seventh Avenue Line",
    "8th Av - Fulton St": "IND Eighth Avenue Line OR IND Fulton Street Line", "6th Av - Culver": "IND Sixth Avenue Line OR IND Culver Line",
    "Queens Blvd": "IND Queens Boulevard Line", "Concourse": "IND Concourse Line", "Crosstown": "IND Crosstown Line", "63rd St": "63rd Street Line",
    "Second Av": "Second Avenue Subway", "Rockaway": "IND Rockaway Line", "Liberty Av": "IND Fulton Street Line", "Queens - Archer": "Archer Avenue Line",
    "Broadway - Brighton": "BMT Brighton Line OR BMT Broadway Line", "Broadway": "BMT Broadway Line", "4th Av": "BMT Fourth Avenue Line",
    "West End": "BMT West End Line", "Sea Beach": "BMT Sea Beach Line", "Astoria": "BMT Astoria Line", "Canarsie": "BMT Canarsie Line",
    "Jamaica": "BMT Jamaica Line", "Myrtle Av": "BMT Myrtle Avenue Line", "Franklin Shuttle": "BMT Franklin Avenue Line",
    "Lexington - Shuttle": "42nd Street Shuttle", "Staten Island": "Staten Island Railway", "Manhattan Bridge": "BMT Brighton Line",
}


def ordinal(n: str) -> str:
    v = int(n)
    suf = "th" if 10 <= v % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(v % 10, "th")
    return f"{n}{suf}"


def expand(name: str) -> str:
    """'Times Sq-42 St' -> 'Times Square–42nd Street'."""
    parts = re.split(r"(-|/| )", name)
    out = []
    for i, p in enumerate(parts):
        if re.fullmatch(r"\d+", p) and i + 2 < len(parts) and parts[i + 2] in ("St", "Av", "Sts", "Avs", "Rd", "Dr", "Pl"):
            out.append(ordinal(p))
        else:
            out.append(ABBR.get(p, p))
    s = "".join(out).replace("-", "–")
    return re.sub(r"\s+", " ", s).strip()


def get(url: str, params: dict) -> dict:
    """GET with polite backoff: Wikimedia answers 429 quickly if you hurry."""
    params = {"format": "json", "formatversion": "2", **params}
    for attempt in range(7):
        r = requests.get(url, params=params, headers=HEADERS, timeout=20)
        if r.status_code == 429:
            wait = float(r.headers.get("Retry-After") or 0) or 5 * (attempt + 1)
            print(f"    (429; waiting {wait:.0f}s)")
            time.sleep(wait)
            continue
        r.raise_for_status()
        return r.json()
    return {}


def find_article_image(name: str, line: str | None) -> dict | None:
    """One request: search for the article and fetch its lead image in the same call."""
    q = f'intitle:"{expand(name)}" station'
    hint = LINE_HINT.get(line or "", "")
    queries = ([f"{q} ({hint})"] if hint else []) + [f"{q} New York City Subway", f"{expand(name)} station New York City Subway {hint}"]
    for query in queries:
        res = get(WIKI, {"action": "query", "generator": "search", "gsrsearch": query, "gsrlimit": 5, "gsrnamespace": 0, "prop": "pageimages|info", "piprop": "original|name|thumbnail", "pithumbsize": THUMB_PX, "inprop": "url", "redirects": 1})
        pages = sorted(res.get("query", {}).get("pages", []), key=lambda p: p.get("index", 99))
        hits = [p for p in pages if "station" in p["title"].lower() and not p["title"].startswith(BAD_TITLES)]
        if hits:
            p = hits[0]
            return {"file": p.get("pageimage"), "thumb": (p.get("thumbnail") or {}).get("source"), "original": (p.get("original") or {}).get("source"), "page": p.get("fullurl"), "title": p["title"]}
        time.sleep(0.5)
    return None


def _meta_of(page: dict) -> dict:
    if not page.get("imageinfo"):
        return {}
    ii = page["imageinfo"][0]
    md = ii.get("extmetadata", {})
    artist = re.sub(r"<[^>]+>", "", md.get("Artist", {}).get("value", "")).strip()
    return {"artist": artist[:80], "license": md.get("LicenseShortName", {}).get("value", ""), "license_url": md.get("LicenseUrl", {}).get("value", ""), "commons": ii.get("descriptionurl")}


def commons_meta(file: str) -> dict:
    return commons_meta_batch([file]).get(file, {})


def commons_meta_batch(files: list[str]) -> dict[str, dict]:
    """file name -> {artist, license, ...}, 40 files per request."""
    out: dict[str, dict] = {}
    files = [f for f in files if f]
    for i in range(0, len(files), 40):
        chunk = files[i : i + 40]
        res = get(COMMONS, {"action": "query", "titles": "|".join(f"File:{f}" for f in chunk), "prop": "imageinfo", "iiprop": "extmetadata|url", "iiextmetadatafilter": "Artist|LicenseShortName|LicenseUrl|Credit"})
        q = res.get("query", {})
        normalized = {n["to"]: n["from"] for n in q.get("normalized", [])}
        for p in q.get("pages", []):
            title = p.get("title", "")
            orig = normalized.get(title, title)
            out[orig[len("File:"):] if orig.startswith("File:") else orig] = _meta_of(p)
        time.sleep(0.6)
    return out


def candidates(name: str, line: str | None) -> list[str]:
    """Likely article titles, most specific first."""
    base = f"{expand(name)} station"
    hints = [h.strip() for h in LINE_HINT.get(line or "", "").split(" OR ") if h.strip()]
    out = [f"{base} ({h})" for h in hints] + [base, f"{base} (New York City Subway)"]
    # a few MTA spellings differ from Wikipedia's
    alt = expand(name).replace("–", "-")
    if alt != expand(name):
        out.append(f"{alt} station")
    return out


def batch_pages(titles: list[str]) -> dict[str, dict]:
    """titles -> page (with lead image + disambiguation flag); redirects are followed."""
    found: dict[str, dict] = {}
    for i in range(0, len(titles), 40):
        chunk = titles[i : i + 40]
        res = get(WIKI, {"action": "query", "titles": "|".join(chunk), "prop": "pageimages|info|pageprops", "piprop": "original|name|thumbnail", "pithumbsize": THUMB_PX, "inprop": "url", "ppprop": "disambiguation", "redirects": 1})
        q = res.get("query", {})
        redirect = {r["from"]: r["to"] for r in q.get("redirects", [])}
        normalized = {n["from"]: n["to"] for n in q.get("normalized", [])}
        by_title = {p["title"]: p for p in q.get("pages", []) if not p.get("missing")}
        for t in chunk:
            t2 = normalized.get(t, t)
            t2 = redirect.get(t2, t2)
            p = by_title.get(t2)
            if p and "disambiguation" not in (p.get("pageprops") or {}):
                found[t] = p
        time.sleep(0.6)
    return found


def record(p: dict, name: str, meta: dict) -> dict:
    img = {"file": p.get("pageimage"), "thumb": (p.get("thumbnail") or {}).get("source"), "original": (p.get("original") or {}).get("source"), "page": p.get("fullurl"), "title": p["title"]}
    if not img["thumb"]:
        return {"name": name, "article": p["title"], "error": "no image"}
    thumb = img["thumb"].split("?")[0]
    return {"name": name, "article": img["title"], "page": img["page"], "thumb": thumb, "original": img.get("original"), "file": img["file"], **meta}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--refresh", action="store_true", help="ignore the cached results")
    args = ap.parse_args()

    static = json.loads((DATA / "static.json").read_text())
    stations = [s for s in static["stops"].values() if s.get("is_station")]
    cache = {} if args.refresh or not OUT.exists() else json.loads(OUT.read_text())
    def wrong(sid: str) -> bool:
        c = cache.get(sid, {})
        art = c.get("article") or ""
        return not c.get("thumb") or art.startswith(BAD_TITLES) or (sid in OVERRIDES and art != OVERRIDES[sid])

    todo = [s for s in stations if wrong(s["id"])]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(stations)} stations, {len(stations) - len(todo)} already done, {len(todo)} to look up")

    # pass 1: guess the titles and fetch them in batches (cheap, not rate limited like search)
    cands = {s["id"]: ([OVERRIDES[s["id"]]] if s["id"] in OVERRIDES else candidates(s["name"], s.get("line"))) for s in todo}
    all_titles = sorted({t for ts in cands.values() for t in ts})
    print(f"  pass 1: {len(all_titles)} title guesses in {(len(all_titles) + 39) // 40} requests")
    pages = batch_pages(all_titles)
    leftovers, hits = [], {}
    for s in todo:
        hit = next((pages[t] for t in cands[s["id"]] if t in pages and pages[t].get("thumbnail") and not pages[t]["title"].startswith(BAD_TITLES)), None)
        if hit:
            hits[s["id"]] = (s, hit)
        else:
            leftovers.append(s)
    metas = commons_meta_batch(sorted({h.get("pageimage") for _, h in hits.values() if h.get("pageimage")}))
    for sid, (s, hit) in hits.items():
        cache[sid] = record(hit, s["name"], metas.get(hit.get("pageimage"), {}))
        print(f"  ✓ {s['name']} -> {hit['title']} [{cache[sid].get('license', '?')}]")
    OUT.write_text(json.dumps(cache, indent=0))

    # pass 2: full-text search for what is left (slow path)
    print(f"  pass 2: searching for {len(leftovers)} stations")
    for n, s in enumerate(leftovers):
        try:
            img = find_article_image(s["name"], s.get("line"))
            if not img:
                cache[s["id"]] = {"name": s["name"], "error": "no article"}
                print(f"  ? {s['name']} ({s.get('line')}): no article")
            elif not img.get("thumb"):
                cache[s["id"]] = {"name": s["name"], "article": img["title"], "error": "no image"}
                print(f"  - {s['name']}: {img['title']} has no lead image")
            else:
                meta = commons_meta(img["file"]) if img.get("file") else {}
                cache[s["id"]] = {"name": s["name"], "article": img["title"], "page": img["page"], "thumb": img["thumb"].split("?")[0], "original": img.get("original"), **meta}
                print(f"  ✓ {s['name']} -> {img['title']} [{meta.get('license', '?')}]")
        except Exception as e:  # noqa: BLE001
            cache[s["id"]] = {"name": s["name"], "error": str(e)[:120]}
            print(f"  ! {s['name']}: {e}")
        time.sleep(2.0)
        if n % 10 == 9:
            OUT.write_text(json.dumps(cache, indent=0))
    OUT.write_text(json.dumps(cache, indent=0))
    ok = sum(1 for v in cache.values() if v.get("thumb"))
    print(f"wrote {OUT}: {ok} / {len(stations)} stations have a photo")


if __name__ == "__main__":
    main()

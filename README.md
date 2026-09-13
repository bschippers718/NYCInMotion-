# NYC in Motion — the city in layers

A realtime, browser-based 3D view of New York City as a stack of moving layers:
subway trains gliding through their tunnels 16–41 m below the street (and over the
bridges and els), MTA buses and NYC Ferry boats on their routes, a replay of
taxi / Uber / Lyft traffic along the real street grid, and every aircraft over the
region flying at altitude — all over the city's buildings.
A slider pulls the strata apart so you can see the city as a section drawing.

`/` is the 3D view; `/2d.html` is a flat top-down map of the trains with the same
smooth motion.

## Where the data comes from

| Layer | Source | Notes |
|---|---|---|
| Live subway trains | [MTA GTFS-Realtime](https://api.mta.info/) — 8 protobuf feeds, no key | The feed has **no GPS**: it gives each train's current/next stop and predicted arrival times. Positions are modelled along the track (see below). |
| Subway track, stations, schedules | [MTA static GTFS](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip) | `scripts/build_static.py` |
| Subway depth / elevation | [MTA Subway Stations (data.ny.gov 39hk-dx4f)](https://data.ny.gov/d/39hk-dx4f) `structure` field + [OpenStreetMap](https://www.openstreetmap.org) railway ways (`tunnel`, `bridge`, `layer` tags via Overpass) | Every track shape gets a smoothed vertical profile: subway −16 m, open cut −7 m, embankment +6 m, elevated/viaduct +13 m, river tunnels down to −41 m, bridges +14 m. |
| Live buses | [MTA Bus Time GTFS-RT](https://gtfsrt.prod.obanyc.com/vehiclePositions) — works without a key (set `MTA_BUS_KEY` if you have one) | GPS positions snapped to the route shape from the bus GTFS and dead-reckoned between polls. |
| Bus routes | MTA bus static GTFS (6 borough bundles) | `scripts/build_bus_static.py` |
| Live ferries | [NYC Ferry GTFS-RT](https://www.ferry.nyc/developer-tools/) + static GTFS | `scripts/build_ferry_static.py` |
| Live aircraft | Community ADS-B: [adsb.fi](https://github.com/adsbfi/opendata) (primary) / [adsb.lol](https://api.adsb.lol/docs) (fallback), no key | Everything within 45 nm of the city every 5 s: position, altitude, ground speed, track, climb rate, type, operator. Dead-reckoned between polls. |
| Taxi / Uber / Lyft | [TLC trip records](https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page) (monthly parquet, ~2 month lag) | No live feed exists. The latest month is compiled into an hourly zone-to-zone flow model; particles replay a typical hour. `scripts/build_taxi.py` |
| Street grid, bridges, tunnels | [NYC Street Centerlines (CSCL, inkn-q76z)](https://data.cityofnewyork.us/d/inkn-q76z) | A directed road graph (one-way streets, level codes → z for bridges/tunnels/ramps). Taxi flows are routed zone-to-zone through it with Dijkstra so the particles drive real streets. `scripts/build_streets.py` |
| 311 complaints on the subway | [NYC Open Data 311 (erm2-nwe9)](https://data.cityofnewyork.us/d/erm2-nwe9) | Optional overlay. `scripts/fetch_311.py` |
| Live cameras | [511NY](https://511ny.org/developers/help): ten NYSDOT expressway cameras picked by hand out of ~310 for picture quality and for what is in the frame, live HLS video, no key | Click a red pin to watch. Video plays straight from NYSDOT's CDN; the server only refreshes the stream urls. `subway/cameras.py` |
| Basemap + 3D buildings | [OpenFreeMap](https://openfreemap.org) (OpenMapTiles / OpenStreetMap) | Rendered by MapLibre; deck.gl draws everything else interleaved into the same scene. |

## Quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python scripts/build_static.py        # subway GTFS + station structure + OSM tunnel/bridge tags -> data/static.json
python scripts/build_station_photos.py  # a Wikipedia/Commons photo per station -> data/station_photos.json (10 min, polite to the API)
python scripts/build_bus_static.py    # bus routes + trip->shape index                            -> data/bus_*.json
python scripts/build_ferry_static.py  # ferry routes                                              -> data/ferry_network.json
python scripts/build_taxi.py          # TLC month -> data/taxi_flow.duckdb, taxi_zones.json (600 MB download)
python scripts/build_streets.py       # CSCL streets -> road graph, routed taxi paths             -> data/streets/
python scripts/fetch_311.py           # optional: subway 311 records (~7 min)

python server.py                      # http://localhost:8000
```

Only `build_static.py` is required for the trains; every other layer switches itself
off in the UI when its data is missing. The Overpass step of `build_static.py` can take
a few minutes when the public mirrors are busy.

## How the trains move smoothly

The MTA feed says where a train *is* only when it is stopped at a platform, and that
status is often stale. What it does give reliably is the predicted arrival time at
the next stops. So the server does not try to publish positions; it publishes a
**motion model** per train:

```
shape   the GTFS track shape the trip runs on (matched from the trip id, e.g. 097400_A..N55R -> A..N55R)
dist    distance along that shape right now (m)
dist_to distance of the next stop
eta     when the train should reach it (unix s)
dwell   if standing at a platform, when it should leave
```

`subway/positions.py` derives `dist` from the ETA (`(now - departure) / (eta - departure)`
between the previous and next stop), filtered so a train never moves backwards. The
browser (`web/js/trains.js`) then advances every train along the real track polyline
each frame so that it arrives exactly at its ETA, and when a new model comes in every
5 s it eases onto it instead of jumping (a model more than 320 m behind is treated as
a re-identification and snapped). Trains are drawn at realistic length lying along
the track at its true depth — close up as a string of 51/60 ft cars in a lighter tint
of the line colour with a dark outline, a white headlight and red tail lights.

**Trains never collide.** The GTFS shapes put every service on a corridor onto one
centreline, so with raw model positions an express would plough straight through a
local and two trains of the same line could sit on top of each other. Every frame
`TrainTracker.separate` therefore:

- draws each train on the right-hand side of its track — half a train's on-screen width
  plus a pixel, recomputed for the current zoom — so the two directions run on separate
  tracks like the real thing and never overlap;
- keeps a train of the same line behind the one ahead of it on the same track
  (train length + 30 m of clear track). A follower holds, or backs out if a feed
  update dropped the leader onto it; it can never advance through it;
- when two *different* lines overlap in the same direction — express passing local —
  the later-sorting line eases onto an outer lane so they pass side by side instead of
  through each other. Trains queued behind a terminal with no track left to back onto
  do the same.

The API (`/api/trains`) still publishes the raw model; this is a presentation rule. It is
also an honest fiction: the feed does not say which of the four tracks a train is on, so
"outer lane" means "beside the other train", not "on the express track" (the NYCT
GTFS-RT extension's `actual_track` field would make that real — see Ideas below).

Buses and ferries have GPS; they are projected onto their route shape and
dead-reckoned by their reported speed between polls, with the same easing.

Aircraft (`web/js/aircraft.js`) report position, ground speed, track and climb rate;
each plane flies forward along its track between polls and eases onto every new fix.
Altitude is true up to 1 500 m (approaches, helicopters); above that it is compressed
to 40 % so a jet at 35 000 ft is still somewhere the camera can see.

Taxis have no live data at all. `build_taxi.py` reduces a month of TLC records into
`flows(service, dow, hour, pickup_zone, dropoff_zone, trips, avg_secs)`;
`build_streets.py` routes every zone pair with ≥ 30 trips a month through the street
graph (three path variants per pair). For the weekday + hour on show, the server
draws `n` trips from the *whole* zone-to-zone distribution by systematic sampling
(evenly spaced points along the cumulative trip count, seeded, so a pair with 0.3
trips/hour gets a dot 30 % of the time and the same hour always looks the same) and
the browser replays that hour as a loop. Every dot therefore stands for the same
number of real trips - shown in the panel as "1 dot ≈ N trips" - and each
neighbourhood gets its true share of traffic. The **dots** selector picks the
scale: ≈ 5 trips per dot (default), ≈ 2, or one dot per trip (≈ 35–60 k particles,
heavy).

What is and isn't faithful about the cab layer:

* Counts are per-hour averages over that weekday in the month (holidays included),
  for yellow cabs and the high-volume ride-hail companies (Uber, Lyft). Green cabs
  (< 0.2 % of trips) are not included.
* TLC locates trips only to one of 263 taxi zones; a dot's route is the shortest
  street path between two points in those zones, at the pair's average trip time.
  Where it was in the zone, and the driver's actual route, are unknowable.
* Trips that start and end in the same zone (~8 %) and trips with an unknown zone
  (~4 %) cannot be drawn; the panel reports how many per hour they are.
* Replay speed is 30–120× real time (an hour loops in 0.5–2 minutes); the number
  of dots on the road at any instant is real concurrency ÷ trips-per-dot.
* "now" follows the New York clock (`America/New_York`) wherever the viewer is.

## The 3D layers

* **Underground** — track runs coloured by line at their real depth, stations with
  shafts up to the street, trains with glow and route bullets.

A small **What's moving** legend sits on the map (closable, remembered) explaining
the moving marks: trains, buses, ferries, the taxi / Uber / Lyft replay dots and aircraft.
* **Street** — buses, taxi particles (Uber white, Lyft pink, yellow cabs yellow),
  ferries with their routes, the CSCL street wireframe, bridges / tunnels / ramps
  in 3D, 311 complaints.
* **Elevated & sky** — buildings (OpenFreeMap footprints extruded to their height),
  the els with their support columns and a shadow on the street beneath, and the
  aircraft: a fuselage-and-wings glyph coloured by size class (heavies white, GA
  amber, helicopters green), a thin beam down to its shadow on the ground, a fading
  trail and callsign / altitude labels. The **Airspace** camera preset looks along the
  JFK approaches.

Everything that moves and everything underground is drawn "x-ray" over the buildings:
at a 60° pitch practically every Midtown street would otherwise be hidden behind a
tower. The **Pull the layers apart** slider sinks the subway 240 m and lifts the
street layer 240 m; camera presets, an orbit mode (`o`), hide-panel (`h`) and the
explode toggle (`x`) are on the keyboard.

## Follow camera: click anything that moves

Click a train, bus, ferry or plane and the map turns to face the way it is heading and
rides along behind it. The camera (`Follow` in `web/js/camera.js`) centres a little ahead
of the vehicle, eases the bearing toward its heading (~1 s) and settles zoom and pitch to a
framing per kind (closer for buses and low aircraft, wider for jets). After that, zoom and
pitch are yours: wheel-zoom keeps following. Drag the map, press Esc, or hit "let go" in
the chip at the top to release. Trains also open the detail panel.

## Cab view: ride in the front of a train (switched off)

The cab view is currently off (`CAB_VIEW = false` in `web/js/main.js`): with a vector
basemap and no tunnel geometry it cannot look real, and most of a subway ride is in a
tunnel. Everything below still works when the flag is on and is kept for the day photoreal
tiles make it worth it.

The **▶ Cab view** button in the chip at the top of the map (or `r`, or `#ride=bridge` in
the URL) puts you in the motorman's seat of a B/D/N/Q that is crossing, or about to cross,
the Manhattan Bridge; the chip says whether a live train is there right now or a ghost will
run it. Click any train and choose **▶ cab view** in the follow chip (or **ride in the
cab →** in its detail panel) to ride that one.
`Esc` / **exit cab** pulls back to a chase view of where you were. If no live train is
near the bridge a *ghost* Q runs it for you (`#ride=ghost` forces that), starting in the
dark just short of the Brooklyn portal, climbing onto the bridge at 29 mph, passing the
towers, and diving into the Manhattan tunnel before looping.

How it is built (`web/js/ride.js`, the `ride` branches in `layers.js`):

* **Camera rig.** The camera is a MapLibre camera, which is defined by a ground point,
  zoom, pitch and bearing rather than an eye and a direction. Every frame we take the
  ridden train's head (`rec.dist` on its `Polyline`, or the ghost's cursor), put the eye
  2.9 m above the rail on the right-hand track (2.2 m right of the GTFS centreline), aim
  it at a point 55 m up the track (bearing eased with τ = 0.45 s so curves swing rather
  than snap), and solve for the map centre / zoom that place MapLibre's camera exactly
  there at a 84.5° pitch (5.5° down). Uphill the eye is kept above the rail for the next
  60 m, since the camera cannot tilt above the horizon; downhill the pitch follows the
  grade. Underground the windshield blacks out (the camera cannot go below the map).
  MapLibre puts the near clipping plane at height/50 px, which from 40 m up would cut
  the first 20 m of track out of the windshield, so while riding it is pulled in to 12 %
  (`transform.overrideNearFarZ`) and restored on exit.
  The lens is widened from MapLibre's 36.9° to a 58° vertical field of view (a windshield,
  not a map) — deck.gl derives its view from the map but assumes the default lens, so the
  overlay is given a `MapView` with the same `fovy`, otherwise the rails drift off the
  basemap. At speed the car rocks on its trucks: a 7 cm lateral sway, 3 cm bob and a
  quarter-degree yaw at truck-and-rail-joint frequencies.
* **Geometry with real perspective.** deck.gl path widths are constant on screen, which
  is right for a map and wrong 3 m from the rail. So the stretch ahead is built as
  polygons: a track bed, ties (every 0.7 m nearby), rail ribbons at 1435 mm gauge for
  both tracks, a deck slab and a row of posts on the outer side, and every other train
  within 4 km as extruded car bodies (18.3 m cars for the lettered lines, 15.5 m for
  the numbered, 3 m wide, 3.6 m tall, with the same right-hand offset as on the map, so
  oncoming trains pass on the left). The ridden train itself is not drawn.
* **The bridge.** The two towers are in the basemap already (OSM `bridge:support`
  polygons, 102 m). Their centroids and the anchorages are in `SUSPENSION_BRIDGES`
  (Manhattan and Williamsburg); two main cables are hung between them as parabolas with
  suspenders every 10 m down to the deck. The deck is at its real height: the track
  profile in `static.json` puts rail level at 27 m over the anchorages, 38 m at the
  towers and 41 m at mid-span (`RIVER_BRIDGES` in `scripts/build_static.py`; the running
  mean turns the ends into the approach ramps), so the HUD's "40 m above the East River"
  is right and the trains climb to it.
* **Real sky and weather** (`web/js/sky.js`). The sun's elevation and azimuth are computed
  from the clock (NOAA's algorithm) and pick the sky, horizon and fog colours — night,
  civil dusk, sunset, day — and light the buildings from the sun's direction. The live
  observation from Central Park (`/api/weather`, National Weather Service, no key) greys
  the sky over with the cloud cover, thickens the fog, and puts rain streaks (fanning out
  faster as the train speeds up) or snow on the windshield.
* **Weather over the city** (one switch — **off** on the card, `w`, or the Layers list — turns all of it off, cab windshield included, and is remembered) (`web/js/weatherfx.js`, layer *Weather*). The same observation
  falls on the map view. Rain and snow are particles in a column of air around the view
  centre (up to ~1,900 of them, one typed array a frame, nothing simulated: each drop has a
  fixed footprint and phase and its height is a function of time), leaning with the wind —
  the NWS gives the direction the wind blows *from* — and drawn depth-tested so they fall
  behind the towers. Rain falls faster than real rain, which at map scale would barely seem
  to move. Fog, snow and rain set a MapLibre sky in the map's own dark palette so the far
  towers dissolve into haze; a clear sky leaves the map as it was. A thunderstorm flashes
  the whole city now and then (a hard stroke, a gap, a softer return stroke). The panel
  carries a weather card: a line icon for the condition that knows day from night (sun or
  moon), the temperature, the wind as an arrow pointing where it blows with speed and
  compass point, humidity, visibility, and the station and time of the observation.
* **Sound** (`web/js/sound.js`, synthesised with the Web Audio API — nothing to license).
  Brown-noise rolling that opens up with speed; a click per 39 ft rail length for each
  of the two trucks under the cab, so the clatter is a true function of speed; an
  inverter whine whose pitch rises with speed; wind that comes up on the bridge; a slap
  echo and darker mix in the tunnel. On live rides, the two-tone door chime when the
  train leaves a stop and a spoken announcement ("This is a Manhattan-bound Q train. The
  next stop is Canal Street", SpeechSynthesis). Browsers only allow audio after a click,
  so the **🔊** button in the cab HUD (or the click that started the ride) turns it on;
  the choice is remembered.
* **Station photographs.** As the train comes within 260 m of a stop a real photograph of
  that station fades in — small on the right when there is a view, large in the middle
  of the black windshield underground — with the photographer and licence beneath it,
  and fades out 120 m after leaving. `scripts/build_station_photos.py` finds each
  station's English Wikipedia article (the MTA name expanded to full words — "Times
  Sq-42 St" → "Times Square–42nd Street station" — plus the line it is on to tell the
  four Canal Streets apart) and takes its lead image with the author and licence from
  Wikimedia Commons; the index is `data/station_photos.json` (all 496 stations; a few
  are pinned by hand in `OVERRIDES` where the search lands on the wrong page),
  served at `/api/photos`.
* **Scene changes while riding.** Everything is depth-tested like a real scene instead
  of drawn x-ray over the buildings; the network becomes a faint thread between the
  rails; basemap labels and the basemap's own railway lines are hidden; the sky, fog and
  light follow the clock and weather (above); pillars and shafts more than 2.5 km away are dropped (pixel-width lines
  that project behind the camera smear across the sky); taxi trails shrink to car size.
  Map interaction is disabled until you exit, and everything is restored on exit.

## Photographs, street level and photoreal buildings

* **Station photo postcards** (layer *station photos*). On the 3D map, zoomed in past
  15.2, up to 12 stations with a photo carry it as a postcard standing 30 m over
  the station shaft, always facing the camera (a deck.gl `BitmapLayer` with four 3D
  corners, sized on screen rather than in metres); hovering shows the credit. A station
  complex (Times Sq, Union Sq, 14 St–6 Av…) is several stop ids that usually share one
  Wikipedia article, so it gets one card: the picture most of its stops carry, over the stop
  nearest the complex's centre (pictures are matched by file name, whatever thumbnail size
  or tracking suffix the URL has, and a picture shared by neighbouring stops outside any
  complex is likewise drawn once). Cards are then placed nearest-first with a screen-space
  overlap test (a card width across, a card height up, foreshortened by the pitch), so two
  never sit on top of each other.
* **Street level beside a followed bus** (`web/js/streetview.js`, `/api/streetview`). While
  following a bus, ferry or above-ground train, a picture-in-picture pane shows the
  nearest Mapillary street photo to the vehicle's live position, preferring images shot
  in its direction of travel (360° panoramas are windowed to a 120° view facing the way
  the vehicle is heading), re-queried every ~35 m. It works out of the box on the
  client token Mapillary publishes in its own open-source API demo
  (github.com/mapillary/api-demo); for anything beyond casual use register your own at
  mapillary.com/dashboard/developers (free, needs a Meta login) and either paste it in the
  **Keys** section of the panel (kept in this browser's localStorage) or put it in
  `data/keys.json` as `{"mapillary": "MLY|…"}` (or `MAPILLARY_TOKEN`). Photos are
  CC BY-SA; each has an "open ↗" link to Mapillary.
* **Photoreal city** (layer under *Buildings*). Google's Photorealistic 3D Tiles replace
  the grey basemap extrusions with photogrammetry of the real city — from the cab, the real
  bridge. It is a deck.gl `Tile3DLayer` on `tile.googleapis.com/v1/3dtiles/root.json`;
  the basemap's buildings hide while it is on and the tiles' copyright line is shown at
  the bottom. It needs your own Google Maps Platform key with the *Map Tiles API* enabled
  (the free monthly credit covers casual use; restrict the key to your origin because it
  is used from the browser): paste it under **Keys** or put `{"google_maps": "AIza…"}` in
  `data/keys.json`. It is GPU-heavy; expect the frame rate to halve on integrated graphics.

## Live cameras: click a pin, watch the street

Layer *Live cameras* (on by default) puts a red pin on a short pole at ten cameras — not the
1,300 public ones in the five boroughs, but the handful with a picture worth watching.

The public feeds are NYC DOT's ~970 street-corner cameras (JPEG stills, all 352×240) and
NYSDOT's ~310 expressway cameras via [511NY](https://511ny.org/developers/help), which stream
live HLS video (`.m3u8`, CORS-open). Two thirds of the video streams are also 352×240 and most
of them point at a stretch of pavement, so `subway/cameras.py` keeps a hand-picked list
(`PICKS`) chosen by probing every stream's resolution and grabbing a frame from each of the ~80
that were 512 px or wider: the Upper Bay from the Gowanus Expressway (1280×720), the downtown
skyline behind the Gowanus at the canal, the Red Hook spires from the BQE at Hamilton Avenue,
the Brooklyn Heights trench, J/M/Z trains crossing the BQE on the Williamsburg el (896×504),
Tribeca and the Hudson Yards towers from West Street, the Harlem River from the drive at 130th
and 164th (720×480), the Van Wyck at 1920×1080 — the sharpest stream NYSDOT has in the city —
and the Cross Bronx at Arthur Avenue. Each pick carries a title, a line on what is in the frame,
its position and its last known stream url, so the layer works with no network; every 12 h the
server asks 511NY for the current urls (NYSDOT moves streams between CDN hosts) and which picks
are online, and caches the result in `data/cameras.json`. A free 511NY developer key goes in
`data/keys.json` as `{"ny511": "…"}` or `NY511_KEY`; the list currently answers without one.

The browser plays the video directly — natively in Safari, with hls.js (loaded on first use)
elsewhere. Clicking a pin opens the viewer at the bottom right: the stream with its source and
actual resolution in the caption, the camera's road, direction and borough, what it looks at,
and the other nine picks nearest-first to click through — the map glides along. `Esc` or ×
closes it; `#cam=<id>` in the URL deep-links a camera. Pins carry their titles past zoom 12,
collision-culled like the station labels.

## API

| Endpoint | Description |
|---|---|
| `GET /api/trains[?scheduled=1]` | Motion model and metadata for every active train (`shape`, `dist`, `dist_to`, `eta`, `dwell`, `lat`, `lon`, `z`, `route`, `status`, stops…). |
| `GET /api/network` | Routes (colours), stations (with `z`, `structure`, `complex`) and track shapes as `[lat, lon, z]` with stop distances. |
| `GET /api/buses` · `GET /api/buses/network` | Live bus GPS with matched route shape; bus routes and shapes. |
| `GET /api/ferries` · `GET /api/ferries/network` | Live NYC Ferry vessels; routes. |
| `GET /api/aircraft` | Live aircraft within 45 nm (`id`, `callsign`, `reg`, `type`, `desc`, `operator`, `size`, `lat`, `lon`, `alt_m`, `speed_mps`, `track`, `vrate_mps`, `on_ground`, …) and which network served it. |
| `GET /api/taxi/flow?dow=4&hour=18&services=uber,lyft,yellow&top=200` | Per-hour totals by service, undrawable trips, per-zone pickups/dropoffs and the busiest pairs. |
| `GET /api/taxi/trips?...&n=7000` | `n` systematically sampled trips for that hour with their street paths, as one binary bundle (magic `TXIQ`, layout in `subway/taxi.py`). |
| `GET /api/taxi/zones` | Taxi zone centroids and polygons. |
| `GET /api/streets` · `GET /api/streets/crossings` | Street centrelines as a binary path buffer; bridges/tunnels/ramps as GeoJSON with `z`. |
| `GET /api/311?days=30&limit=5000` · `GET /api/311/summary` | Subway 311 requests. |
| `GET /api/weather` | Latest NWS observation for Central Park, classified for the renderer (`kind`: clear/clouds/overcast/fog/rain/snow/storm, `intensity`, `cloud`, `temp_c`, `wind_kmh`, …). |
| `GET /api/photos` | Station id → `{thumb, original, name, article, page, artist, license}` from `data/station_photos.json`. |
| `GET /api/streetview?lon&lat&heading[&token]` | Nearest Mapillary image (`url`, `heading`, `captured_at`, `link`, `demo` when on the public demo token) or `{available: false, reason}` if the token is rejected. |
| `GET /api/cameras` | The ten picked cameras: `id`, `title`, `view` (what is in the frame), `road`, `direction`, `area`, `lat`, `lon`, `source`, `online`, `video` (HLS url), `link` (511NY page). |
| `GET /api/keys` | Which optional keys are configured server-side (`mapillary` as a boolean; the Google key itself, since the browser needs it). |
| `GET /api/layers` · `GET /api/health` | Which data files are present; per-feed fetch status. |
| `GET /train/<id>` `/bus/<id>` `/ferry/<id>` `/plane/<id>` | The map, following that vehicle, with Open Graph tags for the link preview. |
| `GET /og/<train\|bus\|ferry\|plane>/<id>.png` · `GET /og/city.png` | The link-preview pictures, 1200×630, drawn from the live feeds. |

JSON and JavaScript responses are gzip-compressed when the client accepts it.

## Share links: every vehicle has an address

Every train, bus, ferry and plane on the map has a link — `/train/<id>`, `/bus/<id>`,
`/ferry/<id>`, `/plane/<id>` — that opens the map already following it. The **share**
button in the follow chip copies one (on a phone it opens the share sheet), and while you
follow anything the address bar shows its link, so copying the URL works too.

Paste one into iMessage, Slack, X or anywhere that unfurls links and it comes up as a card:
the server puts Open Graph / Twitter tags on the page whose picture is drawn on the spot
from the live feeds (`subway/share.py`, Pillow, 1200×630): *Follow this Q train · 96 St →
Coney Island-Stillwell Av · right now between Canal St and DeKalb Av*, the route lit up on
a map of the city, a dot where the train is, its heading, and the weather in the footer.
Buses and ferries zoom the map to their route; planes get a trail, and one outside the
city is pinned to the edge of the map with its distance. The front page unfurls with the
whole network and every live train and plane on it (`/og/city.png`).

Vehicles are transient, so a link outlives the trip it names. When that happens the page
still comes up with a card (*Follow a Q train — this one has finished its run*) and the
map hands you another train of the same route and direction, the one with the most of its
run left; a bus, boat or flight that has gone just gets a line at the bottom of the map.

The pictures cost tens of milliseconds and are cached for 20–60 s per vehicle, so a link
in a busy chat does not render once per crawler. The public base URL comes from
`X-Forwarded-Proto` / `Host` (set `PUBLIC_URL` to override).

## URL state

Both pages keep the camera in the hash. 3D: `#c=-73.9855,40.7535&z=14.6&p=62&b=-28&x=40`
(centre, zoom, pitch, bearing, explode %); add `ride=bridge` or `ride=ghost` to start in
the cab over the Manhattan Bridge, or `cam=<camera id>` to open a live camera. 2D: `#c=…&z=13&routes=A,C,E&311=60`.

## Layout

```
server.py                    HTTP server + JSON/binary API (ThreadingHTTPServer, gzip)
subway/feeds.py              fetch + decode the 8 MTA subway GTFS-RT feeds
subway/positions.py          motion model per train (ETA-driven, monotonic)
subway/network.py            static network: shapes with z, stations, trip -> shape matching
subway/geo.py                haversine, projection onto polylines, simplification, grid index
subway/poller.py             base class for the background feed pollers
subway/buses.py              MTA Bus Time GTFS-RT + bus GTFS shape matching
subway/ferries.py            NYC Ferry GTFS-RT
subway/aircraft.py           ADS-B aircraft (adsb.fi / adsb.lol)
subway/cameras.py            the ten hand-picked NYSDOT video cameras; refreshes their stream urls from 511NY
subway/taxi.py               TLC flow model (DuckDB), trip sampling + street path bundles (mmap'd numpy)
scripts/build_static.py      subway GTFS + station structure + OSM tags -> data/static.json
scripts/build_bus_static.py  bus GTFS bundles -> data/bus_network.json, data/bus_trips.json
scripts/build_ferry_static.py  ferry GTFS -> data/ferry_network.json
scripts/build_taxi.py        TLC parquet -> data/taxi_flow.duckdb, data/taxi_zones.json
scripts/build_streets.py     CSCL -> data/streets/{streets.bin, crossings.json, paths.npy, paths_index.json}
scripts/fetch_311.py         NYC Open Data -> data/311_subway.{csv,json}, 311_summary.json
web/index.html, web/js/main.js   3D view (MapLibre + deck.gl, ES modules, no build step)
web/2d.html, web/js/flat.js      flat map of the trains
web/js/trains.js, vehicles.js    smooth track-following motion for trains / buses / ferries
web/js/aircraft.js               dead-reckoned aircraft with altitude compression
web/js/ride.js                   cab view: camera rig, track/bridge/car geometry, ghost train
web/js/cameras.js                live camera viewer: HLS video, the other picks as a list
web/js/taxi.js, layers.js, camera.js, geo.js, api.js, ui.js
```

## Ideas: what would make the picture truer

Roughly in order of how much they would change what you see, all free / no-key unless noted.

**Subway**
- **Real track assignment.** The NYCT GTFS-RT extension (`nyct_stop_time_update.actual_track` /
  `scheduled_track`, e.g. `A1` local vs `A3` express, and `nyct_trip_descriptor.train_id`) says
  which of the four tracks each train is on. Paired with per-track geometry from OpenStreetMap
  (`railway=subway` ways are digitised track by track for most of the system) trains would sit
  on their actual track and the "outer lane" rule above becomes unnecessary.
- **Service alerts** (`camsys/subway-alerts` GTFS-RT): show reroutes, skipped stops and
  suspensions on the map instead of drawing the timetable's shape while a train is running
  express on another line's track.
- **Accuracy meter.** When a train reports `STOPPED_AT`, log how far our model had it from
  the platform. Publish the running median error per line — an honest number instead of a
  smooth animation that looks certain.
- **Station ridership pulse.** MTA hourly ridership by station (Open Data `wujg-7c2s` /
  `5wq4-mkjj`) — size or light each station by a typical count for this hour, so the map
  breathes with the commute the same way the taxi replay does.
- **Elevator/escalator outages** (MTA `camsys/nyct_ene` feed) as red marks on the shafts.

**More of the city moving**
- **LIRR and Metro-North** GTFS-RT (`lirr/gtfs-lirr`, `mnr/gtfs-mnr`) — live, no key — into Penn,
  Grand Central and Atlantic Terminal; the Park Avenue tunnel and East River tunnels are
  already in the underground stratum with nothing running through them.
- **Citi Bike** GBFS (`gbfs.citibikenyc.com`): 2 000+ stations with live dock counts; there is
  no trip feed, but the historical trip CSVs would drive a replay like the taxis.
- **Harbour AIS** (aisstream.io, free key): the Staten Island Ferry, tugs, tankers and cruise
  ships, not just the NYC Ferry fleet.
- **Street speeds** — NYC DOT real-time traffic speed sensors (Open Data `i4gi-tmcm`) to colour
  the road grid by congestion, and to slow the taxi replay where the streets really are slow.
- **Bus crowding**: MTA Bus Time already publishes `occupancy_status` per vehicle; the buses
  could glow by load.
- **PATH** has no official realtime feed; the community `path-data` API is the only option.

**Taxi replay fidelity**
- Trips are drawn along the shortest street path; using the TLC `trip_distance` to pick the
  path variant whose length matches would follow the real detours more often.
- Congestion pricing (Jan 2025) changed Manhattan below 60 St; a month-over-month toggle
  would show it.

**Ground truth for the geometry**
- Building heights from NYC's own **Building Footprints** (`heightroof`, `groundelev`) instead
  of OSM extrusions — complete and surveyed, with real ground elevation for the terrain.
- Tunnel depths are still estimates from station structure and OSM `layer` tags; the MTA
  track schematics and the DEP/Con Ed utility maps would place the water tunnels, steam mains
  and sewers in the same stratum, which is what the "layers of the city" idea wants.
- **Time travel**: archived GTFS-RT (e.g. subwaydata.nyc) would let the whole thing replay a
  past day — a blizzard, a blackout, New Year's Eve.

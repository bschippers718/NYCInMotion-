// NYC in Motion - 3D view. deck.gl layers interleaved into a MapLibre basemap.
//
//   below street   subway tunnels, stations, trains (depth from MTA + OSM data)
//   street level   buses on their routes, taxi particles on real streets, ferries
//   above street   elevated tracks, bridges, buildings (OpenFreeMap vector tiles)
//
// The "explode" slider pulls the strata apart vertically.

import { Clock, decodeStreets, getBuffer, getJSON } from "./api.js";
import { Follow, Orbit, VIEWS } from "./camera.js";
import { Ride } from "./ride.js";
import { CabAudio } from "./sound.js";
import { Windshield } from "./sky.js";
import { KEYS, StreetView } from "./streetview.js";
import { CameraViewer } from "./cameras.js";
import { clamp, hex2rgb } from "./geo.js";
import { buildLayers, buildPillars, buildTrackRuns } from "./layers.js";
import { AircraftTracker } from "./aircraft.js";
import { DENSITIES, TaxiReplay } from "./taxi.js";
import { TrainTracker } from "./trains.js";
import { $, fmtHour, renderDetail, renderRouteChips, renderStatus, renderTaxiNote, setLayerControl, tooltip } from "./ui.js";
import { VehicleTracker } from "./vehicles.js";

const TRAIN_POLL_MS = 5000;
const BUS_POLL_MS = 10000;
const FERRY_POLL_MS = 15000;
const AIR_POLL_MS = 5000;

const state = {
  layers: {
    buildings: true, crossings: false, aircraft: true, buses: true, busRoutes: false, taxi: false, columns: false, ferries: true, streets: false,
    complaints: false, trains: true, tracks: true, stations: true, scheduled: false, labels: true, photos: true, photoreal: false, cameras: true,
  },
  camera: null, // id of the camera open in the viewer
  googleKey: null,
  tilesCredit: "",
  photos: null, // stop id (parent) -> { thumb, name, artist, license, page }
  explode: 0,
  services: new Set(["uber", "lyft", "yellow"]),
  ...nycNow(),
  followNow: true,
  taxiSpeed: 60,
  taxiLoopStart: 0,
  routes: {},
  activeRoutes: null,
  selected: null,
  zoom: 14,
  feedInfo: null,
  busInfo: null,
  ferryInfo: null,
  airInfo: null,
  flow: null,
  zones: null,
  frame: 0,
  perf: { buildMs: 0, frameMs: 0, lastFrameAt: 0 },
};

const clock = new Clock();
const trains = new TrainTracker();
const buses = new VehicleTracker({ defaultSpeed: 5.5, maxSpeed: 17, z: 0 });
const ferries = new VehicleTracker({ defaultSpeed: 7, maxSpeed: 14, z: 0 });
const aircraft = new AircraftTracker();
const taxi = new TaxiReplay({ particles: DENSITIES[localStorage.getItem("nyc-taxi-density") || "sparse"] ?? 7000 });
const statics = { labelLayerId: null, trackRuns: null, elevatedRuns: [], pillars: null, stations: null, stationLabels: null, busRoutes: null, ferryRoutes: null, streets: null, crossings: null, zoneColumns: null, complaints: null, cameras: null };

// ---- map ---------------------------------------------------------------------
const hashView = parseHash();
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  ...(hashView || VIEWS.downtown),
  maxPitch: 80,
  antialias: true,
  attributionControl: { compact: true },
  hash: false,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
const overlay = new deck.MapboxOverlay({ interleaved: true, layers: [], pickingRadius: 6, getTooltip: (info) => tooltip(state, info) }); // pickingRadius: buses are ~2 px wide
map.addControl(overlay);
const orbit = new Orbit(map);
const ride = new Ride(map, trains, overlay);
const follow = new Follow(map, (f) => renderFollowHud(f));
const audio = new CabAudio();
const windshield = new Windshield($("ride-weather"));
const streetview = new StreetView($("streetview"));
const camview = new CameraViewer($("camview"), {
  onOpen: (cam, { nearby } = {}) => {
    state.camera = cam.id;
    document.body.classList.add("camera-open");
    writeHash();
    if (nearby) map.easeTo({ center: [cam.lon, cam.lat], zoom: Math.max(map.getZoom(), 14), duration: 1400, essential: true }); // stepping through the list: glide along
  },
  onClose: () => { state.camera = null; document.body.classList.remove("camera-open"); writeHash(); },
});
window.__nyc = { map, overlay, state, trains, buses, ferries, aircraft, taxi, statics, ride, follow, audio, windshield, streetview, camview, kick: () => { cancelAnimationFrame(rafId); render(performance.now()); } }; // for poking at from the console

map.on("load", () => {
  state.zoom = map.getZoom();
  const layers = map.getStyle().layers;
  // Insert our layers above every road / footprint layer of the basemap but below the
  // place labels. (The first symbol layer in this style is "water_name", which sits
  // *under* the roads - using it would bury the tracks under the street casing.)
  const lastGround = layers.reduce((idx, l, i) => (l.type !== "symbol" && !/boundary/.test(l.id) ? i : idx), -1);
  statics.labelLayerId = (layers.slice(lastGround + 1).find((l) => l.type === "symbol") || {}).id;
  // tone the basemap down so our layers carry the picture
  for (const l of layers) {
    if (l.type === "fill" && /landuse|landcover|park/.test(l.id)) map.setPaintProperty(l.id, "fill-opacity", 0.5);
    if (l.type === "fill" && l.id === "building") map.setPaintProperty(l.id, "fill-opacity", 0.35);
    if (l.type === "symbol" && /highway_name|road_name/.test(l.id)) map.setPaintProperty(l.id, "text-opacity", 0.55);
    if (l.type === "line" && /road|street|highway|bridge|tunnel|motorway|path/.test(l.id) && !/label/.test(l.id)) {
      try { map.setPaintProperty(l.id, "line-opacity", 0.55); } catch (_) { /* some layers have no opacity */ }
    }
  }
  map.setLight({ anchor: "viewport", color: "#b9c6ff", intensity: 0.38, position: [1.3, 200, 40] });
  map.addLayer(
    {
      id: "3d-buildings",
      source: "openmaptiles",
      "source-layer": "building",
      type: "fill-extrusion",
      minzoom: 12.2,
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 10], 0, "#1a202b", 40, "#232b3a", 120, "#2e3749", 300, "#3c475c"],
        "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 12.2, 0, 13.4, ["coalesce", ["get", "render_height"], 10]],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.9,
        "fill-extrusion-vertical-gradient": true,
      },
    },
    statics.labelLayerId
  );
  boot();
});
map.on("zoom", () => (state.zoom = map.getZoom()));
map.on("moveend", () => { if (!ride.active && !follow.active) writeHash(); });

// ---- URL state -------------------------------------------------------------------
function parseHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has("c")) return null;
  // The hash tracks the camera as you pan, so a plain reload would otherwise reopen wherever you left off.
  // Fresh loads and reloads always start downtown; only a link someone actually navigated to keeps its view.
  if (performance.getEntriesByType("navigation")[0]?.type === "reload") return null;
  const [lon, lat] = h.get("c").split(",").map(Number);
  return { center: [lon, lat], zoom: +h.get("z") || 14, pitch: +h.get("p") || 60, bearing: +h.get("b") || 0 };
}
function writeHash() {
  const c = map.getCenter();
  const h = new URLSearchParams({ c: `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`, z: map.getZoom().toFixed(2), p: map.getPitch().toFixed(0), b: map.getBearing().toFixed(0) });
  if (state.explode) h.set("x", Math.round(state.explode * 100));
  if (state.camera) h.set("cam", state.camera);
  history.replaceState(null, "", `#${h}`);
}

// ---- data loading -------------------------------------------------------------------
async function loadNetwork() {
  const net = await getJSON("/api/network");
  state.routes = net.routes;
  trains.setNetwork(net);
  statics.trackRuns = buildTrackRuns(net, net.routes, hex2rgb);
  statics.elevatedRuns = statics.trackRuns.filter((r) => r.elevated).map((r) => ({ ground: r.path.map((p) => [p[0], p[1], 0.3]) }));
  statics.pillars = buildPillars(statics.trackRuns);
  statics.stations = net.stations.map((s) => ({ ...s, z: s.z ?? -16 }));
  // one label per station complex (Times Sq has five platforms, one name)
  const labelled = new Set();
  statics.stationLabels = statics.stations.filter((s) => {
    const k = s.complex ?? s.name;
    if (labelled.has(k)) return false;
    labelled.add(k);
    return true;
  });
  renderRouteChips(state, {}, null);
}

async function loadBusNetwork() {
  try {
    const net = await getJSON("/api/buses/network");
    buses.setNetwork(net);
    statics.busRoutes = net.shapes.map((sh) => ({ color: hex2rgb((net.routes[sh.route] || {}).color || "#f28c28"), path: sh.points.map(([lat, lon]) => [lon, lat, 0]) }));
  } catch (err) { console.warn("bus network:", err.message); }
}

async function loadFerryNetwork() {
  try {
    const net = await getJSON("/api/ferries/network");
    ferries.setNetwork(net);
    statics.ferryRoutes = net.shapes.map((sh) => ({ color: hex2rgb((net.routes[sh.route] || {}).color || "#00839c"), path: sh.points.map(([lat, lon]) => [lon, lat, 0]) }));
  } catch (err) { console.warn("ferry network:", err.message); }
}

async function loadStreets() {
  if (statics.streets) return;
  try {
    const s = decodeStreets(await getBuffer("/api/streets"));
    statics.streets = { length: s.length, startIndices: s.startIndices, attributes: { getPath: { value: s.positions, size: 3 } } };
  } catch (err) { console.warn("streets:", err.message); }
}
async function loadCrossings() {
  if (statics.crossings) return;
  try { statics.crossings = await getJSON("/api/streets/crossings"); } catch (err) { console.warn("crossings:", err.message); }
}
async function loadComplaints() {
  if (statics.complaints) return;
  const data = await getJSON("/api/311?days=30&limit=6000");
  statics.complaints = data.rows || [];
}

/** The ten picked NYSDOT video cameras. The server refreshes their stream urls in the background at start, so retry if the list is not there yet. */
async function loadCameras(attempt = 0) {
  try {
    const data = await getJSON("/api/cameras");
    if (!data.count) {
      if (attempt < 6) setTimeout(() => loadCameras(attempt + 1), 5000);
      else { $("cameras-hint").textContent = `camera index unavailable: ${data.error || "no cameras"}`; $("cameras-hint").classList.remove("hidden"); }
      return;
    }
    statics.cameras = data.cameras.filter((c) => c.online);
    camview.setCameras(statics.cameras);
    $("n-cameras").textContent = `${statics.cameras.length}`;
    $("cameras-hint").classList.add("hidden");
    // #cam=<id> deep-links a camera
    const want = new URLSearchParams(location.hash.slice(1)).get("cam");
    if (want && !state.camera) openCamera(statics.cameras.find((c) => c.id === want), true);
  } catch (err) { console.warn("cameras:", err.message); }
}

/** Open a camera in the viewer; `fly` eases the map to it (deep links and the nearby strip). */
function openCamera(cam, fly = false) {
  if (!cam || ride.active) return;
  camview.open(cam);
  if (fly) map.easeTo({ center: [cam.lon, cam.lat], zoom: Math.max(map.getZoom(), 15.2), duration: 1400, essential: true });
}

async function loadLayerStatus() {
  const st = await getJSON("/api/layers");
  if (!st.taxi.available) {
    setLayerControl("taxi", false, true);
    state.layers.taxi = false;
    $("taxi-hint").textContent = st.taxi.hint;
    $("taxi-hint").classList.remove("hidden");
  } else if (!st.taxi.street_paths) {
    $("taxi-hint").textContent = "Street routes not built (python scripts/build_streets.py) - particles fly zone to zone.";
    $("taxi-hint").classList.remove("hidden");
  }
  if (!st.streets.available) { setLayerControl("streets", false, true); setLayerControl("crossings", false, true); }
  if (!st.complaints.available) setLayerControl("complaints", false, true);
}

// ---- polling --------------------------------------------------------------------------
let trainTimer = null;
async function pollTrains() {
  clearTimeout(trainTimer);
  try {
    const t0 = performance.now();
    const data = await getJSON(`/api/trains?scheduled=${state.layers.scheduled ? 1 : 0}`);
    clock.sample(data.generated_at, t0);
    state.feedInfo = data;
    trains.ingest(data.trains, data.generated_at);
    renderRouteChips(state, trains.byRoute, null);
    $("n-trains").textContent = data.count;
    if (state.selected) showDetail(state.selected, data.trains.find((t) => t.id === state.selected));
    renderStatus(state, clock);
  } catch (err) {
    $("headline").textContent = `subway feed error: ${err.message}`;
  }
  trainTimer = setTimeout(pollTrains, TRAIN_POLL_MS);
}

let busTimer = null;
async function pollBuses() {
  clearTimeout(busTimer);
  if (state.layers.buses) {
    try {
      const data = await getJSON("/api/buses");
      state.busInfo = data;
      if (!data.error) buses.ingest(data.buses, clock.now());
      $("n-buses").textContent = data.count || "";
      renderStatus(state, clock);
    } catch (err) { console.warn(err); }
  }
  busTimer = setTimeout(pollBuses, BUS_POLL_MS);
}

let ferryTimer = null;
async function pollFerries() {
  clearTimeout(ferryTimer);
  if (state.layers.ferries) {
    try {
      const data = await getJSON("/api/ferries");
      state.ferryInfo = data;
      if (!data.error) ferries.ingest(data.vessels, clock.now());
      $("n-ferries").textContent = data.count || "";
    } catch (err) { console.warn(err); }
  }
  ferryTimer = setTimeout(pollFerries, FERRY_POLL_MS);
}

let airTimer = null;
async function pollAircraft() {
  clearTimeout(airTimer);
  if (state.layers.aircraft) {
    try {
      const data = await getJSON("/api/aircraft");
      state.airInfo = data;
      // fixes are stamped relative to the feed time, which is ~now on the server
      if (!data.error && data.aircraft) aircraft.ingest(data.aircraft, data.header_ts || clock.now());
      $("n-aircraft").textContent = data.count || "";
    } catch (err) { console.warn(err); }
  }
  airTimer = setTimeout(pollAircraft, AIR_POLL_MS);
}

async function loadFlow() {
  if (!state.layers.taxi || !taxi.zones) return;
  $("taxi-note").textContent = "loading trips…";
  const flow = await taxi.load(state.dow, state.hour, state.services);
  if (!flow) return;
  state.flow = flow;
  state.zones = taxi.zones;
  state.taxiLoopStart = clock.now();
  statics.zoneColumns = taxi.zoneColumns();
  state.taxiTrips = taxi.trips;
  state.taxiPerDot = taxi.tripsPerDot;
  renderTaxiNote(state, flow, taxi);
  renderStatus(state, clock);
}

/** Weekday (0 = Monday) and hour in New York, wherever the viewer is. */
function nycNow() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday").value;
  const hour = +parts.find((p) => p.type === "hour").value % 24;
  return { dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd), hour };
}

// ---- render loop --------------------------------------------------------------------
let frame = 0;
let rafId = 0;
function render(nowMs) {
  rafId = requestAnimationFrame(render);
  frame++;
  state.frame = frame;
  const t0 = performance.now();
  if (!ride.active && !follow.active) orbit.tick(nowMs);
  const now = clock.now();
  trains.update(now);
  buses.update(now);
  ferries.update(now);
  aircraft.update(now);
  const dtS = state.perf.lastFrameAt ? (nowMs - state.perf.lastFrameAt) / 1000 : 0.016;
  if (ride.active) {
    ride.tick(dtS);
    if (audio.on) audio.update(rideAudioState(ride.cursor(), dtS));
    windshield.draw(dtS, ride.cursor()?.speed || 0);
    if (frame % 6 === 0) { renderRideHud(ride, trains, state); renderRidePhoto(ride.cursor()); }
  } else if (follow.active) {
    follow.tick(dtS);
    if (frame % 10 === 0) renderFollowHud(follow);
    if (frame % 15 === 0) {
      const t = follow.target();
      // street photos make sense at street level: buses, ferries at the piers, trains that are not underground
      if (t && (follow.kind !== "aircraft") && (follow.kind !== "train" || t.pos[2] > -2)) streetview.update(t.pos, t.bearing, t.title);
      else streetview.hide();
    }
  }
  const mc = map.getCenter();
  overlay.setProps({ layers: buildLayers({ state, trains, buses, ferries, aircraft, taxi, statics, now, frame, ride: ride.cursor(), view: { center: [mc.lng, mc.lat], bearing: map.getBearing(), pitch: map.getPitch() }, onSelectTrain: selectTrain, onFollow: startFollow, onCamera: openCamera }) });
  // cheap perf telemetry for the status line / console (`__nyc.state.perf`)
  const dt = performance.now() - t0;
  state.perf.buildMs = state.perf.buildMs * 0.95 + dt * 0.05;
  if (state.perf.lastFrameAt) state.perf.frameMs = state.perf.frameMs * 0.95 + (nowMs - state.perf.lastFrameAt) * 0.05;
  state.perf.lastFrameAt = nowMs;
}

function showDetail(id, data) {
  renderDetail(state, data, () => { state.selected = null; if (follow.kind === "train") follow.stop(); }, () => rideTrain(id));
}
function selectTrain(id) {
  state.selected = id;
  const rec = trains.get(id);
  showDetail(id, rec?.data);
  if (rec && !ride.active) startFollow("train", id);
}

// ---- follow camera: click a train / bus / plane / ferry and ride along behind it --------------
const FRAMING = {
  train: { zoom: 15.6, pitch: 62, leadM: 140 },
  bus: { zoom: 16.4, pitch: 62, leadM: 70 },
  ferry: { zoom: 14.6, pitch: 60, leadM: 250 },
  aircraft: { zoom: 12.4, pitch: 66, leadM: 1600 },
};
const mph = (mps) => `${Math.round((mps || 0) * 2.237)} mph`;
const FOLLOW_GETTERS = {
  train: (id) => () => {
    const r = trains.get(id);
    if (!r?.shape) return null;
    const t = r.data;
    const where = t.status === "STOPPED_AT" ? `standing at ${t.prev_stop_name}` : `next ${t.next_stop_name}`;
    return { pos: r.pos, bearing: r.bearing, title: `${dirWordShort(t.direction)} ${t.route.replace(/X$/, "")}`, sub: `${where} · ${mph(r.speed)}`, color: state.routes[t.route]?.color, text: state.routes[t.route]?.text_color, bullet: t.route.replace(/X$/, "") };
  },
  bus: (id) => () => {
    const v = buses.vehicles.get(id);
    if (!v) return null;
    const status = v.data.status === "STOPPED_AT" ? "at a stop" : v.data.status === "INCOMING_AT" ? "pulling in" : "on its way";
    return { pos: v.pos, bearing: v.bearing, title: `${v.data.route || "bus"} bus`, sub: `${v.onRoute ? mph(v.speed) + " · " : ""}${status}${v.data.occupancy ? ` · ${v.data.occupancy}` : ""} · vehicle ${v.data.id}`, color: v.data.color || "#f28c28", text: "#000", bullet: "B" };
  },
  ferry: (id) => () => {
    const v = ferries.vehicles.get(id);
    if (!v) return null;
    return { pos: v.pos, bearing: v.bearing, title: `NYC Ferry ${v.data.route || ""}`, sub: `${v.data.label || v.data.id}${v.data.speed_mps != null ? ` · ${(v.data.speed_mps * 1.944).toFixed(0)} kn` : ""}`, color: "#3fc1c9", text: "#000", bullet: "F" };
  },
  aircraft: (id) => () => {
    const a = aircraft.aircraft.get(id);
    if (!a) return null;
    const d = a.data;
    return { pos: a.pos, bearing: a.track, title: d.callsign || d.reg || d.id, sub: `${[d.desc || d.type, d.operator].filter(Boolean).join(" · ")} · ${Math.round(a.alt * 3.281).toLocaleString()} ft${d.speed_mps ? ` · ${Math.round(d.speed_mps * 1.944)} kn` : ""}`, color: "#dfe6ff", text: "#000", bullet: "✈" };
  },
};
const dirWordShort = (d) => (d === "N" ? "northbound" : d === "S" ? "southbound" : "");
function startFollow(kind, id) {
  if (ride.active) return;
  const get = FOLLOW_GETTERS[kind]?.(id);
  if (!get || !get()) return;
  orbit.set(false); $("orbit").checked = false;
  let frame = FRAMING[kind];
  if (kind === "aircraft") {
    // low, slow traffic (helicopters, GA over the rivers) wants a closer camera than a jet at 8,000 ft
    const alt = aircraft.aircraft.get(id)?.alt || 0;
    frame = alt < 1200 ? { zoom: 13.4, pitch: 66, leadM: 800 } : frame;
  }
  follow.start(kind, id, get, frame);
}
function renderFollowHud(f) {
  const el = $("follow");
  const t = f.target();
  if (!t) { el.classList.add("hidden"); document.body.classList.remove("following"); streetview.hide(); if (!ride.active) writeHash(); return; }
  el.classList.remove("hidden");
  document.body.classList.add("following");
  $("follow-cab").classList.toggle("hidden", f.kind !== "train");
  const b = $("follow-bullet");
  b.textContent = t.bullet; b.style.background = t.color || "#888"; b.style.color = t.text || "#000";
  $("follow-title").textContent = t.title;
  $("follow-sub").textContent = t.sub;
}

// ---- cab view -------------------------------------------------------------------------
function rideTrain(id) {
  const rec = trains.get(id);
  if (!rec?.shape) return;
  orbit.set(false); $("orbit").checked = false;
  follow.stop();
  ride.follow(rec);
  audio.tryResume(); // we are inside a click / key handler here
}
// The Manhattan Bridge: the elevated run of the B/D/N/Q between the Brooklyn and Manhattan portals.
const BRIDGE_BOX = { lon: [-73.9948, -73.983], lat: [40.7003, 40.7138] };
const inBridgeBox = (p) => p[0] > BRIDGE_BOX.lon[0] && p[0] < BRIDGE_BOX.lon[1] && p[1] > BRIDGE_BOX.lat[0] && p[1] < BRIDGE_BOX.lat[1];
const bridgeSpans = new Map(); // shape -> { d0, d1 } | null
function bridgeSpan(shape) {
  if (bridgeSpans.has(shape)) return bridgeSpans.get(shape);
  let d0 = null, d1 = null;
  for (let d = 0; d < shape.length; d += 20) {
    const p = shape.pointAt(d);
    if (inBridgeBox(p) && p[2] > 3) { if (d0 == null) d0 = d; d1 = d; }
  }
  const span = d0 != null && d1 - d0 > 800 ? { d0, d1 } : null;
  bridgeSpans.set(shape, span);
  return span;
}
/** Ride a live train over the Manhattan Bridge if one is about to cross; otherwise drive a ghost Q over it. */
/** The live B/D/N/Q best placed to carry us over the bridge right now, or null. */
function bridgeCandidate(maxApproachM = 350) {
  let best = null;
  for (const rec of trains.trains.values()) {
    if (!rec.shape || !/^[BDNQ]$/.test(rec.data.route) || rec.data.scheduled) continue;
    const span = bridgeSpan(rec.shape);
    if (!span) continue;
    const toBridge = span.d0 - rec.dist; // m until the portal (negative = already on it)
    if (toBridge > maxApproachM || rec.dist > span.d1 - 400) continue;
    // prefer a train already on the bridge with the most bridge still ahead, then the nearest approaching one
    const score = toBridge <= 0 ? 1000 + (span.d1 - rec.dist) : 500 - toBridge;
    if (!best || score > best.score) best = { rec, span, toBridge, score };
  }
  return best;
}
function renderCabStatus() {
  const el = $("cab-status");
  if (!el) return;
  if (!trains.trains.size) { el.textContent = "waiting for the live feed…"; return; }
  const c = bridgeCandidate(2500);
  if (!c) { el.textContent = "no B·D·N·Q near the bridge right now — a ghost Q will run it for you"; return; }
  const t = c.rec.data, dir = DIR_WORD[t.direction] || "";
  if (c.toBridge <= 0) el.textContent = `live: a ${dir} ${t.route} is on the bridge now`;
  else if (c.toBridge <= 350) el.textContent = `live: a ${dir} ${t.route} is about to enter the bridge`;
  else el.textContent = `live: next ${dir} ${t.route} reaches the bridge in ~${Math.max(1, Math.round(c.toBridge / Math.max(4, c.rec.speed || 8) / 60))} min · ghost Q until then`;
}
setInterval(renderCabStatus, 2000);
function rideManhattanBridge(forceGhost = false) {
  orbit.set(false); $("orbit").checked = false;
  follow.stop();
  const best = forceGhost ? null : bridgeCandidate();
  if (best) { ride.follow(best.rec); return; }
  const id = [...trains.shapes.keys()].find((k) => /^Q\.\.N/.test(k) && bridgeSpan(trains.shapes.get(k)));
  const shape = id && trains.shapes.get(id);
  if (!shape) return;
  const span = bridgeSpan(shape);
  const route = state.routes.Q || {};
  // start in the dark just short of the Brooklyn portal, run the bridge, dive into the Manhattan tunnel, loop
  ride.tour(shape, { route: "Q", dir: "Manhattan-bound", color: hex2rgb(route.color || "#F6BC26"), text: hex2rgb(route.text_color || "#000000"), d0: span.d0 - 110, d1: span.d1 + 260, vmax: 13, v0: 7, label: "ghost run: no Q is about to cross right now" });
}
const DIR_WORD = { N: "Manhattan-bound", S: "Brooklyn-bound" };
/** Where the ridden train is: { p, z, onBridge, where, dir } (dir only for live trains). */
function rideWhere(c) {
  const p = c.shape.pointAt(c.dist);
  const z = p[2];
  const onBridge = inBridgeBox(p) && z > 3;
  const where = onBridge ? `Manhattan Bridge · ${Math.round(z)} m above the East River` : z < -1 ? `in the tunnel, ${Math.round(-z)} m down` : z > 3 ? `elevated, ${Math.round(z)} m up` : "at grade";
  let dir = "";
  if (c.live) {
    const t = c.rec.data;
    dir = t.direction === "N" || t.direction === "S" ? (/^[BDNQ]$/.test(t.route) && (onBridge || z < 0) ? DIR_WORD[t.direction] : t.direction === "N" ? "northbound" : "southbound") : "";
  }
  return { p, z, onBridge, where, dir };
}
function rideAudioState(c, dt) {
  if (!c) return { speed: 0, z: 0, dt };
  const w = rideWhere(c);
  const t = c.live ? c.rec.data : null;
  return { speed: c.speed, z: w.z, onBridge: w.onBridge, dt, live: c.live, stopped: t ? t.status === "STOPPED_AT" : false, nextStop: t?.next_stop_name, route: c.route, dirWord: w.dir };
}
function renderRideHud(ride, trains, state) {
  const c = ride.cursor();
  const el = $("ride");
  if (!c) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const route = state.routes[c.route] || {};
  const b = $("ride-bullet");
  b.textContent = c.route; b.style.background = route.color || "#888"; b.style.color = route.text_color || "#000";
  const { z, where, dir } = rideWhere(c);
  const mph = Math.round(c.speed * 2.237);
  let title, sub;
  if (c.live) {
    const t = c.rec.data;
    title = `${dir} ${route.short_name || c.route}`.trim();
    const next = t.status === "STOPPED_AT" ? `standing at ${t.prev_stop_name}` : `next ${t.next_stop_name}${t.eta_s != null ? ` in ${Math.max(0, Math.round(t.eta_s / 60))} min` : ""}`;
    sub = `${where} · ${next} · ${mph} mph`;
  } else {
    title = `${c.dir || ""} ${c.route} · ghost run`.trim();
    sub = `${where} · ${mph} mph · ${c.label}`;
  }
  $("ride-title").textContent = title;
  $("ride-sub").textContent = sub;
  // black out the windshield while we are underground (the camera can't go below the map)
  $("ride-dark").style.opacity = Math.min(1, Math.max(0, (-z - 0.5) / 4.5)).toFixed(2);
}
ride.onChange = (r) => { renderRideHud(r, trains, state); document.body.classList.toggle("riding", r.active); if (r.active) camview.close(); else { writeHash(); audio.quiet(); } };
function renderSoundButton() {
  const b = $("ride-sound");
  b.textContent = audio.on ? "🔊 sound on" : audio.wanted && !audio.ctx ? "🔇 tap for sound" : "🔇 sound off";
  b.classList.toggle("on", audio.on);
}
audio.onChange = renderSoundButton;
renderSoundButton();
$("ride-sound").addEventListener("click", () => audio.toggle());

// ---- controls ------------------------------------------------------------------------
document.querySelectorAll(".layer input").forEach((input) => {
  input.addEventListener("change", async (e) => {
    const name = input.closest(".layer").dataset.layer;
    state.layers[name] = e.target.checked;
    if (name === "scheduled") pollTrains();
    if (name === "buses" && e.target.checked) pollBuses();
    if (name === "ferries" && e.target.checked) pollFerries();
    if (name === "aircraft" && e.target.checked) pollAircraft();
    if (name === "taxi" && e.target.checked && !state.flow) { if (!taxi.zones) await taxi.loadZones(); loadFlow(); }
    if (name === "complaints" && e.target.checked) loadComplaints();
    if (name === "streets" && e.target.checked) loadStreets();
    if (name === "crossings" && e.target.checked) loadCrossings();
    if (name === "cameras") { if (e.target.checked && !statics.cameras) loadCameras(); else if (!e.target.checked) camview.close(); }
    if (name === "buildings" && map.getLayer("3d-buildings")) map.setLayoutProperty("3d-buildings", "visibility", e.target.checked ? "visible" : "none");
    if (name === "photoreal") applyPhotoreal();
  });
});
/** Google's photogrammetry replaces the grey extrusions; the basemap buildings hide while it is on. */
function applyPhotoreal() {
  const on = state.layers.photoreal && !!state.googleKey;
  if (state.layers.photoreal && !state.googleKey) $("photoreal-note").textContent = "add a Google Maps key under Keys first";
  else $("photoreal-note").textContent = on ? "Google Photorealistic 3D Tiles" : "Google 3D Tiles · needs a key (see Keys)";
  if (map.getLayer("3d-buildings")) map.setLayoutProperty("3d-buildings", "visibility", on || !state.layers.buildings ? "none" : "visible");
  $("tiles-credit").classList.toggle("hidden", !on);
}
state.onTilesCredit = (text) => { const el = $("tiles-credit"); if (el.textContent !== text) el.textContent = text; };
document.querySelectorAll(".services input").forEach((input) =>
  input.addEventListener("change", () => {
    input.checked ? state.services.add(input.dataset.service) : state.services.delete(input.dataset.service);
    loadFlow();
  })
);
$("dow").value = state.dow;
$("hour").value = state.hour;
$("hour-label").textContent = fmtHour(state.hour);
$("dow").addEventListener("change", (e) => { state.dow = +e.target.value; unfollow(); loadFlow(); });
let hourTimer = null;
$("hour").addEventListener("input", (e) => {
  state.hour = +e.target.value;
  $("hour-label").textContent = fmtHour(state.hour);
  unfollow();
  clearTimeout(hourTimer);
  hourTimer = setTimeout(loadFlow, 250);
});
function unfollow() { state.followNow = false; $("follow-now").checked = false; }
$("follow-now").addEventListener("change", (e) => { state.followNow = e.target.checked; if (state.followNow) syncClock(true); });
function syncClock(force = false) {
  if (!state.followNow) return;
  const { dow, hour } = nycNow();
  if (force || dow !== state.dow || hour !== state.hour) {
    state.dow = dow; state.hour = hour;
    $("dow").value = dow; $("hour").value = state.hour; $("hour-label").textContent = fmtHour(state.hour);
    loadFlow();
  }
}
setInterval(syncClock, 30000);
$("taxi-density").value = localStorage.getItem("nyc-taxi-density") || "sparse";
$("taxi-density").addEventListener("change", (e) => {
  localStorage.setItem("nyc-taxi-density", e.target.value);
  taxi.particleTarget = DENSITIES[e.target.value] ?? 7000;
  loadFlow();
});
$("taxi-speed").querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    // keep the replay clock continuous when changing speed
    const t = ((clock.now() - state.taxiLoopStart) * state.taxiSpeed) % 3600;
    state.taxiSpeed = +b.dataset.speed;
    state.taxiLoopStart = clock.now() - t / state.taxiSpeed;
    $("taxi-speed").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  })
);
$("explode").addEventListener("input", (e) => {
  state.explode = +e.target.value / 100;
  $("explode-val").textContent = `${e.target.value}%`;
  if (state.explode > 0.02) { loadStreets(); loadCrossings(); }
  writeHash();
});
if (location.hash.includes("x=")) {
  const x = +new URLSearchParams(location.hash.slice(1)).get("x") || 0;
  $("explode").value = x; state.explode = x / 100; $("explode-val").textContent = `${x}%`;
}
document.querySelectorAll(".views button").forEach((b) =>
  b.addEventListener("click", () => { orbit.pause(); map.flyTo({ ...VIEWS[b.dataset.view], duration: 2200, essential: true }); })
);
$("orbit").addEventListener("change", (e) => orbit.set(e.target.checked));
$("ride-bridge").addEventListener("click", () => { rideManhattanBridge(); audio.tryResume(); });
$("ride-exit").addEventListener("click", () => ride.stop());
$("follow-stop").addEventListener("click", () => follow.stop("released"));
$("follow-cab").addEventListener("click", () => { if (follow.kind === "train") rideTrain(follow.id); });
$("collapse").addEventListener("click", () => { $("panel").classList.add("collapsed"); $("expand").classList.remove("hidden"); });
$("expand").addEventListener("click", () => { $("panel").classList.remove("collapsed"); $("expand").classList.add("hidden"); });
$("legend-close").addEventListener("click", () => { $("legend").classList.add("hidden"); $("legend-show").classList.remove("hidden"); localStorage.setItem("nyc-legend", "hidden"); });
$("legend-show").addEventListener("click", () => { $("legend").classList.remove("hidden"); $("legend-show").classList.add("hidden"); localStorage.removeItem("nyc-legend"); });
if (localStorage.getItem("nyc-legend") === "hidden") { $("legend").classList.add("hidden"); $("legend-show").classList.remove("hidden"); }
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "o") { $("orbit").checked = !$("orbit").checked; orbit.set($("orbit").checked); }
  if (e.key === "Escape") { if (ride.active) ride.stop(); else if (state.camera) camview.close(); else follow.stop("released"); }
  if (e.key === "r" && !ride.active) { rideManhattanBridge(); audio.tryResume(); }
  if (e.key === "h") $("panel").classList.contains("collapsed") ? $("expand").click() : $("collapse").click();
  if (e.key === "x") { const v = state.explode > 0.5 ? 0 : 100; $("explode").value = v; $("explode").dispatchEvent(new Event("input")); }
});

// ---- boot ------------------------------------------------------------------------------
async function loadKeys() {
  try {
    const k = await getJSON("/api/keys");
    streetview.serverHasToken = !!k.mapillary;
    state.googleKey = KEYS.google || k.google_maps || null;
  } catch (_) { /* server without the route */ }
  $("key-mapillary").value = KEYS.mapillary;
  $("key-google").value = KEYS.google;
  $("key-mapillary").addEventListener("change", (e) => { KEYS.mapillary = e.target.value; streetview.last = null; });
  $("key-google").addEventListener("change", (e) => { KEYS.google = e.target.value; state.googleKey = KEYS.google || null; applyPhotoreal(); });
  applyPhotoreal();
}

async function loadPhotos() {
  try {
    state.photos = await getJSON("/api/photos");
    for (const p of Object.values(state.photos)) if (p.thumb) p.thumb = p.thumb.split("?")[0]; // drop wikipedia's tracking params
    const n = Object.values(state.photos).filter((p) => p.thumb).length;
    const el = $("photos-count");
    if (el) el.textContent = n ? `${n} stations` : "";
  } catch (e) { console.warn("photos", e); }
}

// ---- station photo card in the cab: fades in as we pull into a station -------------------
const photoCard = { stop: null, img: $("ride-photo-img"), el: $("ride-photo"), preloaded: new Set() };
function stationPhoto(stopId) {
  if (!state.photos) return null;
  const p = state.photos[stopId] || state.photos[stopId.replace(/[NS]$/, "")];
  return p && p.thumb ? p : null;
}
function renderRidePhoto(c) {
  const el = photoCard.el;
  if (!c || !c.shape.stops?.length || !state.layers.photos) { el.classList.add("hidden"); el.style.opacity = 0; return; }
  const stops = c.shape.stops;
  // the stop we are at or about to reach (allow 120 m past a stop while the doors close)
  let i = stops.findIndex((st) => st.dist >= c.dist - 120);
  if (i < 0) { el.classList.add("hidden"); el.style.opacity = 0; return; }
  const st = stops[i];
  const ahead = st.dist - c.dist; // >0 approaching, <0 leaving
  const nxt = stops[i + 1];
  if (nxt && nxt.dist - c.dist < 700) { const p = stationPhoto(nxt.id); if (p && !photoCard.preloaded.has(p.thumb)) { photoCard.preloaded.add(p.thumb); new Image().src = p.thumb; } }
  const photo = stationPhoto(st.id);
  const k = ahead > 0 ? clamp((260 - ahead) / 120, 0, 1) : clamp((120 + ahead) / 70, 0, 1);
  if (!photo || k <= 0) { el.classList.add("hidden"); el.style.opacity = 0; photoCard.stop = null; return; }
  if (photoCard.stop !== st.id) {
    photoCard.stop = st.id;
    photoCard.img.src = photo.thumb;
    $("ride-photo-name").textContent = photo.name;
    const cred = [photo.artist && `photo: ${photo.artist}`, photo.license, "Wikimedia Commons"].filter(Boolean).join(" · ");
    $("ride-photo-credit").textContent = cred;
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
  }
  el.classList.remove("hidden");
  el.classList.toggle("big", c.shape.pointAt(c.dist)[2] < -4); // underground there is nothing else to look at
  el.style.opacity = k.toFixed(2);
}

async function pollWeather() {
  try {
    const w = await getJSON("/api/weather");
    state.weather = w;
    ride.weather = w;
    windshield.set(w);
    if (ride.active) ride.refreshSky(true);
    renderStatus(state, clock);
  } catch (e) { console.warn("weather", e); }
  setTimeout(pollWeather, 5 * 60 * 1000);
}

async function boot() {
  try {
    await Promise.all([loadNetwork(), loadLayerStatus(), loadBusNetwork(), loadFerryNetwork()]);
    requestAnimationFrame(render);
    pollTrains();
    pollBuses();
    pollFerries();
    pollAircraft();
    pollWeather();
    loadPhotos();
    loadKeys();
    if (state.layers.cameras) loadCameras();
    if (state.layers.taxi) { await taxi.loadZones(); await loadFlow(); }
    if (state.explode > 0.02) { loadStreets(); loadCrossings(); }
    renderStatus(state, clock);
    // #ride=bridge starts in the cab over the Manhattan Bridge (ride=ghost forces the ghost train)
    const want = new URLSearchParams(location.hash.slice(1)).get("ride");
    if (want === "bridge" || want === "ghost") setTimeout(() => rideManhattanBridge(want === "ghost"), 1200);
  } catch (err) {
    $("headline").textContent = `failed to start: ${err.message}`;
    console.error(err);
  }
}

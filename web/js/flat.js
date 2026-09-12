// 2D companion view: the same smooth, track-following trains as the 3D page, on a flat
// top-down map. Shares TrainTracker / layer helpers / sidebar code with main.js.

import { Clock, getJSON } from "./api.js";
import { hex2rgb } from "./geo.js";
import { buildTrackRuns, trainSideOffset } from "./layers.js";
import { TrainTracker, trainLength } from "./trains.js";
import { $, renderDetail, renderRouteChips, renderStatus, tooltip } from "./ui.js";

const { PathLayer, ScatterplotLayer, TextLayer } = deck;
const TRAIN_POLL_MS = 5000;
const FONT = "Inter, Helvetica Neue, Arial, sans-serif";
const CAT_COLORS = [
  [/homeless|encampment/i, [255, 179, 71]],
  [/panhandl/i, [255, 107, 107]],
  [/urinat|street condition/i, [192, 132, 252]],
  [/animal/i, [74, 222, 128]],
];
const catColor = (t) => (CAT_COLORS.find(([re]) => re.test(t || "")) || [0, [229, 231, 235]])[1];

const state = {
  routes: {},
  activeRoutes: null,
  selected: null,
  scheduled: false,
  stations: true,
  complaints: false,
  days: 30,
  zoom: 12,
  feedInfo: null,
  frame: 0,
};
const clock = new Clock();
const trains = new TrainTracker();
const statics = { trackRuns: null, stations: null, stationLabels: null, complaints: null };

// ---- map -----------------------------------------------------------------------------
const hash = new URLSearchParams(location.hash.slice(1));
const start = hash.has("c") ? hash.get("c").split(",").map(Number) : [-73.94, 40.735];
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  center: start,
  zoom: +hash.get("z") || 12,
  pitch: 0,
  maxPitch: 0,
  dragRotate: false,
  touchPitch: false,
  attributionControl: { compact: true },
  hash: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
const overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip: (info) => tooltip(state, info) });
map.addControl(overlay);
window.__nyc = { map, overlay, state, trains, statics };

map.on("load", () => {
  state.zoom = map.getZoom();
  for (const l of map.getStyle().layers) {
    if (l.type === "line" && /road|street|highway|bridge|tunnel|motorway|path/.test(l.id) && !/label/.test(l.id)) {
      try { map.setPaintProperty(l.id, "line-opacity", 0.5); } catch (_) { /* no opacity on this layer */ }
    }
  }
  boot();
});
map.on("zoom", () => (state.zoom = map.getZoom()));
map.on("moveend", writeHash);

function readHash() {
  if (hash.get("routes")) state.activeRoutes = new Set(hash.get("routes").split(",").filter(Boolean));
  if (hash.get("scheduled") === "1") { state.scheduled = true; $("toggle-scheduled").checked = true; }
  if (hash.get("311")) {
    state.complaints = true;
    state.days = Math.max(1, Math.min(365, +hash.get("311") || 30));
    $("toggle-311").checked = true;
    $("days").value = state.days;
    $("days-label").textContent = state.days;
    $("days-row").classList.remove("hidden");
  }
}
function writeHash() {
  const c = map.getCenter();
  const h = new URLSearchParams({ c: `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`, z: map.getZoom().toFixed(2) });
  if (state.activeRoutes) h.set("routes", [...state.activeRoutes].join(","));
  if (state.scheduled) h.set("scheduled", "1");
  if (state.complaints) h.set("311", state.days);
  history.replaceState(null, "", `#${h}`);
}

// ---- data ----------------------------------------------------------------------------
async function loadNetwork() {
  const net = await getJSON("/api/network");
  state.routes = net.routes;
  trains.setNetwork(net);
  statics.trackRuns = buildTrackRuns(net, net.routes, hex2rgb);
  statics.stations = net.stations;
  const labelled = new Set();
  statics.stationLabels = net.stations.filter((s) => {
    const k = s.complex ?? s.name;
    if (labelled.has(k)) return false;
    labelled.add(k);
    return true;
  });
  renderRouteChips(state, {}, writeHash);
}

async function loadComplaints() {
  $("c311-count").textContent = "loading…";
  const data = await getJSON(`/api/311?days=${state.days}&limit=8000`);
  if (!data.available) {
    statics.complaints = [];
    $("c311-count").textContent = "no data yet — run scripts/fetch_311.py";
    $("summary311").classList.add("hidden");
    return;
  }
  statics.complaints = data.rows;
  $("c311-count").textContent = `${data.rows.length.toLocaleString()} shown`;
  const s = await getJSON("/api/311/summary");
  const el = $("summary311");
  if (!s.available) { el.classList.add("hidden"); return; }
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const top = Object.entries(s.by_complaint_type).slice(0, 8);
  const dot = (t) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:rgb(${catColor(t).join(",")});margin-right:6px"></span>`;
  el.classList.remove("hidden");
  el.innerHTML =
    `<h2>311 subway complaints · ${s.total.toLocaleString()} since ${esc((s.first_created || "").slice(0, 10))}</h2>` +
    `<table>${top.map(([t, n]) => `<tr><td>${dot(t)}${esc(t)}</td><td>${n.toLocaleString()}</td></tr>`).join("")}</table>` +
    `<div class="muted" style="margin-top:6px">by borough: ${Object.entries(s.by_borough).filter(([b]) => b && b !== "Unspecified").map(([b, n]) => `${esc(b)} ${n.toLocaleString()}`).join(" · ")}</div>`;
}

let trainTimer = null;
async function pollTrains() {
  clearTimeout(trainTimer);
  try {
    const t0 = performance.now();
    const data = await getJSON(`/api/trains?scheduled=${state.scheduled ? 1 : 0}`);
    clock.sample(data.generated_at, t0);
    state.feedInfo = data;
    trains.ingest(data.trains, data.generated_at);
    renderRouteChips(state, trains.byRoute, writeHash);
    if (state.selected) renderDetail(state, data.trains.find((t) => t.id === state.selected));
    renderStatus(state, clock);
  } catch (err) {
    $("headline").textContent = `subway feed error: ${err.message}`;
  }
  trainTimer = setTimeout(pollTrains, TRAIN_POLL_MS);
}

// ---- layers ----------------------------------------------------------------------------
function buildLayers(now) {
  const L = [];
  const zoom = state.zoom;
  const routeOn = (r) => !state.activeRoutes || state.activeRoutes.has(r);
  const flat = (path) => path.map((p) => [p[0], p[1]]);
  const pick = { pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 90] };

  if (statics.trackRuns) {
    L.push(
      new PathLayer({
        id: "tracks",
        data: statics.trackRuns,
        getPath: (d) => flat(d.path),
        getColor: (d) => [...d.color, routeOn(d.route) ? (d.elevated ? 235 : 190) : 30],
        getWidth: 4,
        widthMinPixels: 1.5,
        widthMaxPixels: 5,
        capRounded: true,
        jointRounded: true,
        pickable: false,
        updateTriggers: { getColor: state.activeRoutes },
      })
    );
  }
  if (state.stations && statics.stations && zoom >= 11.5) {
    L.push(
      new ScatterplotLayer({
        ...pick,
        id: "stations",
        data: statics.stations,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 18,
        radiusMinPixels: 1.8,
        radiusMaxPixels: 5,
        getFillColor: [225, 228, 235, 230],
        stroked: false,
      })
    );
    if (zoom >= 13.8) {
      L.push(
        new TextLayer({
          id: "station-labels",
          data: statics.stationLabels,
          getPosition: (d) => [d.lon, d.lat],
          getText: (d) => d.name,
          getColor: [220, 224, 232, 210],
          getSize: 11,
          getPixelOffset: [0, -12],
          fontFamily: FONT,
          fontWeight: 500,
          outlineWidth: 2,
          outlineColor: [10, 12, 16, 220],
          fontSettings: { sdf: true },
          extensions: deck.CollisionFilterExtension ? [new deck.CollisionFilterExtension()] : [],
          collisionTestProps: { sizeScale: 2.5 },
          pickable: false,
        })
      );
    }
  }
  if (state.complaints && statics.complaints?.length) {
    L.push(
      new ScatterplotLayer({
        ...pick,
        id: "complaints",
        data: statics.complaints,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 16,
        radiusMinPixels: 2.5,
        radiusMaxPixels: 6,
        getFillColor: (d) => [...catColor(d.type), 160],
        stroked: false,
      })
    );
  }

  const bodies = [];
  // right-hand running: a few pixels to the right of the track so the two directions never overlap
  const sideM = trainSideOffset(zoom);
  for (const rec of trains.trains.values()) {
    if (!routeOn(rec.data.route)) continue;
    if (rec.data.scheduled && !state.scheduled) continue;
    bodies.push({ rec, path: flat(trains.capsule(rec, 0, sideM)), head: trains.headPos(rec, 0, sideM).slice(0, 2) });
  }
  const stopped = (d) => d.rec.data.status === "STOPPED_AT";
  L.push(
    new PathLayer({
      id: "trains-glow",
      data: bodies,
      getPath: (d) => d.path,
      getColor: (d) => [...d.rec.color, d.rec.data.scheduled ? 15 : stopped(d) ? 45 : 80],
      getWidth: 34,
      widthMinPixels: 7,
      widthMaxPixels: 44,
      capRounded: true,
      jointRounded: true,
      pickable: false,
    }),
    new PathLayer({
      ...pick,
      id: "trains",
      data: bodies,
      getPath: (d) => d.path,
      getColor: (d) => [...d.rec.color, d.rec.data.scheduled ? 90 : 255],
      getWidth: (d) => (trainLength(d.rec.data.route) < 100 ? 9 : 11),
      widthMinPixels: 4,
      widthMaxPixels: 18,
      capRounded: true,
      jointRounded: true,
      onClick: ({ object }) => object && selectTrain(object.rec.id),
    }),
    new ScatterplotLayer({
      id: "train-heads",
      data: bodies,
      getPosition: (d) => d.head,
      getRadius: 2.5,
      radiusMinPixels: 1.4,
      radiusMaxPixels: 4.5,
      getFillColor: (d) => (stopped(d) ? [255, 255, 255, 130] : [255, 255, 255, 240]),
      stroked: false,
      pickable: false,
    })
  );
  if (zoom >= 12.3) {
    L.push(
      new TextLayer({
        id: "train-labels",
        data: bodies,
        getPosition: (d) => d.head,
        getText: (d) => d.rec.data.route.replace(/X$/, ""),
        getColor: (d) => d.rec.text,
        getSize: zoom >= 14 ? 12 : 10,
        getPixelOffset: [0, -13],
        fontFamily: FONT,
        fontWeight: 700,
        fontSettings: { sdf: true },
        outlineWidth: 3,
        outlineColor: (d) => [...d.rec.color, 255],
        pickable: false,
      })
    );
  }
  if (state.selected) {
    const sel = trains.get(state.selected);
    if (sel) {
      L.push(
        new ScatterplotLayer({
          id: "selected-ring",
          data: [[sel.pos[0], sel.pos[1]]],
          getPosition: (d) => d,
          getRadius: 30 + 7 * Math.sin(state.frame / 12),
          radiusUnits: "meters",
          radiusMinPixels: 14,
          stroked: true,
          filled: false,
          getLineColor: [255, 255, 255, 200],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          pickable: false,
          updateTriggers: { getRadius: state.frame },
        })
      );
    }
  }
  return L;
}

function render() {
  requestAnimationFrame(render);
  state.frame++;
  const now = clock.now();
  trains.update(now);
  overlay.setProps({ layers: buildLayers(now) });
}

function selectTrain(id) {
  state.selected = id;
  const rec = trains.get(id);
  renderDetail(state, rec?.data, () => (state.selected = null));
}

// ---- controls -------------------------------------------------------------------------
$("toggle-stations").addEventListener("change", (e) => (state.stations = e.target.checked));
$("toggle-scheduled").addEventListener("change", (e) => { state.scheduled = e.target.checked; writeHash(); pollTrains(); });
$("toggle-311").addEventListener("change", (e) => {
  state.complaints = e.target.checked;
  $("days-row").classList.toggle("hidden", !state.complaints);
  if (state.complaints) loadComplaints().catch((err) => ($("c311-count").textContent = err.message));
  else $("summary311").classList.add("hidden");
  writeHash();
});
let daysTimer = null;
$("days").addEventListener("input", (e) => {
  state.days = +e.target.value;
  $("days-label").textContent = state.days;
  clearTimeout(daysTimer);
  daysTimer = setTimeout(() => { if (state.complaints) loadComplaints(); writeHash(); }, 400);
});

// ---- boot -----------------------------------------------------------------------------
async function boot() {
  readHash();
  try {
    await loadNetwork();
  } catch (err) {
    $("headline").textContent = `failed to load network: ${err.message}`;
    return;
  }
  if (state.complaints) loadComplaints().catch(() => {});
  pollTrains();
  requestAnimationFrame(render);
}

// Cab view: ride in the front of a train and look out of the windshield.
//
// The camera is a MapLibre camera, so we cannot set "eye position + direction"
// directly; instead every frame we compute where the eye should be (3 m above the
// rail, on the right-hand track), then solve for the map centre/zoom/pitch/bearing
// that puts MapLibre's camera exactly there. The ridden train itself is not drawn
// (we are inside it); everything else - the other track, oncoming trains as
// billboarded car bodies, the bridge pillars, buildings, traffic below - is the
// normal scene, restyled a little for a 3 m eye height (see layers.js).
//
// Two ways to ride:
//   follow(rec)          a live train from the feed (its position is the motion model)
//   tour(shape, ...)     a "ghost" train we drive ourselves between two distances

import { lightSpec, skySpec, sunPosition } from "./sky.js";
import { M_PER_DEG_LAT, M_PER_DEG_LON, clamp } from "./geo.js";

export const RIDE_SIDE_M = 2.2; // our track is this far right of the GTFS centreline (real track spacing ~4.4 m)
export const EYE_M = 2.9; // motorman's eye above the rail
const PITCH = 84.5; // 5.5° down: MapLibre clips at height/50 px, so a flatter look-ahead from 40 m up would cut the near 20 m of track
const LOOK_AHEAD_M = 55; // aim at a point this far up the track (steadies the view on curves)
const BEARING_TAU = 0.45; // s
const Z_TAU = 0.35; // s
const DEFAULT_FOV_DEG = 36.87; // MapLibre's default vertical field of view
const CAB_FOV_DEG = 58; // wider lens in the cab: a windshield, not a map
const NEAR_SCALE = 0.12; // near clipping plane, as a fraction of MapLibre's default
const SWAY_M = 0.07; // lateral rock of the car body at speed
const MIN_CAM_ALT = 1.6; // camera can't go below the ground plane; tunnels are covered by the HUD blackout

const SKY_REFRESH_S = 30; // the sun moves; re-pick the sky this often while riding

export class Ride {
  constructor(map, trains, overlay = null) {
    this.map = map;
    this.trains = trains;
    this.overlay = overlay; // deck MapboxOverlay: its view must be told about the wider lens too
    this.weather = null; // latest /api/weather, set from outside
    this.sun = null;
    this._skyAt = -1e9;
    this.active = false;
    this.rec = null; // live train being ridden
    this.ghost = null; // { shape, route, color, text, d0, d1, dist, v, vmax, dwell, label }
    this.bearing = null;
    this.z = null;
    this.pitch = null;
    this._saved = null;
    this.t = 0; // seconds riding, for the sway
    this._interactions = ["dragPan", "dragRotate", "scrollZoom", "keyboard", "doubleClickZoom", "touchZoomRotate", "boxZoom"];
    this.onChange = null; // (ride) => void, for the HUD
  }

  /** Ride a live train. */
  follow(rec) {
    if (!rec?.shape) return false;
    this.rec = rec;
    this.ghost = null;
    this._begin();
    return true;
  }

  /** Drive a ghost train along `shape` from d0 to d1 (loops). Speed in m/s. */
  tour(shape, { route, color, text, d0, d1, vmax = 13, v0 = 0, label = "", dir = "" }) {
    this.rec = null;
    this.ghost = { shape, route, color, text, d0, d1, dist: d0, v: v0, v0, vmax, dwell: 0, label, dir };
    this._begin();
  }

  _begin() {
    if (!this.active) {
      const m = this.map;
      this._saved = { center: m.getCenter(), zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing(), maxPitch: m.getMaxPitch(), sky: m.getSky?.(), fov: m.getVerticalFieldOfView?.(), light: m.getLight?.() };
      m.setMaxPitch(89);
      this._setFov(CAB_FOV_DEG);
      for (const h of this._interactions) m[h]?.disable();
      this._skyAt = -1e9;
      this.refreshSky(true);
      // basemap labels are sized for a map; from 3 m up they are house-sized. The basemap's
      // own railway lines go too - the rails are ours now.
      this._hidden = [];
      for (const l of m.getStyle().layers) {
        if ((l.type === "symbol" || /^railway/.test(l.id)) && m.getLayoutProperty(l.id, "visibility") !== "none") {
          m.setLayoutProperty(l.id, "visibility", "none");
          this._hidden.push(l.id);
        }
      }
      this.active = true;
    }
    this.bearing = null;
    this.z = null;
    this.pitch = null;
    this.onChange?.(this);
  }

  /** Change the lens on both renderers: deck.gl derives its view from the map but assumes the default fov. */
  _setFov(deg) {
    try { this.map.setVerticalFieldOfView(deg); } catch (_) { return; }
    const MapView = globalThis.deck?.MapView;
    if (this.overlay && MapView) this.overlay.setProps({ views: new MapView({ id: "mapbox", fovy: deg }) });
  }

  stop() {
    if (!this.active) return;
    const m = this.map;
    for (const h of this._interactions) m[h]?.enable();
    m.transform?.clearNearFarZOverride?.();
    m.setMaxPitch(this._saved.maxPitch);
    this._setFov(this._saved.fov || DEFAULT_FOV_DEG);
    try { m.setSky(this._saved.sky || undefined); } catch (_) { /* ignore */ }
    try { if (this._saved.light) m.setLight(this._saved.light); } catch (_) { /* ignore */ }
    for (const id of this._hidden || []) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
    const c = this.cursor();
    this.active = false;
    this.rec = null;
    this.ghost = null;
    // pull back to a chase view of where we were, so the exit is not a jump cut
    if (c) {
      const p = c.shape.pointAt(c.dist);
      m.jumpTo({ center: [p[0], p[1]], zoom: 16.2, pitch: 62, bearing: c.shape.bearingAt(c.dist) });
    } else m.jumpTo(this._saved);
    this.onChange?.(this);
  }

  /** Sky, fog and light from the clock and the weather. */
  refreshSky(force = false) {
    if (!this.active) return;
    if (!force && this.t - this._skyAt < SKY_REFRESH_S) return;
    this._skyAt = this.t;
    this.sun = sunPosition(new Date());
    const spec = skySpec(this.sun.elevation, this.weather);
    this.skyInfo = { day: spec._day, foggy: spec._foggy };
    const { _day, _foggy, ...sky } = spec;
    try { this.map.setSky(sky); } catch (_) { /* older maplibre */ }
    try { this.map.setLight(lightSpec(this.sun, this.weather)); } catch (_) { /* ignore */ }
  }

  /** What we are riding right now: { id, shape, dist, route, color, text, speed, live, label, rec } or null. */
  cursor() {
    if (!this.active) return null;
    if (this.rec) {
      const r = this.rec;
      if (!r.shape) return null;
      return { id: r.id, shape: r.shape, dist: r.dist, route: r.data.route, color: r.color, text: r.text, speed: r.speed || 0, live: true, rec: r, label: "", eye: this.eye || r.pos };
    }
    if (this.ghost) {
      const g = this.ghost;
      return { id: "ghost", shape: g.shape, dist: g.dist, route: g.route, color: g.color, text: g.text, speed: g.v, live: false, rec: null, label: g.label, dir: g.dir, eye: this.eye || g.shape.pointAt(g.dist) };
    }
    return null;
  }

  /** Advance the ghost and place the camera. Call once per frame after trains.update. */
  tick(dt) {
    if (!this.active) return;
    dt = clamp(dt, 0, 0.1);
    if (this.rec && !this.trains.trains.has(this.rec.id)) { this.stop(); return; } // train left the feed
    if (this.ghost) this._drive(this.ghost, dt);
    this.t += dt;
    this.refreshSky();
    const c = this.cursor();
    if (!c) { this.stop(); return; }
    this._placeCamera(c, dt);
  }

  /** Trapezoidal speed profile: accelerate, cruise, brake to a stop at d1, dwell, loop. */
  _drive(g, dt) {
    if (g.dwell > 0) { g.dwell -= dt; if (g.dwell <= 0) { g.dist = g.d0; g.v = g.v0; this.bearing = null; this.z = null; this.pitch = null; } return; }
    const remaining = g.d1 - g.dist;
    const brakeV = Math.sqrt(Math.max(0, 2 * 0.9 * remaining)); // v so that 0.9 m/s² stops us at d1
    const target = Math.min(g.vmax, brakeV);
    g.v = target > g.v ? Math.min(target, g.v + 0.8 * dt) : Math.max(target, g.v - 1.2 * dt);
    g.dist = Math.min(g.d1, g.dist + g.v * dt);
    if (g.dist >= g.d1 - 0.05) { g.v = 0; g.dwell = 3.5; }
  }

  _placeCamera(c, dt) {
    const { shape, dist } = c;
    const p = shape.pointAt(dist);
    const q = shape.pointAt(Math.min(shape.length, dist + LOOK_AHEAD_M));
    const targetBearing = (Math.atan2((q[0] - p[0]) * M_PER_DEG_LON, (q[1] - p[1]) * M_PER_DEG_LAT) * 180) / Math.PI;
    if (this.bearing == null) this.bearing = targetBearing;
    else {
      let delta = targetBearing - this.bearing;
      delta = ((delta + 540) % 360) - 180;
      this.bearing += delta * (1 - Math.exp(-dt / BEARING_TAU));
    }
    // on a ramp the track ahead climbs into the windshield: keep the eye above the rail for
    // the next ~60 m, since we cannot tilt the MapLibre camera above the horizon
    let zTrack = p[2];
    for (const ahead of [20, 40, 60]) zTrack = Math.max(zTrack, shape.pointAt(Math.min(shape.length, dist + ahead))[2]);
    const zTarget = zTrack + EYE_M;
    this.z = this.z == null ? zTarget : this.z + (zTarget - this.z) * (1 - Math.exp(-dt / Z_TAU));
    // going downhill we can tilt the camera down to follow the grade (up is capped at the horizon)
    const grade = Math.atan2(shape.pointAt(Math.min(shape.length, dist + 60))[2] - p[2], 60) * (180 / Math.PI);
    const pitchTarget = PITCH + Math.min(0, Math.max(-12, grade));
    this.pitch = this.pitch == null ? pitchTarget : this.pitch + (pitchTarget - this.pitch) * (1 - Math.exp(-dt / Z_TAU));
    // eye sits on our (right-hand) track; the car rocks a little on its trucks at speed
    const gait = Math.min(1, (c.speed || 0) / 9);
    const sway = SWAY_M * gait * (Math.sin(this.t * 2 * Math.PI * 0.9) + 0.4 * Math.sin(this.t * 2 * Math.PI * 2.3));
    const bob = 0.03 * gait * Math.sin(this.t * 2 * Math.PI * 1.7);
    const th = (this.bearing * Math.PI) / 180;
    const eyeLon = p[0] + (Math.cos(th) * (RIDE_SIDE_M + sway)) / M_PER_DEG_LON;
    const eyeLat = p[1] - (Math.sin(th) * (RIDE_SIDE_M + sway)) / M_PER_DEG_LAT;
    const alt = Math.max(MIN_CAM_ALT, this.z + bob);
    // MapLibre's camera looks at `center` on the ground from `alt` above it at `pitch`:
    // the ground point is alt / tan(90 - pitch) ahead, and the camera-to-centre distance
    // fixes the zoom (cameraToCenterDistance = 0.5 * height / tan(fov / 2) pixels).
    const down = ((90 - this.pitch) * Math.PI) / 180;
    const ahead = alt / Math.tan(down);
    const camDist = alt / Math.sin(down);
    const cLat = eyeLat + (ahead * Math.cos(th)) / M_PER_DEG_LAT;
    const cLon = eyeLon + (ahead * Math.sin(th)) / M_PER_DEG_LON;
    const h = this.map.getCanvas().clientHeight || 800;
    const fov = ((this.map.getVerticalFieldOfView?.() || DEFAULT_FOV_DEG) * Math.PI) / 180;
    const camPx = (0.5 * h) / Math.tan(fov / 2);
    const mpp = camDist / camPx;
    const zoom = Math.log2((40075016.686 * Math.cos((cLat * Math.PI) / 180)) / (512 * mpp));
    this.map.jumpTo({ center: [cLon, cLat], zoom, pitch: this.pitch, bearing: this.bearing + 0.25 * gait * Math.sin(this.t * 2 * Math.PI * 0.6) });
    // MapLibre puts the near plane at height/50 px, which from 40 m up is ~20 m of track cut
    // off in front of the windshield. Pull it in (deck.gl reads the same near/far).
    const tr = this.map.transform;
    if (tr?.overrideNearFarZ) {
      tr.clearNearFarZOverride();
      tr.overrideNearFarZ(tr.nearZ * NEAR_SCALE, tr.farZ);
    }
    this.eye = [eyeLon, eyeLat, this.z];
  }
}

// ---- geometry for the cab view -------------------------------------------------------
// deck.gl path widths are constant on screen (they do not shrink with distance), which
// is right for a map and wrong for a windshield. Everything close to the eye is
// therefore built as real polygons: rail ribbons, ties, a track bed and extruded car
// bodies, all with true perspective.

/** Unit vector pointing to the right of travel at each vertex of a [lon, lat, z] path. */
function rightNormals(pts) {
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = (b[0] - a[0]) * M_PER_DEG_LON, dy = (b[1] - a[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy) || 1;
    out[i] = [dy / len, -dx / len];
  }
  return out;
}
const offset = (p, n, m, dz = 0) => [p[0] + (n[0] * m) / M_PER_DEG_LON, p[1] + (n[1] * m) / M_PER_DEG_LAT, p[2] + dz];

/** A closed polygon ring `halfW` metres either side of a path shifted `side` metres right. */
export function ribbon(pts, side, halfW, dz = 0) {
  if (pts.length < 2) return null;
  const ns = rightNormals(pts);
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    left.push(offset(pts[i], ns[i], side - halfW, dz));
    right.push(offset(pts[i], ns[i], side + halfW, dz));
  }
  return left.concat(right.reverse(), [left[0]]);
}

/**
 * Track furniture for a stretch of `shape`: { bed: [ring], rails: [ring, ring], ties: [ring...] }
 * for the track `side` metres right of the centreline.
 */
export function trackGeometry(shape, d0, d1, side, dz = 0) {
  d0 = Math.max(0, d0); d1 = Math.min(shape.length, d1);
  const pts = shape.slice(d0, d1, dz);
  const gauge = 0.72; // half of 1435 mm
  const rails = [ribbon(pts, side - gauge, 0.04, 0.05), ribbon(pts, side + gauge, 0.04, 0.05)].filter(Boolean);
  const bed = ribbon(pts, side, 2.0, -0.04);
  const ties = [];
  // ties every 0.7 m for the first 150 m, then sparser (they merge into the bed anyway)
  for (let d = d0; d < d1; d += d - d0 < 150 ? 0.7 : 2.8) {
    const seg = shape.slice(d, Math.min(d1, d + 0.24), dz);
    const r = ribbon(seg, side, 1.25, 0.01);
    if (r) ties.push(r);
  }
  return { bed, rails, ties };
}

/** Car bodies of a train as extrudable footprints: [{ ring, color }]. */
export function carFootprints(rec, side, carLen, gap, n, dz = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const end = rec.dist - i * (carLen + gap);
    const pts = rec.shape.slice(end - carLen, end, dz);
    const ring = ribbon(pts, side, 1.5);
    if (ring) out.push(ring);
  }
  return out;
}

/**
 * The structure carrying an elevated stretch: a deck slab under both tracks and a row of
 * posts on the outer side of our track (the truss rhythm you see flicker past on a bridge).
 * Returns { deck: [ring], posts: [{ ring, h }] }. Only where the track is above ground.
 */
export function structureGeometry(shape, d0, d1, dz = 0) {
  d0 = Math.max(0, d0); d1 = Math.min(shape.length, d1);
  const pts = shape.slice(d0, d1, dz);
  const deck = [];
  // split the deck into runs that are actually elevated
  let run = [];
  const flush = () => { if (run.length > 1) { const r = ribbon(run, 0, RIDE_SIDE_M + 3.6, -0.7); if (r) deck.push(r); } run = []; };
  for (const p of pts) { if (p[2] - dz > 3) run.push(p); else flush(); }
  flush();
  const posts = [];
  for (let d = Math.ceil(d0 / 8) * 8; d < d1; d += 8) {
    const p = shape.pointAt(d);
    if (p[2] <= 3) continue;
    const seg = shape.slice(d, Math.min(d1, d + 0.26), dz);
    const ring = ribbon(seg, RIDE_SIDE_M + 3.2, 0.13, -0.7);
    if (ring) posts.push({ ring, h: 5.6 });
  }
  return { deck, posts };
}

// ---- suspension bridges ----------------------------------------------------------------
// Tower and anchorage positions are the centroids of the OSM `bridge:support` polygons
// (the towers themselves are already in the basemap as 3D buildings). We hang two main
// cables between them and drop suspenders to deck level; the deck height is our track's.
export const SUSPENSION_BRIDGES = [
  {
    name: "Manhattan Bridge",
    anchors: [[-73.98828, 40.70304], [-73.99264, 40.71089]], // Brooklyn, Manhattan
    towers: [[-73.98944, 40.70512], [-73.99149, 40.70881]],
    towerTop: 100, // m; OSM height 102
    deckZ: 40, // rail level mid-span (scripts/build_static.py RIVER_BRIDGES gives the tracks this profile)
    halfWidth: 18, // cables this far either side of the bridge axis
  },
  {
    name: "Williamsburg Bridge",
    anchors: [[-73.9615, 40.7087], [-73.9765, 40.7145]], // Brooklyn, Manhattan
    towers: [[-73.966, 40.7103], [-73.9727, 40.713]],
    towerTop: 94,
    deckZ: 40,
    halfWidth: 14,
  },
];
/** Centre of each bridge, for "are we near it" checks. */
export const BRIDGE_CENTRES = SUSPENSION_BRIDGES.map((b) => [(b.towers[0][0] + b.towers[1][0]) / 2, (b.towers[0][1] + b.towers[1][1]) / 2]);

/** Cables and suspenders for every configured bridge: { cables: [path...], hangers: [{a, b}] }. */
export function bridgeCables() {
  const cables = [], hangers = [];
  for (const b of SUSPENSION_BRIDGES) {
    const [a0, a1] = b.anchors, [t0, t1] = b.towers;
    // bridge axis: unit vector from Brooklyn tower to Manhattan tower, and its right normal
    const ux = (t1[0] - t0[0]) * M_PER_DEG_LON, uy = (t1[1] - t0[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(ux, uy);
    const ax = ux / len, ay = uy / len;
    const nx = ay, ny = -ax;
    const along = (p) => ((p[0] - t0[0]) * M_PER_DEG_LON) * ax + ((p[1] - t0[1]) * M_PER_DEG_LAT) * ay;
    const at = (s, side, z) => [t0[0] + (ax * s + nx * side) / M_PER_DEG_LON, t0[1] + (ay * s + ny * side) / M_PER_DEG_LAT, z];
    const sA0 = along(a0), sA1 = along(a1), sT1 = len;
    const low = b.deckZ + 5;
    // z along the cable: parabolas anchor -> tower top -> mid-span low -> tower top -> anchor
    const zAt = (s) => {
      if (s < 0) { const f = (s - sA0) / (0 - sA0); return low + (b.towerTop - low) * f * f; }
      if (s > sT1) { const f = (sA1 - s) / (sA1 - sT1); return low + (b.towerTop - low) * f * f; }
      const f = (s - sT1 / 2) / (sT1 / 2); return low + (b.towerTop - low) * f * f;
    };
    for (const side of [-b.halfWidth, b.halfWidth]) {
      const path = [];
      for (let s = sA0; s <= sA1 + 0.01; s += 4) path.push(at(s, side, zAt(s)));
      cables.push(path);
      for (let s = Math.ceil(sA0 / 10) * 10; s < sA1; s += 10) {
        const z = zAt(s);
        if (z - b.deckZ > 2) hangers.push({ a: at(s, side, z), b: at(s, side, b.deckZ + 0.5) });
      }
    }
  }
  return { cables, hangers };
}

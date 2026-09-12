// Aircraft: ADS-B fixes arrive every few seconds with position, ground speed, track
// and climb rate. Between fixes we fly each plane forward along its track at its
// reported speed (dead reckoning) and ease onto every new fix instead of jumping.

import { M_PER_DEG_LAT, M_PER_DEG_LON, clamp } from "./geo.js";

const CHASE_TAU = 1.5; // s
const SNAP_M = 2500; // a fix this far from the drawn position is a different plane / long gap
const MAX_EXTRAPOLATE_S = 45;
const TRAIL_EVERY_S = 0.8;
const TRAIL_MAX = 70;

// Real altitudes put a cruising jet 10 km up - far above the camera. Keep the first
// 1500 m true (approaches, helicopters) and compress everything above it.
export const ALT_KNEE_M = 1500;
export const ALT_SCALE = 0.4;
export const displayAlt = (alt) => (alt <= ALT_KNEE_M ? alt : ALT_KNEE_M + (alt - ALT_KNEE_M) * ALT_SCALE);

// body lengths (m) by ADS-B size class - exaggerated a little so they read at city scale
export const PLANE_SIZE = { light: 14, small: 24, large: 45, heavy: 70, fast: 30, rotorcraft: 16, glider: 14, balloon: 10, ultralight: 10, drone: 6 };
export const PLANE_COLORS = {
  heavy: [255, 255, 255], large: [225, 236, 255], small: [186, 214, 255], fast: [255, 210, 130],
  light: [255, 200, 120], rotorcraft: [120, 255, 205], glider: [200, 255, 160], balloon: [255, 160, 220],
  ultralight: [255, 200, 120], drone: [255, 120, 120],
};

export class AircraftTracker {
  constructor() {
    this.aircraft = new Map();
    this.count = 0;
  }

  ingest(list, serverNow) {
    const seen = new Set();
    for (const d of list) {
      if (d.lat == null || d.lon == null) continue;
      seen.add(d.id);
      const fix = {
        lon: d.lon, lat: d.lat, alt: d.alt_m || 0,
        t: serverNow - (d.seen_pos_s || 0),
        speed: d.speed_mps || 0,
        track: d.track ?? null,
        vrate: d.vrate_mps || 0,
      };
      let a = this.aircraft.get(d.id);
      if (!a) {
        a = { id: d.id, data: d, fix, pos: [d.lon, d.lat, displayAlt(fix.alt)], alt: fix.alt, track: fix.track ?? 0, trail: [], trailT: 0, lastT: serverNow, speed: fix.speed };
        this.aircraft.set(d.id, a);
      }
      a.data = d;
      a.fix = fix;
      if (fix.track != null) a.track = fix.track;
      a.speed = fix.speed;
    }
    for (const id of [...this.aircraft.keys()]) if (!seen.has(id)) this.aircraft.delete(id);
    this.count = list.length;
  }

  update(t) {
    for (const a of this.aircraft.values()) {
      const dt = clamp(t - a.lastT, 0, 1);
      a.lastT = t;
      const f = a.fix;
      const age = clamp(t - f.t, 0, MAX_EXTRAPOLATE_S);
      const rad = ((f.track ?? a.track) * Math.PI) / 180;
      const px = f.lon + (Math.sin(rad) * f.speed * age) / M_PER_DEG_LON;
      const py = f.lat + (Math.cos(rad) * f.speed * age) / M_PER_DEG_LAT;
      const palt = Math.max(0, f.alt + f.vrate * age);
      const gapM = Math.hypot((px - a.pos[0]) * M_PER_DEG_LON, (py - a.pos[1]) * M_PER_DEG_LAT);
      if (gapM > SNAP_M || a.trail.length === 0) {
        a.pos[0] = px; a.pos[1] = py; a.alt = palt;
        a.trail.length = 0;
      } else {
        const k = 1 - Math.exp(-dt / CHASE_TAU);
        a.pos[0] += (px - a.pos[0]) * k;
        a.pos[1] += (py - a.pos[1]) * k;
        a.alt += (palt - a.alt) * k;
      }
      a.pos[2] = displayAlt(a.alt);
      if (t - a.trailT >= TRAIL_EVERY_S && !a.data.on_ground) {
        a.trailT = t;
        a.trail.push([a.pos[0], a.pos[1], a.pos[2]]);
        if (a.trail.length > TRAIL_MAX) a.trail.shift();
      }
    }
  }

  /** Fuselage + wings as two short paths, oriented along the track. */
  glyph(a, dz = 0, scale = 1) {
    const len = (PLANE_SIZE[a.data.size] || 24) * scale;
    const rad = (a.track * Math.PI) / 180;
    const fx = Math.sin(rad), fy = Math.cos(rad); // forward unit (east, north)
    const [x, y] = a.pos;
    const z = a.pos[2] + dz;
    const P = (dxm, dym) => [x + dxm / M_PER_DEG_LON, y + dym / M_PER_DEG_LAT, z];
    const fuselage = [P(-fx * len * 0.5, -fy * len * 0.5), P(fx * len * 0.5, fy * len * 0.5)];
    // wings: perpendicular, slightly aft of centre, span ~ 0.9 * length
    const wx = fy, wy = -fx, span = len * 0.9, aft = -len * 0.05;
    const wings = [P(-wx * span * 0.5 + fx * aft, -wy * span * 0.5 + fy * aft), P(wx * span * 0.5 + fx * aft, wy * span * 0.5 + fy * aft)];
    return { fuselage, wings };
  }

  get(id) { return this.aircraft.get(id); }
}

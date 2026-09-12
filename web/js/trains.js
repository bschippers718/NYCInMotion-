// Subway trains: turn the server's motion model into a smooth position every frame.
//
// The server tells us, per train: which track shape it is on, how far along it is
// right now (dist), where its next stop is (dist_to), when it should get there
// (eta) and - if it is standing at a platform - when it should leave (dwell).
// Between polls we move the train along the real track so that it reaches the
// stop at its ETA; when a fresh model arrives we ease onto it rather than jump.

import { M_PER_DEG_LAT, M_PER_DEG_LON, Polyline, clamp, hex2rgb } from "./geo.js";

const CHASE_TAU = 1.4; // seconds - how quickly the drawn position converges on the model
const SNAP_M = 320; // a model this far behind the drawn position is a re-identification: snap
const HOLD_BEFORE_STOP_M = 4; // never draw the train past its next stop until the feed confirms
const MAX_SPEED = 32; // m/s, ~115 km/h, faster than anything on the system

// collision avoidance (see separate())
const FOLLOW_GAP_M = 30; // clear track kept between a train's nose and the tail ahead
const SAME_TRACK_M = 10; // two trains this close to one centreline are on the same drawn track (shapes on a corridor agree to <1 m; converging lines sit ~7 m apart)
const SAME_DIR_DEG = 25; // bearings closer than this count as the same direction
const BACK_OFF_MPS = 14; // how fast a train that finds itself inside another backs out
const GRID_M = 300; // spatial hash cell
const LANE_TAU = 1.2; // s, easing onto / off an outer lane
export const LANE_SPACING = 2; // extra lanes, in multiples of the base side offset (= one full train width + margin)

const shift = (path, [ox, oy]) => (ox || oy ? path.map((p) => [p[0] + ox, p[1] + oy, p[2]]) : path);

// Rough train lengths (m) by route - the capsule drawn along the track.
const TRAIN_LENGTH = { GS: 60, FS: 40, H: 75, SI: 90, L: 145, G: 75, "1": 155, "2": 155, "3": 155, "4": 155, "5": 155, "6": 155, "6X": 155, "7": 170, "7X": 170 };
export const trainLength = (route) => TRAIN_LENGTH[route] ?? 180;
// car bodies are drawn a shade lighter than the track they run on so they stand out from it
const tint = (c) => c.map((v) => Math.round(v + (255 - v) * 0.38));

export class TrainTracker {
  constructor() {
    this.shapes = new Map(); // shape id -> Polyline
    this.trains = new Map(); // train id -> record
    this.byRoute = {};
    this.count = 0;
  }

  setNetwork(net) {
    this.shapes.clear();
    for (const sh of net.shapes) {
      const poly = new Polyline(sh.points, -16);
      poly.id = sh.id;
      poly.stops = sh.stops || []; // [{ id (platform), dist }] along the shape
      this.shapes.set(sh.id, poly);
    }
  }

  /** Ingest one /api/trains response. `serverNow` = generated_at (unix s). */
  ingest(list, serverNow) {
    const seen = new Set();
    const byRoute = {};
    for (const d of list) {
      seen.add(d.id);
      byRoute[d.route] = (byRoute[d.route] || 0) + 1;
      const shape = d.shape ? this.shapes.get(d.shape) : null;
      let rec = this.trains.get(d.id);
      if (!rec) {
        rec = { id: d.id, data: d, shape: null, model: null, dist: 0, speed: 0, lastT: serverNow, pos: [d.lon, d.lat, d.z ?? -16], from: null, to: null, color: hex2rgb(d.route_color), text: hex2rgb(d.route_text_color), body: tint(hex2rgb(d.route_color)) };
        this.trains.set(d.id, rec);
        if (shape && d.dist != null) rec.dist = d.dist;
        rec.fresh = true; // first placement may be moved straight to a safe spot
      }
      rec.data = d;
      rec.color = hex2rgb(d.route_color);
      rec.text = hex2rgb(d.route_text_color);
      if (shape && d.dist != null) {
        if (rec.shape !== shape) { rec.shape = shape; rec.dist = d.dist; rec.speed = 0; rec.fresh = true; } // new/changed track: snap
        rec.model = { d0: d.dist, t0: serverNow, d1: d.dist_to ?? d.dist, eta: d.eta, dwell: d.dwell };
        rec.from = rec.to = null;
      } else {
        // no track geometry: fall back to easing between snapshot positions
        rec.shape = null; rec.model = null;
        rec.from = rec.pos.slice();
        rec.to = [d.lon, d.lat, d.z ?? -16];
        rec.lerpT0 = serverNow; rec.lerpT1 = serverNow + 5;
      }
    }
    for (const id of [...this.trains.keys()]) if (!seen.has(id)) this.trains.delete(id);
    this.byRoute = byRoute;
    this.count = list.length;
  }

  /** Where the model says the train is at server time t. */
  static modelDist(m, t) {
    if (m.dwell && t < m.dwell) return m.d0;
    const start = m.dwell && m.dwell > m.t0 ? m.dwell : m.t0;
    if (m.eta && m.eta > start + 1 && m.d1 !== m.d0) {
      const k = clamp((t - start) / (m.eta - start), 0, 1);
      const target = m.d0 + (m.d1 - m.d0) * k;
      return m.d1 > m.d0 ? Math.min(target, m.d1 - HOLD_BEFORE_STOP_M) : target;
    }
    return m.d0;
  }

  /** Advance every train to server time `t`; call once per frame. */
  update(t) {
    for (const rec of this.trains.values()) {
      const dt = clamp(t - rec.lastT, 0, 1);
      rec.lastT = t;
      rec._prev = rec.dist;
      if (rec.model && rec.shape) {
        const target = TrainTracker.modelDist(rec.model, t);
        let d = rec.dist;
        if (target < d - SNAP_M || target > d + SNAP_M * 4) { d = target; rec.fresh = true; } // re-identification or first fix: a jump anyway
        else if (target > d) {
          // ease toward the model, but never faster than a real train
          const k = 1 - Math.exp(-dt / CHASE_TAU);
          const step = Math.min((target - d) * k, MAX_SPEED * dt);
          rec.speed = dt > 0 ? step / dt : rec.speed;
          d += step;
        } else {
          rec.speed *= Math.exp(-dt / 0.4); // model is behind us (revised ETA): hold, don't reverse
        }
        rec.dist = d;
        rec.shape.pointAt(d, rec.pos);
      } else if (rec.from && rec.to) {
        const k = clamp((t - rec.lerpT0) / (rec.lerpT1 - rec.lerpT0), 0, 1);
        rec.pos[0] = rec.from[0] + (rec.to[0] - rec.from[0]) * k;
        rec.pos[1] = rec.from[1] + (rec.to[1] - rec.from[1]) * k;
        rec.pos[2] = rec.to[2];
      }
    }
    const dt = clamp(t - (this.lastT ?? t), 0, 1);
    this.lastT = t;
    this.separate(dt);
  }

  /**
   * Keep trains from being drawn through each other. The GTFS shapes put every
   * service on a corridor on the same centreline, so without this an express would
   * plough through a local and two trains of one line could overlap.
   *  - same line, same direction, same track  -> the one behind holds a safe distance
   *  - different lines overlapping in the same direction -> the later-sorting line is
   *    eased onto an outer "lane" (drawn further to the right), so they pass side by side
   * Opposite directions never collide because every train is drawn on the right-hand
   * side of its track (see sideVec).
   */
  separate(dt) {
    const grid = new Map();
    const list = [];
    for (const rec of this.trains.values()) {
      if (!rec.shape || !rec.model) { rec.lane = 0; continue; }
      rec.bearing = rec.shape.bearingAt(rec.dist);
      rec._lane = 0;
      rec._limit = Infinity;
      rec._instant = false;
      rec._cx = Math.floor((rec.pos[0] * M_PER_DEG_LON) / GRID_M);
      rec._cy = Math.floor((rec.pos[1] * M_PER_DEG_LAT) / GRID_M);
      const key = rec._cx * 100003 + rec._cy;
      let arr = grid.get(key);
      if (!arr) grid.set(key, (arr = []));
      arr.push(rec);
      list.push(rec);
    }
    // pass 1: find every pair that shares a track and overlaps, once per pair. Detection is
    // asymmetric (a train past the end of the other's shape cannot be projected onto it),
    // so whichever side finds the pair records the consequence for both trains.
    const seen = new Set();
    for (const a of list) {
      const lenA = trainLength(a.data.route);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get((a._cx + dx) * 100003 + (a._cy + dy));
          if (!arr) continue;
          for (const b of arr) {
            if (b === a) continue;
            const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
            if (seen.has(pairKey)) continue;
            // where is b's head measured along a's track, and is it heading the same way there?
            let dB;
            if (b.shape === a.shape) dB = b.dist;
            else {
              const pr = a.shape.project(b.pos[0], b.pos[1], a.dist, 600);
              if (pr.offset > SAME_TRACK_M) continue;
              dB = pr.dist;
              // compare headings at the same spot (on a curve two trains 150 m apart differ by 30°)
              let db = Math.abs(a.shape.bearingAt(dB) - b.bearing);
              if (db > 180) db = 360 - db;
              if (db > SAME_DIR_DEG) continue;
            }
            const lenB = trainLength(b.data.route);
            const overlap = dB > a.dist - lenA - FOLLOW_GAP_M && dB - lenB - FOLLOW_GAP_M < a.dist;
            if (!overlap) continue;
            seen.add(pairKey);
            if (b.data.route === a.data.route) {
              // same line, same track: the one behind holds (ties broken by id so two trains
              // never back away from each other forever)
              const bAhead = dB > a.dist + 0.5 || (Math.abs(dB - a.dist) <= 0.5 && a.id < b.id);
              const [back, front, dFront] = bAhead ? [a, b, dB] : [b, a, b.dist + (a.dist - dB)];
              const lim = dFront - trainLength(front.data.route) - FOLLOW_GAP_M;
              if (lim >= 0) { back._limit = Math.min(back._limit, lim); if (front.fresh) back._instant = true; }
              else back._lane++; // no track behind the leader (terminal layup): sit beside it instead
            } else if (b.data.route < a.data.route) a._lane++;
            else b._lane++;
          }
        }
      }
    }
    // pass 2: apply
    for (const a of list) {
      if (a.dist > a._limit) {
        // hold behind the train ahead; if we are already inside its space, don't advance - back off
        // (a train that has just appeared or jumped is simply placed behind: it was a teleport anyway)
        a.dist = a.fresh || a._instant ? a._limit : Math.max(a._limit, Math.min(a.dist, a._prev) - BACK_OFF_MPS * dt);
        a.speed = 0;
        a.shape.pointAt(a.dist, a.pos);
        a.held = true;
      } else a.held = false;
      a.lane = (a.lane || 0) + (a._lane - (a.lane || 0)) * (1 - Math.exp(-dt / LANE_TAU));
      a.fresh = false;
    }
  }

  /** Sideways offset (deg lon, deg lat) that puts the train on the right-hand side of its track. */
  sideVec(rec, sideM) {
    if (!sideM || !rec.shape || rec.bearing == null) return [0, 0];
    const m = sideM * (1 + (rec.lane || 0) * LANE_SPACING);
    const th = (rec.bearing * Math.PI) / 180;
    return [(Math.cos(th) * m) / M_PER_DEG_LON, (-Math.sin(th) * m) / M_PER_DEG_LAT];
  }

  /** Drawn position of the head (with side offset), lifted by dz. */
  headPos(rec, dz = 0, sideM = 0) {
    const [ox, oy] = this.sideVec(rec, sideM);
    return [rec.pos[0] + ox, rec.pos[1] + oy, rec.pos[2] + dz];
  }

  /** Capsule geometry for one train (sub-path of its track ending at the head). */
  capsule(rec, dz = 0, sideM = 0) {
    if (!rec.shape) {
      const p = rec.pos; return [[p[0], p[1], p[2] + dz], [p[0] + 1e-6, p[1] + 1e-6, p[2] + dz]];
    }
    const len = trainLength(rec.data.route);
    return shift(rec.shape.slice(rec.dist - len, rec.dist, dz), this.sideVec(rec, sideM));
  }

  /** The train as a string of cars (51 ft on the numbered lines, 60 ft on the lettered ones). */
  cars(rec, dz = 0, sideM = 0) {
    if (!rec.shape) return [this.capsule(rec, dz)];
    const route = rec.data.route;
    const len = trainLength(route);
    const car = /^[1-7]|^GS|^SI/.test(route) ? 15.5 : 18.3;
    const gap = 1.4;
    const n = Math.max(1, Math.round((len + gap) / (car + gap)));
    const side = this.sideVec(rec, sideM);
    const out = [];
    for (let i = 0; i < n; i++) {
      const end = rec.dist - i * (car + gap);
      out.push(shift(rec.shape.slice(end - car, end, dz), side));
    }
    return out;
  }

  get(id) { return this.trains.get(id); }
}

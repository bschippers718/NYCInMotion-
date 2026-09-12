// GPS vehicles (buses, ferries): snap each fix to the vehicle's route shape and
// dead-reckon along it between fixes, so a bus that reports every 30 s still
// glides down the avenue instead of teleporting a block at a time.

import { Polyline, clamp, hex2rgb } from "./geo.js";

const CHASE_TAU = 1.6;
const SNAP_M = 250;
const MAX_EXTRAPOLATE_S = 75; // stop dead-reckoning if the fix goes stale
const OFF_ROUTE_M = 45; // a fix this far from the shape is a detour: use raw GPS

export class VehicleTracker {
  /**
   * @param {object} opts  { defaultSpeed (m/s), maxSpeed, z }
   */
  constructor(opts = {}) {
    this.shapes = [];
    this.vehicles = new Map();
    this.defaultSpeed = opts.defaultSpeed ?? 6;
    this.maxSpeed = opts.maxSpeed ?? 18;
    this.z = opts.z ?? 0;
    this.count = 0;
  }

  setNetwork(net) {
    this.shapes = net.shapes.map((sh) => new Polyline(sh.points, 0));
    this.routes = net.routes || {};
  }

  ingest(list, serverNow) {
    const seen = new Set();
    for (const d of list) {
      seen.add(d.id);
      const shape = d.shape != null ? this.shapes[d.shape] : null;
      const ts = d.ts || serverNow;
      let v = this.vehicles.get(d.id);
      if (!v) {
        v = { id: d.id, data: d, shape: null, dist: 0, speed: this.defaultSpeed, obsDist: 0, obsT: ts, pos: [d.lon, d.lat, this.z], from: null, to: null, lerpT0: 0, lerpT1: 1, lastT: serverNow, color: hex2rgb(d.color || "#f28c28"), bearing: d.bearing || 0, onRoute: false };
        this.vehicles.set(d.id, v);
      }
      const prevTs = v.data.ts;
      v.data = d;
      v.color = hex2rgb(d.color || "#f28c28");
      if (d.bearing != null) v.bearing = d.bearing;

      if (shape) {
        const sameShape = v.shape === shape;
        const proj = shape.project(d.lon, d.lat, sameShape && v.onRoute ? v.obsDist : null);
        if (proj.offset <= OFF_ROUTE_M) {
          if (!sameShape || !v.onRoute) { v.shape = shape; v.dist = proj.dist; v.speed = this.defaultSpeed; v.onRoute = true; }
          if (ts !== prevTs || !sameShape) {
            // new fix: update speed estimate from the distance covered since the last fix
            if (sameShape && ts > v.obsT + 3) {
              const est = (proj.dist - v.obsDist) / (ts - v.obsT);
              v.speed = clamp(est >= 0 ? est * 0.7 + v.speed * 0.3 : v.speed * 0.5, 0, this.maxSpeed);
            }
            v.obsDist = proj.dist;
            v.obsT = ts;
            if (d.status === "STOPPED_AT") v.speed *= 0.5;
          }
          continue;
        }
      }
      // off route / no shape: ease between raw fixes
      v.onRoute = false; v.shape = null;
      v.from = v.pos.slice();
      v.to = [d.lon, d.lat, this.z];
      v.lerpT0 = serverNow; v.lerpT1 = serverNow + 8;
    }
    for (const id of [...this.vehicles.keys()]) if (!seen.has(id)) this.vehicles.delete(id);
    this.count = list.length;
  }

  update(t) {
    for (const v of this.vehicles.values()) {
      const dt = clamp(t - v.lastT, 0, 1);
      v.lastT = t;
      if (v.onRoute && v.shape) {
        const age = clamp(t - v.obsT, 0, MAX_EXTRAPOLATE_S);
        const target = Math.min(v.obsDist + v.speed * age, v.shape.length);
        let d = v.dist;
        if (target < d - SNAP_M || target > d + SNAP_M * 3) d = target;
        else if (target > d) d += Math.min((target - d) * (1 - Math.exp(-dt / CHASE_TAU)), this.maxSpeed * 1.3 * dt);
        v.dist = d;
        v.shape.pointAt(d, v.pos);
        v.pos[2] = this.z;
        v.bearing = v.shape.bearingAt(d);
      } else if (v.from && v.to) {
        const k = clamp((t - v.lerpT0) / (v.lerpT1 - v.lerpT0), 0, 1);
        v.pos[0] = v.from[0] + (v.to[0] - v.from[0]) * k;
        v.pos[1] = v.from[1] + (v.to[1] - v.from[1]) * k;
        v.pos[2] = this.z;
      }
    }
  }

  /** Short capsule along the route (or along the bearing) for drawing the vehicle body. */
  capsule(v, lengthM, dz = 0) {
    if (v.onRoute && v.shape) return v.shape.slice(v.dist - lengthM, v.dist, dz + this.z);
    const b = (v.bearing || 0) * Math.PI / 180;
    const dx = Math.sin(b) * lengthM, dy = Math.cos(b) * lengthM;
    const p = v.pos;
    return [[p[0] - dx / 84300, p[1] - dy / 111000, p[2] + dz], [p[0], p[1], p[2] + dz]];
  }
}

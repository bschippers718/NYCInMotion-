// Taxi / Uber / Lyft: replay a typical hour of trips as particles that drive
// real street routes (over bridges, through tunnels) between taxi zones.
//
// The server samples `particles` trips from the whole zone-to-zone distribution
// for the chosen weekday + hour (see subway/taxi.py), so each dot stands for the
// same number of real trips and every neighbourhood gets its true share. Paths
// are expanded here into flat typed arrays for deck.gl's binary attribute mode.

import { decodeTaxiTrips, getBuffer, getJSON } from "./api.js";
import { M_PER_DEG_LAT, M_PER_DEG_LON, clamp } from "./geo.js";

export const LOOP_SECONDS = 3600; // one hour of trips ...
export const SERVICES = ["uber", "lyft", "yellow", "other_hv"];
export const SERVICE_COLORS = { uber: [235, 235, 235], lyft: [255, 0, 191], yellow: [255, 212, 0], other_hv: [120, 200, 255] };
export const DENSITIES = { sparse: 7000, medium: 20000, full: 0 }; // 0 = one dot per trip

export class TaxiReplay {
  constructor(opts = {}) {
    this.particleTarget = opts.particles ?? 7000; // 0 => one dot per drawable trip
    this.zones = null; // id -> zone
    this.zoneList = [];
    this.flow = null;
    this.trips = []; // metadata per particle (for tooltips)
    this.tripsPerDot = 0;
    this.data = null; // binary TripsLayer data
    this.pathsAvailable = false;
    this._req = 0;
  }

  get count() { return this.trips.length; }

  async loadZones() {
    const z = await getJSON("/api/taxi/zones");
    this.zones = {};
    for (const zone of z.zones) this.zones[zone.id] = zone;
    this.zoneList = z.zones;
  }

  /** Load flow summary + sampled trips for a weekday/hour/service selection. Resolves to the flow summary. */
  async load(dow, hour, services) {
    const req = ++this._req;
    const q = `dow=${dow}&hour=${hour}&services=${[...services].join(",")}`;
    const flow = await getJSON(`/api/taxi/flow?${q}&top=200`);
    if (req !== this._req) return null;
    const n = this.particleTarget || Math.max(1, flow.drawable_per_hour || flow.trips_per_hour);
    const bundle = await getBuffer(`/api/taxi/trips?${q}&n=${n}`).then(decodeTaxiTrips).catch(() => null);
    if (req !== this._req) return null; // superseded
    this.flow = flow;
    this.pathsAvailable = !!flow.street_paths;
    this.build(bundle);
    return flow;
  }

  jitter(zone) {
    // spread pickups across the zone: ~ ±350 m gaussian-ish
    const r = (Math.random() + Math.random() + Math.random() - 1.5) * 0.006;
    const a = Math.random() * Math.PI * 2;
    return [zone.lon + Math.cos(a) * r, zone.lat + Math.sin(a) * r * 0.76, 0];
  }

  build(bundle) {
    this.trips = [];
    this.data = null;
    this.tripsPerDot = 0;
    if (!bundle || !bundle.trips.length || !this.zones) return;
    const { trips, pathStart, verts } = bundle;
    this.tripsPerDot = bundle.tripsPerDot;

    // first pass: how many particles and vertices (trips that spill past the hour are drawn twice)
    const starts = new Float64Array(trips.length);
    const spill = new Uint8Array(trips.length);
    let nParticles = 0, nVerts = 0;
    for (let i = 0; i < trips.length; i++) {
      const t = trips[i];
      const m = t.path >= 0 ? pathStart[t.path + 1] - pathStart[t.path] : 2;
      starts[i] = Math.random() * LOOP_SECONDS;
      const dur = Math.max(120, Math.min(LOOP_SECONDS, t.secs));
      spill[i] = starts[i] + dur > LOOP_SECONDS ? 1 : 0;
      const copies = 1 + spill[i];
      nParticles += copies;
      nVerts += copies * m;
    }

    const positions = new Float32Array(nVerts * 3);
    const timestamps = new Float32Array(nVerts);
    const colors = new Uint8Array(nVerts * 3);
    const startIndices = new Uint32Array(nParticles + 1);
    const meta = new Array(nParticles);
    let p = 0, v = 0;
    const scratch = new Float64Array(4096);

    for (let i = 0; i < trips.length; i++) {
      const t = trips[i];
      const color = SERVICE_COLORS[SERVICES[t.service]] || SERVICE_COLORS.other_hv;
      const start = starts[i];
      let m, base, dur, ox = 0, oy = 0, a = null, b = null;
      if (t.path >= 0) {
        base = pathStart[t.path] * 3;
        m = pathStart[t.path + 1] - pathStart[t.path];
        // lateral offset of a few metres so particles on the same route form lanes
        const side = (Math.random() - 0.5) * 9;
        ox = side / M_PER_DEG_LON; oy = side / M_PER_DEG_LAT;
        // cumulative length along the path -> constant speed timestamps
        const cum = m <= scratch.length ? scratch : new Float64Array(m);
        cum[0] = 0;
        for (let j = 1; j < m; j++) {
          const dx = (verts[base + j * 3] - verts[base + (j - 1) * 3]) * M_PER_DEG_LON;
          const dy = (verts[base + j * 3 + 1] - verts[base + (j - 1) * 3 + 1]) * M_PER_DEG_LAT;
          cum[j] = cum[j - 1] + Math.hypot(dx, dy);
        }
        const length = cum[m - 1] || 1;
        // duration: the observed average for this pair, but keep the implied speed sane
        dur = clamp(t.secs, length / 22, length / 3.5);
        for (let copy = 0; copy <= spill[i]; copy++) {
          const shift = copy ? -LOOP_SECONDS : 0;
          startIndices[p] = v;
          meta[p] = t;
          for (let j = 0; j < m; j++, v++) {
            positions[v * 3] = verts[base + j * 3] + ox;
            positions[v * 3 + 1] = verts[base + j * 3 + 1] + oy;
            positions[v * 3 + 2] = verts[base + j * 3 + 2];
            timestamps[v] = start + shift + (cum[j] / length) * dur;
            colors[v * 3] = color[0]; colors[v * 3 + 1] = color[1]; colors[v * 3 + 2] = color[2];
          }
          p++;
        }
      } else {
        // no routed street path for this pair (islands, Newark ...): fly zone to zone
        const zPu = this.zones[t.pu], zDo = this.zones[t.do];
        if (!zPu || !zDo) continue;
        a = this.jitter(zPu); b = this.jitter(zDo);
        dur = Math.max(120, Math.min(LOOP_SECONDS, t.secs));
        for (let copy = 0; copy <= spill[i]; copy++) {
          const shift = copy ? -LOOP_SECONDS : 0;
          startIndices[p] = v;
          meta[p] = t;
          positions.set(a, v * 3); timestamps[v] = start + shift; colors.set(color, v * 3); v++;
          positions.set(b, v * 3); timestamps[v] = start + shift + dur; colors.set(color, v * 3); v++;
          p++;
        }
      }
    }
    startIndices[p] = v;
    this.trips = meta.slice(0, p);
    this.data = {
      length: p,
      startIndices: startIndices.subarray(0, p + 1),
      attributes: {
        getPath: { value: positions.subarray(0, v * 3), size: 3 },
        getTimestamps: { value: timestamps.subarray(0, v), size: 1 },
        getColor: { value: colors.subarray(0, v * 3), size: 3 },
      },
    };
  }

  /** GeoJSON features for the pickup-volume columns. */
  zoneColumns() {
    if (!this.flow || !this.zoneList.length) return [];
    const m = new Map(this.flow.zones.map(([id, p, d]) => [id, [p, d]]));
    return this.zoneList
      .filter((z) => (m.get(z.id) || [0])[0] > 0)
      .map((z) => ({ type: "Feature", geometry: z.geometry, properties: { id: z.id, zone: z.zone, borough: z.borough, pickups: m.get(z.id)[0], dropoffs: m.get(z.id)[1] } }));
  }
}

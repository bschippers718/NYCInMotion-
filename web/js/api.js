// Fetch helpers and a clock that runs on server time.

export async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export async function getBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

/**
 * All motion models are expressed in server unix seconds. The browser clock may
 * be off by seconds, so we estimate the offset from every /api/trains response
 * (generated_at vs. our receive time, minus half the round trip).
 */
export class Clock {
  constructor() { this.offset = 0; this.samples = 0; }
  sample(serverUnixSeconds, requestStartedMs) {
    const rtt = performance.now() - requestStartedMs;
    const est = serverUnixSeconds * 1000 + rtt / 2 - Date.now();
    this.offset = this.samples === 0 ? est : this.offset * 0.8 + est * 0.2;
    this.samples++;
  }
  /** Server time in unix seconds (fractional). */
  now() { return (Date.now() + this.offset) / 1000; }
}

/** Decode /api/streets: binary PathLayer buffer (uint32 header, start indices, float32 xyz). */
export function decodeStreets(buf) {
  const head = new Uint32Array(buf, 0, 2);
  const nPaths = head[0], nVerts = head[1];
  const startIndices = new Uint32Array(buf, 8, nPaths + 1);
  const positions = new Float32Array(buf, 8 + (nPaths + 1) * 4, nVerts * 3);
  return { length: nPaths, startIndices, positions };
}

/** Decode /api/taxi/paths (see subway/taxi.py for the layout). Returns per-flow arrays of Float32 xyz views. */
export function decodeTaxiTrips(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x51495854) throw new Error("bad taxi trip bundle");
  const nTrips = dv.getUint32(4, true), nPaths = dv.getUint32(8, true), nVerts = dv.getUint32(12, true);
  const tripsPerDot = dv.getFloat32(16, true), days = dv.getUint32(20, true);
  let off = 24;
  const pathStart = new Uint32Array(buf, off, nPaths + 1); off += (nPaths + 1) * 4;
  const recOff = off; off += nTrips * 12;
  const verts = new Float32Array(buf, off, nVerts * 3);
  const trips = new Array(nTrips);
  for (let i = 0; i < nTrips; i++) {
    const o = recOff + i * 12;
    trips[i] = { pu: dv.getUint16(o, true), do: dv.getUint16(o + 2, true), service: dv.getUint16(o + 4, true), secs: dv.getUint16(o + 6, true), path: dv.getInt32(o + 8, true) };
  }
  return { trips, pathStart, verts, tripsPerDot, days };
}

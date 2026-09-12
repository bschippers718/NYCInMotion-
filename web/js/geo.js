// Geometry helpers. Positions are deck.gl style [lon, lat, z]; distances in metres.

const R = 6371000;
const RAD = Math.PI / 180;
export const M_PER_DEG_LAT = RAD * R;
export const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(40.73 * RAD);

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function haversine(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD;
  const dphi = p2 - p1, dl = (lon2 - lon1) * RAD;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearing(lon1, lat1, lon2, lat2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

/** Binary search: index i such that cum[i] <= d < cum[i+1]. */
function segmentIndex(cum, d) {
  let lo = 0, hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * A polyline with cumulative distances, built from server points [[lat, lon, z?], ...].
 * The cumulative distance uses the same haversine as the server so a "dist" from
 * the API lands on exactly the same spot.
 */
export class Polyline {
  constructor(points, defaultZ = 0) {
    const n = points.length;
    this.n = n;
    this.lon = new Float64Array(n);
    this.lat = new Float64Array(n);
    this.z = new Float32Array(n);
    this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      this.lat[i] = p[0];
      this.lon[i] = p[1];
      this.z[i] = p.length > 2 ? p[2] : defaultZ;
      if (i > 0) this.cum[i] = this.cum[i - 1] + haversine(this.lat[i - 1], this.lon[i - 1], this.lat[i], this.lon[i]);
    }
    this.length = this.cum[n - 1];
    this.zMin = Math.min(...this.z);
    this.zMax = Math.max(...this.z);
    this._path = null;
  }

  /** Full path as [[lon, lat, z], ...] (cached). */
  path() {
    if (!this._path) {
      this._path = new Array(this.n);
      for (let i = 0; i < this.n; i++) this._path[i] = [this.lon[i], this.lat[i], this.z[i]];
    }
    return this._path;
  }

  pointAt(d, out = [0, 0, 0]) {
    if (this.n === 1) { out[0] = this.lon[0]; out[1] = this.lat[0]; out[2] = this.z[0]; return out; }
    let i, t;
    if (d <= 0) { i = 0; t = 0; }
    else if (d >= this.length) { i = this.n - 2; t = 1; }
    else { i = segmentIndex(this.cum, d); const seg = this.cum[i + 1] - this.cum[i]; t = seg > 0 ? (d - this.cum[i]) / seg : 0; }
    out[0] = this.lon[i] + (this.lon[i + 1] - this.lon[i]) * t;
    out[1] = this.lat[i] + (this.lat[i + 1] - this.lat[i]) * t;
    out[2] = this.z[i] + (this.z[i + 1] - this.z[i]) * t;
    return out;
  }

  bearingAt(d) {
    if (this.n < 2) return 0;
    const i = clamp(segmentIndex(this.cum, clamp(d, 0, this.length - 0.01)), 0, this.n - 2);
    const j = Math.min(i + 2, this.n - 1);
    return bearing(this.lon[i], this.lat[i], this.lon[j], this.lat[j]);
  }

  /** Sub-path between two distances (inclusive of interpolated end points), with an optional z offset. */
  slice(d0, d1, dz = 0) {
    d0 = clamp(d0, 0, this.length);
    d1 = clamp(d1, 0, this.length);
    if (d1 - d0 < 0.5) { const p = this.pointAt(d1); p[2] += dz; const q = this.pointAt(Math.max(0, d1 - 0.5)); q[2] += dz; return [q, p]; }
    const out = [];
    const a = this.pointAt(d0); a[2] += dz; out.push(a);
    let i = segmentIndex(this.cum, d0) + 1;
    while (i < this.n && this.cum[i] < d1) { out.push([this.lon[i], this.lat[i], this.z[i] + dz]); i++; }
    const b = this.pointAt(d1); b[2] += dz; out.push(b);
    return out;
  }

  /**
   * Project a lon/lat onto the polyline. If `hint` is given, only segments within
   * `window` metres (along the line) of it are considered - keeps buses from jumping
   * to the other leg of a loop route. Returns {dist, offset} (offset = metres off the line).
   */
  project(lon, lat, hint = null, window = 1500) {
    const px = lon * M_PER_DEG_LON, py = lat * M_PER_DEG_LAT;
    let i0 = 0, i1 = this.n - 2;
    if (hint != null) {
      i0 = Math.max(0, segmentIndex(this.cum, Math.max(0, hint - window)));
      i1 = Math.min(this.n - 2, segmentIndex(this.cum, Math.min(this.length, hint + window)) + 1);
    }
    let best = Infinity, bestDist = 0;
    for (let i = i0; i <= i1; i++) {
      const ax = this.lon[i] * M_PER_DEG_LON, ay = this.lat[i] * M_PER_DEG_LAT;
      const bx = this.lon[i + 1] * M_PER_DEG_LON, by = this.lat[i + 1] * M_PER_DEG_LAT;
      const dx = bx - ax, dy = by - ay;
      const seg2 = dx * dx + dy * dy;
      const t = seg2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / seg2, 0, 1) : 0;
      const qx = ax + t * dx - px, qy = ay + t * dy - py;
      const d2 = qx * qx + qy * qy;
      if (d2 < best) { best = d2; bestDist = this.cum[i] + t * (this.cum[i + 1] - this.cum[i]); }
    }
    return { dist: bestDist, offset: Math.sqrt(best) };
  }
}

/** Offset a [lon, lat, z] path sideways by `m` metres (used to fan out overlapping taxi paths). */
export function offsetPath(path, mx, my, dz = 0) {
  const dlon = mx / M_PER_DEG_LON, dlat = my / M_PER_DEG_LAT;
  return path.map((p) => [p[0] + dlon, p[1] + dlat, (p[2] || 0) + dz]);
}

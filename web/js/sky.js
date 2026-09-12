// Real sky for the cab view: the sun's position from the clock (NOAA's low-precision
// solar algorithm, good to a fraction of a degree) picks the sky, horizon and fog
// colours and lights the buildings; the live NWS observation (/api/weather) greys the
// sky over, thickens the fog, and puts rain or snow on the windshield.

const NYC = { lat: 40.73, lon: -73.99 };
const rad = Math.PI / 180;

/** Sun elevation / azimuth (degrees) at a Date for a lat/lon. */
export function sunPosition(date = new Date(), lat = NYC.lat, lon = NYC.lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const L = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const C = Math.sin(M * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * t) + Math.sin(3 * M * rad) * 0.000289;
  const trueLon = L + C;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLon - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqT = 4 * (y * Math.sin(2 * L * rad) - 2 * e * Math.sin(M * rad) + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L * rad) - 0.5 * y * y * Math.sin(4 * L * rad) - 1.25 * e * e * Math.sin(2 * M * rad)) / rad;
  const minutes = (date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + eqT + 4 * lon) % 1440;
  const ha = (minutes / 4 < 0 ? minutes / 4 + 180 : minutes / 4 - 180) * rad;
  const phi = lat * rad;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZ)));
  let az = Math.acos(Math.min(1, Math.max(-1, (Math.sin(phi) * Math.cos(zenith) - Math.sin(decl)) / (Math.cos(phi) * Math.sin(zenith))))) / rad;
  az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  return { elevation: 90 - zenith / rad, azimuth: az };
}

const hex = (c) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const grey = (c, t) => { const g = (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11); return mix(c, [g, g, g], t); };

/** Sky / horizon / fog colours and blends for MapLibre's setSky, from sun elevation and weather. */
export function skySpec(elevation, weather) {
  const w = weather || { kind: "unknown", cloud: 0, intensity: 0 };
  // keyframes by sun elevation (degrees)
  const keys = [
    [-18, { sky: [7, 10, 22], horizon: [28, 34, 56], fog: [12, 14, 23] }], // night
    [-6, { sky: [18, 26, 58], horizon: [120, 70, 60], fog: [40, 36, 48] }], // civil dusk
    [0, { sky: [60, 90, 150], horizon: [236, 150, 90], fog: [120, 110, 120] }], // sunset
    [8, { sky: [110, 160, 220], horizon: [230, 215, 200], fog: [190, 200, 215] }],
    [30, { sky: [96, 160, 235], horizon: [215, 228, 242], fog: [205, 216, 230] }],
    [90, { sky: [80, 150, 235], horizon: [210, 225, 242], fog: [205, 216, 230] }],
  ];
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) if (elevation >= keys[i][0] && elevation <= keys[i + 1][0]) { a = keys[i]; b = keys[i + 1]; break; }
  const t = a === b ? 0 : (elevation - a[0]) / (b[0] - a[0]);
  let sky = mix(a[1].sky, b[1].sky, t), horizon = mix(a[1].horizon, b[1].horizon, t), fog = mix(a[1].fog, b[1].fog, t);
  const day = Math.min(1, Math.max(0, (elevation + 6) / 12));
  // clouds flatten and grey the sky; rain / snow / fog more so
  const overcast = Math.min(1, (w.cloud || 0) * 0.8 + (w.kind === "rain" || w.kind === "storm" ? 0.5 : 0) + (w.kind === "snow" ? 0.4 : 0));
  sky = grey(sky, overcast * 0.7); horizon = grey(horizon, overcast * 0.8); fog = grey(fog, overcast * 0.6);
  if (overcast > 0.5) { sky = mix(sky, horizon, (overcast - 0.5) * 0.9); }
  if (w.kind === "storm") sky = mix(sky, [30, 32, 40], 0.5 * day);
  const foggy = w.kind === "fog" ? 1 : w.kind === "rain" ? 0.45 : w.kind === "snow" ? 0.6 : 0.15 + 0.2 * overcast;
  if (w.kind === "fog") { fog = mix(fog, horizon, 0.6); sky = mix(sky, fog, 0.5); }
  return {
    "sky-color": hex(sky),
    "horizon-color": hex(horizon),
    "fog-color": hex(fog),
    "fog-ground-blend": 0.5 + 0.4 * foggy,
    "horizon-fog-blend": 0.6 + 0.35 * foggy,
    "sky-horizon-blend": 0.85 - 0.3 * foggy,
    "atmosphere-blend": 0.3 + 0.5 * foggy,
    _day: day,
    _foggy: foggy,
  };
}

/** MapLibre light for fill-extrusions: sun direction and a brightness that follows the day. */
export function lightSpec(sun, weather) {
  const day = Math.min(1, Math.max(0, (sun.elevation + 6) / 12));
  const dim = weather && (weather.cloud || 0) > 0.7 ? 0.7 : 1;
  return { anchor: "map", position: [1.15, sun.azimuth, Math.max(20, Math.min(88, 90 - sun.elevation))], intensity: 0.25 + 0.3 * day * dim, color: day > 0.5 ? "#ffffff" : "#c9d2ff" };
}

/** Rain / snow streaks on the windshield, drawn on a 2D canvas over the cab view. */
export class Windshield {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.drops = [];
    this.kind = "clear";
    this.intensity = 0;
    this.t = 0;
  }
  set(weather) {
    this.kind = weather?.kind || "clear";
    this.intensity = weather?.intensity || 0;
    if (!/rain|storm|snow/.test(this.kind)) { this.drops.length = 0; this.clear(); }
  }
  clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  /** speed in m/s: faster means longer, more slanted streaks. */
  draw(dt, speed) {
    const c = this.canvas, g = this.ctx;
    if (!/rain|storm|snow/.test(this.kind) || this.intensity <= 0) return;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const snow = this.kind === "snow";
    const want = Math.round((snow ? 260 : 140) * this.intensity * (W * H) / (1440 * 900));
    while (this.drops.length < want) this.drops.push({ x: Math.random() * W, y: Math.random() * H, len: 8 + Math.random() * 22, v: 260 + Math.random() * 300, s: 0.6 + Math.random() * 0.8 });
    if (this.drops.length > want) this.drops.length = want;
    g.clearRect(0, 0, W, H);
    const k = Math.min(1, (speed || 0) / 18);
    g.lineCap = "round";
    for (const d of this.drops) {
      const vy = snow ? d.v * 0.25 : d.v * (0.6 + 0.6 * k);
      const vx = (d.x - W / 2) / W * (snow ? 40 : 90) * (0.3 + k); // streaks fan outwards from the centre at speed
      d.y += vy * dt; d.x += vx * dt + (snow ? Math.sin(this.t * 2 + d.len) * 14 * dt : 0);
      if (d.y > H + 20 || d.x < -20 || d.x > W + 20) { d.y = -20 - Math.random() * 40; d.x = Math.random() * W; }
      if (snow) {
        g.fillStyle = `rgba(240,244,255,${0.5 + 0.4 * d.s})`;
        g.beginPath(); g.arc(d.x, d.y, 1.2 + d.s * 1.6, 0, Math.PI * 2); g.fill();
      } else {
        const len = d.len * (0.5 + k);
        g.strokeStyle = `rgba(205,220,245,${0.3 + 0.4 * d.s})`;
        g.lineWidth = 0.8 + d.s;
        g.beginPath(); g.moveTo(d.x - vx * 0.02 * len / 10, d.y - len); g.lineTo(d.x, d.y); g.stroke();
      }
    }
    this.t += dt;
  }
}

// The weather over the city. /api/weather (the National Weather Service's Central Park
// observation) already picks the sky in the cab; here it also falls on the 3D city -
// rain streaks and snow leaning with the wind, a haze that swallows the far towers
// when it is foggy, lightning when there is a storm - and gets a proper card in the
// panel: an icon that knows whether it is day or night, the temperature, and the wind
// as an arrow that points where it blows.

import { M_PER_DEG_LAT, M_PER_DEG_LON, clamp } from "./geo.js";

const { LineLayer, ScatterplotLayer } = deck;
const rad = Math.PI / 180;
const hex = (c) => "#" + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

export const WET = /rain|storm|snow/;
const STATIONS = { KNYC: "Central Park", KLGA: "LaGuardia", KJFK: "JFK", KEWR: "Newark" };
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

// ---- precipitation in 3D ------------------------------------------------------------------
/**
 * Rain and snow as particles falling through a column of air around the view centre.
 * Each drop has a fixed random footprint and phase; its height is a function of time, so
 * nothing is simulated and the whole field costs one pass over a small typed array a frame.
 * The fall is faster than real rain (which at map scale would barely seem to move) and the
 * whole column leans with the wind: the NWS gives the direction the wind blows *from*.
 */
export class Precipitation {
  constructor(n = 3200) {
    this.n = n;
    this.seed = new Float32Array(n * 4); // u, v, phase, size
    for (let i = 0; i < n; i++) { this.seed[i * 4] = Math.random(); this.seed[i * 4 + 1] = Math.random(); this.seed[i * 4 + 2] = Math.random(); this.seed[i * 4 + 3] = Math.random(); }
    this.src = new Float32Array(n * 3);
    this.dst = new Float32Array(n * 3);
    this.rad = new Float32Array(n);
    this.rgba = new Uint8Array(n * 4);
  }

  /** deck.gl layers for this frame, or [] when it is dry. `t` is a clock in seconds. */
  layers({ center, zoom, t, weather, beforeId }) {
    const w = weather;
    if (!w || !WET.test(w.kind) || !center) return [];
    const snow = w.kind === "snow";
    const inten = clamp(w.intensity || 0.5, 0.15, 1);
    const count = Math.min(this.n, Math.round((snow ? 1900 : 1700) * (0.3 + 0.7 * inten)));
    const R = clamp(760 * Math.pow(2, 15.4 - zoom), 220, 3200); // half-size of the column's footprint: fills the view at any zoom
    const H = snow ? 240 : 380; // how high the column reaches (m): over the towers, under the aircraft
    const speed = snow ? 12 + 6 * inten : 95 + 70 * inten; // m/s (real rain is ~9; that would crawl at map scale)
    const len = snow ? 0 : 8 + 22 * inten; // streak length (m)
    // each drop keeps its own faintness, so the field has depth instead of reading as one texture
    const { rgba } = this;
    const base = snow ? [238, 242, 255] : [150, 172, 212];
    // lean with the wind: metres sideways per metre fallen
    const wk = w.wind_kmh || 0;
    const to = ((w.wind_dir ?? 0) + 180) * rad; // the direction the wind blows towards
    const slant = clamp(wk / 45, 0, 0.9) * (snow ? 1.5 : 0.55);
    const wx = Math.sin(to) * slant, wy = Math.cos(to) * slant;
    const kx = 1 / M_PER_DEG_LON, ky = 1 / M_PER_DEG_LAT;
    const { seed, src, dst } = this;
    const wrap = (x) => (((x + R) % (2 * R)) + 2 * R) % (2 * R) - R;
    for (let i = 0; i < count; i++) {
      const u = seed[i * 4], v = seed[i * 4 + 1], ph = seed[i * 4 + 2], sz = seed[i * 4 + 3];
      const f = (ph + (t * speed) / H) % 1; // fraction of the way down
      const z = H * (1 - f);
      const fallen = H - z;
      let ox = (u * 2 - 1) * R + wx * fallen, oy = (v * 2 - 1) * R + wy * fallen;
      if (snow) { ox += Math.sin(t * 1.4 + ph * 50) * (4 + 6 * sz); oy += Math.cos(t * 1.1 + ph * 37) * (4 + 6 * sz); }
      ox = wrap(ox); oy = wrap(oy);
      const lon = center[0] + ox * kx, lat = center[1] + oy * ky;
      src[i * 3] = lon; src[i * 3 + 1] = lat; src[i * 3 + 2] = z;
      rgba[i * 4] = base[0]; rgba[i * 4 + 1] = base[1]; rgba[i * 4 + 2] = base[2];
      rgba[i * 4 + 3] = snow ? 120 + 110 * sz : 35 + 120 * sz * (0.55 + 0.45 * inten);
      if (snow) { this.rad[i] = 1.1 + 1.7 * sz; continue; }
      // the streak trails back up the fall line, into the wind
      const L = len * (0.6 + 0.8 * sz);
      dst[i * 3] = lon - wx * L * kx; dst[i * 3 + 1] = lat - wy * L * ky; dst[i * 3 + 2] = z + L;
    }
    const over = beforeId ? { beforeId } : {};
    if (snow) {
      return [
        new ScatterplotLayer({
          id: "weather-snow",
          data: { length: count, attributes: { getPosition: { value: src, size: 3 }, getRadius: { value: this.rad, size: 1 }, getFillColor: { value: rgba, size: 4 } } },
          radiusUnits: "pixels",
          stroked: false,
          pickable: false,
          ...over,
        }),
      ];
    }
    return [
      new LineLayer({
        id: "weather-rain",
        data: { length: count, attributes: { getSourcePosition: { value: src, size: 3 }, getTargetPosition: { value: dst, size: 3 }, getColor: { value: rgba, size: 4 } } },
        getWidth: 1,
        widthUnits: "pixels",
        pickable: false,
        ...over,
      }),
    ];
  }
}

// ---- haze over the city --------------------------------------------------------------------
/**
 * MapLibre sky / fog for the map view, in the map's own dark palette: fog, rain and snow
 * pull a haze over the far towers; a clear night leaves the map as it was (null).
 */
export function citySky(weather, sun) {
  const w = weather;
  if (!w || w.kind === "unknown") return null;
  const inten = w.intensity || 0.5;
  const foggy = w.kind === "fog" ? 1 : w.kind === "snow" ? 0.7 : w.kind === "rain" || w.kind === "storm" ? 0.35 + 0.35 * inten : w.kind === "overcast" ? 0.22 : 0;
  if (foggy < 0.2) return null;
  const day = clamp((sun.elevation + 6) / 12, 0, 1);
  const fogN = w.kind === "fog" ? [30, 34, 46] : w.kind === "snow" ? [34, 38, 50] : [18, 22, 32];
  const fogD = w.kind === "fog" ? [96, 104, 122] : w.kind === "snow" ? [120, 128, 144] : [58, 66, 84];
  const fog = mix(fogN, fogD, day);
  const sky = mix([7, 9, 15], mix([34, 40, 56], fog, 0.5), day);
  return {
    "sky-color": hex(sky),
    "horizon-color": hex(fog),
    "fog-color": hex(fog),
    "fog-ground-blend": 0.3 + 0.55 * foggy,
    "horizon-fog-blend": 0.7 + 0.3 * foggy,
    "sky-horizon-blend": 0.9 - 0.3 * foggy,
    "atmosphere-blend": 0.2 + 0.6 * foggy,
  };
}

// ---- lightning -----------------------------------------------------------------------------
/** Flashes a full-screen element now and then while a storm is on. */
export class Lightning {
  constructor(el) {
    this.el = el;
    this.next = 4 + Math.random() * 8;
    this.seq = null;
    this.on = false;
  }
  tick(dt, active) {
    if (!active) { if (this.on) { this.el.style.opacity = "0"; this.on = false; this.seq = null; } return; }
    this.next -= dt;
    if (this.next <= 0 && !this.seq) {
      // a stroke: a hard flash, a gap, a softer return stroke - then quiet for a while
      const big = Math.random() < 0.35;
      this.seq = big ? [[0.05, 0.75], [0.07, 0.05], [0.06, 0.45], [0.3, 0]] : [[0.05, 0.35], [0.08, 0], [0.04, 0.2], [0.25, 0]];
      this.next = 7 + Math.random() * 22;
    }
    if (this.seq) {
      const step = this.seq[0];
      this.el.style.opacity = String(step[1]);
      this.on = true;
      step[0] -= dt;
      if (step[0] <= 0) { this.seq.shift(); if (!this.seq.length) { this.seq = null; this.el.style.opacity = "0"; this.on = false; } }
    }
  }
}

// ---- the card in the panel -------------------------------------------------------------------
const S = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const CLOUD = `<path ${S} d="M16 35h18a7 7 0 0 0 .8-13.95A10 10 0 0 0 15.6 24 5.5 5.5 0 0 0 16 35z"/>`;
const CLOUD_HI = `<path ${S} d="M16 31h18a7 7 0 0 0 .8-13.95A10 10 0 0 0 15.6 20 5.5 5.5 0 0 0 16 31z"/>`;
const SUN = (cx, cy, r) => `<circle ${S} cx="${cx}" cy="${cy}" r="${r}"/>` + [0, 45, 90, 135, 180, 225, 270, 315].map((a) => { const c = Math.cos(a * rad), s = Math.sin(a * rad); return `<path ${S} d="M${(cx + c * (r + 3.5)).toFixed(1)} ${(cy + s * (r + 3.5)).toFixed(1)}L${(cx + c * (r + 7)).toFixed(1)} ${(cy + s * (r + 7)).toFixed(1)}"/>`; }).join("");
const MOON = (cx, cy, r) => `<path ${S} d="M${cx + r * 0.2} ${cy - r}a${r} ${r} 0 1 0 ${r * 0.8} ${r * 1.75}a${r * 0.85} ${r * 0.85} 0 0 1-${r * 0.8}-${r * 1.75}z"/>`;
const RAIN = `<path ${S} d="M19 39l-2.2 5M26 39l-2.2 5M33 39l-2.2 5"/>`;
const SNOW = `<circle cx="18" cy="41" r="1.7" fill="currentColor"/><circle cx="25" cy="44" r="1.7" fill="currentColor"/><circle cx="32" cy="41" r="1.7" fill="currentColor"/>`;
const FOG = `<path ${S} d="M12 40h24M17 45h16"/>`;
const BOLT = `<path d="M27 33l-5 9h5l-3 8 8-11h-5l3-6z" fill="currentColor"/>`;

/** An inline SVG icon for the condition; the sky's `night` flips sun for moon. */
export function weatherIcon(w, night) {
  const kind = w?.kind || "unknown";
  let body = "", cls = kind;
  const star = night ? MOON(24, 24, 9) : SUN(24, 24, 8);
  const smallStar = night ? MOON(16, 16, 5.5) : SUN(17, 16, 5);
  switch (kind) {
    case "clear": body = star; cls = night ? "night" : "clear"; break;
    case "clouds": body = smallStar + CLOUD; break;
    case "overcast": body = CLOUD; break;
    case "fog": body = CLOUD_HI + FOG; break;
    case "rain": body = CLOUD_HI + RAIN; break;
    case "snow": body = CLOUD_HI + SNOW; break;
    case "storm": body = CLOUD_HI + BOLT; break;
    default: body = CLOUD; cls = "unknown";
  }
  return `<svg class="wx-svg ${cls}" viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">${body}</svg>`;
}

// points down (south) unrotated, so rotating it by the direction the wind blows *from* makes it point where the wind goes
const ARROW = `<svg class="wx-arrow" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2v12M3.5 9.5L8 14l4.5-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Fill the weather card. `sun` is { elevation } for day / night. */
export function renderWeatherCard(el, w, sun) {
  if (!el) return;
  if (!w || w.kind === "unknown" || w.temp_c == null) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const night = (sun?.elevation ?? 10) < -2;
  const f = Math.round(w.temp_c * 9 / 5 + 32);
  let desc = (w.description || w.kind).trim();
  desc = desc.charAt(0).toUpperCase() + desc.slice(1);
  const bits = [];
  if (w.wind_kmh != null) {
    const mph = w.wind_kmh / 1.609;
    if (mph < 1.5) bits.push(`<span class="wx-wind"><span class="wx-calm">○</span> calm</span>`);
    else bits.push(`<span class="wx-wind" title="wind from the ${compass(w.wind_dir ?? 0)}"><span class="wx-arrow-wrap" style="transform:rotate(${(w.wind_dir ?? 0) % 360}deg)">${ARROW}</span> ${Math.round(mph)} mph ${w.wind_dir != null ? compass(w.wind_dir) : ""}</span>`);
  }
  if (w.humidity != null) bits.push(`${Math.round(w.humidity)}% humidity`);
  if (w.visibility_m != null) { const mi = w.visibility_m / 1609.34; bits.push(`${mi >= 9.9 ? "10+" : mi >= 3 ? mi.toFixed(0) : mi.toFixed(1)} mi visibility`); }
  const when = w.observed ? new Date(w.observed).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  const where = STATIONS[w.station] || w.station || "NWS";
  el.innerHTML = `
    <div class="wx-icon">${weatherIcon(w, night)}</div>
    <div class="wx-main">
      <div class="wx-temp">${f}<span class="wx-unit">°F</span></div>
      <div class="wx-desc">${desc}</div>
    </div>
    <div class="wx-side">
      <div class="wx-bits">${bits.map((b) => `<span class="wx-bit">${b}</span>`).join('<span class="wx-dot">·</span>')}</div>
      <div class="wx-src">${where}${when ? ` · ${when}` : ""} · <abbr title="National Weather Service">NWS</abbr></div>
    </div>`;
  el.dataset.kind = w.kind;
}

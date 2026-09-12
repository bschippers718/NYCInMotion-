// Camera presets and the slow cinematic orbit.

export const VIEWS = {
  midtown: { center: [-73.9855, 40.7535], zoom: 14.6, pitch: 62, bearing: -28 },
  downtown: { center: [-74.008, 40.7105], zoom: 14.7, pitch: 64, bearing: 22 },
  bridges: { center: [-73.9915, 40.7075], zoom: 14.1, pitch: 66, bearing: 118 },
  queens: { center: [-73.9135, 40.7485], zoom: 14.5, pitch: 63, bearing: -62 },
  city: { center: [-73.94, 40.72], zoom: 11.4, pitch: 52, bearing: -12 },
  airspace: { center: [-73.83, 40.66], zoom: 11.6, pitch: 74, bearing: -48 },
};

export class Orbit {
  constructor(map) {
    this.map = map;
    this.on = false;
    this.lastT = 0;
    this.degPerSec = 1.6;
    this.paused = false;
    this._resume = null;
    for (const ev of ["mousedown", "touchstart", "wheel"]) {
      map.getCanvas().addEventListener(ev, () => this.pause(), { passive: true });
    }
  }
  pause() {
    if (!this.on) return;
    this.paused = true;
    clearTimeout(this._resume);
    this._resume = setTimeout(() => (this.paused = false), 6000); // resume after the user lets go
  }
  set(on) {
    this.on = on;
    this.paused = false;
    this.lastT = 0;
  }
  /** Call once per frame with performance.now(). */
  tick(nowMs) {
    if (!this.on || this.paused) { this.lastT = nowMs; return; }
    const dt = this.lastT ? Math.min(0.1, (nowMs - this.lastT) / 1000) : 0;
    this.lastT = nowMs;
    if (!dt) return;
    const m = this.map;
    const bearing = m.getBearing() + this.degPerSec * dt;
    // a gentle breathing pitch keeps the orbit from feeling mechanical
    const pitch = 58 + 6 * Math.sin(nowMs / 23000);
    m.jumpTo({ bearing, pitch });
  }
}

// ---- follow: ride along behind a moving thing --------------------------------------------
// The map centres a little ahead of the vehicle, turns to face the way it is heading and
// keeps up with it every frame. Zoom and pitch are eased to a sensible framing once, then
// left to the user (wheel zoom keeps following); dragging the map lets go.

const M_PER_DEG_LAT = 111000, M_PER_DEG_LON = 84300;
const CENTER_TAU = 0.25, BEARING_TAU = 1.1, FRAME_TAU = 0.6; // s
const wrap180 = (d) => ((d + 540) % 360) - 180;

export class Follow {
  /**
   * @param map MapLibre map
   * @param onChange (follow) => void, called when following starts / stops
   */
  constructor(map, onChange) {
    this.map = map;
    this.onChange = onChange;
    this.get = null; // () => { pos: [lon, lat, z], bearing, label } | null
    this.kind = null;
    this.id = null;
    this.settle = 0; // seconds left of easing zoom / pitch to the framing
    this.frame = null; // { zoom, pitch, leadM }
    this.bearing = null;
    this.center = null;
    // jumpTo() every frame resets MapLibre's gesture handlers, so `dragstart` never fires while
    // following; watch the pointer ourselves and let go once a press turns into a drag.
    const canvas = map.getCanvas();
    let down = null;
    const at = (e) => (e.touches ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY]);
    const press = (e) => { down = at(e); };
    const move = (e) => {
      if (!down || !this.get) return;
      const [x, y] = at(e);
      if (Math.hypot(x - down[0], y - down[1]) > 5) { down = null; this.stop("released"); }
    };
    const lift = () => { down = null; };
    canvas.addEventListener("mousedown", press);
    canvas.addEventListener("touchstart", press, { passive: true });
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("mouseup", lift);
    window.addEventListener("touchend", lift);
  }
  get active() { return !!this.get; }

  /** Follow whatever `get` returns each frame; `frame` = { zoom, pitch, leadM } for the initial framing. */
  start(kind, id, get, frame) {
    const same = this.kind === kind && this.id === id;
    this.kind = kind; this.id = id; this.get = get; this.frame = frame;
    if (!same) {
      this.settle = 2.2;
      this.bearing = this.map.getBearing();
      const c = this.map.getCenter();
      this.center = [c.lng, c.lat];
    }
    this.onChange?.(this);
  }
  stop(reason = "") {
    if (!this.get) return;
    this.get = null; this.kind = null; this.id = null; this.frame = null;
    this.reason = reason;
    this.onChange?.(this);
  }
  /** Current target, for the HUD. */
  target() { return this.get ? this.get() : null; }

  /** Once per frame, after the trackers have moved. dt in seconds. */
  tick(dt) {
    if (!this.get) return;
    const t = this.get();
    if (!t) { this.stop("gone"); return; }
    dt = Math.min(0.1, Math.max(0, dt));
    const m = this.map;
    const bearing = t.bearing ?? this.bearing ?? m.getBearing();
    this.bearing += wrap180(bearing - this.bearing) * (1 - Math.exp(-dt / BEARING_TAU));
    // look ahead of the vehicle: the lead shrinks/grows with the user's zoom so the framing holds
    const zoomNow = m.getZoom();
    const lead = (this.frame?.leadM || 0) * Math.pow(2, (this.frame?.zoom ?? zoomNow) - zoomNow);
    const th = (this.bearing * Math.PI) / 180;
    const target = [t.pos[0] + (Math.sin(th) * lead) / M_PER_DEG_LON, t.pos[1] + (Math.cos(th) * lead) / M_PER_DEG_LAT];
    const k = 1 - Math.exp(-dt / CENTER_TAU);
    this.center = [this.center[0] + (target[0] - this.center[0]) * k, this.center[1] + (target[1] - this.center[1]) * k];
    const opts = { center: this.center, bearing: this.bearing };
    if (this.settle > 0 && this.frame) {
      const f = 1 - Math.exp(-dt / FRAME_TAU);
      opts.zoom = zoomNow + (this.frame.zoom - zoomNow) * f;
      opts.pitch = m.getPitch() + (this.frame.pitch - m.getPitch()) * f;
      this.settle -= dt;
    }
    m.jumpTo(opts);
  }
}

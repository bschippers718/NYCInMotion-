// Cab audio, synthesised in the browser (no samples to license):
//   - rolling noise: brown noise through a low-pass, louder and brighter with speed
//   - rail joints: a click per 11.9 m rail length (39 ft, the New York standard) for each
//     of the two trucks under the cab, so the clatter rate is a real function of speed
//   - traction whine: the inverter tone of an R160-style car, pitch rising with speed
//   - wind: band-passed noise that opens up on the bridge, 40 m over the river
//   - tunnel: the mix gets darker and a slap echo comes in underground
//   - door chime and station announcements (SpeechSynthesis) on live rides
// Browsers only allow audio after a user gesture, so `enable()` must be called from a click.

const RAIL_M = 11.9;
const TRUCK_GAP_M = 12.6; // between the two trucks of a 60 ft car
const STORE_KEY = "nyc.sound";

function noiseBuffer(ctx, seconds = 2) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02; // brown-ish
    d[i] = last * 3.5;
  }
  return buf;
}

export class CabAudio {
  constructor() {
    this.ctx = null;
    this.wanted = localStorage.getItem(STORE_KEY) !== "off";
    this.nodes = null;
    this.railPhase = 0; // metres since the last joint under the lead truck
    this.lastStop = null;
    this.wasStopped = null;
    this.onChange = null;
  }
  get on() { return this.wanted && !!this.ctx; }

  /** Call from a user gesture. */
  enable() {
    this.wanted = true;
    localStorage.setItem(STORE_KEY, "on");
    if (!this.ctx) this._build();
    this.ctx.resume?.();
    this.nodes.master.gain.setTargetAtTime(1, this.ctx.currentTime, 0.4);
    this.onChange?.(this);
  }
  disable() {
    this.wanted = false;
    localStorage.setItem(STORE_KEY, "off");
    if (this.ctx) this.nodes.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    window.speechSynthesis?.cancel?.();
    this.onChange?.(this);
  }
  toggle() { this.on ? this.disable() : this.enable(); }
  /** Try to start if the user previously left sound on (works only inside a gesture handler). */
  tryResume() { if (this.wanted) this.enable(); }
  /** Fade out when the ride ends; the graph stays for next time. */
  quiet() {
    if (!this.ctx) return;
    this.nodes.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    window.speechSynthesis?.cancel?.();
    this.lastStop = null; this.wasStopped = null;
  }

  _build() {
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const master = ctx.createGain(); master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    const noise = noiseBuffer(ctx);
    const src = (loop = true) => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = loop; s.start(); return s; };

    // rolling
    const rollLP = ctx.createBiquadFilter(); rollLP.type = "lowpass"; rollLP.frequency.value = 300;
    const roll = ctx.createGain(); roll.gain.value = 0;
    src().connect(rollLP).connect(roll).connect(master);
    // wind
    const windBP = ctx.createBiquadFilter(); windBP.type = "bandpass"; windBP.frequency.value = 900; windBP.Q.value = 0.6;
    const wind = ctx.createGain(); wind.gain.value = 0;
    src().connect(windBP).connect(wind).connect(master);
    // traction whine: two detuned oscillators through a gentle low-pass
    const whineLP = ctx.createBiquadFilter(); whineLP.type = "lowpass"; whineLP.frequency.value = 1800;
    const whine = ctx.createGain(); whine.gain.value = 0;
    const osc1 = ctx.createOscillator(); osc1.type = "sawtooth"; osc1.frequency.value = 120;
    const osc2 = ctx.createOscillator(); osc2.type = "sine"; osc2.frequency.value = 240;
    osc1.connect(whineLP); osc2.connect(whineLP); whineLP.connect(whine).connect(master);
    osc1.start(); osc2.start();
    // tunnel slap echo, fed from the rolling noise and the clicks
    const echo = ctx.createDelay(0.5); echo.delayTime.value = 0.11;
    const echoGain = ctx.createGain(); echoGain.gain.value = 0;
    const echoFb = ctx.createGain(); echoFb.gain.value = 0.35;
    const echoLP = ctx.createBiquadFilter(); echoLP.type = "lowpass"; echoLP.frequency.value = 900;
    echo.connect(echoLP).connect(echoFb).connect(echo);
    echo.connect(echoGain).connect(master);
    roll.connect(echo);
    // click bus (rail joints)
    const clickBus = ctx.createGain(); clickBus.gain.value = 1;
    const clickBP = ctx.createBiquadFilter(); clickBP.type = "bandpass"; clickBP.frequency.value = 1400; clickBP.Q.value = 1.2;
    clickBus.connect(clickBP).connect(master);
    clickBP.connect(echo);
    this.nodes = { master, roll, rollLP, wind, windBP, whine, osc1, osc2, echoGain, clickBus, noise };
  }

  _click(when, gain) {
    const ctx = this.ctx, n = this.nodes;
    const s = ctx.createBufferSource(); s.buffer = n.noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
    s.connect(g).connect(n.clickBus);
    s.start(when, Math.random() * 1.5, 0.08);
  }

  /** Two-tone door chime (descending, like the R142/R160 cars). */
  chime() {
    if (!this.on) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [f, at] of [[659.3, 0], [523.3, 0.42]]) {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(0.25, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + at + 0.9);
      o.connect(g).connect(this.nodes.master);
      o.start(t + at); o.stop(t + at + 1);
    }
  }

  announce(text) {
    if (!this.on || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.98; u.pitch = 0.9; u.volume = 0.9;
    const v = speechSynthesis.getVoices().find((x) => /en-US/i.test(x.lang) && /Samantha|Google US|Aria|Jenny/i.test(x.name)) || speechSynthesis.getVoices().find((x) => /en-US/i.test(x.lang));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  /**
   * Once per frame while riding.
   * @param s { speed (m/s), z (m), onBridge, dt (s), live, stopped, nextStop, route, dirWord }
   */
  update(s) {
    if (!this.on) return;
    const ctx = this.ctx, n = this.nodes, t = ctx.currentTime;
    const v = Math.max(0, s.speed || 0);
    const k = Math.min(1, v / 18);
    const under = s.z < -1;
    const set = (param, value, tau = 0.15) => param.setTargetAtTime(value, t, tau);
    set(n.roll.gain, 0.05 + 0.55 * k);
    set(n.rollLP.frequency, 220 + 900 * k + (under ? -80 : 0), 0.3);
    set(n.wind.gain, (s.onBridge ? 0.5 : under ? 0.02 : 0.12) * k * k, 0.5);
    set(n.windBP.frequency, 600 + 700 * k, 0.5);
    set(n.whine.gain, v > 0.5 ? 0.035 + 0.05 * k : 0, 0.25);
    set(n.osc1.frequency, 110 + 190 * k, 0.2);
    set(n.osc2.frequency, 2 * (110 + 190 * k) + 3, 0.2);
    set(n.echoGain.gain, under ? 0.45 : 0.04, 0.6);
    // rail joints: schedule clicks for the distance covered this frame
    if (v > 0.3) {
      const dist = v * s.dt;
      let phase = this.railPhase;
      let travelled = 0;
      while (phase + (dist - travelled) >= RAIL_M) {
        const toJoint = RAIL_M - phase;
        travelled += toJoint;
        phase = 0;
        const when = t + travelled / v;
        const g = 0.25 + 0.5 * k;
        this._click(when, g);
        this._click(when + TRUCK_GAP_M / v, g * 0.8);
      }
      this.railPhase = phase + (dist - travelled);
    }
    // doors + announcements on live rides
    if (s.live) {
      if (this.wasStopped === true && !s.stopped) this.chime();
      if (this.wasStopped === true && !s.stopped && s.nextStop) {
        this.announce(`This is a ${s.dirWord || ""} ${s.route} train. The next stop is ${s.nextStop.replace(/-/g, " ")}.`);
      } else if (s.nextStop && s.nextStop !== this.lastStop && this.lastStop != null && !s.stopped) {
        this.announce(`The next stop is ${s.nextStop.replace(/-/g, " ")}.`);
      }
      this.lastStop = s.nextStop || this.lastStop;
      this.wasStopped = !!s.stopped;
    }
  }
}

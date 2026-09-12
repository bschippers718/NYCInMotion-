// Live camera viewer: click a camera pin and watch it here.
//
//   The cameras are ten hand-picked NYSDOT highway cameras (via 511NY) with live HLS video,
//   played natively where the browser can (Safari) or with hls.js, loaded on first use.
//   Under the picture: what the camera looks at, and the other picks as a list to step through.

import { M_PER_DEG_LAT, M_PER_DEG_LON } from "./geo.js";
import { esc } from "./ui.js";

const HLS_URL = "https://unpkg.com/hls.js@1/dist/hls.mjs";

export const CAM_COLOR = [255, 96, 96];

export const distM = (a, b) => Math.hypot((a.lon - b.lon) * M_PER_DEG_LON, (a.lat - b.lat) * M_PER_DEG_LAT);
export const fmtDist = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

export class CameraViewer {
  constructor(el, { onOpen, onClose } = {}) {
    this.el = el;
    this.video = el.querySelector("video");
    this.hint = el.querySelector(".cv-hint");
    this.name = el.querySelector(".cv-name");
    this.sub = el.querySelector(".cv-sub");
    this.view = el.querySelector(".cv-view");
    this.cap = el.querySelector(".cv-cap");
    this.link = el.querySelector("a.cv-link");
    this.othersEl = el.querySelector(".cv-others");
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.cameras = [];
    this.cam = null;
    this.hls = null;
    this.tickTimer = null;
    this.playingSince = 0;
    el.querySelector(".cv-close").addEventListener("click", () => this.close());
    this.video.addEventListener("playing", () => {
      this.playingSince ||= performance.now();
      this.hint.classList.add("hidden");
      this.video.classList.remove("dim");
      this.renderCaption();
    });
    this.video.addEventListener("waiting", () => this.renderCaption());
  }

  setCameras(list) { this.cameras = list; if (this.cam) this.renderOthers(); }

  open(cam, opts = {}) {
    if (!cam) return;
    this.stopMedia();
    this.cam = cam;
    this.el.classList.remove("hidden");
    this.name.textContent = cam.title || cam.name;
    this.sub.textContent = [cam.road, cam.direction, cam.area].filter(Boolean).join(" · ");
    this.view.textContent = cam.view || "";
    this.link.href = cam.link || "#";
    this.startVideo(cam);
    this.renderOthers();
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.renderCaption(), 1000);
    this.renderCaption();
    this.onOpen?.(cam, opts);
  }

  close() {
    if (!this.cam) return;
    this.stopMedia();
    clearInterval(this.tickTimer); this.tickTimer = null;
    this.cam = null;
    this.el.classList.add("hidden");
    this.othersEl.innerHTML = "";
    this.onClose?.();
  }

  // ---- video -----------------------------------------------------------------------
  async startVideo(cam) {
    this.playingSince = 0;
    this.video.classList.add("dim");
    this.hint.textContent = "connecting to the stream…";
    this.hint.classList.remove("hidden");
    const v = this.video;
    if (v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = cam.video;
      v.play().catch(() => {});
      return;
    }
    try {
      this.Hls ||= (await import(HLS_URL)).default;
    } catch (e) {
      this.hint.textContent = "video player failed to load";
      return;
    }
    if (this.cam !== cam) return;
    if (!this.Hls.isSupported()) { this.hint.textContent = "this browser cannot play the stream"; return; }
    const hls = new this.Hls({ liveDurationInfinity: true, lowLatencyMode: false, maxBufferLength: 10, enableWorker: true });
    this.hls = hls;
    hls.on(this.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || this.cam !== cam) return;
      this.hint.textContent = "stream unavailable right now";
      this.hint.classList.remove("hidden");
      v.classList.add("dim");
    });
    hls.loadSource(cam.video);
    hls.attachMedia(v);
    hls.on(this.Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
  }

  stopMedia() {
    if (this.hls) { try { this.hls.destroy(); } catch (_) { /* already gone */ } this.hls = null; }
    if (this.video.src) { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); }
  }

  // ---- caption / the other picks -------------------------------------------------------
  renderCaption() {
    if (!this.cam) return;
    const v = this.video;
    const res = v.videoWidth ? ` · ${v.videoWidth}×${v.videoHeight}` : "";
    const state = !this.playingSince ? "connecting" : v.readyState < 3 ? "buffering" : "live video";
    this.cap.textContent = `${this.cam.source}${res} · ${state}`;
    this.el.classList.toggle("stale", state !== "live video");
  }

  renderOthers() {
    const cam = this.cam;
    const others = this.cameras
      .filter((c) => c.id !== cam.id)
      .map((c) => ({ c, d: distM(c, cam) }))
      .sort((a, b) => a.d - b.d);
    this.othersEl.innerHTML = others
      .map(({ c, d }) => `<button class="cv-other" data-id="${esc(c.id)}" title="${esc(c.view || "")}"><span class="cv-play">▶</span><span class="cv-other-name">${esc(c.title || c.name)}</span><span class="cv-other-d">${esc(c.area)} · ${fmtDist(d)}</span></button>`)
      .join("");
    this.othersEl.querySelectorAll(".cv-other").forEach((b) => b.addEventListener("click", () => {
      const c = this.cameras.find((x) => x.id === b.dataset.id);
      if (c) this.open(c, { nearby: true });
    }));
  }
}

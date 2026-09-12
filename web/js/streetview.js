// Street-level photo beside the followed vehicle (Mapillary, via /api/streetview).
// Re-queries when the vehicle has moved ~35 m or 5 s have passed; crossfades images.

import { getJSON } from "./api.js";
import { M_PER_DEG_LAT, M_PER_DEG_LON } from "./geo.js";

export const KEYS = {
  get mapillary() { return localStorage.getItem("nyc.keys.mapillary") || ""; },
  set mapillary(v) { v ? localStorage.setItem("nyc.keys.mapillary", v.trim()) : localStorage.removeItem("nyc.keys.mapillary"); },
  get google() { return localStorage.getItem("nyc.keys.google") || ""; },
  set google(v) { v ? localStorage.setItem("nyc.keys.google", v.trim()) : localStorage.removeItem("nyc.keys.google"); },
};

export class StreetView {
  constructor(el) {
    this.el = el;
    this.img = el.querySelector("img");
    this.cap = el.querySelector(".sv-cap");
    this.hint = el.querySelector(".sv-hint");
    this.link = el.querySelector("a.sv-link");
    this.last = null; // { pos, t }
    this.current = null;
    this.busy = false;
    this.serverHasToken = false;
    this.available = null; // null unknown, false no token, true ok
  }

  hide() { this.el.classList.add("hidden"); this.last = null; }

  /** Call every frame while following; cheap unless a query is due. */
  update(pos, heading, label) {
    if (!pos) return this.hide();
    this.el.classList.remove("hidden");
    const now = performance.now();
    if (this.last) {
      const moved = Math.hypot((pos[0] - this.last.pos[0]) * M_PER_DEG_LON, (pos[1] - this.last.pos[1]) * M_PER_DEG_LAT);
      if (moved < 35 && now - this.last.t < 5000) return;
    }
    if (this.busy) return;
    this.last = { pos: pos.slice(0, 2), t: now };
    this.busy = true;
    const q = new URLSearchParams({ lon: pos[0].toFixed(6), lat: pos[1].toFixed(6) });
    if (heading != null) q.set("heading", heading.toFixed(0));
    if (KEYS.mapillary) q.set("token", KEYS.mapillary);
    getJSON(`/api/streetview?${q}`)
      .then((r) => {
        this.available = r.available;
        if (!r.available) { this.hint.textContent = r.reason || "street photos unavailable"; this.hint.classList.remove("hidden"); this.img.classList.add("dim"); return; }
        this.hint.classList.add("hidden");
        if (!r.image) { this.cap.textContent = `${label || ""} · no Mapillary coverage right here`; this.img.classList.add("dim"); return; }
        if (this.current?.id !== r.image.id) {
          this.current = r.image;
          const im = new Image();
          im.onload = () => {
            this.img.src = r.image.url;
            this.img.classList.remove("dim");
            this.img.classList.toggle("pano", !!r.image.pano);
            if (r.image.pano) {
              // equirectangular: x = 0.5 is the camera's compass heading; show a 120° window facing the vehicle's heading
              const delta = (heading ?? r.image.heading ?? 0) - (r.image.heading ?? 0);
              const x = Math.min(5 / 6, Math.max(1 / 6, (((delta % 360) + 540) % 360) / 360)); // keep the window inside the strip
              this.img.style.left = `calc(50% - ${(x * 300).toFixed(1)}%)`;
            } else this.img.style.left = "0";
          };
          im.src = r.image.url;
          const when = r.image.captured_at ? new Date(r.image.captured_at).toLocaleDateString(undefined, { year: "numeric", month: "short" }) : "";
          this.cap.textContent = `${label || ""} · Mapillary${when ? ` · ${when}` : ""}${r.image.pano ? " · 360°" : ""}${r.demo ? " · demo token" : ""}`;
          this.link.href = r.image.link;
        }
      })
      .catch(() => { this.cap.textContent = "street photo lookup failed"; })
      .finally(() => { this.busy = false; });
  }
}

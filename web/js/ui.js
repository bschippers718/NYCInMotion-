// Sidebar: layer toggles, route chips, train detail, feed status, tooltips.

import { SERVICES } from "./taxi.js";

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmtHour = (h) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
export const fmtEta = (s) => (s == null ? "" : s <= 15 ? "now" : s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);
export const fmtTime = (unix) => (unix ? new Date(unix * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
export const dirWord = (d) => (d === "N" ? "Northbound" : d === "S" ? "Southbound" : "");
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ROUTE_ORDER = ["1", "2", "3", "4", "5", "6", "6X", "7", "7X", "A", "C", "E", "B", "D", "F", "FX", "M", "G", "J", "Z", "L", "N", "Q", "R", "W", "GS", "FS", "H", "SI"];
const EXPRESS = new Set(["6X", "7X", "FX"]);

export function setLayerControl(name, on, disable = false) {
  const input = document.querySelector(`.layer[data-layer="${name}"] input`);
  if (input) { input.checked = on; input.disabled = disable; }
}

export function renderRouteChips(state, byRoute, onChange) {
  const el = $("routes");
  const ids = ROUTE_ORDER.filter((r) => state.routes[r]);
  el.innerHTML =
    ids
      .map((r) => {
        const route = state.routes[r];
        const on = !state.activeRoutes || state.activeRoutes.has(r);
        return `<span class="bullet ${EXPRESS.has(r) ? "diamond" : ""} ${on ? "on" : ""}" data-route="${r}" title="${esc(route.long_name)}" style="background:${route.color};color:${route.text_color}"><span>${esc(route.short_name)}</span><span class="n">${byRoute[r] || 0}</span></span>`;
      })
      .join("") + `<span class="all" id="routes-all">${state.activeRoutes ? "show all" : ""}</span>`;
  el.querySelectorAll(".bullet").forEach((b) =>
    b.addEventListener("click", (ev) => {
      const r = b.dataset.route;
      if (ev.shiftKey || ev.metaKey) {
        state.activeRoutes = state.activeRoutes || new Set(ids);
        state.activeRoutes.has(r) ? state.activeRoutes.delete(r) : state.activeRoutes.add(r);
        if (state.activeRoutes.size === ids.length) state.activeRoutes = null;
      } else {
        state.activeRoutes = state.activeRoutes && state.activeRoutes.size === 1 && state.activeRoutes.has(r) ? null : new Set([r]);
      }
      renderRouteChips(state, byRoute, onChange);
      onChange?.();
    })
  );
  const all = $("routes-all");
  if (all) all.addEventListener("click", () => { state.activeRoutes = null; renderRouteChips(state, byRoute, onChange); onChange?.(); });
}

export function renderDetail(state, t, onClose, onRide) {
  const el = $("detail");
  if (!t) { el.classList.add("hidden"); state.selected = null; return; }
  const route = state.routes[t.route] || {};
  el.classList.remove("hidden");
  const stops = (t.upcoming || []).map((u) => `<li><span>${esc(u.name || u.stop)}</span><span class="eta">${fmtTime(u.time)}</span></li>`).join("");
  const where = t.status === "STOPPED_AT"
    ? `Standing at <b>${esc(t.prev_stop_name)}</b>${t.dwell ? `, leaving ${fmtEta(Math.max(0, Math.round(t.dwell - Date.now() / 1000)))}` : ""}`
    : `${esc(t.prev_stop_name || "—")} → <b>${esc(t.next_stop_name)}</b>, arriving ${fmtEta(t.eta_s)}`;
  const depth = t.z == null ? "" : t.z > 2 ? `elevated, ${Math.round(t.z)} m up` : t.z < -2 ? `${Math.round(-t.z)} m below street` : "at grade";
  el.innerHTML = `
    <div class="title"><span class="bullet on ${EXPRESS.has(t.route) ? "diamond" : ""}" style="background:${route.color};color:${route.text_color}"><span>${esc(route.short_name || t.route)}</span></span><span>${dirWord(t.direction)}</span><span class="close" title="close">✕</span></div>
    <div class="kv">${where}</div>
    <div class="bar"><i style="width:${Math.round((t.progress || 0) * 100)}%;background:${route.color}"></i></div>
    <ul>${stops}</ul>
    <div class="kv">${esc(route.long_name || "")} · ${depth}<br>trip ${esc(t.trip_id)}${t.scheduled ? " · not yet departed" : ""}</div>
    ${onRide && !t.scheduled ? `<button class="ride-btn">ride in the cab →</button>` : ""}`;
  el.querySelector(".close").addEventListener("click", () => { renderDetail(state, null); onClose?.(); });
  el.querySelector(".ride-btn")?.addEventListener("click", () => onRide?.(t.id));
}

export function renderStatus(state, clock) {
  const d = state.feedInfo;
  if (!d) return;
  const parts = [`${d.count} trains`];
  if (state.busInfo && !state.busInfo.error) parts.push(`${state.busInfo.count.toLocaleString()} buses`);
  if (state.ferryInfo && !state.ferryInfo.error && state.ferryInfo.count) parts.push(`${state.ferryInfo.count} ferries`);
  if (state.airInfo && !state.airInfo.error && state.airInfo.count) parts.push(`${state.airInfo.count} aircraft`);
  if (state.flow) parts.push(`${state.flow.trips_per_hour.toLocaleString()} cab trips/h`);
  $("headline").textContent = `${parts.join(" · ")} · ${new Date(clock.now() * 1000).toLocaleTimeString()}`;
  const rows = Object.entries(d.feeds).map(([k, f]) => `<span class="${f.ok ? "" : "bad"}">${k}: ${f.ok ? `${f.trips} trips, ${f.age_s}s old` : "error"}</span>`);
  if (state.busInfo) rows.push(`<span class="${state.busInfo.error ? "bad" : ""}">Bus Time: ${state.busInfo.error ? "error" : `${state.busInfo.count} buses, ${state.busInfo.age_s}s old`}</span>`);
  if (state.ferryInfo) rows.push(`<span class="${state.ferryInfo.error ? "bad" : ""}">NYC Ferry: ${state.ferryInfo.error ? "error" : `${state.ferryInfo.count} vessels, ${state.ferryInfo.age_s}s old`}</span>`);
  if (state.airInfo) rows.push(`<span class="${state.airInfo.error ? "bad" : ""}">ADS-B (${esc(state.airInfo.source || "…")}): ${state.airInfo.error ? "error" : `${state.airInfo.count} aircraft, ${state.airInfo.age_s}s old`}</span>`);
  const w = state.weather;
  if (w) rows.push(`<span class="${w.kind === "unknown" ? "bad" : ""}">NWS weather: ${w.kind === "unknown" ? "error" : `${esc(w.station || "")}${w.observed ? `, observed ${new Date(w.observed).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`}</span>`);
  $("feeds").innerHTML = `<h2 style="grid-column:1/-1">Live feeds</h2>` + rows.join("");
}

export function renderTaxiNote(state, flow, taxi) {
  const bs = Object.entries(flow.by_service).map(([s, n]) => `${s === "yellow" ? "yellow cab" : s} ${n.toLocaleString()}`).join(" · ");
  $("n-taxi").textContent = `${flow.trips_per_hour.toLocaleString()}/h`;
  $("taxi-month").textContent = flow.month;
  const dots = taxi.trips.length ? (taxi.tripsPerDot < 1.5 ? "one dot per trip" : `each dot ≈ ${taxi.tripsPerDot.toFixed(taxi.tripsPerDot < 3 ? 1 : 0)} trips`) : "no particles";
  const hidden = (flow.same_zone_per_hour || 0) + (flow.unknown_zone_per_hour || 0);
  $("taxi-note").textContent =
    `${DOW[flow.dow]} ${fmtHour(flow.hour)}, average over ${flow.days_in_sample} such days in ${flow.month}: ${flow.trips_per_hour.toLocaleString()} trips/hour (${bs}). ` +
    `${dots}${flow.street_paths ? ", driving real street routes" : ""}` +
    (hidden ? `; ${hidden.toLocaleString()}/h not drawn (${(flow.same_zone_per_hour || 0).toLocaleString()} start and end inside one zone, ${(flow.unknown_zone_per_hour || 0).toLocaleString()} have no zone)` : "") + ".";
}

export function tooltip(state, { object, layer, index }) {
  if (layer && layer.id === "taxi-particles") object = state.taxiTrips?.[index];
  if (!object && !(layer && layer.id.startsWith("photo-"))) return null;
  const style = { background: "rgba(14,16,21,0.95)", color: "#e6e8ec", border: "1px solid rgba(255,255,255,0.16)", borderRadius: "8px", padding: "6px 9px", fontSize: "12px", lineHeight: "1.4", maxWidth: "260px" };
  let html = "";
  const id = layer.id;
  if (id === "trains") {
    const t = object.rec.data;
    const where = t.status === "STOPPED_AT" ? `at <b>${esc(t.prev_stop_name)}</b>` : `→ <b>${esc(t.next_stop_name)}</b> (${fmtEta(t.eta_s)})`;
    const depth = t.z > 2 ? "elevated" : t.z < -2 ? `${Math.round(-t.z)} m down` : "at grade";
    html = `<b>${esc(t.route)}</b> ${dirWord(t.direction)} · ${depth}<br>${where}${t.scheduled ? "<br><i>not yet departed</i>" : ""}${object.rec.held ? "<br><i>holding behind the train ahead</i>" : ""}`;
  } else if (id === "buses") {
    const b = object.v.data;
    const spd = object.v.onRoute ? `${Math.round(object.v.speed * 2.237)} mph · ` : "";
    html = `<b>${esc(b.route || "bus")}</b> · vehicle ${esc(b.id)}<br>${spd}${esc(b.status.toLowerCase().replace(/_/g, " "))}${b.occupancy ? ` · ${esc(b.occupancy)}` : ""}`;
  } else if (id === "ferries") {
    const f = object.v.data;
    html = `<b>NYC Ferry ${esc(f.route || "")}</b> ${esc(f.label || f.id)}<br>${f.speed_mps != null ? `${(f.speed_mps * 1.944).toFixed(0)} kn · ` : ""}${esc(f.status.toLowerCase().replace(/_/g, " "))}`;
  } else if (id === "aircraft") {
    const a = object.a, d = a.data;
    const ft = Math.round(a.alt * 3.281);
    const vs = d.vrate_mps ? (d.vrate_mps > 0.5 ? " ↗ climbing" : d.vrate_mps < -0.5 ? " ↘ descending" : "") : "";
    const who = [d.desc || d.type, d.operator].filter(Boolean).join(" · ");
    html = `<b>${esc(d.callsign || d.reg || d.id)}</b>${d.reg && d.callsign && d.reg !== d.callsign ? ` · ${esc(d.reg)}` : ""}<br>${esc(who)}<br>${d.on_ground ? "on the ground" : `${ft.toLocaleString()} ft (${Math.round(a.alt)} m)${vs}`}${d.speed_mps ? ` · ${Math.round(d.speed_mps * 1.944)} kn` : ""}${d.emergency ? `<br><b style="color:#ff6b6b">${esc(d.emergency)}</b>` : ""}`;
  } else if (id.startsWith("photo-")) {
    const p = layer.props.photo;
    html = `<b>${esc(p.name)}</b><br><span style="color:#8a909b">${esc([p.artist && `photo: ${p.artist}`, p.license, "Wikimedia Commons"].filter(Boolean).join(" · "))}</span>`;
  } else if (id === "stations") {
    html = `<b>${esc(object.name)}</b><br><span style="color:#8a909b">${esc(object.structure || "")}${object.z != null ? ` · ${object.z > 0 ? "+" : ""}${Math.round(object.z)} m` : ""}</span>`;
  } else if (id === "taxi-particles") {
    const z = state.zones;
    const svc = SERVICES[object.service] || "ride-hail";
    html = `<b>${esc(svc === "yellow" ? "yellow cab" : svc)}</b> trip<br>${esc(z?.[object.pu]?.zone)} → ${esc(z?.[object.do]?.zone)}<br>${Math.round(object.secs / 60)} min average · this dot stands for ${state.taxiPerDot < 1.5 ? "one trip" : `~${Math.round(state.taxiPerDot)} trips`} an hour`;
  } else if (id === "zone-columns") {
    const p = object.properties;
    html = `<b>${esc(p.zone)}</b>, ${esc(p.borough)}<br>${Math.round(p.pickups)} pickups / hour<br>${Math.round(p.dropoffs)} dropoffs / hour`;
  } else if (id === "crossings") {
    const p = object.properties;
    html = `<b>${esc(p.name || p.kind)}</b><br>${esc(p.kind)} · ${p.z > 0 ? "+" : ""}${Math.round(p.z)} m`;
  } else if (id === "cameras") {
    const c = object;
    const where = [c.road, c.direction, c.area].filter(Boolean).join(" · ");
    html = `<b>${esc(c.title || c.name)}</b>${where ? `<br>${esc(where)}` : ""}${c.view ? `<br><span style="color:#8a909b">${esc(c.view)}</span>` : ""}<br><i>click to watch live video</i>`;
  } else if (id === "complaints") {
    html = `<b>${esc(object.type)}</b>${object.descriptor && object.descriptor !== "N/A" ? ` — ${esc(object.descriptor)}` : ""}<br>${esc(object.address || "")} ${esc(object.borough || "")}<br><span style="color:#8a909b">${esc((object.created || "").replace("T", " ").slice(0, 16))} · ${esc(object.agency)}</span>`;
  }
  return html ? { html, style } : null;
}

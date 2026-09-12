// deck.gl layer assembly. Called every frame; static layers keep the same data
// references so deck.gl does not re-upload them.

import { PLANE_COLORS, PLANE_SIZE } from "./aircraft.js";
import { LOOP_SECONDS } from "./taxi.js";
import { BRIDGE_CENTRES, RIDE_SIDE_M, bridgeCables, carFootprints, structureGeometry, trackGeometry } from "./ride.js";

let CABLES = null; // built once
import { LANE_SPACING, trainLength } from "./trains.js";
import { M_PER_DEG_LAT, M_PER_DEG_LON } from "./geo.js";
import { CAM_COLOR } from "./cameras.js";

const { PathLayer, ScatterplotLayer, LineLayer, TextLayer, GeoJsonLayer, TripsLayer, PolygonLayer, SolidPolygonLayer, BitmapLayer, Tile3DLayer } = deck;
const Collision = deck.CollisionFilterExtension ? [new deck.CollisionFilterExtension()] : [];

export const EXPLODE_M = 240; // vertical separation between the layers at full "explode"
// Draw moving things and the underground on top of the buildings: at a 60° pitch
// almost every street in Midtown is hidden behind a tower otherwise.
/**
 * How far (m) a train is drawn to the right of its track centreline at this zoom: half the
 * train's on-screen outline width plus a pixel, so the two directions (and extra lanes, at
 * 2x this) never overlap on screen, capped so trains stay near their line when zoomed out.
 */
export function trainSideOffset(zoom) {
  const mpp = (156543.03 * Math.cos((40.73 * Math.PI) / 180)) / Math.pow(2, zoom);
  const outlinePx = Math.min(22, Math.max(6, 13 / mpp)); // mirrors the trains-outline layer
  return Math.min(150, ((outlinePx + 2) / 2) * mpp);
}

const XRAY = { depthCompare: "always", depthWriteEnabled: false };
const FONT = "Inter, Helvetica Neue, Arial, sans-serif";
const CROSSING_COLORS = { bridge: [255, 178, 84], tunnel: [96, 205, 255], elevated: [196, 150, 255], ramp: [180, 180, 200] };
const CAT_COLORS = [
  [/homeless|encampment/i, [255, 179, 71]],
  [/panhandl/i, [255, 107, 107]],
  [/urinat|street condition/i, [192, 132, 252]],
  [/animal/i, [74, 222, 128]],
];
const catColor = (t) => (CAT_COLORS.find(([re]) => re.test(t || "")) || [0, [229, 231, 235]])[1];

/** Split each track shape into above/below ground runs so they can be styled differently. */
export function buildTrackRuns(net, routes, hex2rgb) {
  const runs = [];
  // GTFS ships one shape per direction (and per short-turn variant) of every route; drawn
  // together they stack 4-8 translucent copies of the same track. For each route, only
  // draw the parts of a shape that run more than ~50 m from track already drawn for it.
  const covered = new Map(); // route -> Set(cell key)
  const cell = (p) => [Math.round(p[1] * 1800), Math.round(p[0] * 1500)]; // ~47 m x 74 m
  const key = (i, j) => i * 1e6 + j;
  const isCovered = (seen, [i, j]) => {
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (seen.has(key(i + di, j + dj))) return true;
    return false;
  };
  const shapes = [...net.shapes].sort((a, b) => b.points.length - a.points.length);
  for (const sh of shapes) {
    let seen = covered.get(sh.route);
    if (!seen) covered.set(sh.route, (seen = new Set()));
    const cells = sh.points.map(cell);
    const fresh = cells.map((c) => !isCovered(seen, c));
    for (const c of cells) seen.add(key(c[0], c[1]));
    // grow every fresh stretch by one point each side so joins with existing track overlap
    const draw = fresh.map((f, i) => f || fresh[i - 1] || fresh[i + 1]);
    // bridge short stale gaps (a few points) so a variant does not shatter into confetti
    for (let i = 0; i < draw.length; i++) {
      if (draw[i]) continue;
      let j = i;
      while (j < draw.length && !draw[j]) j++;
      if (i > 0 && j < draw.length && j - i <= 4) for (let k = i; k < j; k++) draw[k] = true;
      i = j;
    }
    const color = hex2rgb((routes[sh.route] || {}).color || "#808183");
    let cur = null;
    sh.points.forEach((p, i) => {
      if (!draw[i]) { cur = null; return; }
      const elevated = p[2] > 2.5;
      const pos = [p[1], p[0], p[2]];
      if (!cur || cur.elevated !== elevated) {
        if (cur) cur.path.push(pos); // share the boundary vertex
        cur = { route: sh.route, color, elevated, path: [pos] };
        runs.push(cur);
      } else cur.path.push(pos);
    });
  }
  return runs.filter((r) => r.path.length > 2);
}

/**
 * Support columns for the elevated structures: one every ~PILLAR_SPACING metres along
 * each elevated run, de-duplicated on a coarse grid so the parallel local/express
 * shapes of the same line do not each plant their own forest.
 */
const PILLAR_SPACING = 42;
export function buildPillars(runs) {
  const seen = new Set();
  const pillars = [];
  for (const r of runs) {
    if (!r.elevated) continue;
    let carry = 0;
    for (let i = 1; i < r.path.length; i++) {
      const [x0, y0, z0] = r.path[i - 1];
      const [x1, y1, z1] = r.path[i];
      const dx = (x1 - x0) * 111320 * Math.cos((y0 * Math.PI) / 180);
      const dy = (y1 - y0) * 110540;
      const seg = Math.hypot(dx, dy);
      let d = PILLAR_SPACING - carry;
      while (d <= seg && seg > 0) {
        const t = d / seg;
        const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, z = z0 + (z1 - z0) * t;
        const key = `${Math.round(x * 5000)}|${Math.round(y * 5000)}`; // ~20 m cells
        if (!seen.has(key) && z > 4) {
          seen.add(key);
          pillars.push({ base: [x, y, 0], top: [x, y, z - 0.8], route: r.route });
        }
        d += PILLAR_SPACING;
      }
      carry = seg - (d - PILLAR_SPACING);
    }
  }
  return pillars;
}

const shift = (path, dz) => (dz ? path.map((p) => [p[0], p[1], p[2] + dz]) : path);
/** Items whose position (via `pos`) lies within `radiusM` of [lon, lat]. Cached per frame by identity of `data`. */
function nearby(data, eye, radiusM, pos) {
  const r2 = radiusM * radiusM;
  const out = [];
  for (const d of data) {
    const p = pos(d);
    const dx = (p[0] - eye[0]) * 84300, dy = (p[1] - eye[1]) * 111000;
    if (dx * dx + dy * dy < r2) out.push(d);
  }
  return out;
}

export function buildLayers(ctx) {
  const { state, trains, buses, ferries, aircraft, taxi, statics, now, frame, ride } = ctx;
  const L = [];
  // Google's photogrammetry of the city (needs the user's key; drawn first so everything else sits on it)
  if (state.layers.photoreal && state.googleKey && Tile3DLayer) {
    L.push(
      new Tile3DLayer({
        id: "google-3d-tiles",
        data: `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(state.googleKey)}`,
        onTilesetLoad: (tileset) => {
          tileset.setProps?.({ maximumScreenSpaceError: ride ? 8 : 14 }); // finer tiles from the cab
          tileset.options.onTraversalComplete = (selected) => {
            const credits = new Set();
            for (const t of selected) for (const c of (t.content?.gltf?.asset?.copyright || "").split(";")) if (c.trim()) credits.add(c.trim());
            state.onTilesCredit?.(["Google", ...credits].join(" · "));
            return selected;
          };
        },
        onTileError: (tile, url, message) => { if (!state._tileErr) { state._tileErr = true; console.warn("3D tiles:", message || url); } },
        pickable: false,
        beforeId: statics.labelLayerId,
      })
    );
  }
  const subDz = -state.explode * EXPLODE_M;
  const surfDz = state.explode * EXPLODE_M;
  const zoom = state.zoom;
  const pick = { pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 90] };
  const beforeId = statics.labelLayerId;
  // from the cab everything is depth-tested like a real scene; on the map the moving things
  // and the underground are drawn through the buildings
  const over = ride ? { beforeId } : { beforeId, parameters: XRAY };
  const routeOn = (r) => !state.activeRoutes || state.activeRoutes.has(r);

  // ---- streets (wireframe of every centreline, with bridges / tunnels in 3D) ----
  const streetsAlpha = state.layers.streets ? 1 : state.explode;
  if (statics.streets && streetsAlpha > 0.02 && zoom > 10.5) {
    L.push(
      new PathLayer({
        id: "streets",
        data: statics.streets,
        _pathType: "open",
        getColor: [150, 165, 195, Math.round(70 * streetsAlpha)],
        getWidth: 3,
        widthMinPixels: 0.6,
        widthMaxPixels: 2,
        modelMatrix: surfDz ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, surfDz, 1] : null,
        beforeId,
        pickable: false,
      })
    );
  }
  if (statics.crossings && (state.layers.crossings || state.explode > 0.02)) {
    L.push(
      new GeoJsonLayer({
        ...pick,
        id: "crossings",
        data: statics.crossings,
        lineWidthUnits: "meters",
        getLineWidth: 7,
        lineWidthMinPixels: 1.2,
        lineWidthMaxPixels: 4,
        getLineColor: (f) => [...(CROSSING_COLORS[f.properties.kind] || CROSSING_COLORS.ramp), 190],
        modelMatrix: surfDz ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, surfDz, 1] : null,
        ...over,
      })
    );
  }

  // ---- subway network -------------------------------------------------------
  if (state.layers.tracks && statics.trackRuns) {
    const data = statics.trackRuns;
    const visible = (d) => routeOn(d.route);
    if (!ride) L.push(
      new PathLayer({
        id: "tracks-glow",
        data,
        getPath: (d) => shift(d.path, subDz),
        getColor: (d) => [...d.color, visible(d) ? (d.elevated ? 75 : 55) : 8],
        getWidth: (d) => (d.elevated ? 16 : 22),
        widthMinPixels: 3,
        widthMaxPixels: 13,
        capRounded: true,
        jointRounded: true,
        ...over,
        pickable: false,
        updateTriggers: { getPath: subDz, getColor: state.activeRoutes },
      })
    );
    L.push(
      new PathLayer({
        id: "tracks",
        data,
        getPath: (d) => shift(d.path, subDz),
        getColor: (d) => [...d.color, visible(d) ? (ride ? 110 : d.elevated ? 240 : 210) : 25],
        // from the cab the network is a faint thread of light between the rails; deck path
        // widths are constant on screen, so anything wider would read as a motorway
        getWidth: (d) => (d.elevated ? 4.5 : 3.5),
        widthMinPixels: ride ? 0.5 : 1.2,
        widthMaxPixels: ride ? 0.9 : 4.5,
        capRounded: true,
        jointRounded: true,
        ...over,
        pickable: false,
        updateTriggers: { getPath: subDz, getColor: [state.activeRoutes, !!ride] },
      })
    );
    if (ride) {
      // real track bed, rails and ties (polygons, true perspective) for the stretch ahead,
      // on our track and the one beside it
      const beds = [], rails = [], ties = [];
      for (const side of [RIDE_SIDE_M, -RIDE_SIDE_M]) {
        const g = trackGeometry(ride.shape, ride.dist - 80, ride.dist + 1200, side, subDz);
        if (g.bed) beds.push(g.bed);
        rails.push(...g.rails);
        ties.push(...g.ties);
      }
      const poly = { getPolygon: (d) => d, _full3d: true, beforeId, pickable: false };
      const deck3d = structureGeometry(ride.shape, ride.dist - 80, ride.dist + 1200, subDz);
      const nearBridge = BRIDGE_CENTRES.some((c) => Math.hypot((ride.eye[0] - c[0]) * M_PER_DEG_LON, (ride.eye[1] - c[1]) * M_PER_DEG_LAT) < 2500);
      if (nearBridge) {
        L.push(
          new PathLayer({
            id: "bridge-cables",
            data: (CABLES ||= bridgeCables()).cables,
            getPath: (d) => d,
            getColor: [150, 156, 172, 240],
            getWidth: 2,
            widthUnits: "pixels",
            beforeId,
            pickable: false,
          }),
          new LineLayer({
            id: "bridge-hangers",
            data: CABLES.hangers,
            getSourcePosition: (d) => d.a,
            getTargetPosition: (d) => d.b,
            getColor: [130, 136, 152, 200],
            getWidth: 1,
            widthUnits: "pixels",
            beforeId,
            pickable: false,
          })
        );
      }
      L.push(
        new SolidPolygonLayer({ id: "ride-deck", data: deck3d.deck, getFillColor: [22, 24, 30, 255], ...poly }),
        new SolidPolygonLayer({ id: "ride-bed", data: beds, getFillColor: [40, 38, 40, 255], ...poly }),
        new SolidPolygonLayer({ id: "ride-ties", data: ties, getFillColor: [78, 64, 52, 255], ...poly }),
        new SolidPolygonLayer({ id: "ride-rails", data: rails, getFillColor: [210, 214, 224, 255], ...poly }),
        new SolidPolygonLayer({
          id: "ride-posts",
          data: deck3d.posts,
          getPolygon: (d) => d.ring,
          extruded: true,
          getElevation: (d) => d.h,
          getFillColor: [96, 102, 118, 255],
          material: { ambient: 0.5, diffuse: 0.6, shininess: 20, specularColor: [40, 40, 50] },
          _full3d: true,
          beforeId,
          pickable: false,
        })
      );
    }
    if (zoom > 12.5 && !ride) {
      // shadow of elevated structures on the street below - reads as "floating above"
      L.push(
        new PathLayer({
          id: "el-shadow",
          data: statics.elevatedRuns,
          getPath: (d) => d.ground,
          getColor: [0, 0, 0, 110],
          getWidth: 12,
          widthMinPixels: 1,
          beforeId,
          pickable: false,
        })
      );
    }
    if (zoom > 13.2 && statics.pillars) {
      L.push(
        new LineLayer({
          id: "el-pillars",
          // from the cab, only pillars within a couple of km: pixel-width lines that project
          // behind the camera or past the horizon smear across the sky
          data: ride ? nearby(statics.pillars, ride.eye, 2500, (d) => d.base) : statics.pillars,
          getSourcePosition: (d) => d.base,
          getTargetPosition: (d) => d.top,
          getColor: (d) => [165, 172, 190, routeOn(d.route) ? 130 : 30],
          updateTriggers: { getColor: state.activeRoutes },
          getWidth: 1.6,
          widthUnits: "pixels",
          beforeId,
          pickable: false,
        })
      );
    }
  }
  if (state.layers.stations && statics.stations) {
    const stationData = ride ? nearby(statics.stations, ride.eye, 2500, (d) => [d.lon, d.lat]) : statics.stations;
    L.push(
      new LineLayer({
        id: "station-shafts",
        data: stationData,
        getSourcePosition: (d) => [d.lon, d.lat, d.z + subDz],
        getTargetPosition: (d) => [d.lon, d.lat, Math.max(0, d.z) + (d.z > 2 ? 0 : 0)],
        getColor: (d) => [200, 205, 215, d.z > 2 ? 40 : 70 + 60 * state.explode],
        getWidth: 1,
        widthUnits: "pixels",
        ...over,
        pickable: false,
        updateTriggers: { getSourcePosition: subDz, getColor: state.explode },
      }),
      new ScatterplotLayer({
        ...pick,
        id: "stations",
        data: statics.stations,
        getPosition: (d) => [d.lon, d.lat, d.z + subDz + 0.5],
        getRadius: 16,
        radiusMinPixels: 1.5,
        radiusMaxPixels: 5,
        getFillColor: [225, 228, 235, 230],
        stroked: false,
        ...over,
        updateTriggers: { getPosition: subDz },
      })
    );
    if (zoom >= 14.2 && state.layers.labels) {
      L.push(
        new TextLayer({
          id: "station-labels",
          data: statics.stationLabels || statics.stations,
          getPosition: (d) => [d.lon, d.lat, d.z + subDz + 2],
          getText: (d) => d.name,
          getColor: [220, 224, 232, 210],
          getSize: 11,
          getPixelOffset: [0, -12],
          fontFamily: FONT,
          fontWeight: 500,
          outlineWidth: 2,
          outlineColor: [10, 12, 16, 220],
          fontSettings: { sdf: true },
          getCollisionPriority: 0,
          collisionTestProps: { sizeScale: 2.5 },
          extensions: Collision,
          ...over,
          pickable: false,
          updateTriggers: { getPosition: subDz },
        })
      );
    }
    // real photographs of the stations, standing over their shafts like postcards, facing the camera
    if (state.layers.photos && state.photos && !ride && zoom >= 15.2 && ctx.view) {
      const { center, bearing } = ctx.view;
      const radius = 1400 * Math.pow(2, 15.5 - zoom); // tighter as you zoom in
      const cands = [];
      for (const d of statics.stations) {
        const p = state.photos[d.id];
        if (!p || !p.thumb) continue;
        const dx = (d.lon - center[0]) * M_PER_DEG_LON, dy = (d.lat - center[1]) * M_PER_DEG_LAT;
        const dist = Math.hypot(dx, dy);
        if (dist < radius) cands.push({ d, p, dist });
      }
      cands.sort((a, b) => a.dist - b.dist);
      const th = (bearing * Math.PI) / 180;
      const rx = Math.cos(th) / M_PER_DEG_LON, ry = -Math.sin(th) / M_PER_DEG_LAT; // unit "screen right" in degrees
      // sized on screen (~150 px wide) rather than in metres: these are postcards over the city, not signs
      const mpp = (156543.03 * Math.cos((center[1] * Math.PI) / 180)) / Math.pow(2, zoom);
      const W = Math.min(150, Math.max(40, 120 * mpp)), H = W * 2 / 3, LIFT = 30;
      const posts = [];
      for (const { d, p } of cands.slice(0, 12)) {
        const z0 = Math.max(0, d.z) + LIFT + subDz * (d.z < 0 ? 0 : 1);
        const bl = [d.lon - rx * W / 2, d.lat - ry * W / 2, z0];
        const br = [d.lon + rx * W / 2, d.lat + ry * W / 2, z0];
        L.push(
          new BitmapLayer({
            id: `photo-${d.id}`,
            image: p.thumb,
            bounds: [bl, [bl[0], bl[1], z0 + H], [br[0], br[1], z0 + H], br],
            opacity: 0.96,
            pickable: true,
            ...over,
            photo: p,
          })
        );
        posts.push({ a: [d.lon, d.lat, Math.max(0, d.z) + 0.5], b: [d.lon, d.lat, z0] });
      }
      if (posts.length) {
        L.push(
          new LineLayer({
            id: "photo-posts",
            data: posts,
            getSourcePosition: (d) => d.a,
            getTargetPosition: (d) => d.b,
            getColor: [200, 205, 215, 90],
            getWidth: 1,
            widthUnits: "pixels",
            ...over,
            pickable: false,
          })
        );
      }
    }
  }

  // ---- trains -------------------------------------------------------------------
  if (state.layers.trains) {
    // Close up, a train is a string of cars with a dark outline, a white headlight and
    // red tail lights, so it reads as a train rather than a brighter bit of track.
    const detail = zoom >= 12.6;
    // Trains ride on the right-hand side of their track (opposite directions never
    // overlap), a few pixels at any zoom; see TrainTracker.separate for the rest.
    // In the cab view the offsets are real track spacing, car bodies are billboarded so a
    // flat ribbon becomes a 3.4 m tall wall of train, and the train we are in is not drawn.
    const sideM = ride ? RIDE_SIDE_M : trainSideOffset(zoom);
    const bodies = [];
    const cars = [];
    const boxes = []; // ride mode: extruded car footprints
    for (const rec of trains.trains.values()) {
      if (!routeOn(rec.data.route)) continue;
      if (rec.data.scheduled && !state.layers.scheduled) continue;
      if (ride && rec.id === ride.id) continue;
      if (ride) {
        if (!rec.shape) continue;
        const dd = Math.hypot((rec.pos[0] - ride.eye[0]) * 84300, (rec.pos[1] - ride.eye[1]) * 111000);
        if (dd > 4000) continue;
        const route = rec.data.route;
        const carLen = /^[1-7]|^GS|^SI/.test(route) ? 15.5 : 18.3;
        const n = Math.max(1, Math.round((trainLength(route) + 1.4) / (carLen + 1.4)));
        const side = RIDE_SIDE_M * (1 + (rec.lane || 0) * LANE_SPACING);
        for (const ring of carFootprints(rec, side, carLen, 1.4, n, subDz)) boxes.push({ rec, ring });
        bodies.push({ rec, head: trains.headPos(rec, subDz + 1.6, sideM), tail: null });
        continue;
      }
      const path = trains.capsule(rec, subDz, sideM);
      const body = { rec, path, head: trains.headPos(rec, subDz + 0.6, sideM), tail: [...path[0].slice(0, 2), path[0][2] + 0.6] };
      bodies.push(body);
      if (detail) for (const c of trains.cars(rec, subDz, sideM)) cars.push({ rec, path: c });
    }
    const stopped = (d) => d.rec.data.status === "STOPPED_AT";
    const bodyAlpha = (d) => (d.rec.data.scheduled ? 90 : 255);
    const bodyWidth = (d) => (trainLength(d.rec.data.route) < 100 ? 7 : 9);
    if (ride) {
      L.push(
        new SolidPolygonLayer({
          ...pick,
          id: "ride-cars",
          data: boxes,
          getPolygon: (d) => d.ring,
          _full3d: true,
          extruded: true,
          getElevation: 3.6,
          getFillColor: (d) => [...d.rec.body, 255],
          material: { ambient: 0.45, diffuse: 0.7, shininess: 40, specularColor: [70, 70, 80] },
          beforeId,
          onClick: ({ object }) => object && ctx.onSelectTrain(object.rec.id),
        }),
        new ScatterplotLayer({
          id: "train-heads",
          data: bodies,
          getPosition: (d) => d.head,
          getRadius: 0.3,
          radiusMinPixels: 1.5,
          radiusMaxPixels: 40,
          getFillColor: [255, 250, 230, 255],
          stroked: false,
          beforeId,
          pickable: false,
        })
      );
    } else L.push(
      new PathLayer({
        id: "trains-glow",
        data: bodies,
        getPath: (d) => d.path,
        getColor: (d) => [...d.rec.color, d.rec.data.scheduled ? 20 : stopped(d) ? 50 : 85],
        getWidth: 30,
        widthMinPixels: 6,
        widthMaxPixels: 40,
        capRounded: true,
        jointRounded: true,
        ...over,
        pickable: false,
        parameters: XRAY,
      })
    );
    if (!ride) L.push(
      new PathLayer({
        ...pick,
        id: "trains-outline",
        data: bodies,
        getPath: (d) => d.path,
        getColor: (d) => [8, 10, 16, d.rec.data.scheduled ? 80 : 235],
        getWidth: (d) => bodyWidth(d) + 4,
        widthMinPixels: detail ? 6 : 4.5,
        widthMaxPixels: 22,
        capRounded: true,
        jointRounded: true,
        ...over,
        onClick: ({ object }) => object && ctx.onSelectTrain(object.rec.id),
      }),
      new PathLayer({
        ...pick,
        id: "trains",
        data: detail ? cars : bodies,
        getPath: (d) => d.path,
        getColor: (d) => [...d.rec.body, bodyAlpha(d)],
        getWidth: bodyWidth,
        widthMinPixels: detail ? 3.5 : 2.5,
        widthMaxPixels: 16,
        capRounded: detail ? false : true,
        jointRounded: true,
        ...over,
        onClick: ({ object }) => object && ctx.onSelectTrain(object.rec.id),
      }),
      new ScatterplotLayer({
        id: "train-heads",
        data: bodies,
        getPosition: (d) => d.head,
        getRadius: 3,
        radiusMinPixels: 1.6,
        radiusMaxPixels: 5,
        getFillColor: (d) => (stopped(d) ? [255, 255, 255, 150] : [255, 255, 255, 250]),
        stroked: false,
        ...over,
        pickable: false,
      })
    );
    if (detail && !ride) {
      L.push(
        new ScatterplotLayer({
          id: "train-tails",
          data: bodies,
          getPosition: (d) => d.tail,
          getRadius: 2,
          radiusMinPixels: 1.2,
          radiusMaxPixels: 3.5,
          getFillColor: [255, 64, 64, 230],
          stroked: false,
          ...over,
          pickable: false,
        })
      );
    }
    if (zoom >= 12.2 && state.layers.labels && !ride) {
      L.push(
        new TextLayer({
          id: "train-labels",
          data: bodies,
          getPosition: (d) => d.head,
          getText: (d) => d.rec.data.route.replace(/X$/, ""),
          getColor: (d) => d.rec.text,
          getSize: zoom >= 14 ? 12 : 10,
          getPixelOffset: [0, -13],
          fontFamily: FONT,
          fontWeight: 700,
          fontSettings: { sdf: true },
          outlineWidth: 3,
          outlineColor: (d) => [...d.rec.color, 255],
          background: false,
          ...over,
          pickable: false,
        })
      );
    }
    if (state.selected) {
      const sel = trains.get(state.selected);
      if (sel) {
        const p = trains.headPos(sel, subDz, sideM);
        L.push(
          new ScatterplotLayer({
            id: "selected-ring",
            data: [p],
            getPosition: (d) => d,
            getRadius: 26 + 6 * Math.sin(frame / 12),
            radiusUnits: "meters",
            radiusMinPixels: 14,
            stroked: true,
            filled: false,
            getLineColor: [255, 255, 255, 200],
            getLineWidth: 2,
            lineWidthUnits: "pixels",
            ...over,
            pickable: false,
          }),
          new LineLayer({
            id: "selected-beam",
            data: [p],
            getSourcePosition: (d) => d,
            getTargetPosition: (d) => [d[0], d[1], 260 + surfDz],
            getColor: [255, 255, 255, 120],
            getWidth: 1.5,
            widthUnits: "pixels",
            ...over,
            pickable: false,
          })
        );
      }
    }
  }

  // ---- buses -------------------------------------------------------------------------
  if (state.layers.busRoutes && statics.busRoutes && zoom > 11.5) {
    L.push(
      new PathLayer({
        id: "bus-routes",
        data: statics.busRoutes,
        getPath: (d) => shift(d.path, surfDz + 0.3),
        getColor: (d) => [...d.color, 55],
        getWidth: 2.5,
        widthMinPixels: 0.8,
        widthMaxPixels: 2.5,
        ...over,
        pickable: false,
        updateTriggers: { getPath: surfDz },
      })
    );
  }
  if (state.layers.buses && buses.vehicles.size) {
    const items = [];
    for (const v of buses.vehicles.values()) items.push({ v, path: buses.capsule(v, 13, surfDz + 1.2) });
    L.push(
      new PathLayer({
        ...pick,
        id: "buses",
        data: items,
        getPath: (d) => d.path,
        getColor: (d) => [...d.v.color, 245],
        getWidth: 4.2,
        widthMinPixels: 2.2,
        widthMaxPixels: 9,
        capRounded: true,
        jointRounded: true,
        ...over,
        onClick: ({ object }) => object && ctx.onFollow?.("bus", object.v.id),
      })
    );
    if (zoom >= 12) {
      L.push(
        new ScatterplotLayer({
          id: "bus-glow",
          data: items,
          getPosition: (d) => d.path[d.path.length - 1],
          getRadius: 9,
          radiusMinPixels: 3,
          radiusMaxPixels: 10,
          getFillColor: (d) => [...d.v.color, 45],
          stroked: false,
          ...over,
          pickable: false,
        })
      );
    }
    if (zoom >= 15.4 && state.layers.labels) {
      L.push(
        new TextLayer({
          id: "bus-labels",
          data: items,
          getPosition: (d) => d.path[d.path.length - 1],
          getText: (d) => d.v.data.route || "",
          getColor: [255, 255, 255, 230],
          getSize: 10,
          getPixelOffset: [0, -11],
          fontFamily: FONT,
          fontWeight: 600,
          fontSettings: { sdf: true },
          outlineWidth: 2,
          outlineColor: [0, 0, 0, 200],
          ...over,
          pickable: false,
        })
      );
    }
  }

  // ---- ferries ---------------------------------------------------------------------
  if (state.layers.ferries) {
    if (statics.ferryRoutes) {
      L.push(
        new PathLayer({
          id: "ferry-routes",
          data: statics.ferryRoutes,
          getPath: (d) => shift(d.path, surfDz + 0.2),
          getColor: (d) => [...d.color, 60],
          getWidth: 6,
          widthMinPixels: 1,
          widthMaxPixels: 3,
          getDashArray: [6, 6],
          dashJustified: true,
          extensions: deck.PathStyleExtension ? [new deck.PathStyleExtension({ dash: true })] : [],
          ...over,
          pickable: false,
          updateTriggers: { getPath: surfDz },
        })
      );
    }
    if (ferries.vehicles.size) {
      const items = [];
      for (const v of ferries.vehicles.values()) items.push({ v, path: ferries.capsule(v, 42, surfDz + 1) });
      L.push(
        new PathLayer({
          ...pick,
          id: "ferries",
          data: items,
          getPath: (d) => d.path,
          getColor: (d) => [...d.v.color, 250],
          getWidth: 11,
          widthMinPixels: 3,
          widthMaxPixels: 14,
          capRounded: true,
          jointRounded: true,
          ...over,
          onClick: ({ object }) => object && ctx.onFollow?.("ferry", object.v.id),
        }),
        new PathLayer({
          id: "ferry-wake",
          data: items,
          getPath: (d) => (d.v.onRoute && d.v.shape ? d.v.shape.slice(d.v.dist - 220, d.v.dist - 30, surfDz + 0.4) : d.path),
          getColor: [255, 255, 255, 60],
          getWidth: 18,
          widthMinPixels: 2,
          widthMaxPixels: 16,
          capRounded: true,
          ...over,
          pickable: false,
        })
      );
    }
  }

  // ---- aircraft -------------------------------------------------------------------------
  if (state.layers.aircraft && aircraft && aircraft.aircraft.size) {
    const skyDz = surfDz * 1.5; // the sky lifts a little more than the street when exploded
    // a 45 m jet is one pixel from across the city: grow the glyphs as the camera pulls back
    const gScale = Math.max(1, Math.pow(2, 13.6 - zoom));
    const items = [];
    for (const a of aircraft.aircraft.values()) {
      const g = aircraft.glyph(a, skyDz, gScale);
      items.push({ a, fuselage: g.fuselage, wings: g.wings, color: PLANE_COLORS[a.data.size] || PLANE_COLORS.small });
    }
    const bodies = items.flatMap((d) => [{ ...d, path: d.fuselage }, { ...d, path: d.wings }]);
    L.push(
      // faint vertical beam from the shadow on the ground to the aircraft: altitude, readable
      new LineLayer({
        id: "aircraft-beams",
        data: items,
        getSourcePosition: (d) => [d.a.pos[0], d.a.pos[1], skyDz],
        getTargetPosition: (d) => [d.a.pos[0], d.a.pos[1], d.a.pos[2] + skyDz],
        getColor: (d) => [...d.color, d.a.data.on_ground ? 0 : 70],
        getWidth: 1.2,
        widthUnits: "pixels",
        ...over,
        pickable: false,
      }),
      new ScatterplotLayer({
        id: "aircraft-shadows",
        data: items,
        getPosition: (d) => [d.a.pos[0], d.a.pos[1], skyDz + 0.5],
        getRadius: (d) => (PLANE_SIZE[d.a.data.size] || 24) * 0.6 * gScale,
        radiusMinPixels: 1.5,
        radiusMaxPixels: 6,
        getFillColor: (d) => [...d.color, d.a.data.on_ground ? 0 : 70],
        updateTriggers: { getRadius: gScale },
        stroked: false,
        ...over,
        pickable: false,
      }),
      new PathLayer({
        id: "aircraft-trails",
        data: items.filter((d) => d.a.trail.length > 1),
        getPath: (d) => d.a.trail,
        getColor: (d) => [...d.color, 70],
        getWidth: 6,
        widthMinPixels: 1,
        widthMaxPixels: 2.5,
        ...over,
        pickable: false,
      }),
      new PathLayer({
        id: "aircraft-glow",
        data: bodies,
        getPath: (d) => d.path,
        getColor: (d) => [...d.color, 60],
        getWidth: (d) => (PLANE_SIZE[d.a.data.size] || 24) * 0.7 * gScale,
        widthMinPixels: 6,
        widthMaxPixels: 30,
        capRounded: true,
        ...over,
        pickable: false,
        updateTriggers: { getWidth: gScale },
      }),
      new PathLayer({
        ...pick,
        id: "aircraft",
        data: bodies,
        getPath: (d) => d.path,
        getColor: (d) => [...d.color, 245],
        getWidth: (d) => (PLANE_SIZE[d.a.data.size] || 24) * 0.16 * gScale,
        widthMinPixels: 2,
        widthMaxPixels: 8,
        capRounded: true,
        ...over,
        updateTriggers: { getWidth: gScale },
        onClick: ({ object }) => object && ctx.onFollow?.("aircraft", object.a.id),
      })
    );
    if (zoom >= 10.8 && state.layers.labels) {
      // no collision extension here: its collision map never settles for data rebuilt every frame
      L.push(
        new TextLayer({
          id: "aircraft-labels",
          data: items.filter((d) => !d.a.data.on_ground && d.a.alt > 30),
          getPosition: (d) => [d.a.pos[0], d.a.pos[1], d.a.pos[2] + skyDz],
          getText: (d) => `${d.a.data.callsign || d.a.data.reg || d.a.id}  ${Math.round(d.a.alt * 3.281 / 100) * 100} ft`,
          getColor: (d) => [...d.color, 220],
          getSize: 10.5,
          getPixelOffset: [0, -14],
          fontFamily: FONT,
          fontWeight: 600,
          fontSettings: { sdf: true },
          outlineWidth: 2,
          outlineColor: [8, 10, 16, 220],
          ...over,
          pickable: false,
        })
      );
    }
  }

  // ---- taxi / ride-hail particles -----------------------------------------------------
  if (state.layers.taxi && taxi.data) {
    const t = ((now - state.taxiLoopStart) * state.taxiSpeed) % LOOP_SECONDS;
    L.push(
      new TripsLayer({
        ...pick,
        id: "taxi-particles",
        data: taxi.data, // binary attributes built in taxi.js: positions, timestamps, colours
        currentTime: t,
        trailLength: ride ? 35 : 110, // from the cab: car-sized streaks, not light trails
        fadeTrail: true,
        getWidth: ride ? 2.2 : 4.5,
        widthMinPixels: 1.4,
        widthMaxPixels: 4,
        capRounded: true,
        jointRounded: true,
        opacity: 0.9,
        modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, surfDz + 2.5, 1],
        ...over,
      })
    );
  }
  if (state.layers.columns && taxi.flow) {
    L.push(
      new GeoJsonLayer({
        ...pick,
        id: "zone-columns",
        data: { type: "FeatureCollection", features: statics.zoneColumns || [] },
        extruded: true,
        wireframe: false,
        getElevation: (f) => Math.min(f.properties.pickups, 4000) * 0.35,
        getFillColor: (f) => {
          const k = Math.min(1, f.properties.pickups / 1500);
          return [255, Math.round(220 - 160 * k), Math.round(60 - 40 * k), 70];
        },
        stroked: false,
        modelMatrix: surfDz ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, surfDz, 1] : null,
        ...over,
        updateTriggers: { getElevation: statics.zoneColumns, getFillColor: statics.zoneColumns },
      })
    );
  }

  // ---- live cameras: a red pin on a short pole at each of the ten picked NYSDOT cameras ----------
  if (state.layers.cameras && statics.cameras?.length && !ride && zoom > 9.5) {
    const CAM_H = 6; // metres up the pole
    const camColor = (d) => [...CAM_COLOR, d.id === state.camera ? 255 : 225];
    if (zoom >= 14.4) {
      L.push(
        new LineLayer({
          id: "camera-poles",
          data: statics.cameras,
          getSourcePosition: (d) => [d.lon, d.lat, surfDz],
          getTargetPosition: (d) => [d.lon, d.lat, CAM_H + surfDz],
          getColor: [190, 200, 215, 120],
          getWidth: 1,
          widthUnits: "pixels",
          ...over,
          pickable: false,
          updateTriggers: { getSourcePosition: surfDz, getTargetPosition: surfDz },
        })
      );
    }
    L.push(
      new ScatterplotLayer({
        ...pick,
        id: "cameras",
        data: statics.cameras,
        getPosition: (d) => [d.lon, d.lat, (zoom >= 14.4 ? CAM_H : 0.5) + surfDz],
        getRadius: 5,
        radiusMinPixels: 6,
        radiusMaxPixels: 9,
        getFillColor: camColor,
        stroked: true,
        getLineColor: [8, 10, 16, 220],
        lineWidthMinPixels: 1.5,
        lineWidthMaxPixels: 2,
        ...over,
        onClick: ({ object }) => object && ctx.onCamera?.(object),
        updateTriggers: { getPosition: [surfDz, zoom >= 14.4], getFillColor: state.camera },
      })
    );
    if (zoom >= 12 && state.layers.labels) {
      L.push(
        new TextLayer({
          id: "camera-labels",
          data: statics.cameras,
          getPosition: (d) => [d.lon, d.lat, CAM_H + surfDz],
          getText: (d) => d.title || d.name,
          getColor: [...CAM_COLOR, 230],
          getSize: 11,
          getPixelOffset: [0, -14],
          fontFamily: FONT,
          fontWeight: 500,
          outlineWidth: 2,
          outlineColor: [10, 12, 16, 220],
          fontSettings: { sdf: true },
          getCollisionPriority: -1,
          collisionTestProps: { sizeScale: 2.5 },
          extensions: Collision,
          ...over,
          pickable: false,
          updateTriggers: { getPosition: surfDz },
        })
      );
    }
    const sel = state.camera && statics.cameras.find((d) => d.id === state.camera);
    if (sel) {
      const p = [sel.lon, sel.lat, (zoom >= 14.4 ? CAM_H : 0.5) + surfDz];
      L.push(
        new ScatterplotLayer({
          id: "camera-selected",
          data: [p],
          getPosition: (d) => d,
          getRadius: 18 + 4 * Math.sin(frame / 12),
          radiusUnits: "meters",
          radiusMinPixels: 11,
          stroked: true,
          filled: false,
          getLineColor: [...CAM_COLOR, 220],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          ...over,
          pickable: false,
        }),
        new LineLayer({
          id: "camera-beam",
          data: [p],
          getSourcePosition: (d) => d,
          getTargetPosition: (d) => [d[0], d[1], 200 + surfDz],
          getColor: [...CAM_COLOR, 110],
          getWidth: 1.5,
          widthUnits: "pixels",
          ...over,
          pickable: false,
        })
      );
    }
  }

  // ---- 311 -----------------------------------------------------------------------------
  if (state.layers.complaints && statics.complaints?.length) {
    L.push(
      new ScatterplotLayer({
        ...pick,
        id: "complaints",
        data: statics.complaints,
        getPosition: (d) => [d.lon, d.lat, 0.5 + surfDz],
        getRadius: 14,
        radiusMinPixels: 2,
        radiusMaxPixels: 6,
        getFillColor: (d) => [...catColor(d.type), 170],
        stroked: false,
        ...over,
        updateTriggers: { getPosition: surfDz },
      })
    );
  }
  return L;
}

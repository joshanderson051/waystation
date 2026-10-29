// ============================================================
// PORT SOLACE v2 — engine/traffic.js (Engineer E)
// Ships and the people who come off them (DESIGN2.md 3.5, A6.2).
//
// Since A6 a ship is its pack render (ships/512/<id>.webp): picked by
// `${company}_${cls}`, else a class fallback, with a deterministic
// 1-in-6 "named ship" that takes one of the company's specials. Renders
// face lower-left with the nose at the left; they are never rotated,
// only mirrored when the heading's x component is positive. Width per
// class in cells; engine bloom and the trail come from the stern; nav
// lights, HOLD plate, hover ring, approach vectors and the v1 docking
// choreography stay. Textures load lazily per class on first spawn and
// the baked ships.js hull draws until then (240 ms cross-fade).
//
// People: when a ship docks a gangway is laid from the ship to the dock
// pad and 2–5 figures (crew / passengers / alien traders / security /
// officer / dockworker + loader) walk in, idle and walk back before
// departure. Tier 2 above zoom 0.9 only, pooled, capped at 24, none
// under reduced motion.
//
// A7 ("one connected station"): ships fly the grid's axes. A render can face down-left (as drawn, axis B) or
// down-right (mirrored, axis A), so every visual path runs nose first DOWN the screen along one axis: the
// berth's lane (perpendicular to the dock -> berth direction, so a docked ship lies broadside to its dock with a
// corridor gangway), approached from the far side out of deep space, left onward toward the camera. The Sim's
// straight lines in grid space only supply progress (its remaining distance is laid out upstream of the park
// point); queued ships hold above the station's far corners pointing at it. In flight a ship rides ALT px above
// its ground track with its shadow on the deck; docked it sits at deck level, depth-sorted with the modules.
//
// Ship progress comes from Sim.state.ships (cells); the engine only reads.
// Classic script: exports the global `EngineTraffic`.
// ============================================================
'use strict';

const EngineTraffic = (() => {
  const U = EngineUtil, ST = EngineStage, CAM = EngineCamera;
  const CELL = ST.CELL, TAU = U.TAU;
  const NAV_PORT = '#FF5A5A', NAV_STBD = '#5AE08A';
  const TRAIL_PTS = 12, TRAIL_STEP = 3.5, FADE_MS = 240;
  // A6 render geometry (unmirrored): nose at the lower-left, stern at the upper-right; fractions of the sprite width
  const ART_W = { courier: 0.95, freighter: 1.25, hauler: 1.45, liner: 1.7 };
  const ISO = ST.ISO;
  const PARK_OUT = 1.2;                  // docked ships park this many cells out from the dock, on the berth side
  const ALT = 0.55 * CELL, BLEND_MS = 900; // flight altitude above the ground track; glide when a plan changes mid-flight
  const CLASS_FALLBACK = { courier: 'kestrel_courier', freighter: 'halvorsen_freighter', hauler: 'halvorsen_hauler', liner: 'aurelian_liner' };
  const STERN = { x: 0.36, y: -0.27 }, NOSE = { x: -0.38, y: 0.27 };
  const AXIS = (() => { const dx = STERN.x - NOSE.x, dy = STERN.y - NOSE.y, l = Math.hypot(dx, dy); return { x: dx / l, y: dy / l }; })();
  const PERP = { x: -AXIS.y, y: AXIS.x };
  // people (A6.2)
  const PEOPLE_CAP = 24, PERSON_H = 0.4, LOADER_H = 0.52, WALK_SPEED = 0.55 * CELL, WALK_FPS = 10, IDLE_FPS = 4, PEOPLE_ZOOM = 0.9;

  const S = {
    recs: new Map(),              // ship -> record
    hover: null,
    band: 0,
    vectors: null,                // Graphics container for approach vectors (lanes layer)
    hullCache: new Map(),         // key -> { tex, w, h, ax, ay, unit }
    shadowCache: new Map(),
    shipIds: null,                // ARTPACK ship ids (null without the pack)
    visits: new Map(),            // ship -> visit (gangway + figures)
    pool: [],                     // free figure sprites
    figures: 0,                   // live figures (cap)
  };

  const hasShips = () => typeof Ships !== 'undefined' && Ships && typeof Ships.hullCanvas === 'function';
  const hullDef = cls => (hasShips() && Ships.HULLS && Ships.HULLS[cls]) || { nose: 26, tail: -26, halfW: 13, exhaust: { x: -26, y: 0 }, engines: [{ x: -26, y: 0 }], nav: [{ x: 0, y: -12 }, { x: 0, y: 12 }] };
  const halfLength = cls => ((typeof SHIP_CLASSES !== 'undefined' && SHIP_CLASSES[cls]) ? SHIP_CLASSES[cls].size : 8) * CELL / 14;
  const toW = (x, y) => ISO.toWorld(x, y);                 // Sim position (column, row in cells) to world
  const simState = () => (typeof Sim !== 'undefined' && Sim) ? Sim.state : null;
  const hash = n => (Math.imul(n | 0, 2654435761) >>> 0);

  // ---------------------------------------------------------------- render pick (A6.2)
  function shipIds() { if (S.shipIds === null) S.shipIds = ST.assets.ids('ships') || false; return S.shipIds || null; }
  function isNamed(ship) { return hash(ship.id) % 6 === 0; }
  // the company's specials for a class, from COLLECTION.ships (rare / epic entries whose id is not the stock `<company>_<cls>`)
  function specialsFor(company, cls) {
    const stock = company + '_' + cls;
    const col = (typeof COLLECTION !== 'undefined' && COLLECTION && Array.isArray(COLLECTION.ships)) ? COLLECTION.ships : [];
    return col.filter(e => e && e.fam === company && e.cls === cls && e.id !== stock).map(e => e.id);
  }
  function renderId(ship) {
    const ids = shipIds(); if (!ids) return null;
    if (isNamed(ship)) {
      const sp = specialsFor(ship.company, ship.cls).filter(id => ids.includes(id));
      if (sp.length) return sp[hash(ship.id * 7 + 3) % sp.length];
    }
    const direct = ship.company + '_' + ship.cls;
    if (ids.includes(direct)) return direct;
    const fb = CLASS_FALLBACK[ship.cls];
    return fb && ids.includes(fb) ? fb : null;
  }

  // ---------------------------------------------------------------- hull textures (fallback while a render loads, or without the pack)
  function hullRec(cls, co) {
    const key = cls + '|' + co + '|' + S.band;
    let rec = S.hullCache.get(key);
    if (rec) return rec;
    let canvas;
    if (hasShips()) canvas = Ships.hullCanvas(cls, co, CELL * S.band);
    else {
      canvas = U.makeCanvas(64, 32);
      const g = canvas.getContext('2d'); g.fillStyle = U.companyColor(co); g.beginPath(); g.moveTo(62, 16); g.lineTo(2, 2); g.lineTo(14, 16); g.lineTo(2, 30); g.closePath(); g.fill();
      canvas.anchorX = 24; canvas.anchorY = 16; canvas.unit = 1;
    }
    const h = hullDef(cls), len = h.nose - h.tail;
    rec = { tex: ST.textureFromCanvas(canvas), w: canvas.width, h: canvas.height, ax: canvas.anchorX, ay: canvas.anchorY, unit: canvas.unit || (canvas.width / len), len };
    S.hullCache.set(key, rec);
    return rec;
  }
  function shadowRec(cls, co) {
    const key = cls + '|' + co + '|' + S.band;
    let rec = S.shadowCache.get(key);
    if (rec) return rec;
    const hr = hullRec(cls, co);
    const canvas = U.makeCanvas(hr.w, hr.h);
    const g = canvas.getContext('2d');
    g.drawImage(hasShips() ? Ships.hullCanvas(cls, co, CELL * S.band) : hr.tex.source.resource, 0, 0);
    g.globalCompositeOperation = 'source-in'; g.fillStyle = 'rgba(0,0,0,1)'; g.fillRect(0, 0, hr.w, hr.h);
    rec = { tex: ST.textureFromCanvas(canvas) };
    S.shadowCache.set(key, rec);
    return rec;
  }
  function purgeHulls() {
    for (const r of S.hullCache.values()) ST.destroyTexture(r.tex);
    for (const r of S.shadowCache.values()) ST.destroyTexture(r.tex);
    S.hullCache.clear(); S.shadowCache.clear();
    if (hasShips() && typeof Ships.purge === 'function') Ships.purge();
  }

  // ---------------------------------------------------------------- records
  function createRec(ship) {
    const root = new PIXI.Container(); root.eventMode = 'none';              // shadow, hull / render, HOLD plate, hover ring (traffic)
    const glow = new PIXI.Container(); glow.eventMode = 'none';              // engine bloom, trail, nav lights (bloom layer)
    const hd = hullDef(ship.cls);
    const co = U.companyColor(ship.company);
    const artId = renderId(ship);
    const rec = {
      ship, root, glow, co, hd,
      w: (ART_W[ship.cls] || 1.5) * CELL, L: halfLength(ship.cls),
      shadow: new PIXI.Sprite(), hull: new PIXI.Sprite(), art: new PIXI.Sprite(), artShadow: new PIXI.Sprite(),
      artId, artUrl: artId ? ST.assets.url('ships', artId, 512) : null, artState: 'none', fadeT0: 0,
      mirror: 1, flip: 1, named: !!artId && isNamed(ship),
      bloom: ST.sprite(ST.glowTexture(co, 32, 'core'), { blend: 'add', alpha: 0 }),
      nav: [ST.sprite(ST.glowTexture(NAV_PORT, 6, 'hard'), { blend: 'add' }), ST.sprite(ST.glowTexture(NAV_STBD, 6, 'hard'), { blend: 'add' })],
      running: ship.cls === 'liner' ? ST.sprite(ST.glowTexture(U.pal('rose'), 6, 'hard'), { blend: 'add' }) : null,
      trail: new PIXI.Graphics(), trailPts: [],
      hold: null, hoverRing: new PIXI.Graphics(), vector: new PIXI.Graphics(),
      entry: { x0: ship.x, y0: ship.y, state: ship.state }, vectorKey: '',
      departAt: 0, band: 0, drawX: toW(ship.x, ship.y).x, drawY: toW(ship.x, ship.y).y,
      lane: null, hold0: null, dep0: null, pose: null, blend: null,
    };
    rec.shadow.anchor.set(0.5); rec.shadow.alpha = 0.35; rec.shadow.tint = 0x000000;
    rec.artShadow.anchor.set(0.5); rec.artShadow.alpha = 0.35; rec.artShadow.tint = 0x000000; rec.artShadow.visible = false;
    rec.art.anchor.set(0.5); rec.art.visible = false;
    for (const n of [rec.hull, rec.art, rec.shadow, rec.artShadow, rec.trail, rec.hoverRing, rec.vector]) n.eventMode = 'none';
    for (const n of rec.nav) n.scale.set(0.45);
    if (rec.running) rec.running.scale.set(0.5);
    glow.addChild(rec.trail, rec.bloom, ...rec.nav);
    if (rec.running) glow.addChild(rec.running);
    root.addChild(rec.shadow, rec.artShadow, rec.hull, rec.art, rec.hoverRing);
    ST.layers.trafficGlow.addChild(glow);
    ST.layers.traffic.addChild(root);
    S.vectors.addChild(rec.vector);
    applyBand(rec);
    if (rec.artUrl) ST.assets.load(rec.artUrl);                             // lazy per class / company: first spawn starts the fetch
    return rec;
  }
  function applyBand(rec) {
    rec.band = S.band;
    const hr = hullRec(rec.ship.cls, rec.ship.company), sr = shadowRec(rec.ship.cls, rec.ship.company);
    const scale = (2 * rec.L) / (hr.len * hr.unit);          // world px per canvas px
    rec.hull.texture = hr.tex; rec.hull.anchor.set(hr.ax / hr.w, hr.ay / hr.h); rec.hull.scale.set(scale);
    rec.shadow.texture = sr.tex; rec.shadow.anchor.set(hr.ax / hr.w, hr.ay / hr.h); rec.shadow.scale.set(scale);
    rec.u = (2 * rec.L) / hr.len;                              // world px per design unit
  }
  function adoptArt(rec) {
    if (rec.artState !== 'none' || !rec.artUrl) return;
    const tex = ST.assets.texture(rec.artUrl);
    if (!tex) return;
    rec.art.texture = tex; rec.artShadow.texture = tex;
    rec.art.visible = true; rec.artState = 'fading'; rec.fadeT0 = U.nowMs();
  }
  function destroyRec(rec) {
    rec.root.destroy({ children: true });
    rec.glow.destroy({ children: true });
    rec.vector.destroy();
    if (rec.hold) { rec.hold.bg.destroy(); rec.hold.text.destroy(); }
    endVisit(rec.ship);
  }

  // ---------------------------------------------------------------- frame
  function update(dt) {
    const s = simState();
    if (!s) { for (const rec of S.recs.values()) destroyRec(rec); S.recs.clear(); return; }
    const band = EngineWorld.band;
    if (band !== S.band) { S.band = band; purgeHulls(); for (const rec of S.recs.values()) applyBand(rec); }
    const live = new Set(s.ships);
    for (const [ship, rec] of S.recs) if (!live.has(ship)) { destroyRec(rec); S.recs.delete(ship); }
    const tier = ST.tier, reduced = ST.reduced, paused = ST.paused, t = ST.tellTime, nowM = U.nowMs();
    const grid = s.grid;
    for (const ship of s.ships) {
      let rec = S.recs.get(ship);
      if (!rec) { rec = createRec(ship); S.recs.set(ship, rec); }
      const moving = ship.state === 'approach' || ship.state === 'depart', queued = ship.state === 'queue', docked = ship.state === 'docked';
      const pose = flightPose(ship, rec), ang = pose.ang;
      // art arrival and cross-fade from the baked hull
      adoptArt(rec);
      let artK = rec.artState === 'art' ? 1 : 0;
      if (rec.artState === 'fading') { artK = U.clamp((nowM - rec.fadeT0) / FADE_MS, 0, 1); if (artK >= 1) rec.artState = 'art'; }
      const useArt = artK > 0;
      // the render faces its axis: as drawn for B (nose down-left), mirrored for A (nose down-right); never rotated
      const mirror = pose.axis === 'A' ? -1 : 1;
      rec.mirror = mirror;
      rec.flip += (mirror - rec.flip) * Math.min(1, dt * 8);
      if (Math.abs(rec.flip - mirror) < 0.02) rec.flip = mirror;
      // docked ships bob 1.5 px at 0.4 Hz; in flight a ship rides pose.alt above its ground track
      const bob = docked && !reduced ? Math.sin(t * TAU * 0.4 + (ship.id || 0)) * 1.5 : 0;
      const x = pose.x, y = pose.y - pose.alt + bob;
      rec.drawX = x; rec.drawY = y;
      rec.root.position.set(x, y); rec.glow.position.set(x, y);
      rec.root.alpha = rec.glow.alpha = pose.alpha;
      // deck level while docked (sorted with the modules by its ground point); in flight above the station
      const layer = docked ? ST.layers.world.minis : ST.layers.traffic;
      if (rec.root.parent !== layer) layer.addChild(rec.root);
      if (docked) rec.root.zIndex = Math.round(ISO.depthAt(pose.x, pose.y) * 100);
      // render sprite (sized by class width, mirrored by flip) and the baked hull (rotated) under it while fading
      if (useArt) {
        const sc = rec.w / Math.max(1, rec.art.texture.width);
        rec.art.scale.set(sc * rec.flip, sc);
        rec.art.alpha = artK;
        rec.artShadow.scale.set(sc * rec.flip, sc);
      }
      rec.hull.visible = artK < 1; rec.hull.alpha = 1 - artK; rec.hull.rotation = ang;
      // the shadow falls on the deck below: under the hull when docked, dropped by the altitude in flight
      rec.shadow.visible = artK < 1; rec.artShadow.visible = useArt;
      rec.shadow.position.set(2, 3 + pose.alt); rec.shadow.rotation = ang; rec.shadow.alpha = 0.3 * (1 - artK);
      rec.artShadow.position.set(3, 4 + pose.alt); rec.artShadow.alpha = (pose.alt > 1 ? 0.2 : 0.3) * artK;
      // stern (bloom, exhaust, trail origin) and axis angle, in local coordinates
      const st = sternOf(rec, useArt, ang);
      let bloomA = 0, bloomScale = 0;
      if (moving) {
        const ramp = ship.state === 'depart' && rec.departAt ? U.clamp((nowM - rec.departAt) / 400, 0, 1) : 1;
        bloomA = 0.75 * ramp; bloomScale = 1.6;
      } else if (queued) { bloomA = 0.3; bloomScale = 0.7; }
      const rBase = Math.max(4, (useArt ? rec.w * 0.11 : rec.L * 0.3)) * bloomScale;
      const stretch = ship.cls === 'liner' ? 3.2 : 2.2;
      rec.bloom.position.set(st.x + Math.cos(st.a) * rBase * 0.6, st.y + Math.sin(st.a) * rBase * 0.6);
      rec.bloom.rotation = st.a;
      rec.bloom.scale.set(rBase * stretch / 32, rBase / 32);
      rec.bloom.alpha = bloomA * (0.9 + 0.1 * Math.sin(t * 17));
      if (moving && !reduced && !paused && tier > 0 && bloomA > 0.2) EngineFX.exhaust(x + st.x, y + st.y, st.a + Math.PI, rec.co, tier > 1 ? 2 : 1);
      updateTrail(rec, x + st.x, y + st.y, x, y, moving && tier > 1 && !reduced);
      // nav lights: port red / starboard green, 1 Hz with per-ship phase; liner adds a rose running light
      const phase = ((ship.id || 0) * 0.37) % 1;
      const blink = ((t + phase) % 1) < 0.55;
      for (let i = 0; i < 2; i++) {
        const n = rec.nav[i], side = i === 0 ? -1 : 1;
        if (useArt) n.position.set(PERP.x * side * 0.15 * rec.w * rec.flip, PERP.y * side * 0.15 * rec.w);
        else { const p = rec.hd.nav[i]; n.position.set((p.x * Math.cos(ang) - p.y * Math.sin(ang)) * rec.u, (p.x * Math.sin(ang) + p.y * Math.cos(ang)) * rec.u); }
        n.alpha = blink ? 1 : 0.18;
      }
      if (rec.running) {
        if (useArt) rec.running.position.set(NOSE.x * 0.5 * rec.w * rec.flip, NOSE.y * 0.5 * rec.w);
        else rec.running.position.set(rec.hd.nose * 0.3 * Math.cos(ang) * rec.u, rec.hd.nose * 0.3 * Math.sin(ang) * rec.u);
        rec.running.alpha = 0.5 + 0.5 * Math.sin(t * TAU * 0.7 + phase * 6);
      }
      updateHold(rec, queued, useArt);
      rec.hoverRing.clear();
      if (S.hover === ship) rec.hoverRing.circle(0, 0, hitRadius(rec) + 2).stroke({ width: 1.5, color: U.int(U.pal('ivory')), alpha: 0.9 });
      updateVector(rec, ship);
    }
    updatePeople(dt, s);
  }

  // A ship's lane (A7): the Sim's berth is a free neighbour of the dock; the ship parks PARK_OUT cells out on that
  // side, broadside to the dock, so its axis is the other grid axis (berth along a column step -> axis B).
  function laneOf(ship) {
    if (!ship.dock || !ship.target) return null;
    const dx = ship.target.x - (ship.dock.c + 0.5), dy = ship.target.y - (ship.dock.r + 0.5);
    const alongC = Math.abs(dx) >= Math.abs(dy);
    const og = alongC ? { gx: Math.sign(dx) || 1, gy: 0 } : { gx: 0, gy: Math.sign(dy) || 1 };
    const axis = alongC ? 'B' : 'A';
    // park in open space: step out from the dock until the cell and its two neighbours along the ship's axis are free
    // (a berth in a notch between modules would bury the hull); the gangway grows into a docking arm to reach it
    const lat = axis === 'A' ? { dr: 0, dc: 1 } : { dr: 1, dc: 0 }, occ = (r, c) => EngineWorld.occupied(r, c);
    let out = PARK_OUT;
    for (let k = 1; k <= 4; k++) {
      const pr = ship.dock.r + og.gy * k, pc = ship.dock.c + og.gx * k;
      if (occ(pr, pc)) break;
      if (!occ(pr + lat.dr, pc + lat.dc) && !occ(pr - lat.dr, pc - lat.dc)) { out = k + PARK_OUT - 1; break; }
    }
    return { axis, dir: axis === 'A' ? ISO.A : ISO.B, park: toW(ship.dock.c + 0.5 + og.gx * out, ship.dock.r + 0.5 + og.gy * out), dock: { r: ship.dock.r, c: ship.dock.c } };
  }
  // where a queued ship holds: beside the station's upper flanks (odd ids right, even left), stacked outward, nose toward it
  function holdPoint(ship) {
    const st = EngineWorld.station || { x0: -120, y0: -120, x1: 120, y1: 120 };
    const s = simState(), side = hash(ship.id) % 2;
    const q = s ? s.ships.filter(o => o !== ship && o.state === 'queue' && hash(o.id) % 2 === side && o.id < ship.id).length : 0;
    const x = side ? st.x1 + 1.1 * CELL + q * 0.7 * CELL : st.x0 - 1.1 * CELL - q * 0.7 * CELL;
    return { x, y: st.y0 + (st.y1 - st.y0) * 0.2 + q * 0.45 * CELL + ALT, axis: side ? 'B' : 'A' };
  }
  // The visual pose of a ship this frame: ground point (x, y), altitude, axis, heading angle and alpha.
  function flightPose(ship, rec) {
    const st = ship.state;
    if (st === 'approach' || st === 'docked') { const ln = laneOf(ship); if (ln) rec.lane = ln; }
    const ln = rec.lane;
    let x, y, alt = 0, alpha = 1, axis = 'B';
    if (st === 'depart') {
      if (!rec.dep0) rec.dep0 = { x: ship.x, y: ship.y };
      const tr = Math.hypot(ship.x - rec.dep0.x, ship.y - rec.dep0.y);
      const fromHold = !ln && rec.hold0, base = ln ? ln.park : (fromHold ? rec.hold0 : { x: rec.drawX, y: rec.drawY });
      axis = ln ? ln.axis : (fromHold ? rec.hold0.axis : 'B');
      const dir = axis === 'A' ? ISO.A : ISO.B;
      x = base.x + dir.x * tr * ISO.EDGE; y = base.y + dir.y * tr * ISO.EDGE;
      alt = ln ? ALT * Math.min(1, tr / 2) : ALT;
      alpha = U.clamp(1 - (tr - 7) / 3, 0, 1);
    } else if (st === 'queue' || !ln) {
      const h = holdPoint(ship); rec.hold0 = h;
      x = h.x; y = h.y; axis = h.axis; alt = ALT;
    } else if (st === 'approach') {
      const d = Math.hypot(ship.target.x - ship.x, ship.target.y - ship.y);
      x = ln.park.x - ln.dir.x * d * ISO.EDGE; y = ln.park.y - ln.dir.y * d * ISO.EDGE;
      alt = ALT * Math.min(1, d / 2.5); axis = ln.axis;
    } else { x = ln.park.x; y = ln.park.y; axis = ln.axis; }
    // a ship whose plan changes mid-flight (a queued ship given a berth) glides to its new track
    const prev = rec.pose, nowM = U.nowMs();
    if (prev && !rec.blend && Math.hypot(x - prev.x, (y - alt) - (prev.y - prev.alt)) > ISO.EDGE * 1.5) rec.blend = { t0: nowM, x: prev.x, y: prev.y, alt: prev.alt };
    if (rec.blend) {
      const k = (nowM - rec.blend.t0) / BLEND_MS;
      if (k >= 1 || ST.reduced) rec.blend = null;
      else { const e = U.easeInOutCubic(k); x = U.lerp(rec.blend.x, x, e); y = U.lerp(rec.blend.y, y, e); alt = U.lerp(rec.blend.alt, alt, e); }
    }
    const dir = axis === 'A' ? ISO.A : ISO.B;
    rec.pose = { x, y, alt, axis, ang: Math.atan2(dir.y, dir.x), alpha };
    return rec.pose;
  }
  // Local stern offset and the direction the exhaust points (away from the nose).
  function sternOf(rec, useArt, ang) {
    if (useArt) {
      const f = rec.flip;
      return { x: STERN.x * rec.w * f, y: STERN.y * rec.w, a: Math.atan2(AXIS.y, AXIS.x * f) };
    }
    const e = rec.hd.exhaust;
    return { x: (e.x * Math.cos(ang) - e.y * Math.sin(ang)) * rec.u, y: (e.x * Math.sin(ang) + e.y * Math.cos(ang)) * rec.u, a: ang + Math.PI };
  }
  function hitRadius(rec) { return rec.artState !== 'none' ? rec.w * 0.42 : rec.L + 4; }

  function updateTrail(rec, sx, sy, x, y, on) {
    const pts = rec.trailPts;
    if (!on) { if (pts.length) { pts.length = 0; rec.trail.clear(); } return; }
    if (!pts.length || Math.hypot(sx - pts[pts.length - 1].x, sy - pts[pts.length - 1].y) >= TRAIL_STEP) {
      pts.push({ x: sx, y: sy });
      if (pts.length > TRAIL_PTS) pts.shift();
    }
    const g = rec.trail; g.clear();
    if (pts.length < 2) return;
    const col = U.int(rec.co), n = pts.length;
    for (let i = 1; i < n; i++) {
      const k = i / (n - 1);
      g.moveTo(pts[i - 1].x - x, pts[i - 1].y - y).lineTo(pts[i].x - x, pts[i].y - y)
        .stroke({ width: 0.6 + 2.6 * k, color: col, alpha: 0.05 + 0.5 * k * k, cap: 'round' });
    }
  }

  function updateHold(rec, queued, useArt) {
    if (!queued) { if (rec.hold) { rec.hold.bg.destroy(); rec.hold.text.destroy(); rec.hold = null; } return; }
    if (!rec.hold) {
      const bg = new PIXI.Graphics(); bg.eventMode = 'none'; bg.scale.set(0.8);                          // A6: the plate at 80%
      const text = ST.makeText('HOLD', { size: 10, color: U.pal('warn') }); text.anchor.set(0.5, 0.5); text.scale.set(0.8);
      rec.root.addChild(bg, text);
      rec.hold = { bg, text, last: '' };
    }
    const days = Math.max(0, Sim.now() - (rec.ship.waitStart || 0));
    const str = 'HOLD ' + days.toFixed(1) + 'd', top = useArt ? rec.w * 0.32 : rec.L;
    const key = str + '|' + Math.round(top);
    if (key !== rec.hold.last) {
      rec.hold.last = key; rec.hold.text.text = str;
      const pw = Math.ceil(rec.hold.text.width + 10), ph = 14, pyt = -top - 8 - ph, pxl = -pw / 2;
      const warn = U.int(U.pal('warn')), bg = rec.hold.bg;
      bg.clear();
      bg.rect(pxl, pyt, pw, ph).fill({ color: 0x04050A, alpha: 0.8 });
      const bl = 8, bx0 = pxl - 2, by0 = pyt - 2, bx1 = pxl + pw + 2, by1 = pyt + ph + 2;
      bg.moveTo(bx0, by0 + bl).lineTo(bx0, by0).lineTo(bx0 + bl, by0).moveTo(bx1 - bl, by1).lineTo(bx1, by1).lineTo(bx1, by1 - bl).stroke({ width: 1, color: warn });
      rec.hold.text.position.set(0, (pyt + ph / 2 + 0.5) * 0.8);
    }
  }

  function updateVector(rec, ship) {
    const show = ship.state === 'approach' && rec.lane && rec.pose && ST.tier > 0;
    const key = show ? `${Math.round(rec.pose.x / 6)},${Math.round(rec.pose.y / 6)}` : '';
    if (key === rec.vectorKey) return;
    rec.vectorKey = key;
    const g = rec.vector; g.clear();
    if (!show) return;
    const ax = rec.pose.x, ay = rec.pose.y, bx = rec.lane.park.x, by = rec.lane.park.y;   // the ground track still to fly
    const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
    const cut = Math.max(0, L - 2 * CELL);
    const ivory = U.int(U.pal('ivory')), ice = U.int(U.pal('ice'));
    for (let d = 0; d < L; d += 8) {
      const far = d >= cut;
      g.circle(ax + ux * d, ay + uy * d, far ? 1.2 : 0.9).fill({ color: far ? ice : ivory, alpha: far ? 0.28 : 0.1 });
    }
  }

  // ---------------------------------------------------------------- people (A6.2)
  function peopleAllowed() { return ST.assets.active && ST.tier === 2 && !ST.reduced; }
  function peopleVisible() { return peopleAllowed() && CAM.zoom > PEOPLE_ZOOM; }
  function secondsPerDay() {
    const s = simState();
    const ms = (typeof TIMERS !== 'undefined' && TIMERS && TIMERS.DAY_MS) ? TIMERS.DAY_MS : (typeof DAY_SECONDS !== 'undefined' ? DAY_SECONDS * 1000 : 6000);
    return ms / 1000 / Math.max(1, (s && s.speed) || 1);
  }
  // Role list for a docking (A6.2): crew / passengers / alien traders / security / officer / dockworker (+ loader); 2–5 figures.
  function rolesFor(ship, dock) {
    const list = ship.cls === 'liner' ? ['passenger_a', 'passenger_b', 'passenger_a'] : ['crew', 'crew'];
    if (ship.cls === 'hauler') list.push('crew');
    if (ship.company === 'ouroboros' || ship.company === 'aurelian') list.push('trader_alien');
    if (EngineWorld.nearModule(dock.r, dock.c, 'security', 2)) list.push('security');
    if (EngineWorld.nearModule(dock.r, dock.c, 'hub', 1)) list.push('officer');
    const traded = Array.isArray(ship.trades) && ship.trades.some(tr => /^(Bought|Sold|Took)/.test(tr));
    const loader = traded && !!EngineWorld.nearModule(dock.r, dock.c, 'warehouse', 3);
    if (loader) list.push('dockworker');
    // deterministic order per ship, 2..5 figures
    const h = hash(ship.id);
    const picked = list.slice(0, Math.max(2, Math.min(5, list.length)));
    if (h & 1) picked.reverse();
    return { roles: picked, loader };
  }
  // A figure is a sheet-frame sprite plus a soft lamp-coloured floor glow at its feet (the uniforms are gunmetal
  // on gunmetal renders; the spot keeps them findable). Both are pooled together.
  function acquireFigure() {
    let f = S.pool.pop();
    if (!f) {
      const sp = new PIXI.Sprite(); sp.eventMode = 'none';
      const spot = ST.sprite(ST.glowTexture(U.pal('lamp'), 16, 'soft'), { blend: 'add', alpha: 0.22 });
      f = { sp, spot };
    }
    f.sp.visible = f.spot.visible = false;
    ST.layers.world.minis.addChild(f.spot, f.sp);
    return f;
  }
  function releaseFigure(f) { f.sp.removeFromParent(); f.spot.removeFromParent(); f.sp.visible = f.spot.visible = false; if (S.pool.length < 64) S.pool.push(f); }

  function startVisit(ship) {
    if (!peopleAllowed() || !ship.dock || S.visits.has(ship)) return;
    const dock = ship.dock, D = EngineWorld.cellCentre(dock.r, dock.c), ln = laneOf(ship), P = ln ? ln.park : toW(ship.x, ship.y);
    const dx = D.x - P.x, dy = D.y - P.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const from = { x: P.x + ux * CELL * 0.12, y: P.y + uy * CELL * 0.12 };     // the ship's side
    const to = { x: D.x - ux * ISO.EDGE * 0.42, y: D.y - uy * ISO.EDGE * 0.42 }; // the dock's edge
    const visit = { ship, dock, from, to, pad: D, figures: [], gangway: null, loader: null, ux, uy, left: false };
    // gangway (A7): the corridor tube, thinner, from the dock to the ship's side, sorted just behind the nearer-back end
    if (EngineWorld.tube) {
      const tex = EngineWorld.tube(), g = new PIXI.Sprite(tex.texture); g.eventMode = 'none'; g.anchor.set(0.5);
      let gx = P.x - D.x, gy = P.y - D.y; const gl = Math.hypot(gx, gy);
      if (gx < 0) { gx = -gx; gy = -gy; }
      g.rotation = Math.atan2(gy, gx);
      g.scale.set(gl / tex.w, 0.15 * CELL / tex.h);
      g.position.set((P.x + D.x) / 2, (P.y + D.y) / 2 - 0.08 * CELL);
      g.zIndex = Math.round(Math.min(ISO.depthAt(D.x, D.y), ISO.depthAt(P.x, P.y)) * 100) - 1;
      g.alpha = 0;
      ST.layers.world.minis.addChild(g);
      visit.gangway = g;
    }
    const { roles, loader } = rolesFor(ship, dock);
    const room = Math.max(0, PEOPLE_CAP - S.figures);
    roles.slice(0, room).forEach((role, i) => {
      const info = ST.assets.sheet(role); if (!info) return;
      const side = (i % 2 ? 1 : -1) * (3 + (i >> 1) * 3);
      const fig = { role, info, fx: acquireFigure(), state: 'in', t: 0, delay: 0.45 * i, speed: WALK_SPEED * (0.9 + 0.2 * ((hash(ship.id + i * 31) % 100) / 100)),
        x: from.x, y: from.y, from: { x: from.x, y: from.y },
        to: { x: D.x + (-uy) * side + ux * (-6 + (i % 3) * 4), y: D.y + ux * side + uy * (-6 + (i % 3) * 4) }, facing: 'front', frame: 0 };
      visit.figures.push(fig); S.figures++;
    });
    if (loader && room > roles.length) {
      const info = ST.assets.sheet('loader');
      const lurl = info && info.url;
      if (info) {
        if (!ST.assets.texture(lurl)) ST.assets.load(lurl);
        const fig = { role: 'loader', info, fx: acquireFigure(), state: 'in', t: 0, delay: 1.2, speed: WALK_SPEED * 1.1, x: from.x, y: from.y, from: { x: from.x, y: from.y },
          to: { x: D.x + uy * 14 - ux * 4, y: D.y - ux * 14 - uy * 4 }, facing: 'front', frame: 0 };
        visit.figures.push(fig); S.figures++;
      }
    }
    S.visits.set(ship, visit);
  }
  function endVisit(ship) {
    const v = S.visits.get(ship); if (!v) return;
    for (const f of v.figures) { releaseFigure(f.fx); S.figures--; }
    if (v.gangway) v.gangway.destroy();
    S.visits.delete(ship);
  }
  // sheet frame for a facing/animation at time t
  function figureTexture(fig, anim, t) {
    const info = fig.info, A = info.animations && info.animations[anim];
    if (!A) return null;
    const fps = anim === 'idle' ? IDLE_FPS : (fig.role === 'loader' ? 6 : WALK_FPS);
    let col = Math.floor(t * fps) % A.frames, row = A.row;
    if (fig.role === 'loader') { col = Math.max(0, (info.facings || []).indexOf(fig.facing)); row = (Math.floor(t * 6) % 2) ? 1 : 0; }
    return ST.assets.frame(info.url, col * info.cell.w, row * info.cell.h, info.cell.w, info.cell.h);
  }
  function facingFor(fig, dx, dy) {
    if (fig.role === 'loader') return dx >= 0 ? (dy < 0 ? 'back_right' : 'front_right') : (dy < 0 ? 'back_left' : 'front_left');
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'front' : 'back');
  }
  function updatePeople(dt, s) {
    if (!S.visits.size) return;
    const show = peopleVisible(), paused = ST.paused, spd = secondsPerDay();
    for (const [ship, v] of S.visits) {
      if (!s.ships.includes(ship) || ship.state !== 'docked') { endVisit(ship); continue; }
      if (v.gangway) v.gangway.alpha = Math.min(1, v.gangway.alpha + dt * 3) * (show ? 1 : 0) + (show ? 0 : v.gangway.alpha);
      if (v.gangway) v.gangway.visible = show;
      // leave in time to be aboard before departure: walk back when the stay has that many seconds left
      const remainingS = (ship.dockedUntil - Sim.now()) * spd;
      let allGone = true;
      for (const f of v.figures) {
        const sp = f.fx.sp, spot = f.fx.spot;
        if (!paused) {
          if (f.delay > 0) f.delay -= dt;
          else {
            f.t += dt;
            const walkS = Math.hypot(f.to.x - f.from.x, f.to.y - f.from.y) / f.speed;
            if (f.state === 'idle' && remainingS < walkS + 0.8) { f.state = 'out'; }
            if (f.state === 'in' || f.state === 'out') {
              const tgt = f.state === 'in' ? f.to : f.from, dx = tgt.x - f.x, dy = tgt.y - f.y, d = Math.hypot(dx, dy), step = f.speed * dt;
              if (d <= step) { f.x = tgt.x; f.y = tgt.y; f.state = f.state === 'in' ? 'idle' : 'gone'; }
              else { f.x += dx / d * step; f.y += dy / d * step; f.facing = facingFor(f, dx, dy); }
            }
          }
        }
        if (f.state === 'gone') { sp.visible = spot.visible = false; continue; }
        allGone = false;
        if (!show || f.delay > 0) { sp.visible = spot.visible = false; continue; }
        const anim = f.state === 'idle' ? 'idle' : f.facing;
        const tex = figureTexture(f, f.role === 'loader' ? 'drive_a' : anim, f.t);
        if (!tex) { sp.visible = spot.visible = false; continue; }
        sp.texture = tex; sp.visible = true;
        const h = f.role === 'loader' ? LOADER_H : PERSON_H, sc = (h * CELL) / f.info.cell.h;
        sp.anchor.set(0.5, (f.info.baseline || f.info.cell.h) / f.info.cell.h);
        sp.scale.set(sc);
        sp.position.set(f.x, f.y);
        sp.zIndex = Math.round(ISO.depthAt(f.x, f.y) * 100) + 2;
        spot.visible = true; spot.position.set(f.x, f.y - 1); spot.scale.set(h * CELL * 0.9 / 32, h * CELL * 0.4 / 32); spot.zIndex = sp.zIndex - 1;
      }
      if (allGone) { for (const f of v.figures) { releaseFigure(f.fx); S.figures--; } v.figures = []; }
    }
  }

  // ---------------------------------------------------------------- choreography (v1 9.3 / 9.5)
  function onDock(ship) {
    if (!ship || !ship.dock) return;
    const dc = EngineWorld.cellCentre(ship.dock.r, ship.dock.c), cx = dc.x, cy = dc.y - ISO.HH * 0.4;
    EngineFX.ring(cx, cy, 0.2 * CELL, 0.6 * CELL, U.pal('ice'), 300, 1.5);
    const path = EngineWorld.pathToStorage(ship.dock.r, ship.dock.c);
    if (path && path.length > 1) {
      const bought = ship.trades.some(t => /^Bought/.test(t)), sold = ship.trades.some(t => /^(Sold|Took)/.test(t));
      if (bought) EngineFX.motes(path, U.pal('amber'), 3, 600, 'out');
      if (sold) EngineFX.motes(path.slice().reverse(), U.pal('amber'), 3, 600, 'out');
    }
    startVisit(ship);
  }
  function onDepart(ship) {
    if (!ship) return;
    const rec = S.recs.get(ship);
    if (rec) rec.departAt = U.nowMs();
    endVisit(ship);
    if (!(ship.earned > 0)) return;
    let target = { x: 16, y: 16 };
    try {
      if (typeof UI !== 'undefined' && UI && typeof UI.anchor === 'function') {
        const el = UI.anchor('credits');
        if (el) { const r = el.getBoundingClientRect(), h = ST.host.getBoundingClientRect(); target = { x: r.left + r.width / 2 - h.left, y: r.top + r.height / 2 - h.top }; }
      }
    } catch (e) { /* anchor unavailable */ }
    const tw = CAM.screenToWorld(target.x, target.y);
    const from = rec ? { x: rec.drawX, y: rec.drawY } : toW(ship.x, ship.y);
    EngineFX.motes([from, tw], U.pal('amber-hi'), 6, 600, 'in');
  }
  // Create the record at spawn so the approach vector starts exactly at the entry point (and the render fetch starts early).
  function onSpawn(ship) { if (ship && S.vectors && !S.recs.has(ship)) S.recs.set(ship, createRec(ship)); }

  // ---------------------------------------------------------------- queries
  function shipAt(x, y) {
    const s = simState(); if (!s) return null;
    let best = null, bd = Infinity;
    for (const sh of s.ships) {
      const rec = S.recs.get(sh);
      const sw = toW(sh.x, sh.y), d = rec ? Math.hypot(x - rec.drawX, y - rec.drawY) : Math.hypot(x - sw.x, y - sw.y), R = rec ? hitRadius(rec) : halfLength(sh.cls) + 4;
      if (d < R && d < bd) { bd = d; best = sh; }
    }
    return best;
  }
  // Render id a ship draws with (null when the pack is absent): for the HUD's fleet rows and the harness.
  function renderOf(ship) { const rec = S.recs.get(ship); return rec ? rec.artId : renderId(ship); }

  function init() {
    S.vectors = new PIXI.Container(); S.vectors.eventMode = 'none';
    ST.layers.lanes.addChild(S.vectors);
    S.band = EngineWorld.band;
  }

  return {
    init, update, onDock, onDepart, onSpawn, shipAt, renderOf, isNamed,
    get hover() { return S.hover; }, set hover(v) { S.hover = v || null; },
    get people() { return S.figures; },
  };
})();

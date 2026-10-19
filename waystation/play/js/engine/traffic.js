// ============================================================
// WAYSTATION v2 — engine/traffic.js (Engineer E)
// Ships (DESIGN2.md 3.5): hulls baked from ships.js per zoom band with
// company livery, engine bloom on the bloom layer scaled with speed,
// fading trail ribbons, nav lights, HOLD plates, hover ring, approach
// vectors and the v1 9.3 docking choreography (collar ring, clamps via
// the dock art, cargo motes, undocking bloom ramp, credits motes).
//
// Ship positions come from Sim.state.ships (cells); the engine only reads.
// ships.js is used for its baked hull canvases and HULLS geometry; its
// Ships.draw() (which calls the v1 FX global) is never called here.
// Classic script: exports the global `EngineTraffic`.
// ============================================================
'use strict';

const EngineTraffic = (() => {
  const U = EngineUtil, ST = EngineStage, CAM = EngineCamera;
  const CELL = ST.CELL, TAU = U.TAU;
  const NAV_PORT = '#FF5A5A', NAV_STBD = '#5AE08A';
  const TRAIL_PTS = 12, TRAIL_STEP = 3.5;

  const S = {
    recs: new Map(),              // ship -> record
    hover: null,
    band: 0,
    vectors: null,                // Graphics container for approach vectors (lanes layer)
    hullCache: new Map(),         // key -> { tex, w, h, ax, ay, unit }
    shadowCache: new Map(),
  };

  const hasShips = () => typeof Ships !== 'undefined' && Ships && typeof Ships.hullCanvas === 'function';
  const hullDef = cls => (hasShips() && Ships.HULLS && Ships.HULLS[cls]) || { nose: 26, tail: -26, halfW: 13, exhaust: { x: -26, y: 0 }, engines: [{ x: -26, y: 0 }], nav: [{ x: 0, y: -12 }, { x: 0, y: 12 }] };
  const halfLength = cls => ((typeof SHIP_CLASSES !== 'undefined' && SHIP_CLASSES[cls]) ? SHIP_CLASSES[cls].size : 8) * CELL / 14;
  const wx = x => x * CELL, wy = y => y * CELL;

  // ---------------------------------------------------------------- hull textures
  // Baked with ships.js at cellPx = CELL * band so the hull is crisp for the band; the record
  // carries the hull origin (ax, ay in canvas px) and device px per design unit.
  function hullRec(cls, co) {
    const key = cls + '|' + co + '|' + S.band;
    let rec = S.hullCache.get(key);
    if (rec) return rec;
    let canvas;
    if (hasShips()) canvas = Ships.hullCanvas(cls, co, CELL * S.band);
    else {
      // minimal dart when ships.js is absent
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
    const root = new PIXI.Container(); root.eventMode = 'none';              // hull, shadow, HOLD plate, hover ring (traffic)
    const glow = new PIXI.Container(); glow.eventMode = 'none';              // engine bloom, trail, nav lights (bloom layer)
    const hd = hullDef(ship.cls);
    const co = U.companyColor(ship.company);
    const rec = {
      ship, root, glow, co, hd,
      shadow: new PIXI.Sprite(), hull: new PIXI.Sprite(),
      blooms: hd.engines.map(() => ST.sprite(ST.glowTexture(co, 32, 'core'), { blend: 'add', alpha: 0 })),
      nav: [ST.sprite(ST.glowTexture(NAV_PORT, 6, 'hard'), { blend: 'add' }), ST.sprite(ST.glowTexture(NAV_STBD, 6, 'hard'), { blend: 'add' })],
      running: ship.cls === 'liner' ? ST.sprite(ST.glowTexture(U.pal('rose'), 6, 'hard'), { blend: 'add' }) : null,
      trail: new PIXI.Graphics(), trailPts: [],
      hold: null, hoverRing: new PIXI.Graphics(), vector: new PIXI.Graphics(),
      entry: { x0: ship.x, y0: ship.y, state: ship.state }, vectorKey: '',
      departAt: 0, band: 0, L: halfLength(ship.cls),
    };
    rec.shadow.anchor.set(0.5); rec.shadow.alpha = 0.35; rec.shadow.tint = 0x000000;
    rec.hull.eventMode = rec.shadow.eventMode = rec.trail.eventMode = rec.hoverRing.eventMode = rec.vector.eventMode = 'none';
    for (const n of rec.nav) n.scale.set(0.45);
    if (rec.running) rec.running.scale.set(0.5);
    glow.addChild(rec.trail, ...rec.blooms, ...rec.nav);
    if (rec.running) glow.addChild(rec.running);
    root.addChild(rec.shadow, rec.hull, rec.hoverRing);
    ST.layers.trafficGlow.addChild(glow);
    ST.layers.traffic.addChild(root);
    S.vectors.addChild(rec.vector);
    applyBand(rec);
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
  function destroyRec(rec) {
    rec.root.destroy({ children: true });
    rec.glow.destroy({ children: true });
    rec.vector.destroy();
    if (rec.hold) { rec.hold.bg.destroy(); rec.hold.text.destroy(); }
  }

  // ---------------------------------------------------------------- frame
  function update(dt) {
    const s = (typeof Sim !== 'undefined' && Sim) ? Sim.state : null;
    if (!s) { for (const rec of S.recs.values()) destroyRec(rec); S.recs.clear(); return; }
    const band = EngineWorld.band;
    if (band !== S.band) { S.band = band; purgeHulls(); for (const rec of S.recs.values()) applyBand(rec); }
    // sync records with Sim.state.ships
    const live = new Set(s.ships);
    for (const [ship, rec] of S.recs) if (!live.has(ship)) { destroyRec(rec); S.recs.delete(ship); }
    const tier = ST.tier, reduced = ST.reduced, paused = ST.paused, t = ST.tellTime, nowM = U.nowMs();
    const grid = s.grid;
    for (const ship of s.ships) {
      let rec = S.recs.get(ship);
      if (!rec) { rec = createRec(ship); S.recs.set(ship, rec); }
      const x = wx(ship.x), y = wy(ship.y), ang = ship.angle || 0;
      const moving = ship.state === 'approach' || ship.state === 'depart', queued = ship.state === 'queue';
      rec.root.position.set(x, y); rec.glow.position.set(x, y);
      rec.hull.rotation = ang;
      // shadow only over hull (an occupied cell), offset (+2,+3)
      const cr = Math.floor(ship.y), cc = Math.floor(ship.x);
      const overHull = !!(grid[cr] && grid[cr][cc]);
      rec.shadow.visible = overHull;
      if (overHull) { rec.shadow.position.set(2, 3); rec.shadow.rotation = ang; }
      // engine bloom: scaled with speed, ramped over 400 ms after depart, dim in the queue
      let bloomA = 0, bloomScale = 0;
      if (moving) {
        const ramp = ship.state === 'depart' && rec.departAt ? U.clamp((nowM - rec.departAt) / 400, 0, 1) : 1;
        bloomA = 0.75 * ramp; bloomScale = 1.6;
      } else if (queued) { bloomA = 0.3; bloomScale = 0.7; }
      const nEng = rec.hd.engines.length;
      const rBase = Math.max(4, rec.L * 0.3) * bloomScale / (1 + 0.3 * (nEng - 1));
      const stretch = ship.cls === 'liner' ? 3.2 : 2.2;
      for (let i = 0; i < nEng; i++) {
        const e = rec.hd.engines[i], b = rec.blooms[i];
        const ex = e.x * rec.u - rBase * 0.6, ey = e.y * rec.u;
        b.position.set(ex * Math.cos(ang) - ey * Math.sin(ang), ex * Math.sin(ang) + ey * Math.cos(ang));
        b.rotation = ang;
        b.scale.set(rBase * stretch / 32, rBase / 32);
        b.alpha = bloomA * (0.9 + 0.1 * Math.sin(t * 17 + i));
      }
      // exhaust particles while moving (2 per frame at tier 2, 1 at tier 1)
      if (moving && !reduced && !paused && tier > 0 && bloomA > 0.2) {
        const ex = rec.hd.exhaust.x * rec.u, ey = rec.hd.exhaust.y * rec.u;
        EngineFX.exhaust(x + ex * Math.cos(ang) - ey * Math.sin(ang), y + ex * Math.sin(ang) + ey * Math.cos(ang), ang, rec.co, tier > 1 ? 2 : 1);
      }
      // trail ribbon (tier 2 only): 12 points behind the exhaust, ~40 px, fading
      updateTrail(rec, x, y, ang, moving && tier > 1 && !reduced, dt);
      // nav lights: port red / starboard green, 1 Hz with per-ship phase; liner adds a rose running light
      const phase = ((ship.id || 0) * 0.37) % 1;
      const blink = ((t + phase) % 1) < 0.55;
      for (let i = 0; i < 2; i++) {
        const p = rec.hd.nav[i], n = rec.nav[i];
        n.position.set((p.x * Math.cos(ang) - p.y * Math.sin(ang)) * rec.u, (p.x * Math.sin(ang) + p.y * Math.cos(ang)) * rec.u);
        n.alpha = blink ? 1 : 0.18;
      }
      if (rec.running) {
        const px = rec.hd.nose * 0.3, py = 0;
        rec.running.position.set(px * Math.cos(ang) * rec.u, px * Math.sin(ang) * rec.u + py);
        rec.running.alpha = 0.5 + 0.5 * Math.sin(t * TAU * 0.7 + phase * 6);
      }
      // HOLD plate while queued
      updateHold(rec, queued, s);
      // hover ring
      rec.hoverRing.clear();
      if (S.hover === ship) rec.hoverRing.circle(0, 0, rec.L + 4).stroke({ width: 1.5, color: U.int(U.pal('ivory')), alpha: 0.9 });
      // approach vector: the real path from the entry point to the berth
      updateVector(rec, ship);
    }
  }

  function updateTrail(rec, x, y, ang, on, dt) {
    const pts = rec.trailPts;
    if (!on) { if (pts.length) { pts.length = 0; rec.trail.clear(); } return; }
    const ex = rec.hd.exhaust.x * rec.u, ey = rec.hd.exhaust.y * rec.u;
    const tx = x + ex * Math.cos(ang) - ey * Math.sin(ang), ty = y + ex * Math.sin(ang) + ey * Math.cos(ang);
    if (!pts.length || Math.hypot(tx - pts[pts.length - 1].x, ty - pts[pts.length - 1].y) >= TRAIL_STEP) {
      pts.push({ x: tx, y: ty });
      if (pts.length > TRAIL_PTS) pts.shift();
    }
    const g = rec.trail; g.clear();
    if (pts.length < 2) return;
    const col = U.int(rec.co), n = pts.length;
    for (let i = 1; i < n; i++) {
      const k = i / (n - 1);              // 0 oldest .. 1 newest
      g.moveTo(pts[i - 1].x - x, pts[i - 1].y - y).lineTo(pts[i].x - x, pts[i].y - y)
        .stroke({ width: 0.6 + 2.6 * k, color: col, alpha: 0.05 + 0.5 * k * k, cap: 'round' });
    }
  }

  function updateHold(rec, queued, s) {
    if (!queued) { if (rec.hold) { rec.hold.bg.destroy(); rec.hold.text.destroy(); rec.hold = null; } return; }
    if (!rec.hold) {
      const bg = new PIXI.Graphics(); bg.eventMode = 'none';
      const text = ST.makeText('HOLD', { size: 10, color: U.pal('warn') }); text.anchor.set(0.5, 0.5);
      rec.root.addChild(bg, text);
      rec.hold = { bg, text, last: '' };
    }
    const days = Math.max(0, Sim.now() - (rec.ship.waitStart || 0));
    const str = 'HOLD ' + days.toFixed(1) + 'd';
    if (str !== rec.hold.last) {
      rec.hold.last = str; rec.hold.text.text = str;
      const pw = Math.ceil(rec.hold.text.width + 10), ph = 14, pyt = -rec.L - 8 - ph, pxl = -pw / 2;
      const warn = U.int(U.pal('warn')), bg = rec.hold.bg;
      bg.clear();
      bg.rect(pxl, pyt, pw, ph).fill({ color: 0x04050A, alpha: 0.8 });
      const bl = 8, bx0 = pxl - 2, by0 = pyt - 2, bx1 = pxl + pw + 2, by1 = pyt + ph + 2;
      bg.moveTo(bx0, by0 + bl).lineTo(bx0, by0).lineTo(bx0 + bl, by0).moveTo(bx1 - bl, by1).lineTo(bx1, by1).lineTo(bx1, by1 - bl).stroke({ width: 1, color: warn });
      rec.hold.text.position.set(0, pyt + ph / 2 + 0.5);
    }
  }

  function updateVector(rec, ship) {
    const e = rec.entry;
    if (e.state !== ship.state) { if (ship.state === 'approach' && e.state === 'queue') { e.x0 = ship.x; e.y0 = ship.y; } e.state = ship.state; }
    const show = ship.state === 'approach' && ship.target && ST.tier > 0;
    const key = show ? `${e.x0.toFixed(2)},${e.y0.toFixed(2)}-${ship.target.x},${ship.target.y}` : '';
    if (key === rec.vectorKey) return;
    rec.vectorKey = key;
    const g = rec.vector; g.clear();
    if (!show) return;
    const ax = wx(e.x0), ay = wy(e.y0), bx = wx(ship.target.x), by = wy(ship.target.y);
    const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
    const cut = Math.max(0, L - 2 * CELL);
    const ivory = U.int(U.pal('ivory')), ice = U.int(U.pal('ice'));
    for (let d = 0; d < L; d += 8) {
      const far = d >= cut;
      g.circle(ax + ux * d, ay + uy * d, far ? 1.2 : 0.9).fill({ color: far ? ice : ivory, alpha: far ? 0.28 : 0.1 });
    }
  }

  // ---------------------------------------------------------------- choreography (v1 9.3 / 9.5)
  function onDock(ship) {
    if (!ship || !ship.dock) return;
    const cx = wx(ship.dock.c + 0.5), cy = wy(ship.dock.r + 0.5);
    EngineFX.ring(cx, cy, 0.2 * CELL, 0.6 * CELL, U.pal('ice'), 300, 1.5);
    const path = EngineWorld.pathToStorage(ship.dock.r, ship.dock.c);
    if (path && path.length > 1) {
      const bought = ship.trades.some(t => /^Bought/.test(t)), sold = ship.trades.some(t => /^(Sold|Took)/.test(t));
      if (bought) EngineFX.motes(path, U.pal('amber'), 3, 600, 'out');
      if (sold) EngineFX.motes(path.slice().reverse(), U.pal('amber'), 3, 600, 'out');
    }
  }
  function onDepart(ship) {
    if (!ship) return;
    const rec = S.recs.get(ship);
    if (rec) rec.departAt = U.nowMs();
    if (!(ship.earned > 0)) return;
    // credits motes toward the HUD credits readout (UI.anchor) or the top-left of the host
    let target = { x: 16, y: 16 };
    try {
      if (typeof UI !== 'undefined' && UI && typeof UI.anchor === 'function') {
        const el = UI.anchor('credits');
        if (el) { const r = el.getBoundingClientRect(), h = ST.host.getBoundingClientRect(); target = { x: r.left + r.width / 2 - h.left, y: r.top + r.height / 2 - h.top }; }
      }
    } catch (e) { /* anchor unavailable */ }
    const tw = CAM.screenToWorld(target.x, target.y);
    EngineFX.motes([{ x: wx(ship.x), y: wy(ship.y) }, tw], U.pal('amber-hi'), 6, 600, 'in');
  }
  // Create the record at spawn so the approach vector starts exactly at the entry point.
  function onSpawn(ship) { if (ship && S.vectors && !S.recs.has(ship)) S.recs.set(ship, createRec(ship)); }

  // ---------------------------------------------------------------- queries
  function shipAt(x, y) {
    const s = (typeof Sim !== 'undefined' && Sim) ? Sim.state : null; if (!s) return null;
    let best = null, bd = Infinity;
    for (const sh of s.ships) {
      const d = Math.hypot(x - wx(sh.x), y - wy(sh.y)), L = halfLength(sh.cls) + 4;
      if (d < L && d < bd) { bd = d; best = sh; }
    }
    return best;
  }

  function init() {
    S.vectors = new PIXI.Container(); S.vectors.eventMode = 'none';
    ST.layers.lanes.addChild(S.vectors);
    S.band = EngineWorld.band;
  }

  return {
    init, update, onDock, onDepart, onSpawn, shipAt,
    get hover() { return S.hover; }, set hover(v) { S.hover = v || null; },
  };
})();

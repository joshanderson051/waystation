// ============================================================
// WAYSTATION v2 — engine/world.js (Engineer E)
// The station layer (DESIGN2.md 3.1 texture baking, 3.4): plates baked
// from ART[id] per zoom band, soft shadows, trusses with the powered
// seam and running lights, live lit/tell canvases on the emissive layer
// (dock LEDs, cores, lamps), hero glows, scaffolds with progress rings
// and timers (Meta.build), bank chips (Meta.hopper), upgrade ticks
// (Meta.upgrade), hover / selection / placement feedback, floaters
// hand-off, and Engine.thumbnail.
//
// World units: CSS px at zoom 1; cell (r, c) at (c*CELL, r*CELL).
// Reads Sim.state and the Meta read helpers every frame; never writes them.
// Classic script: exports the global `EngineWorld`.
// ============================================================
'use strict';

const EngineWorld = (() => {
  const U = EngineUtil, ST = EngineStage, CAM = EngineCamera;
  const CELL = ST.CELL, TAU = U.TAU, keyOf = U.keyOf;

  const PREFIX = {
    dock: 'DK', warehouse: 'WH', solar: 'SO', fuel: 'FU', quarters: 'QU', cantina: 'CA', comms: 'CO', market: 'MA',
    rec: 'RE', hydro: 'HY', clinic: 'CL', habitat: 'HA', reactor: 'RX', customs: 'CU', security: 'SE', school: 'SC',
    bank: 'BA', plaza: 'PL', menagerie: 'ME', refinery: 'RF', shipyard: 'SH', observatory: 'OB', gate: 'GA', hub: 'HB',
  };
  const CLASS_B = { cantina: 1, rec: 1, school: 1, customs: 1, observatory: 1, fuel: 1, hydro: 1 };
  const REDUCED_KEEP = { security: 1, habitat: 1, dock: 1 };
  const OFFLINE = { plate: '#2A2F3D', rim: '#55596A', strip: '#55596A', sil: '#6C7284' };
  const HERO = { hub: { color: 'ivory', r: 16, a: 0.35 }, reactor: { color: '#9FE8D8', r: 12, a: 0.4 }, gate: { color: 'ice', r: 20, a: 0.4 } };
  const LIVE_FPS = [4, 8, 12];               // live canvas redraw rate per tier

  const S = {
    stateRef: null, rows: 0, cols: 0, cellCount: 0,
    cells: [], byKey: new Map(), dist: new Map(), tags: new Map(), dockInfo: new Map(), spars: [],
    station: null, gridBox: null,
    band: 1.25, cellDev: 0, pad: 0, k: 1,
    trussG: null, seamG: null, trussDirty: true, runLights: [], growCell: null,
    overlay: { hover: null, hoverHalo: null, sel: null, selHalo: null, place: null, ghost: null, reason: null, reasonBg: null, lane: null },
    hoverKey: null, hoverT0: 0, selKey: null, selT0: 0, ghostPos: null,
    pops: new Map(), dockState: new Map(), lastStock: null, stockChangedAt: -1e9,
    shipsByDock: new Map(), T: null, flags: null, trends: null,
    pointer: null, bAllowed: new Set(), bFrame: -1,
    placing: null, selected: null, hover: null,
    floaters: new WeakMap(),
    dotsG: null, stationKey: '',
  };

  const hasMeta = fn => typeof Meta !== 'undefined' && Meta && typeof Meta[fn] === 'function';
  const metaBuild = (r, c) => { if (!hasMeta('build')) return null; try { return Meta.build(r, c); } catch (e) { return null; } };
  const metaHopper = (r, c) => { if (!hasMeta('hopper')) return null; try { return Meta.hopper(r, c); } catch (e) { return null; } };
  const metaUpgrade = (r, c) => { if (!hasMeta('upgrade')) return null; try { return Meta.upgrade(r, c); } catch (e) { return null; } };
  const hasArt = id => typeof ART !== 'undefined' && ART && ART[id] && typeof ART[id] === 'object';
  const simState = () => (typeof Sim !== 'undefined' && Sim) ? Sim.state : null;

  // ---------------------------------------------------------------- geometry
  const wx = c => c * CELL, wy = r => r * CELL;
  function cellAt(x, y) {
    const c = Math.floor(x / CELL), r = Math.floor(y / CELL);
    return (r >= 0 && r < S.rows && c >= 0 && c < S.cols) ? { r, c } : null;
  }
  function cellCentre(r, c) { return { x: (c + 0.5) * CELL, y: (r + 0.5) * CELL }; }
  function occupied(r, c) { const s = simState(); return !!(s && s.grid[r] && s.grid[r][c]); }
  function neighbors(r, c) { return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]; }

  // ---------------------------------------------------------------- bake geometry per band
  // All plate/live canvases share one geometry per band so sprites align exactly.
  function setBand(band) {
    S.band = band;
    S.cellDev = Math.round(CELL * band * ST.dpr);
    S.pad = Math.ceil(S.cellDev * 0.08);
    S.k = S.cellDev / 100;                           // device px per unit
    S.worldPerDev = CELL / S.cellDev;
  }
  function placeCellSprite(sp, r, c) {
    sp.scale.set(S.worldPerDev);
    sp.position.set(wx(c) - S.pad * S.worldPerDev, wy(r) - S.pad * S.worldPerDev);
  }

  // ---------------------------------------------------------------- plate baking (8.0 rules, v1 bakeSprite)
  function roundRectPath(p, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    p.moveTo(x + r, y); p.arcTo(x + w, y, x + w, y + h, r); p.arcTo(x + w, y + h, x, y + h, r); p.arcTo(x, y + h, x, y, r); p.arcTo(x, y, x + w, y, r); p.closePath();
  }
  function hexPath(p, cx, cy, R) {
    for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + i * Math.PI / 3, x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R; if (i === 0) p.moveTo(x, y); else p.lineTo(x, y); }
    p.closePath();
  }
  function tagsOK() { return ST.fontsReady && CELL * S.band >= 48; }

  function plateTexture(id, variant, open, tag, lvl) {
    const key = `plate|${id}|${S.cellDev}|${variant}|${open}|${tag}|${lvl}`;
    const size = S.cellDev + S.pad * 2;
    return ST.bake(key, size, size, g => bakePlate(g, id, variant, open, tag, lvl));
  }
  function bakePlate(g, id, variant, open, tagStr, lvl) {
    const pad = S.pad, cd = S.cellDev, k = cd / 100, dpu = 100 / cd;
    const isHub = id === 'hub', off = variant === 'offline';
    const fam = U.famColor(id);
    const plateCol = off ? OFFLINE.plate : U.pal('hull');
    const rimCol = off ? OFFLINE.rim : U.pal('hull-rim');
    const stripCol = off ? OFFLINE.strip : fam;
    const silCol = off ? OFFLINE.sil : fam;
    g.translate(pad, pad); g.scale(k, k);
    g.lineJoin = 'round'; g.lineCap = 'round';
    const shape = inset => { const p = new Path2D(); if (isHub) hexPath(p, 50, 50, 48 + inset); else roundRectPath(p, 6 - inset, 6 - inset, 88 + 2 * inset, 88 + 2 * inset, 10 + inset); return p; };
    // plate: fill, key-light edges (2 device px), rim
    const plate = shape(0);
    g.fillStyle = plateCol; g.fill(plate);
    // subtle plate gradient: a hair lighter at the top so the hull reads as lit from above
    g.save(); g.clip(plate);
    const pg = g.createLinearGradient(0, 0, 0, 100);
    pg.addColorStop(0, 'rgba(255,255,255,.06)'); pg.addColorStop(1, 'rgba(0,0,0,.10)');
    g.fillStyle = pg; g.fillRect(0, 0, 100, 100);
    g.lineWidth = 2 * dpu;
    g.save(); g.translate(dpu, dpu); g.strokeStyle = 'rgba(255,255,255,.10)'; g.stroke(plate); g.restore();
    g.save(); g.translate(-dpu, -dpu); g.strokeStyle = 'rgba(0,0,0,.55)'; g.stroke(plate); g.restore();
    g.restore();
    g.strokeStyle = rimCol; g.lineWidth = isHub ? 2 : 1.5; g.stroke(plate);
    if (!isHub) {
      // signal strip: one segment at level 1, two at level 2, three at level 3 (3.1 upgrades)
      const segs = Math.max(1, Math.min(3, lvl | 0));
      const gap = 4, total = 68, w = (total - gap * (segs - 1)) / segs;
      g.fillStyle = stripCol;
      for (let i = 0; i < segs; i++) g.fillRect(16 + i * (w + gap), 7.5, w, 4);
      // rivets
      g.fillStyle = 'rgba(255,255,255,.3)';
      for (const [x, y] of [[13, 13], [87, 13], [13, 87], [87, 87]]) { g.beginPath(); g.arc(x, y, 2, 0, TAU); g.fill(); }
      // ivory level ticks along the left rim
      if (lvl >= 2) {
        g.fillStyle = U.pal('ivory');
        for (let i = 0; i < lvl - 1; i++) g.fillRect(8.5, 22 + i * 8, 3, 5);
      }
    }
    // silhouette by the art bundle (family colour, 55% fill / 100% stroke)
    const st = { color: silCol, lamp: U.pal('lamp'), cellPx: cd / ST.dpr, dpr: ST.dpr, variant, reduced: ST.reduced,
      dock: open ? { open, usable: true, approaching: false, docked: false, progress: 0, berth: 0 } : null };
    let drawn = false;
    if (hasArt(id) && typeof ART[id].silhouette === 'function') {
      g.save();
      try { ART[id].silhouette(g, k / ST.dpr, st); drawn = true; } catch (e) { drawn = false; }
      g.restore();
    }
    if (!drawn) {
      g.fillStyle = U.rgba(silCol, 0.55); g.strokeStyle = silCol; g.lineWidth = 2;
      const p = new Path2D(); if (isHub) hexPath(p, 50, 50, 34); else roundRectPath(p, 24, 24, 52, 52, 8);
      g.fill(p); g.stroke(p);
      g.fillStyle = U.pal('ink'); g.font = '600 28px "Barlow Condensed","Bahnschrift Condensed","Arial Narrow",sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(PREFIX[id] || id.slice(0, 2).toUpperCase(), 50, 51);
    }
    if (off) {
      g.save(); g.clip(plate);
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = Math.max(dpu, 1);
      g.beginPath(); for (let d = -100; d <= 200; d += 3) { g.moveTo(d, 0); g.lineTo(d - 100, 100); } g.stroke();
      g.restore();
    }
    if (tagStr) {
      const [reg, berth] = tagStr.split('|');
      g.textAlign = 'right'; g.textBaseline = 'alphabetic';
      if (reg) { g.font = '500 12px "JetBrains Mono","Cascadia Mono",Consolas,monospace'; g.fillStyle = U.rgba(U.pal('ivory'), 0.3); g.fillText(reg, 90, 90); }
      if (berth) { g.font = '500 14px "JetBrains Mono","Cascadia Mono",Consolas,monospace'; g.fillStyle = U.rgba(U.pal('ivory'), 0.55); g.fillText(berth, 90, 26); }
    }
  }

  // Soft drop shadow (black 35%, blur ~10 at zoom 1, offset 0/4), one texture per shape per band.
  function shadowTexture(isHub) {
    const size = S.cellDev + S.pad * 2;
    return ST.bake(`shadow|${isHub ? 'hex' : 'rect'}|${S.cellDev}`, size, size, g => {
      const k = S.cellDev / 100, blur = Math.max(2, 10 * S.band * ST.dpr * 0.6);
      g.translate(S.pad, S.pad); g.scale(k, k);
      const p = new Path2D(); if (isHub) hexPath(p, 50, 50, 48); else roundRectPath(p, 6, 6, 88, 88, 10);
      let blurred = false;
      try { g.filter = `blur(${blur / k}px)`; g.fillStyle = 'rgba(0,0,0,.6)'; g.fill(p); g.filter = 'none'; blurred = 'filter' in g; } catch (e) { blurred = false; }
      if (!blurred) { for (let i = 4; i >= 0; i--) { g.fillStyle = `rgba(0,0,0,${0.1 + i * 0.02})`; const q = new Path2D(); if (isHub) hexPath(q, 50, 50, 48 + i * 2); else roundRectPath(q, 6 - i * 2, 6 - i * 2, 88 + i * 4, 88 + i * 4, 10 + i * 2); g.fill(q); } }
    });
  }

  function bankTexture(full) {
    const r = Math.round(13 * S.band * ST.dpr);
    return ST.bake(`bank|${full ? 1 : 0}|${r}`, r * 2 + 4, r * 2 + 4, g => {
      const c = r + 2;
      g.beginPath(); g.arc(c, c, r, 0, TAU);
      const gr = g.createRadialGradient(c - r * 0.3, c - r * 0.35, r * 0.1, c, c, r);
      gr.addColorStop(0, U.pal('amber-hi')); gr.addColorStop(0.7, U.pal('amber')); gr.addColorStop(1, '#B9781E');
      g.fillStyle = gr; g.fill();
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = Math.max(1, r * 0.08); g.stroke();
      g.beginPath(); g.arc(c, c, r * 0.72, 0, TAU); g.strokeStyle = 'rgba(20,12,0,.35)'; g.lineWidth = Math.max(1, r * 0.06); g.stroke();
      const path = (typeof Icons !== 'undefined' && Icons && typeof Icons.path === 'function') ? Icons.path('credits') : null;
      const sz = r * 1.2;
      g.save(); g.translate(c - sz / 2, c - sz / 2); g.scale(sz / 24, sz / 24);
      g.strokeStyle = U.pal('on-accent'); g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round';
      if (path) g.stroke(path); else { g.beginPath(); g.arc(12, 12, 8, 0, TAU); g.stroke(); }
      g.restore();
    });
  }

  // ---------------------------------------------------------------- structure (rebuilt on Sim 'change')
  function structureStale(s) {
    if (S.stateRef !== s) return true;
    let n = 0;
    for (let r = 0; r < s.grid.length; r++) { const row = s.grid[r]; for (let c = 0; c < row.length; c++) if (row[c]) n++; }
    return n !== S.cellCount;
  }

  function rebuild() {
    const s = simState();
    const L = ST.layers;
    if (!s) {
      for (const rec of S.cells) destroyCell(rec);
      S.cells = []; S.byKey.clear(); S.spars = []; S.trussDirty = true; S.stateRef = null; S.cellCount = 0;
      if (S.trussG) S.trussG.clear(); if (S.seamG) S.seamG.clear();
      return;
    }
    S.rows = s.grid.length; S.cols = s.grid[0] ? s.grid[0].length : 0;
    const cells = [];
    for (let r = 0; r < S.rows; r++) for (let c = 0; c < S.cols; c++) if (s.grid[r][c]) cells.push({ r, c, m: s.grid[r][c] });
    const occ = new Set(cells.map(x => keyOf(x.r, x.c)));

    // BFS distances from the hub
    const dist = new Map(), hk = keyOf(s.hub.r, s.hub.c);
    if (occ.has(hk)) {
      dist.set(hk, 0);
      const q = [[s.hub.r, s.hub.c]];
      while (q.length) {
        const [r, c] = q.shift(), d = dist.get(keyOf(r, c));
        for (const [nr, nc] of neighbors(r, c)) { const k = keyOf(nr, nc); if (occ.has(k) && !dist.has(k)) { dist.set(k, d + 1); q.push([nr, nc]); } }
      }
    }
    S.dist = dist;

    // registry tags and berth numbers
    const byId = new Map();
    for (const x of cells) { if (!byId.has(x.m.id)) byId.set(x.m.id, []); byId.get(x.m.id).push(x); }
    const order = (a, b) => ((a.m.built ?? -1) - (b.m.built ?? -1)) || (a.r - b.r) || (a.c - b.c);
    const tags = new Map();
    for (const [id, arr] of byId) {
      arr.sort(order);
      arr.forEach((x, i) => tags.set(keyOf(x.r, x.c), { reg: id === 'hub' ? '' : `${PREFIX[id] || id.slice(0, 2).toUpperCase()}-${String(i + 1).padStart(2, '0')}`, nn: i + 1, berth: 0 }));
    }
    const docks = cells.filter(x => x.m.id !== 'hub' && (MODULES[x.m.id].docks || 0) > 0).sort(order);
    if (tags.has(hk)) tags.get(hk).berth = 1;
    docks.forEach((x, i) => { tags.get(keyOf(x.r, x.c)).berth = i + 2; });
    S.tags = tags;

    // dock open sides from Sim.berthPoint
    const dockInfo = new Map();
    for (const x of cells) {
      if (!((MODULES[x.m.id].docks || 0) > 0)) continue;
      const bp = Sim.berthPoint(x.r, x.c);
      let open = null;
      if (bp) { const dx = bp.x - (x.c + 0.5), dy = bp.y - (x.r + 0.5); open = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n'); }
      dockInfo.set(keyOf(x.r, x.c), { open, usable: !!bp, berth: (tags.get(keyOf(x.r, x.c)) || {}).berth || 0, bp });
    }
    S.dockInfo = dockInfo;

    // spars, oriented hub-side -> far side; new spars touching growCell are born now
    const old = new Map(S.spars.map(sp => [sp.key, sp]));
    const spars = [], grow = S.growCell;
    for (const x of cells) {
      for (const [nr, nc] of [[x.r, x.c + 1], [x.r + 1, x.c]]) {
        if (!occ.has(keyOf(nr, nc))) continue;
        const key = keyOf(x.r, x.c) + '-' + keyOf(nr, nc);
        const da = dist.get(keyOf(x.r, x.c)) ?? 999, db = dist.get(keyOf(nr, nc)) ?? 999;
        let a = { r: x.r, c: x.c }, b = { r: nr, c: nc };
        if (db < da) { a = { r: nr, c: nc }; b = { r: x.r, c: x.c }; }
        const prev = old.get(key);
        let born = prev ? prev.born : -1e12;
        if (!prev && grow && ((grow.r === x.r && grow.c === x.c) || (grow.r === nr && grow.c === nc))) born = grow.t;
        spars.push({ key, a, b, born, phase: (b.r * 7 + b.c * 13) * 0.37 });
      }
    }
    S.growCell = null; S.spars = spars; S.trussDirty = true;

    // cell records: keep the ones whose id is unchanged, create the rest
    const keep = new Map();
    for (const x of cells) {
      const key = keyOf(x.r, x.c);
      let rec = S.byKey.get(key);
      if (rec && rec.id !== x.m.id) { destroyCell(rec); rec = null; }
      if (!rec) rec = createCell(x.r, x.c, x.m.id);
      keep.set(key, rec);
    }
    for (const [key, rec] of S.byKey) if (!keep.has(key)) destroyCell(rec);
    S.byKey = keep;
    S.cells = cells.map(x => keep.get(keyOf(x.r, x.c)));
    // draw order: by row then column so lower plates overlap shadows naturally
    S.cells.sort((a, b) => (a.r - b.r) || (a.c - b.c));
    S.cells.forEach(rec => { L.world.plates.addChild(rec.plate); L.world.shadow.addChild(rec.shadow); });

    // station box (occupied cells) and grid box, world px
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of cells) { x0 = Math.min(x0, wx(x.c)); y0 = Math.min(y0, wy(x.r)); x1 = Math.max(x1, wx(x.c + 1)); y1 = Math.max(y1, wy(x.r + 1)); }
    S.station = cells.length ? { x0, y0, x1, y1 } : null;
    S.gridBox = { x0: 0, y0: 0, x1: S.cols * CELL, y1: S.rows * CELL };
    CAM.setStation(S.station, S.gridBox);
    // lanes end at the station box and the planet keeps clear of it: re-lay space when the box changes
    const stationKey = S.station ? [x0, y0, x1, y1, S.cols, S.rows].join(',') : '';
    if (stationKey !== S.stationKey) { S.stationKey = stationKey; EngineSpace.setStation(); }

    if (S.stateRef !== s) { S.stateRef = s; S.lastStock = null; S.pops.clear(); S.dockState.clear(); S.hoverKey = S.selKey = null; }
    S.cellCount = cells.length;
    buildDots();
  }

  function createCell(r, c, id) {
    const rec = {
      key: keyOf(r, c), r, c, id, def: MODULES[id],
      plate: new PIXI.Sprite(), shadow: new PIXI.Sprite(), live: null, glow: null,
      liveNext: Math.random() * 0.2, liveKey: '', bakeKey: '',
      scaffold: null, bank: null, bankT0: 0, lvl: 1, building: false,
    };
    rec.plate.eventMode = 'none'; rec.shadow.eventMode = 'none';
    rec.shadow.alpha = 0.35;
    const hero = HERO[id];
    if (hero) {
      const color = hero.color[0] === '#' ? hero.color : U.pal(hero.color);
      rec.glow = ST.sprite(ST.glowTexture(color, 32), { blend: 'add', alpha: hero.a });
      rec.glow.position.set(wx(c) + CELL / 2, wy(r) + CELL / 2);
      ST.layers.world.emissive.addChild(rec.glow);
    }
    return rec;
  }
  function destroyCell(rec) {
    rec.plate.destroy(); rec.shadow.destroy();
    if (rec.glow) rec.glow.destroy();
    if (rec.live) { rec.live.sprite.destroy(); ST.destroyTexture(rec.live.tex); rec.live = null; }
    hideScaffold(rec); hideBank(rec);
  }

  // Ensure the plate texture and live canvas match the current band / variant / tag / level.
  function refreshBake(rec, variant) {
    const open = (rec.id !== 'hub' && (rec.def.docks || 0) > 0) ? ((S.dockInfo.get(rec.key) || {}).open || 'e') : '';
    const tagStr = tagStringFor(rec);
    const key = `${S.cellDev}|${variant}|${open}|${tagStr}|${rec.lvl}`;
    if (key === rec.bakeKey) return;
    rec.bakeKey = key;
    rec.plate.texture = plateTexture(rec.id, variant, open, tagStr, rec.lvl).texture;
    rec.shadow.texture = shadowTexture(rec.id === 'hub').texture;
    placeCellSprite(rec.plate, rec.r, rec.c);
    placeCellSprite(rec.shadow, rec.r, rec.c);
    rec.shadow.y += 4;
    if (!rec.live || rec.live.size !== S.cellDev + S.pad * 2) {
      if (rec.live) { rec.live.sprite.destroy(); ST.destroyTexture(rec.live.tex); }
      const size = S.cellDev + S.pad * 2;
      const canvas = U.makeCanvas(size, size);
      const tex = ST.textureFromCanvas(canvas);
      const sprite = new PIXI.Sprite(tex); sprite.eventMode = 'none';
      ST.layers.world.emissive.addChild(sprite);
      rec.live = { canvas, ctx: canvas.getContext('2d'), tex, sprite, size };
      rec.liveKey = '';
      rec.liveNext = 0;
    }
    placeCellSprite(rec.live.sprite, rec.r, rec.c);
    if (rec.glow) { const hero = HERO[rec.id]; rec.glow.scale.set((hero.r * 2 * 1.6) / 64); }
  }
  function tagStringFor(rec) {
    if (!tagsOK()) return '';
    const t = S.tags.get(rec.key); if (!t) return '';
    const berth = (rec.id !== 'hub' && (rec.def.docks || 0) > 0 && t.berth) ? String(t.berth).padStart(2, '0') : '';
    return (t.reg || '') + '|' + berth;
  }

  // ---------------------------------------------------------------- per-frame shared state (8.2)
  function frameShared(s) {
    const T = Sim.totals();
    const byDock = S.shipsByDock; byDock.clear();
    let linerNear = false;
    const hx = s.hub.c + 0.5, hy = s.hub.r + 0.5;
    for (const sh of s.ships) {
      if (sh.dock && (sh.state === 'approach' || sh.state === 'docked')) byDock.set(keyOf(sh.dock.r, sh.dock.c), sh);
      if (sh.cls === 'liner' && Math.hypot(sh.x - hx, sh.y - hy) < 6) linerNear = true;
    }
    if (S.lastStock !== null && T.stockTotal !== S.lastStock) S.stockChangedAt = U.nowMs();
    S.lastStock = T.stockTotal;
    S.T = T;
    S.flags = {
      flare: !!T.flare,
      festival: s.day < ((s.fx && s.fx.festivalUntil) || 0),
      alert: ST.condition === 'alert',
      loan: Object.values(s.companies).some(c => !!c.loan),
      converting: (s.stock.ore || 0) >= 6,
      xeno: (s.stock.xenofauna || 0) > 0,
      linerNear, shipAdjacent: false,
      stockChanged: U.nowMs() - S.stockChangedAt < 400,
    };
    S.trends = T.hasMarket ? marketTrends() : null;
  }
  function marketTrends() {
    const arr = GOOD_IDS.map(g => { const b = GOODS[g].base, d = Sim.effPrice(g) - b; return { k: Math.abs(d) / b, s: d > b * 0.02 ? 1 : d < -b * 0.02 ? -1 : 0 }; });
    arr.sort((a, b) => b.k - a.k);
    return arr.slice(0, 4).map(x => x.s);
  }
  function tellClassOf(id) {
    if (hasArt(id) && (ART[id].tellClass === 'A' || ART[id].tellClass === 'B')) return ART[id].tellClass;
    return CLASS_B[id] ? 'B' : 'A';
  }
  // Class-B budget (8.0): within 3 cells of the pointer or all when <= 12 modules; at most 16; none at tier 0.
  function bTellBudget() {
    if (S.bFrame === ST.frame) return S.bAllowed;
    S.bFrame = ST.frame;
    const allowed = new Set();
    S.bAllowed = allowed;
    if (ST.tier === 0 || ST.reduced || CELL * CAM.zoom < 44) return allowed;
    const few = (S.T.modules + 1) <= 12, cand = [];
    for (const rec of S.cells) {
      if (tellClassOf(rec.id) !== 'B') continue;
      let d;
      if (S.pointer) d = Math.hypot(wx(rec.c + 0.5) - S.pointer.x, wy(rec.r + 0.5) - S.pointer.y) / CELL; else d = few ? 0 : 99;
      if (few || d <= 3) cand.push({ k: rec.key, d });
    }
    cand.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(16, cand.length); i++) allowed.add(cand[i].k);
    return allowed;
  }

  function buildSt(rec, s, powered) {
    const { id, key, r, c, def } = rec, T = S.T;
    let dock = null;
    if ((def.docks || 0) > 0) {
      const di = S.dockInfo.get(key) || { open: null, usable: false, berth: 0 };
      const sh = S.shipsByDock.get(key);
      const docked = !!(sh && sh.state === 'docked');
      let progress = 0;
      if (docked) { const dd = SHIP_CLASSES[sh.cls].dockDays || 1; progress = U.clamp(1 - (sh.dockedUntil - Sim.now()) / dd, 0, 1); }
      let ds = S.dockState.get(key);
      if (!ds) { ds = { docked, at: -1e12 }; S.dockState.set(key, ds); }
      else if (ds.docked !== docked) { ds.docked = docked; ds.at = U.nowMs(); }
      const kc = U.easeOutCubic((U.nowMs() - ds.at) / 300);
      dock = { open: di.open, usable: di.usable, approaching: !!(sh && sh.state === 'approach'), docked, progress, berth: di.berth, clamp: docked ? kc : 1 - kc };
    }
    let ratio = 0, crowd = 0;
    if (id === 'quarters') ratio = T.beds ? Math.min(1, T.visitors / T.beds) : 0;
    else if (id === 'habitat') ratio = T.homes ? Math.min(1, s.residents / T.homes) : 0;
    else if (id === 'warehouse') ratio = T.storage ? Math.min(1, T.stockTotal / T.storage) : 0;
    else if (id === 'plaza') { crowd = U.clamp(Math.round((s.residents || 0) / 5), 0, 6); ratio = Math.min(1, (s.residents || 0) / 30); }
    const load = T.produced > 0 ? T.used / T.produced : (T.used > 0 ? 2 : 0);
    let shipAdjacent = false;
    for (const [nr, nc] of neighbors(r, c)) { const sh = S.shipsByDock.get(keyOf(nr, nc)); if (sh && sh.state === 'docked') { shipAdjacent = true; break; } }
    return {
      color: U.famColor(id), lamp: U.pal('lamp'),
      T, efficiency: T.efficiency, powered,
      hover: !!(S.hover && S.hover.r === r && S.hover.c === c), selected: !!(S.selected && S.selected.r === r && S.selected.c === c), reduced: ST.reduced,
      cellPx: S.cellDev / ST.dpr, dpr: ST.dpr, dock, ratio, crowd, load, day: s.day + s.t,
      trends: id === 'market' ? S.trends : null, flags: Object.assign({}, S.flags, { shipAdjacent }),
    };
  }

  // ---------------------------------------------------------------- live canvas (lit + tell + status)
  function liveStaticKey(rec, st, powered, offline) {
    // inputs that change what `lit` draws; a change forces a redraw even at tier 0
    const d = st.dock;
    return [powered ? 1 : 0, offline ? 1 : 0, Math.round(st.ratio * 9), st.crowd, Math.round(st.load * 10), d ? (d.docked ? 'd' : d.approaching ? 'a' : d.usable ? 'f' : 'b') + Math.round(d.progress * 50) + Math.round(d.clamp * 10) : '',
      st.flags.flare ? 1 : 0, st.flags.festival ? 1 : 0, st.flags.alert ? 1 : 0, st.flags.loan ? 1 : 0, st.flags.converting ? 1 : 0, st.flags.xeno ? 1 : 0, st.flags.linerNear ? 1 : 0, st.flags.shipAdjacent ? 1 : 0, st.flags.stockChanged ? 1 : 0,
      st.efficiency < 1 ? 1 : 0, st.hover ? 1 : 0, st.selected ? 1 : 0].join(',');
  }

  function redrawLive(rec, s, st, powered, offline) {
    const lv = rec.live, g = lv.ctx, k = S.k, u = S.cellDev / (100 * ST.dpr);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, lv.size, lv.size);
    g.translate(S.pad, S.pad); g.scale(k, k);
    const art = hasArt(rec.id) ? ART[rec.id] : null;
    if (art) {
      if (!offline && typeof art.lit === 'function') { g.save(); try { art.lit(g, u, st); } catch (e) { /* art error must not kill the frame */ } g.restore(); }
      if (typeof art.tell === 'function' && tellAllowed(rec)) {
        g.save();
        const frozen = !powered || CELL * CAM.zoom < 36 || (ST.reduced && !REDUCED_KEEP[rec.id]);
        const t = frozen ? 0 : ST.tellTime + (rec.r * 7 + rec.c * 13) * 0.37;
        try { art.tell(g, u, t, st); } catch (e) { /* ignore */ }
        g.restore();
      }
    }
    // power shortage: dashed warn ring rotating 1 rev / 12 s + 6u triangle, on every consumer
    if (S.T.efficiency < 1 && rec.def.power < 0) {
      const warn = U.pal('warn'), inset = 2, rad = 12, w = 100 - 2 * inset, perim = 4 * w - (8 - TAU) * rad;
      g.save(); g.strokeStyle = warn; g.lineWidth = 1 / k * ST.dpr; g.setLineDash([4 / k, 3 / k]);
      g.lineDashOffset = -((ST.tellTime / 12) % 1) * perim;
      const p = new Path2D(); roundRectPath(p, inset, inset, w, w, rad); g.stroke(p); g.setLineDash([]);
      g.fillStyle = warn; g.beginPath(); g.moveTo(92, 5); g.lineTo(95, 11); g.lineTo(89, 11); g.closePath(); g.fill();
      g.restore();
    }
    ST.updateTexture(lv.tex);
    // shipyard crane sparks (art-mod-b calls the v1 FX global, which the engine does not define)
    if (rec.id === 'shipyard' && powered && st.flags.shipAdjacent && !ST.reduced && ST.tier > 0) {
      const t = ST.tellTime + (rec.r * 7 + rec.c * 13) * 0.37, leg = Math.floor(t / 3), f = U.easeInOutSine((t % 3) / 3);
      const x = (leg % 2 ? 74 - 48 * f : 26 + 48 * f) / 100, y = 0.38;
      if (Math.floor(t * 2) !== rec.sparkBucket) { rec.sparkBucket = Math.floor(t * 2); EngineFX.sparks(wx(rec.c) + x * CELL, wy(rec.r) + y * CELL, U.pal('ice-hi'), 1, 350); }
    }
  }
  function tellAllowed(rec) {
    if (rec.id === 'hub' || rec.id === 'market') return true;        // static geometry lives in their tells
    if (CELL * CAM.zoom < 36) return false;
    if (ST.reduced) return !!REDUCED_KEEP[rec.id];
    if (tellClassOf(rec.id) === 'B') return bTellBudget().has(rec.key);
    return true;
  }

  // ---------------------------------------------------------------- scaffold (3.4)
  function showScaffold(rec, b) {
    if (!rec.scaffold) {
      const frame = new PIXI.Graphics(), ring = new PIXI.Graphics();
      frame.eventMode = ring.eventMode = 'none';
      const label = ST.makeText('0:00', { size: 13, color: U.pal('ice-hi') });
      label.anchor.set(0.5, 1);                    // sits inside its own cell, above the bottom edge (never over the cell below)
      const back = new PIXI.Graphics(); back.eventMode = 'none';
      const x = wx(rec.c), y = wy(rec.r), ice = U.int(U.pal('ice'));
      // hatched frame: 45° lines at 6u pitch clipped to the cell, dashed outline
      hatchCell(frame, x, y, CELL * 0.08, 1);
      frame.stroke({ width: 1, color: ice, alpha: 0.28 });
      const dash = 6, g2 = 4, per = 2 * (CELL - 4), seg = dash + g2;
      for (let p = 0; p < per * 2; p += seg) {
        const a = rectPoint(x + 2, y + 2, CELL - 4, p), b2 = rectPoint(x + 2, y + 2, CELL - 4, Math.min(p + dash, per * 2));
        if (sameEdge(p, Math.min(p + dash, per * 2), CELL - 4)) frame.moveTo(a.x, a.y).lineTo(b2.x, b2.y);
      }
      frame.stroke({ width: 1.5, color: ice, alpha: 0.7 });
      label.position.set(x + CELL / 2, y + CELL - 5);
      ST.layers.world.scaffold.addChild(frame, ring, back, label);
      rec.scaffold = { frame, ring, back, label, lastSpark: ST.time + Math.random(), lastText: '' };
    }
    const sc = rec.scaffold;
    const prog = b.totalMs > 0 ? U.clamp(1 - b.remainingMs / b.totalMs, 0, 1) : 0;
    const cx = wx(rec.c) + CELL / 2, cy = wy(rec.r) + CELL / 2, R = CELL * 0.62;
    sc.ring.clear();
    sc.ring.circle(cx, cy, R).stroke({ width: 2, color: U.int(U.pal('hairline-2')), alpha: 0.9 });
    // moveTo first: a Pixi v8 arc with no current point draws a line from the local origin
    if (prog > 0) sc.ring.moveTo(cx, cy - R).arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + prog * TAU).stroke({ width: 3, color: U.int(U.pal('ice')), alpha: 1, cap: 'round' });
    const secs = Math.max(0, Math.ceil(b.remainingMs / 1000)), m = Math.floor(secs / 60), s2 = secs % 60;
    const txt = m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s2).padStart(2, '0')}`;
    if (txt !== sc.lastText) {
      sc.lastText = txt; sc.label.text = txt;
      // dark pill behind the timer so it reads over the hatched plate
      const w = sc.label.width + 10, h = sc.label.height + 4;
      sc.back.clear().roundRect(sc.label.x - w / 2, sc.label.y - h + 1, w, h, 3).fill({ color: 0x04050A, alpha: 0.74 });
    }
    if (ST.time >= sc.lastSpark && ST.tier > 0 && !ST.reduced && !ST.paused) {
      sc.lastSpark = ST.time + 1.5;
      EngineFX.sparks(wx(rec.c) + CELL * (0.25 + Math.random() * 0.5), wy(rec.r) + CELL * (0.25 + Math.random() * 0.5), U.pal('ice-hi'), 6, 320);
    }
  }
  // Diagonal hatch lines across the cell at (x, y): dir +1 = down-right (x - y = d), -1 = up-right (x + y = d).
  function hatchCell(g, x, y, pitch, dir) {
    if (dir > 0) {
      for (let d = -CELL + pitch; d < CELL; d += pitch) {
        const px0 = Math.max(0, d), px1 = Math.min(CELL, CELL + d);
        if (px1 > px0) g.moveTo(x + px0, y + px0 - d).lineTo(x + px1, y + px1 - d);
      }
    } else {
      for (let d = pitch; d < 2 * CELL; d += pitch) {
        const px0 = Math.max(0, d - CELL), px1 = Math.min(CELL, d);
        if (px1 > px0) g.moveTo(x + px0, y + d - px0).lineTo(x + px1, y + d - px1);
      }
    }
  }
  function rectPoint(x, y, s, p) {
    p = ((p % (4 * s)) + 4 * s) % (4 * s);
    if (p < s) return { x: x + p, y };
    if (p < 2 * s) return { x: x + s, y: y + (p - s) };
    if (p < 3 * s) return { x: x + s - (p - 2 * s), y: y + s };
    return { x, y: y + s - (p - 3 * s) };
  }
  function sameEdge(p0, p1, s) { return Math.floor(p0 / s) === Math.floor(Math.max(p0, p1 - 0.001) / s); }
  function hideScaffold(rec) {
    if (!rec.scaffold) return;
    rec.scaffold.frame.destroy(); rec.scaffold.ring.destroy(); rec.scaffold.back.destroy(); rec.scaffold.label.destroy();
    rec.scaffold = null;
  }

  // ---------------------------------------------------------------- bank chips (3.4)
  function showBank(rec, h) {
    if (!rec.bank) {
      const halo = ST.sprite(ST.glowTexture(U.pal('amber'), 32), { blend: 'add', alpha: 0 });
      const sprite = new PIXI.Sprite(); sprite.anchor.set(0.5); sprite.eventMode = 'none';
      ST.layers.world.emissive.addChild(halo, sprite);
      rec.bank = { sprite, halo, full: null, t0: ST.time };
    }
    const bk = rec.bank;
    if (bk.full !== !!h.full || bk.band !== S.band) {
      bk.full = !!h.full; bk.band = S.band;
      const tex = bankTexture(bk.full);
      bk.sprite.texture = tex.texture;
      bk.sprite.scale.set((26 / tex.w));
    }
    const pop = U.easeOutBack(Math.min(1, (ST.time - bk.t0) / 0.35));
    const bob = Math.sin(ST.time * TAU * 0.8 + rec.c * 0.9 + rec.r * 0.4) * 4;
    const cx = wx(rec.c) + CELL / 2, cy = wy(rec.r) - 18 + (ST.reduced ? 0 : bob);
    const sc = (bk.full ? 1.15 : 1) * pop;
    bk.sprite.position.set(cx, cy); bk.sprite.scale.set((26 / bankTexture(bk.full).w) * sc);
    bk.halo.position.set(cx, cy);
    bk.halo.alpha = bk.full ? 0.35 + 0.2 * Math.sin(ST.time * 3) : 0.12;
    bk.halo.scale.set(bk.full ? 1.1 : 0.7);
  }
  function hideBank(rec) {
    if (!rec.bank) return;
    rec.bank.sprite.destroy(); rec.bank.halo.destroy(); rec.bank = null;
  }
  function bankAt(x, y) {
    for (const rec of S.cells) {
      if (!rec.bank) continue;
      if (Math.hypot(x - rec.bank.sprite.x, y - rec.bank.sprite.y) <= 16) return { r: rec.r, c: rec.c };
    }
    return null;
  }
  function readyBanksNear(r, c, radius) {
    const out = [];
    for (const rec of S.cells) if (rec.bank && Math.abs(rec.r - r) + Math.abs(rec.c - c) <= radius) out.push({ r: rec.r, c: rec.c });
    return out;
  }
  function isScaffold(r, c) { const rec = S.byKey.get(keyOf(r, c)); return !!(rec && rec.scaffold); }

  // ---------------------------------------------------------------- trusses (3.4 / v1 7.7)
  function ensureTruss() {
    if (!S.trussG) {
      S.trussG = new PIXI.Graphics(); S.trussG.eventMode = 'none'; ST.layers.world.truss.addChild(S.trussG);
      S.seamG = new PIXI.Graphics(); S.seamG.eventMode = 'none'; ST.layers.world.emissive.addChild(S.seamG);
    }
  }
  function sparEnds(sp) {
    const ax = wx(sp.a.c + 0.5), ay = wy(sp.a.r + 0.5), bx = wx(sp.b.c + 0.5), by = wy(sp.b.r + 0.5);
    const age = U.nowMs() - sp.born;
    const p = age < 250 ? U.easeOutCubic(Math.max(0, age) / 250) : 1;
    return { ax, ay, bx: ax + (bx - ax) * p, by: ay + (by - ay) * p, growing: age < 250, full: bx, fullY: by };
  }
  function drawTruss() {
    ensureTruss();
    const g = S.trussG, sg = S.seamG;
    g.clear(); sg.clear();
    const w = 0.16 * CELL, hw = w / 2, inset = 0.44 * CELL;
    const truss = U.int(U.pal('truss')), edge = U.int(U.pal('hull-edge')), ice = U.int(U.pal('ice'));
    let growing = false;
    for (const sp of S.spars) {
      const e = sparEnds(sp);
      if (e.growing) growing = true;
      if (e.ay === e.by) {
        const x0 = Math.min(e.ax, e.bx), x1 = Math.max(e.ax, e.bx);
        g.rect(x0, e.ay - hw, x1 - x0, w).fill(truss);
        g.moveTo(x0 + (e.growing ? 0 : inset), e.ay - hw).lineTo(x1 - (e.growing ? 0 : inset), e.ay - hw)
          .moveTo(x0 + (e.growing ? 0 : inset), e.ay + hw).lineTo(x1 - (e.growing ? 0 : inset), e.ay + hw).stroke({ width: 1, color: edge });
        if (!e.growing) {
          g.rect(x0 + inset - 1.5, e.ay - 1.5, 3, 3).rect(x1 - inset - 1.5, e.ay - 1.5, 3, 3).fill(ice);
          sg.moveTo(x0 + inset, e.ay).lineTo(x1 - inset, e.ay);
        }
      } else {
        const y0 = Math.min(e.ay, e.by), y1 = Math.max(e.ay, e.by);
        g.rect(e.ax - hw, y0, w, y1 - y0).fill(truss);
        g.moveTo(e.ax - hw, y0 + (e.growing ? 0 : inset)).lineTo(e.ax - hw, y1 - (e.growing ? 0 : inset))
          .moveTo(e.ax + hw, y0 + (e.growing ? 0 : inset)).lineTo(e.ax + hw, y1 - (e.growing ? 0 : inset)).stroke({ width: 1, color: edge });
        if (!e.growing) {
          g.rect(e.ax - 1.5, y0 + inset - 1.5, 3, 3).rect(e.ax - 1.5, y1 - inset - 1.5, 3, 3).fill(ice);
          sg.moveTo(e.ax, y0 + inset).lineTo(e.ax, y1 - inset);
        }
      }
    }
    sg.stroke({ width: 1.5, color: ice, alpha: 1 });
    S.trussDirty = growing;
  }
  function updateRunLights() {
    const em = ST.layers.world.emissive;
    const want = (ST.tier > 0 && !ST.reduced) ? S.spars.length : 0;
    while (S.runLights.length < want) { const sp = ST.sprite(ST.glowTexture(U.pal('lamp'), 8, 'hard'), { blend: 'add' }); sp.scale.set(0.6); em.addChild(sp); S.runLights.push(sp); }
    while (S.runLights.length > want) S.runLights.pop().destroy();
    const inset = 0.44 * CELL, t = ST.tellTime;
    for (let i = 0; i < want; i++) {
      const sp = S.spars[i], lt = S.runLights[i];
      const ph = ((t + sp.phase) % 2.5 + 2.5) % 2.5;
      if (ph >= 1.2 || U.nowMs() - sp.born < 250) { lt.visible = false; continue; }
      const k = ph / 1.2;
      const ax = wx(sp.a.c + 0.5), ay = wy(sp.a.r + 0.5), bx = wx(sp.b.c + 0.5), by = wy(sp.b.r + 0.5);
      const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
      const sx = ax + ux * inset, sy = ay + uy * inset, tx = bx - ux * inset, ty = by - uy * inset;
      lt.visible = true; lt.position.set(sx + (tx - sx) * k, sy + (ty - sy) * k);
      lt.alpha = k < 0.15 ? k / 0.15 : k > 0.8 ? (1 - k) / 0.2 : 1;
    }
  }

  // ---------------------------------------------------------------- overlay: hover, selection, placement (3.4 / v1 10)
  function ensureOverlay() {
    const O = S.overlay; if (O.hover) return;
    const L = ST.layers.overlay;
    O.hoverHalo = ST.sprite(ST.glowTexture(U.pal('ivory'), 64), { blend: 'add', alpha: 0 });
    O.selHalo = ST.sprite(ST.glowTexture(U.pal('ivory'), 64), { blend: 'add', alpha: 0 });
    O.place = new PIXI.Graphics(); O.lane = new PIXI.Graphics(); O.hover = new PIXI.Graphics(); O.sel = new PIXI.Graphics();
    O.ghost = new PIXI.Sprite(); O.ghost.alpha = 0; O.ghost.visible = false;
    O.reasonBg = new PIXI.Graphics(); O.reason = ST.makeText('', { size: 11, color: U.pal('bad') }); O.reason.anchor.set(0.5, 0.5); O.reason.visible = false;
    S.dotsG = new PIXI.Graphics(); S.dotsG.alpha = 0;
    for (const x of [O.place, O.lane, O.hover, O.sel, O.reasonBg, S.dotsG]) x.eventMode = 'none';
    O.ghost.eventMode = 'none';
    L.addChild(S.dotsG, O.place, O.lane, O.hoverHalo, O.hover, O.ghost, O.selHalo, O.sel, O.reasonBg, O.reason);
  }
  function buildDots() {
    if (!S.dotsG) return;
    const g = S.dotsG; g.clear();
    for (let r = 0; r <= S.rows; r++) for (let c = 0; c <= S.cols; c++) g.rect(wx(c) - 0.75, wy(r) - 0.75, 1.5, 1.5);
    g.fill({ color: U.int(U.pal('ivory')), alpha: 1 });
  }
  function brackets(g, x, y, size, len, inset) {
    const x0 = x + inset, y0 = y + inset, x1 = x + size - inset, y1 = y + size - inset;
    g.moveTo(x0, y0 + len).lineTo(x0, y0).lineTo(x0 + len, y0)
      .moveTo(x1 - len, y0).lineTo(x1, y0).lineTo(x1, y0 + len)
      .moveTo(x1, y1 - len).lineTo(x1, y1).lineTo(x1 - len, y1)
      .moveTo(x0 + len, y1).lineTo(x0, y1).lineTo(x0, y1 - len);
  }
  function mapReason(why, def, s) {
    if (!why) return '';
    if (why === 'Occupied') return 'OCCUPIED';
    const m = why.match(/level\s+(\d+)/i);
    if (m) return `LOCKED · LEVEL ${m[1]}`;
    if (/credits/i.test(why)) return `NEED ${fmt(Math.max(0, def.cost - s.credits))} MORE CR`;
    if (/touch/i.test(why)) return 'NOT ADJACENT';
    return why.toUpperCase();
  }
  function advisoryFor(id, r, c, s) {
    const def = MODULES[id];
    if ((def.docks || 0) > 0) {
      const nb = neighbors(r, c).filter(([nr, nc]) => Sim.inBounds(nr, nc));
      if (nb.length && nb.every(([nr, nc]) => Sim.occupied(nr, nc))) return 'BERTH WILL BE BLOCKED';
    }
    for (const [nr, nc] of neighbors(r, c)) {
      if (!Sim.occupied(nr, nc)) continue;
      const m = s.grid[nr][nc];
      if (!((MODULES[m.id].docks || 0) > 0)) continue;
      const empties = neighbors(nr, nc).filter(([ar, ac]) => Sim.inBounds(ar, ac) && !Sim.occupied(ar, ac));
      if (empties.length === 1) { const tag = S.tags.get(keyOf(nr, nc)); return `BLOCKS BERTH ${String(tag ? tag.berth : 0).padStart(2, '0')}`; }
    }
    return null;
  }
  function previewOpenSide(id, r, c) {
    if (id === 'hub' || !((MODULES[id].docks || 0) > 0)) return '';
    const bp = Sim.berthPoint(r, c);
    if (!bp) return 'e';
    const dx = bp.x - (c + 0.5), dy = bp.y - (r + 0.5);
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
  }

  function drawOverlay(s, dt) {
    ensureOverlay();
    const O = S.overlay, ivory = U.int(U.pal('ivory')), bad = U.int(U.pal('bad')), nowM = U.nowMs();
    // grid dots fade in while placing
    const dotsTarget = S.placing ? 0.16 : 0;
    S.dotsG.alpha += (dotsTarget - S.dotsG.alpha) * Math.min(1, dt / 0.16);

    // hover: ivory outline 1.5 px + soft halo (not while placing)
    O.hover.clear();
    const hv = S.hover;
    if (!S.placing && hv && s.grid[hv.r] && s.grid[hv.r][hv.c]) {
      const key = keyOf(hv.r, hv.c);
      if (key !== S.hoverKey) { S.hoverKey = key; S.hoverT0 = nowM; }
      const k = Math.min(1, (nowM - S.hoverT0) / 140);
      O.hover.roundRect(wx(hv.c) + 1.5, wy(hv.r) + 1.5, CELL - 3, CELL - 3, 6).stroke({ width: 1.5, color: ivory, alpha: 0.6 * k });
      O.hoverHalo.position.set(wx(hv.c) + CELL / 2, wy(hv.r) + CELL / 2); O.hoverHalo.scale.set(CELL * 1.7 / 128); O.hoverHalo.alpha = 0.14 * k;
    } else { S.hoverKey = null; O.hoverHalo.alpha = 0; }

    // selection: brackets drawing in over 160 ms, breathing 2 px on a 3 s sine, focus glow
    O.sel.clear();
    const sel = S.selected;
    if (sel && s.grid[sel.r] && s.grid[sel.r][sel.c]) {
      const key = keyOf(sel.r, sel.c);
      if (key !== S.selKey) { S.selKey = key; S.selT0 = nowM; }
      const k = Math.min(1, (nowM - S.selT0) / 160), len = 10 * U.easeOutCubic(k);
      const breathe = ST.reduced ? 1 : 1 + Math.sin(ST.time * TAU / 3);
      brackets(O.sel, wx(sel.c) - breathe, wy(sel.r) - breathe, CELL + 2 * breathe, len, 0);
      O.sel.stroke({ width: 1.5, color: ivory, alpha: 1 });
      O.selHalo.position.set(wx(sel.c) + CELL / 2, wy(sel.r) + CELL / 2); O.selHalo.scale.set(CELL * 2.2 / 128);
      O.selHalo.alpha = (0.16 + 0.05 * Math.sin(ST.time * TAU / 3)) * k;
    } else { S.selKey = null; O.selHalo.alpha = 0; }

    // placement
    O.place.clear(); O.lane.clear();
    if (!S.placing) { O.ghost.visible = false; O.reason.visible = false; O.reasonBg.clear(); S.ghostPos = null; return; }
    const id = S.placing, def = MODULES[id];
    const legal = [], illegal = [];
    for (let r = 0; r < S.rows; r++) for (let c = 0; c < S.cols; c++) {
      if (s.grid[r][c]) continue;
      if (!neighbors(r, c).some(([nr, nc]) => Sim.occupied(nr, nc))) continue;
      (Sim.canPlace(id, r, c).ok ? legal : illegal).push({ r, c });
    }
    if (legal.length) {
      for (const { r, c } of legal) brackets(O.place, wx(c), wy(r), CELL, 7, 2);
      O.place.stroke({ width: 1.5, color: ivory, alpha: 0.55 + 0.15 * Math.sin(ST.time * TAU / 2.5) });
    }
    if (illegal.length) {
      for (const { r, c } of illegal) hatchCell(O.place, wx(c), wy(r), CELL / 7, -1);
      O.place.stroke({ width: 1, color: bad, alpha: 0.12 });
      for (const { r, c } of illegal) brackets(O.place, wx(c), wy(r), CELL, 7, 2);
      O.place.stroke({ width: 1.5, color: bad, alpha: 0.3 });
    }
    const h = S.hover;
    if (!h) { O.ghost.visible = false; O.reason.visible = false; O.reasonBg.clear(); S.ghostPos = null; return; }
    // ghost snaps to the hover cell (position lerps over 80 ms)
    const tx = wx(h.c), ty = wy(h.r);
    if (!S.ghostPos) S.ghostPos = { x: tx, y: ty };
    else { const k = Math.min(1, dt / 0.08); S.ghostPos.x = U.lerp(S.ghostPos.x, tx, k); S.ghostPos.y = U.lerp(S.ghostPos.y, ty, k); if (Math.abs(S.ghostPos.x - tx) < 0.2) S.ghostPos.x = tx; if (Math.abs(S.ghostPos.y - ty) < 0.2) S.ghostPos.y = ty; }
    const gx = S.ghostPos.x, gy = S.ghostPos.y, cx = gx + CELL / 2, cy = gy + CELL / 2;
    const occ = !!s.grid[h.r][h.c];
    const chk = Sim.canPlace(id, h.r, h.c);
    if (!occ) {
      // preview spars at 40%
      const w = 0.16 * CELL;
      for (const [nr, nc] of neighbors(h.r, h.c)) {
        if (!Sim.occupied(nr, nc)) continue;
        const nx = wx(nc + 0.5), ny = wy(nr + 0.5);
        if (nr === h.r) O.lane.rect(Math.min(cx, nx), cy - w / 2, Math.abs(nx - cx), w); else O.lane.rect(cx - w / 2, Math.min(cy, ny), w, Math.abs(ny - cy));
      }
      O.lane.fill({ color: U.int(U.pal('truss')), alpha: 0.4 });
      // dock: dotted ice lane two cells long on the open side
      if ((def.docks || 0) > 0) {
        const bp = Sim.berthPoint(h.r, h.c);
        if (bp) {
          const dx = Math.sign(bp.x - (h.c + 0.5)), dy = Math.sign(bp.y - (h.r + 0.5));
          for (let d = 0.5; d < 2.5; d += 0.12) O.lane.circle(cx + dx * CELL * d, cy + dy * CELL * d, 1);
          O.lane.fill({ color: U.int(U.pal('ice')), alpha: 0.7 });
        }
      }
      const tex = plateTexture(id, 'normal', previewOpenSide(id, h.r, h.c), '', 1);
      O.ghost.texture = tex.texture;
      O.ghost.visible = true; O.ghost.alpha = 0.45;
      O.ghost.tint = U.int(U.mix('#FFFFFF', U.famColor(id), 0.35));
      O.ghost.scale.set(S.worldPerDev);
      O.ghost.position.set(gx - S.pad * S.worldPerDev, gy - S.pad * S.worldPerDev);
    } else O.ghost.visible = false;
    // dashed outline: ivory, or bad on an illegal cell
    const col = chk.ok ? ivory : bad, dash = 5, gap = 3, per = CELL - 2, seg = dash + gap;
    for (let p = 0; p < per * 4; p += seg) {
      const p1 = Math.min(p + dash, per * 4);
      if (!sameEdge(p, p1, per)) continue;
      const a = rectPoint(gx + 1, gy + 1, per, p), b = rectPoint(gx + 1, gy + 1, per, p1);
      O.lane.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    O.lane.stroke({ width: 1.5, color: col, alpha: 0.9 });
    // reason (bad) or advisory (warn) plate under the cell
    let text = null, color = null;
    if (!chk.ok) { text = mapReason(chk.why, def, s); color = U.pal('bad'); }
    else { const adv = advisoryFor(id, h.r, h.c, s); if (adv) { text = adv; color = U.pal('warn'); } }
    O.reasonBg.clear();
    if (text) {
      O.reason.text = text; ST.setTextColor(O.reason, color); O.reason.visible = true;
      O.reason.position.set(cx, gy + CELL + 12);
      const bw = O.reason.width + 12, bh = 16;
      O.reasonBg.rect(cx - bw / 2, gy + CELL + 4, bw, bh).fill({ color: 0x04050A, alpha: 0.85 });
    } else O.reason.visible = false;
  }

  // ---------------------------------------------------------------- floaters (v1 9.6): Sim creates, the engine presents
  function handFloaters(s) {
    const list = Sim.floaters; if (!list || !list.length) return;
    const nowM = U.nowMs();
    for (const f of list) {
      if (S.floaters.has(f)) continue;
      const num = parseFloat(String(f.text).replace(/[^\d.-]/g, '')) || 0;
      const sign = String(f.text).trim()[0] === '-' ? -1 : 1;
      const e = { t0: nowM, x0: f.x, y0: f.y, value: Math.abs(num) * sign, sign, numeric: /\d/.test(f.text), handle: null };
      // coalesce into a live floater within 300 ms and 0.3 cells with the same sign
      let merged = false;
      for (const o of list) {
        if (o === f) continue;
        const oe = S.floaters.get(o);
        if (!oe || !oe.handle || !oe.numeric || !e.numeric) continue;
        if (nowM - oe.t0 < 300 && oe.sign === e.sign && Math.hypot(oe.x0 - f.x, oe.y0 - f.y) < 0.3) {
          oe.value += e.value; oe.handle.text = (oe.sign < 0 ? '-' : '+') + fmt(Math.abs(oe.value)); merged = true; break;
        }
      }
      if (!merged) e.handle = EngineFX.floaterWorld(wx(f.x), wy(f.y), f.text, floaterColor(f.color));
      S.floaters.set(f, e);
    }
  }
  const COMPANY_RAW = new Set((typeof COMPANIES !== 'undefined' ? COMPANIES : []).map(c => c.color));
  function floaterColor(raw) {
    const c = String(raw || '').toLowerCase();
    if (c === '#ff9d5a') return U.pal('warn');
    if (c === '#7ee787') return U.pal('good');
    if (COMPANY_RAW.has(raw)) return U.desatColor(raw, 0.15);
    return raw || U.pal('ink');
  }

  // ---------------------------------------------------------------- frame
  function update(dt) {
    const s = simState();
    const L = ST.layers;
    if (!s) { if (S.cells.length) rebuild(); L.cam.visible = false; return; }
    L.cam.visible = true;
    if (structureStale(s)) rebuild();
    frameShared(s);
    const band = ST.bandFor(CAM.zoom);
    if (band !== S.band || !S.cellDev) setBand(band);
    const short = S.T.efficiency < 1, tier = ST.tier, nowM = U.nowMs();
    const interval = 1 / LIVE_FPS[tier];
    const n = S.cells.length || 1;
    for (let i = 0; i < n; i++) {
      const rec = S.cells[i];
      if (!rec) continue;
      const offline = rec.id === 'solar' && S.T.flare;
      const up = metaUpgrade(rec.r, rec.c);
      rec.lvl = up && up.lvl ? Math.max(1, Math.min(3, up.lvl | 0)) : 1;
      refreshBake(rec, offline ? 'offline' : 'normal');
      // scaffold (under construction): dim plate, no live layer
      const b = metaBuild(rec.r, rec.c);
      const building = !!(b && b.building);
      if (building !== rec.building) { rec.building = building; if (!building) hideScaffold(rec); }
      if (building) showScaffold(rec, b);
      rec.plate.alpha = building ? 0.35 : 1;
      rec.shadow.alpha = building ? 0.15 : 0.35;
      rec.live.sprite.visible = !building;
      if (rec.glow) rec.glow.visible = !building;
      // bank chip
      const h = building ? null : metaHopper(rec.r, rec.c);
      if (h && h.ready) showBank(rec, h); else hideBank(rec);
      // commit pop / landing
      let scale = 1;
      const pop = S.pops.get(rec.key);
      if (pop) {
        const k = (nowM - pop.t0) / pop.ms;
        if (k >= 1) S.pops.delete(rec.key);
        else scale = pop.kind === 'land' ? 1.15 - 0.15 * U.easeOutBack(k) : 0.7 + 0.3 * U.easeOutBack(k);
      }
      applyScale(rec, scale);
      // live layer (lit + tell + status overlays)
      if (!building) {
        const powered = !offline && (rec.def.power >= 0 || !short);
        const st = buildSt(rec, s, powered);
        const sk = liveStaticKey(rec, st, powered, offline);
        const approachChase = !!(st.dock && st.dock.approaching && !st.dock.docked);
        const due = ST.time >= rec.liveNext || sk !== rec.liveKey;
        if (due && (tier > 0 || sk !== rec.liveKey || approachChase || rec.id === 'hub')) {
          rec.liveKey = sk;
          rec.liveNext = ST.time + (tier > 0 ? interval : (approachChase ? 0.25 : 1)) + (i % 7) * 0.004;
          redrawLive(rec, s, st, powered, offline);
        }
        if (rec.glow) {
          const hero = HERO[rec.id];
          rec.glow.alpha = hero.a * (powered ? 1 : 0.5) * (0.9 + 0.1 * Math.sin(ST.tellTime * 1.3 + rec.r));
        }
      }
    }
    // trusses: rebuild when dirty or growing; seam pulses with healthy power
    if (S.trussDirty || !S.trussG) drawTruss();
    if (S.seamG) S.seamG.alpha = short ? 0.08 : 0.28 + 0.22 * (0.5 + 0.5 * Math.sin(ST.tellTime * TAU / 3));
    updateRunLights();
    drawOverlay(s, dt);
    handFloaters(s);
  }
  function applyScale(rec, scale) {
    const cx = wx(rec.c) + CELL / 2, cy = wy(rec.r) + CELL / 2;
    for (const sp of [rec.plate, rec.live && rec.live.sprite]) {
      if (!sp) continue;
      sp.scale.set(S.worldPerDev * scale);
      sp.position.set(cx - (S.cellDev / 2 + S.pad) * S.worldPerDev * scale, cy - (S.cellDev / 2 + S.pad) * S.worldPerDev * scale);
    }
  }

  // ---------------------------------------------------------------- Sim / Meta event hooks (called by index.js)
  function onBuilt(d) {
    if (!d) return;
    const b = metaBuild(d.r, d.c);
    S.growCell = { r: d.r, c: d.c, t: U.nowMs() };
    if (b && b.building) { EngineFX.facade.buildStart(d.r, d.c); return; }
    S.pops.set(keyOf(d.r, d.c), { t0: U.nowMs(), ms: 180, kind: 'pop' });
    const cx = wx(d.c + 0.5), cy = wy(d.r + 0.5);
    EngineFX.sparks(cx, cy, U.famColor(d.id), 12, 300);
    EngineFX.ring(cx, cy, 0.5 * CELL, 1.3 * CELL, U.pal('ivory'), 400);
  }
  function onDemolished(d) { if (d) { S.pops.delete(keyOf(d.r, d.c)); S.hoverKey = null; } }
  function onBuildDone(d) {
    if (!d) return;
    S.pops.set(keyOf(d.r, d.c), { t0: U.nowMs(), ms: 280, kind: 'land' });
    const rec = S.byKey.get(keyOf(d.r, d.c)); if (rec) hideScaffold(rec);
    EngineFX.facade.buildDone(d.r, d.c);
  }
  function onUpgrade(d) {
    if (!d) return;
    S.pops.set(keyOf(d.r, d.c), { t0: U.nowMs(), ms: 280, kind: 'land' });
    EngineFX.facade.pulse(d.r, d.c, U.pal('ivory'));
  }
  function onHopper(d) { if (d) { const rec = S.byKey.get(keyOf(d.r, d.c)); if (rec && rec.bank) rec.bank.t0 = ST.time; } }

  // Truss path from a dock to the nearest warehouse (hub if none), for cargo motes (v1 9.5)
  function pathToStorage(r0, c0) {
    const s = simState(); if (!s) return null;
    const occ = new Set(S.cells.map(x => x.key));
    const hasWh = S.cells.some(x => x.id === 'warehouse');
    const isTarget = (r, c) => { const m = s.grid[r][c]; return m && (hasWh ? m.id === 'warehouse' : m.id === 'hub'); };
    const start = keyOf(r0, c0), parent = new Map([[start, null]]), q = [[r0, c0]];
    let found = null;
    while (q.length && !found) {
      const [r, c] = q.shift();
      if (!(r === r0 && c === c0) && isTarget(r, c)) { found = [r, c]; break; }
      for (const [nr, nc] of neighbors(r, c)) { const k = keyOf(nr, nc); if (occ.has(k) && !parent.has(k)) { parent.set(k, [r, c]); q.push([nr, nc]); } }
    }
    if (!found) return null;
    const path = []; let cur = found;
    while (cur) { path.unshift({ x: wx(cur[1] + 0.5), y: wy(cur[0] + 0.5) }); cur = parent.get(keyOf(cur[0], cur[1])); }
    return path;
  }

  // ---------------------------------------------------------------- thumbnail (v1 port; state.grid only, no Sim calls)
  function thumbnail(state, w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = U.pal('space-0'); g.fillRect(0, 0, w, h);
    const grid = state && state.grid;
    if (!grid || !grid.length) return c;
    const rows = grid.length, cols = grid[0].length;
    const cell = Math.floor(Math.min(w / cols, h / rows));
    const ox = Math.floor((w - cols * cell) / 2), oy = Math.floor((h - rows * cell) / 2);
    g.strokeStyle = U.pal('hull-edge'); g.lineWidth = 2; g.beginPath();
    for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) {
      if (!grid[r][cc]) continue;
      const x = ox + cc * cell + cell / 2, y = oy + r * cell + cell / 2;
      if (cc + 1 < cols && grid[r][cc + 1]) { g.moveTo(x, y); g.lineTo(x + cell, y); }
      if (r + 1 < rows && grid[r + 1][cc]) { g.moveTo(x, y); g.lineTo(x, y + cell); }
    }
    g.stroke();
    const size = Math.max(2, cell - 2), rad = Math.max(1, size / 4);
    for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) {
      const m = grid[r][cc]; if (!m) continue;
      g.fillStyle = U.rgba(m.id === 'hub' ? U.pal('ivory') : U.famColor(m.id), 0.8);
      const p = new Path2D(); roundRectPath(p, ox + cc * cell + 1, oy + r * cell + 1, size, size, rad); g.fill(p);
    }
    return c;
  }

  function init() {
    setBand(ST.bandFor(1));
    ensureOverlay();
    ST.onFonts(() => { for (const rec of S.cells) rec.bakeKey = ''; });
  }

  return {
    init, update, rebuild, thumbnail,
    cellAt, cellCentre, occupied, bankAt, readyBanksNear, isScaffold, pathToStorage,
    onBuilt, onDemolished, onBuildDone, onUpgrade, onHopper,
    setPointer(p) { S.pointer = p; },
    get placing() { return S.placing; }, set placing(v) { S.placing = v || null; },
    get selected() { return S.selected; }, set selected(v) { S.selected = v || null; },
    get hover() { return S.hover; }, set hover(v) { S.hover = v || null; },
    get station() { return S.station; },
    get band() { return S.band; },
  };
})();

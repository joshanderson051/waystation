// ============================================================
// WAYSTATION v2 — engine/world.js (Engineer E)
// The station layer. Since A6 ("the illustrated look") each occupied cell
// is a miniature: the pack render modules/512/<id>.webp anchored at the
// bottom centre of its cell in painter's order over a family-hue pad,
// with an elliptical drop shadow, one soft additive glow for bloom, the
// dock approach chase and the reactor breathe as pad effects, and the v1
// procedural plate bake as the fallback that cross-fades out when the
// render arrives. Also: trusses with the powered seam, scaffolds with
// progress rings and timers (Meta.build), bank chips (Meta.hopper),
// upgrade ticks (Meta.upgrade) on the pad rim, hover / selection /
// placement feedback, floaters hand-off, Engine.thumbnail, liveries (A5:
// pads, seams and glows) and the plot / territory layer (A1.2).
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
  const OFFLINE = { plate: '#2A2F3D', rim: '#55596A', strip: '#55596A', sil: '#6C7284' };
  // A6 miniature geometry: width 1.0 cell (hub 1.08), feet at cell bottom - 0.02 cell (the render overflows upward a little)
  const MINI_W = 1.0, MINI_W_HUB = 1.08, MINI_LIFT = 0.02;
  const miniW = id => (id === 'hub' ? MINI_W_HUB : MINI_W) * CELL;
  const miniTop = (r, id) => wy(r + 1) - MINI_LIFT * CELL - miniW(id);           // world y of the render's top edge
  // one soft additive glow per module by family (A6: amber by default, ice for ops, gold for power, rose for culture),
  // sized as light spill (0.5 cell; hub and reactor 0.7) at 0.22–0.30
  const GLOW_FAMILY = { ops: 'ice', power: 'gold', culture: 'rose', trade: 'amber', life: 'amber', hub: 'ivory' };
  const GLOW_HERO = { hub: { r: 0.7, a: 0.3 }, reactor: { r: 0.7, a: 0.3 }, gate: { r: 0.55, a: 0.3 } };
  const CHIP_D = 0.26, CHIP_MAX_PX = 30;
  const TINT_OVERDRAW = 0x8A96A8, TINT_BUILDING = 0x9AA0AA, CYAN = '#5EC4FF';
  const FADE_MS = 240;

  const S = {
    stateRef: null, rows: 0, cols: 0, cellCount: 0,
    cells: [], byKey: new Map(), dist: new Map(), tags: new Map(), dockInfo: new Map(), spars: [],
    station: null, gridBox: null,
    band: 1.25, cellDev: 0, pad: 0, k: 1, worldPerDev: 1,
    trussG: null, seamG: null, trussDirty: true, runLights: [], growCell: null,
    padsG: null, padsKey: '',
    overlay: { hover: null, hoverHalo: null, sel: null, selHalo: null, place: null, ghost: null, reason: null, reasonBg: null, lane: null },
    hoverKey: null, hoverT0: 0, selKey: null, selT0: 0, ghostPos: null,
    pops: new Map(), dockState: new Map(),
    shipsByDock: new Map(), T: null,
    pointer: null,
    placing: null, selected: null, hover: null,
    floaters: new WeakMap(),
    dotsG: null, stationKey: '',
    // A5 livery: the active definition (strip / seam / rim / hubCore) and the id pinned by the `livery` bus event when no profile exists (harness)
    livery: null, liveryPinned: null,
    // plot / territory (A1.2): bounds from Sim.state.plot, ring list, field graphics, debris pool, clearing band
    plot: { key: '', bounds: null, rings: [], clearing: null, fieldG: null, bandG: null, sweep: null, label: null, pill: null, debris: [], debrisRoot: null, reveal: null, pulses: [], lastText: '' },
  };
  const DEBRIS_CAP = 240, DEBRIS_PER_CELL = [0.4, 0.4, 1.2];   // 40% of the first cut: the field sits behind the station

  const hasMeta = fn => typeof Meta !== 'undefined' && Meta && typeof Meta[fn] === 'function';
  const metaBuild = (r, c) => { if (!hasMeta('build')) return null; try { return Meta.build(r, c); } catch (e) { return null; } };
  const metaHopper = (r, c) => { if (!hasMeta('hopper')) return null; try { return Meta.hopper(r, c); } catch (e) { return null; } };
  const metaUpgrade = (r, c) => { if (!hasMeta('upgrade')) return null; try { return Meta.upgrade(r, c); } catch (e) { return null; } };
  const hasArt = id => typeof ART !== 'undefined' && ART && ART[id] && typeof ART[id] === 'object';
  const simState = () => (typeof Sim !== 'undefined' && Sim) ? Sim.state : null;
  const famOf = id => (typeof FAMILY !== 'undefined' && FAMILY && FAMILY[id]) || 'hub';

  // ---------------------------------------------------------------- livery (A5): pads, truss seams, hub rim and glows
  // Pads and glows re-tint from the active livery; the fallback plate bake carries the livery id in its texture key.
  // The active id is Meta.livery() (falls back to Meta.profile.settings.livery, then 'default'); without a profile
  // the id pinned by the `livery` event stands in.
  const LIVERY_DEFAULT = { id: 'default', name: 'Standard', strip: 'family', seam: '#8FD3E8', rim: '#F3E9D6', hubCore: '#F3E9D6' };
  function liveryDefs() { return (typeof LIVERIES !== 'undefined' && Array.isArray(LIVERIES) && LIVERIES.length) ? LIVERIES : [LIVERY_DEFAULT]; }
  function liveryById(id) { const L = liveryDefs(); return L.find(l => l.id === id) || L.find(l => l.id === 'default') || LIVERY_DEFAULT; }
  function livery() { return S.livery || LIVERY_DEFAULT; }
  function liveryId() { return livery().id; }
  function wantedLiveryId() {
    if (typeof Meta !== 'undefined' && Meta && Meta.profile) {
      if (typeof Meta.livery === 'function') { try { const d = Meta.livery(); if (d && d.id) return d.id; } catch (e) { /* fall through */ } }
      const st = Meta.profile.settings; if (st && typeof st.livery === 'string' && st.livery) return st.livery;
      return 'default';
    }
    return S.liveryPinned || 'default';
  }
  function stripColor(id) { const s = livery().strip; return (!s || s === 'family') ? U.famColor(id) : s; }
  function seamColor() { return livery().seam || U.pal('ice'); }
  function rimColor() { return livery().rim || U.pal('ivory'); }
  function hubCoreColor() { return livery().hubCore || U.pal('ivory'); }
  // pad hue: the module's strip colour (family by default, the livery strip when dressed); the hub pad takes the livery rim
  function padColor(id) { return id === 'hub' ? rimColor() : stripColor(id); }
  // glow hue: family light; a dressed station mixes the livery strip into it; the hub always glows its core colour
  function glowColor(id) {
    if (id === 'hub') return hubCoreColor();
    const base = U.pal(GLOW_FAMILY[famOf(id)] || 'amber');
    const s = livery().strip;
    return (!s || s === 'family') ? base : U.mix(base, s, 0.5);
  }
  function applyLivery(def) {
    if (!def || (S.livery && S.livery.id === def.id)) return false;
    S.livery = def;
    for (const rec of S.cells) { rec.bakeKey = ''; rec.glow.texture = ST.glowTexture(glowColor(rec.id), 32); }
    S.trussDirty = true; S.padsKey = '';
    return true;
  }
  function syncLivery() { return applyLivery(liveryById(wantedLiveryId())); }
  // the `livery {id}` bus event (Meta.setLivery) or the harness: pin the id, rebake
  function setLivery(id) { S.liveryPinned = id || null; return applyLivery(liveryById(wantedLiveryId())); }

  // ---------------------------------------------------------------- geometry
  const wx = c => c * CELL, wy = r => r * CELL;
  function cellAt(x, y) {
    const c = Math.floor(x / CELL), r = Math.floor(y / CELL);
    return (r >= 0 && r < S.rows && c >= 0 && c < S.cols) ? { r, c } : null;
  }
  function cellCentre(r, c) { return { x: (c + 0.5) * CELL, y: (r + 0.5) * CELL }; }
  // World rect of what a cell shows: the render's box when the pack is active, else the cell (for HUD tooltips)
  function cellBounds(r, c) {
    const rec = S.byKey.get(keyOf(r, c));
    if (rec && rec.artState !== 'none') { const w = miniW(rec.id); return { x: wx(c + 0.5) - w / 2, y: miniTop(r, rec.id), width: w, height: w }; }
    return { x: wx(c), y: wy(r), width: CELL, height: CELL };
  }
  function occupied(r, c) { const s = simState(); return !!(s && s.grid[r] && s.grid[r][c]); }
  function neighbors(r, c) { return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]; }

  // ---------------------------------------------------------------- bake geometry per band (fallback plates, ghost)
  function setBand(band) {
    S.band = band;
    S.cellDev = Math.round(CELL * band * ST.dpr);
    S.pad = Math.ceil(S.cellDev * 0.08);
    S.k = S.cellDev / 100;                           // device px per unit
    S.worldPerDev = CELL / S.cellDev;
  }
  function placeCellSprite(sp, r, c, scale) {
    const sc = scale || 1, cx = wx(c) + CELL / 2, cy = wy(r) + CELL / 2;
    sp.scale.set(S.worldPerDev * sc);
    sp.position.set(cx - (S.cellDev / 2 + S.pad) * S.worldPerDev * sc, cy - (S.cellDev / 2 + S.pad) * S.worldPerDev * sc);
  }
  function placeMini(sp, r, c, id, scale) {
    const w = miniW(id) * (scale || 1);
    sp.width = w; sp.height = w;
    sp.position.set(wx(c) + CELL / 2, wy(r + 1) - MINI_LIFT * CELL);
  }

  // ---------------------------------------------------------------- plate baking (v1 8.0 rules; the loading fallback)
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
    const key = `plate|${id}|${S.cellDev}|${variant}|${open}|${tag}|${lvl}|${liveryId()}`;
    const size = S.cellDev + S.pad * 2;
    return ST.bake(key, size, size, g => bakePlate(g, id, variant, open, tag, lvl));
  }
  function bakePlate(g, id, variant, open, tagStr, lvl) {
    const pad = S.pad, cd = S.cellDev, k = cd / 100, dpu = 100 / cd;
    const isHub = id === 'hub', off = variant === 'offline';
    const fam = U.famColor(id), custom = liveryId() !== 'default';
    const plateCol = off ? OFFLINE.plate : U.pal('hull');
    const rimCol = off ? OFFLINE.rim : (isHub && custom ? U.rgba(rimColor(), 0.3) : U.pal('hull-rim'));
    const stripCol = off ? OFFLINE.strip : stripColor(id);
    const silCol = off ? OFFLINE.sil : (isHub ? rimColor() : fam);
    g.translate(pad, pad); g.scale(k, k);
    g.lineJoin = 'round'; g.lineCap = 'round';
    const shape = inset => { const p = new Path2D(); if (isHub) hexPath(p, 50, 50, 48 + inset); else roundRectPath(p, 6 - inset, 6 - inset, 88 + 2 * inset, 88 + 2 * inset, 10 + inset); return p; };
    const plate = shape(0);
    g.fillStyle = plateCol; g.fill(plate);
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
      const segs = Math.max(1, Math.min(3, lvl | 0));
      const gap = 4, total = 68, w = (total - gap * (segs - 1)) / segs;
      g.fillStyle = stripCol;
      for (let i = 0; i < segs; i++) g.fillRect(16 + i * (w + gap), 7.5, w, 4);
      g.fillStyle = 'rgba(255,255,255,.3)';
      for (const [x, y] of [[13, 13], [87, 13], [13, 87], [87, 87]]) { g.beginPath(); g.arc(x, y, 2, 0, TAU); g.fill(); }
      if (lvl >= 2) { g.fillStyle = U.pal('ivory'); for (let i = 0; i < lvl - 1; i++) g.fillRect(8.5, 22 + i * 8, 3, 5); }
    }
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

  // Elliptical drop shadow under a miniature (soft radial, squashed when placed), one texture for all cells.
  function shadowTexture() {
    return ST.bake('shadow|ellipse', 128, 128, g => {
      const gr = g.createRadialGradient(64, 64, 8, 64, 64, 62);
      gr.addColorStop(0, 'rgba(0,0,0,.9)'); gr.addColorStop(0.55, 'rgba(0,0,0,.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(64, 64, 62, 0, TAU); g.fill();
    }).texture;
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
      S.cells = []; S.byKey.clear(); S.spars = []; S.trussDirty = true; S.stateRef = null; S.cellCount = 0; S.padsKey = '';
      if (S.trussG) S.trussG.clear(); if (S.seamG) S.seamG.clear(); if (S.padsG) S.padsG.clear();
      return;
    }
    S.rows = s.grid.length; S.cols = s.grid[0] ? s.grid[0].length : 0;
    syncLivery();
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
    // painter's order: by row then column, so lower rows overlap the rows above (the renders rise into them)
    S.cells.sort((a, b) => (a.r - b.r) || (a.c - b.c));
    S.cells.forEach(rec => { L.world.minis.addChild(rec.plate, rec.mini); L.world.shadow.addChild(rec.shadow); });
    S.padsKey = '';

    // station box (occupied cells) and grid box, world px
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of cells) { x0 = Math.min(x0, wx(x.c)); y0 = Math.min(y0, wy(x.r)); x1 = Math.max(x1, wx(x.c + 1)); y1 = Math.max(y1, wy(x.r + 1)); }
    S.station = cells.length ? { x0, y0, x1, y1 } : null;
    S.gridBox = { x0: 0, y0: 0, x1: S.cols * CELL, y1: S.rows * CELL };
    CAM.setStation(S.station, S.gridBox);
    const stationKey = S.station ? [x0, y0, x1, y1, S.cols, S.rows].join(',') : '';
    if (stationKey !== S.stationKey) { S.stationKey = stationKey; EngineSpace.setStation(); }

    if (S.stateRef !== s) { S.stateRef = s; S.pops.clear(); S.dockState.clear(); S.hoverKey = S.selKey = null; }
    S.cellCount = cells.length;
    buildDots();
  }

  function createCell(r, c, id) {
    const hero = GLOW_HERO[id];
    const rec = {
      key: keyOf(r, c), r, c, id, def: MODULES[id],
      plate: new PIXI.Sprite(), mini: new PIXI.Sprite(), shadow: new PIXI.Sprite(shadowTexture()),
      glow: ST.sprite(ST.glowTexture(glowColor(id), 32), { blend: 'add', alpha: 0 }),
      glowR: hero ? hero.r : 0.5, glowA: hero ? hero.a : 0.26,
      chase: null, artUrl: ST.assets.url('modules', id, 512), artState: 'none', fadeT0: 0,
      bakeKey: '', scaffold: null, bank: null, lvl: 1, building: false,
    };
    rec.plate.eventMode = rec.mini.eventMode = rec.shadow.eventMode = 'none';
    rec.mini.anchor.set(0.5, 1); rec.mini.visible = false;
    rec.shadow.anchor.set(0.5); rec.shadow.alpha = 0.27;
    rec.shadow.position.set(wx(c) + CELL / 2, wy(r) + CELL * 0.64);
    rec.shadow.scale.set(CELL * 0.69 / 128, CELL * 0.3 / 128);
    rec.glow.position.set(wx(c) + CELL / 2, wy(r) + CELL * 0.45);
    ST.layers.world.emissive.addChild(rec.glow);
    if ((rec.def.docks || 0) > 0 && id !== 'hub') {
      rec.chase = [0, 1, 2].map(() => ST.sprite(ST.glowTexture(CYAN, 6, 'hard'), { blend: 'add', alpha: 0.4 }));
      for (const d of rec.chase) { d.scale.set(0.5); ST.layers.world.emissive.addChild(d); }
    }
    if (rec.artUrl) ST.assets.load(rec.artUrl);
    return rec;
  }
  function destroyCell(rec) {
    rec.plate.destroy(); rec.mini.destroy(); rec.shadow.destroy(); rec.glow.destroy();
    if (rec.chase) for (const d of rec.chase) d.destroy();
    hideScaffold(rec); hideBank(rec);
  }

  // Fallback plate: keep its bake in step with band / variant / tag / level while it is still visible.
  function refreshBake(rec, variant) {
    const open = (rec.id !== 'hub' && (rec.def.docks || 0) > 0) ? ((S.dockInfo.get(rec.key) || {}).open || 'e') : '';
    const tagStr = tagsOK() ? tagStringFor(rec) : '';
    const key = `${S.cellDev}|${variant}|${open}|${tagStr}|${rec.lvl}`;
    if (key === rec.bakeKey) return;
    rec.bakeKey = key;
    rec.plate.texture = plateTexture(rec.id, variant, open, tagStr, rec.lvl).texture;
  }
  function tagStringFor(rec) {
    const t = S.tags.get(rec.key); if (!t) return '';
    const berth = (rec.id !== 'hub' && (rec.def.docks || 0) > 0 && t.berth) ? String(t.berth).padStart(2, '0') : '';
    return (t.reg || '') + '|' + berth;
  }
  // The render arrived: swap it in and cross-fade the plate out over 240 ms.
  function adoptArt(rec) {
    if (rec.artState !== 'none') return;
    const tex = ST.assets.texture(rec.artUrl);
    if (!tex) return;
    rec.mini.texture = tex; rec.mini.visible = true;
    rec.artState = 'fading'; rec.fadeT0 = U.nowMs();
  }

  // ---------------------------------------------------------------- per-frame shared state
  function frameShared(s) {
    S.T = Sim.totals();
    const byDock = S.shipsByDock; byDock.clear();
    for (const sh of s.ships) if (sh.dock && (sh.state === 'approach' || sh.state === 'docked')) byDock.set(keyOf(sh.dock.r, sh.dock.c), sh);
  }

  // ---------------------------------------------------------------- pads (A6): rounded squares in the family hue under every miniature
  function ensurePads() {
    if (S.padsG) return;
    S.padsG = new PIXI.Graphics(); S.padsG.eventMode = 'none';
    ST.layers.world.plates.addChild(S.padsG);
  }
  function drawPads() {
    ensurePads();
    const g = S.padsG; g.clear();
    for (const rec of S.cells) {
      const col = U.int(padColor(rec.id)), x = wx(rec.c) + 5, y = wy(rec.r) + 5, w = CELL - 10;   // 5 px inset: a 2–3 px seam between neighbours
      // a dark seat under the pad keeps cells apart where the renders close the gaps, then the family fill and rim
      g.roundRect(x - 1.5, y - 1.5, w + 3, w + 3, 7).fill({ color: 0x03040A, alpha: 0.55 });
      g.roundRect(x, y, w, w, 6).fill({ color: col, alpha: 0.10 }).roundRect(x, y, w, w, 6).stroke({ width: 1, color: col, alpha: 0.45 });
      // upgrade level ticks on the pad's lower rim
      if (rec.lvl >= 2) {
        const n = rec.lvl - 1, tw = 6, gap = 4, total = n * tw + (n - 1) * gap;
        for (let i = 0; i < n; i++) g.rect(wx(rec.c) + CELL / 2 - total / 2 + i * (tw + gap), y + w - 1, tw, 2);
        g.fill({ color: U.int(U.pal('ivory')), alpha: 0.9 });
      }
    }
  }

  // ---------------------------------------------------------------- dock chase (A6): three cyan dots along the pad's open side
  function updateChase(rec, info, sh) {
    const open = (info && info.open) || 'e', cx = wx(rec.c) + CELL / 2, cy = wy(rec.r) + CELL / 2, e = CELL / 2 - 7, sp = 9;
    const docked = !!(sh && sh.state === 'docked'), approaching = !!(sh && sh.state === 'approach');
    const step = Math.floor(ST.tellTime * 2) % 3;                   // chase: centre, ends, dark (2 steps / s)
    for (let i = 0; i < 3; i++) {
      const d = rec.chase[i], k = i - 1;
      if (open === 'e') d.position.set(cx + e, cy + k * sp); else if (open === 'w') d.position.set(cx - e, cy + k * sp);
      else if (open === 's') d.position.set(cx + k * sp, cy + e); else d.position.set(cx + k * sp, cy - e);
      let a;
      if (!info || !info.usable) a = 0;
      else if (docked) a = 0.9;
      else if (approaching) a = (step === 0 && i === 1) || (step === 1 && i !== 1) ? 1 : 0.15;
      else a = 0.35;
      d.alpha = a; d.visible = a > 0;
    }
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
    const txt = timeText(b.remainingMs);
    if (txt !== sc.lastText) {
      sc.lastText = txt; sc.label.text = txt;
      const w = sc.label.width + 10, h = sc.label.height + 4;
      sc.back.clear().roundRect(sc.label.x - w / 2, sc.label.y - h + 1, w, h, 3).fill({ color: 0x04050A, alpha: 0.74 });
    }
    if (ST.time >= sc.lastSpark && ST.tier > 0 && !ST.reduced && !ST.paused) {
      sc.lastSpark = ST.time + 1.5;
      EngineFX.sparks(wx(rec.c) + CELL * (0.25 + Math.random() * 0.5), wy(rec.r) + CELL * (0.25 + Math.random() * 0.5), U.pal('ice-hi'), 6, 320);
    }
  }
  function timeText(ms) {
    const secs = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(secs / 60), s2 = secs % 60;
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s2).padStart(2, '0')}`;
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

  // ---------------------------------------------------------------- bank chips (3.4; A6: 0.26 cell wide, capped at 30 screen px, 6 px above the render's top edge)
  function chipRadius() { return Math.min(CHIP_D * CELL, CHIP_MAX_PX / Math.max(0.01, CAM.zoom)) / 2; }
  function chipY(rec) {
    const top = rec.artState !== 'none' ? miniTop(rec.r, rec.id) : wy(rec.r);
    return top - 6 - chipRadius();
  }
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
      bk.sprite.texture = bankTexture(bk.full).texture;
    }
    const pop = U.easeOutBack(Math.min(1, (ST.time - bk.t0) / 0.35));
    const bob = Math.sin(ST.time * TAU * 0.8 + rec.c * 0.9 + rec.r * 0.4) * 3;
    const cx = wx(rec.c) + CELL / 2, cy = chipY(rec) + (ST.reduced ? 0 : bob), d = chipRadius() * 2;
    const sc = (bk.full ? 1.15 : 1) * pop;
    bk.sprite.position.set(cx, cy); bk.sprite.scale.set((d / bankTexture(bk.full).w) * sc);
    bk.halo.position.set(cx, cy);
    bk.halo.alpha = bk.full ? 0.18 + 0.1 * Math.sin(ST.time * 3) : 0.06;
    bk.halo.scale.set((bk.full ? 1.1 : 0.7) * d / 26);
  }
  function hideBank(rec) {
    if (!rec.bank) return;
    rec.bank.sprite.destroy(); rec.bank.halo.destroy(); rec.bank = null;
  }
  function bankAt(x, y) {
    for (const rec of S.cells) {
      if (!rec.bank) continue;
      if (Math.hypot(x - rec.bank.sprite.x, y - rec.bank.sprite.y) <= Math.max(12, chipRadius() + 4)) return { r: rec.r, c: rec.c };
    }
    return null;
  }
  function readyBanksNear(r, c, radius) {
    const out = [];
    for (const rec of S.cells) if (rec.bank && Math.abs(rec.r - r) + Math.abs(rec.c - c) <= radius) out.push({ r: rec.r, c: rec.c });
    return out;
  }
  function isScaffold(r, c) { const rec = S.byKey.get(keyOf(r, c)); return !!(rec && rec.scaffold); }

  // ---------------------------------------------------------------- trusses (3.4 / v1 7.7): spars join the pad edges
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
    return { ax, ay, bx: ax + (bx - ax) * p, by: ay + (by - ay) * p, growing: age < 250 };
  }
  function drawTruss() {
    ensureTruss();
    const g = S.trussG, sg = S.seamG;
    g.clear(); sg.clear();
    const w = 0.16 * CELL, hw = w / 2, inset = CELL / 2 - 4;      // from pad edge to pad edge
    const truss = U.int(U.pal('truss')), edge = U.int(U.pal('hull-edge')), ice = U.int(seamColor());   // A5: the seam and its end caps take the livery seam colour
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
    const inset = CELL / 2 - 4, t = ST.tellTime;
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

  // ---------------------------------------------------------------- overlay: hover, selection, placement (3.4 / v1 10), on the pads
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
    if (why === 'plot') return 'UNCLAIMED SPACE';
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
    const dotsTarget = S.placing ? 0.16 : 0;
    S.dotsG.alpha += (dotsTarget - S.dotsG.alpha) * Math.min(1, dt / 0.16);

    // hover: ivory outline 1.5 px on the pad + soft halo (not while placing, never outside the plot)
    O.hover.clear();
    const hv = S.hover;
    if (!S.placing && hv && s.grid[hv.r] && s.grid[hv.r][hv.c] && inPlot(hv.r, hv.c)) {
      const key = keyOf(hv.r, hv.c);
      if (key !== S.hoverKey) { S.hoverKey = key; S.hoverT0 = nowM; }
      const k = Math.min(1, (nowM - S.hoverT0) / 140);
      O.hover.roundRect(wx(hv.c) + 2.5, wy(hv.r) + 2.5, CELL - 5, CELL - 5, 6).stroke({ width: 1.5, color: ivory, alpha: 0.6 * k });
      O.hoverHalo.position.set(wx(hv.c) + CELL / 2, wy(hv.r) + CELL / 2); O.hoverHalo.scale.set(CELL * 1.7 / 128); O.hoverHalo.alpha = 0.14 * k;
    } else { S.hoverKey = null; O.hoverHalo.alpha = 0; }

    // selection: brackets on the pad drawing in over 160 ms, breathing 2 px on a 3 s sine, focus glow
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
      (inPlot(r, c) && Sim.canPlace(id, r, c).ok ? legal : illegal).push({ r, c });   // unclaimed cells are never legal (A1.2)
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
    const occ = !!s.grid[h.r][h.c], claimed = inPlot(h.r, h.c);
    const chk = claimed ? Sim.canPlace(id, h.r, h.c) : { ok: false, why: 'plot' };
    if (!occ && claimed) {
      const w = 0.16 * CELL;
      for (const [nr, nc] of neighbors(h.r, h.c)) {
        if (!Sim.occupied(nr, nc)) continue;
        const nx = wx(nc + 0.5), ny = wy(nr + 0.5);
        if (nr === h.r) O.lane.rect(Math.min(cx, nx), cy - w / 2, Math.abs(nx - cx), w); else O.lane.rect(cx - w / 2, Math.min(cy, ny), w, Math.abs(ny - cy));
      }
      O.lane.fill({ color: U.int(U.pal('truss')), alpha: 0.4 });
      if ((def.docks || 0) > 0) {
        const bp = Sim.berthPoint(h.r, h.c);
        if (bp) {
          const dx = Math.sign(bp.x - (h.c + 0.5)), dy = Math.sign(bp.y - (h.r + 0.5));
          for (let d = 0.5; d < 2.5; d += 0.12) O.lane.circle(cx + dx * CELL * d, cy + dy * CELL * d, 1);
          O.lane.fill({ color: U.int(U.pal('ice')), alpha: 0.7 });
        }
      }
      // ghost: the render at 45% with an ivory tint when the pack has it, else the baked plate
      const art = ST.assets.texture(ST.assets.url('modules', id, 512));
      O.ghost.visible = true; O.ghost.alpha = 0.45;
      if (art) {
        O.ghost.texture = art; O.ghost.anchor.set(0.5, 1); O.ghost.tint = U.int(U.mix('#FFFFFF', U.pal('ivory'), 0.6));
        O.ghost.width = O.ghost.height = miniW(id); O.ghost.position.set(cx, gy + CELL - MINI_LIFT * CELL);
      } else {
        O.ghost.texture = plateTexture(id, 'normal', previewOpenSide(id, h.r, h.c), '', 1).texture; O.ghost.anchor.set(0, 0);
        O.ghost.tint = U.int(U.mix('#FFFFFF', U.famColor(id), 0.35));
        O.ghost.scale.set(S.worldPerDev); O.ghost.position.set(gx - S.pad * S.worldPerDev, gy - S.pad * S.worldPerDev);
      }
    } else O.ghost.visible = false;
    const col = chk.ok ? ivory : bad, dash = 5, gap = 3, per = CELL - 2, seg = dash + gap;
    for (let p = 0; p < per * 4; p += seg) {
      const p1 = Math.min(p + dash, per * 4);
      if (!sameEdge(p, p1, per)) continue;
      const a = rectPoint(gx + 1, gy + 1, per, p), b = rectPoint(gx + 1, gy + 1, per, p1);
      O.lane.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    O.lane.stroke({ width: 1.5, color: col, alpha: 0.9 });
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

  // ---------------------------------------------------------------- plot / territory (A1.2)
  function ringsFor(rows, cols, hub) {
    if (typeof Sim !== 'undefined' && Sim && typeof Sim.plotRingsOf === 'function') {
      try { const r = Sim.plotRingsOf(); if (Array.isArray(r) && r.length > 1) return r; } catch (e) { /* fall through */ }
    }
    if (typeof plotRings === 'function') {
      try { const r = plotRings(rows, cols, hub); if (Array.isArray(r) && r.length) return r; } catch (e) { /* fall through to the local rule */ }
    }
    const start = (typeof PLOT !== 'undefined' && PLOT && PLOT.start) ? PLOT.start : { w: 7, h: 5 };
    const hw = Math.floor(start.w / 2), hh = Math.floor(start.h / 2);
    let r0 = U.clamp(hub.r - hh, 0, rows - 1), r1 = U.clamp(hub.r + hh, 0, rows - 1);
    let c0 = U.clamp(hub.c - hw, 0, cols - 1), c1 = U.clamp(hub.c + hw, 0, cols - 1);
    const out = [{ r0, c0, r1, c1 }];
    const wider = cols > rows;
    for (let k = 1; out.length < 40 && !(r0 === 0 && c0 === 0 && r1 === rows - 1 && c1 === cols - 1); k++) {
      const canW = c0 > 0 || c1 < cols - 1, canH = r0 > 0 || r1 < rows - 1;
      const growH = canH && (!wider || k % 2 === 1 || !canW);
      if (canW) { c0 = Math.max(0, c0 - 1); c1 = Math.min(cols - 1, c1 + 1); }
      if (growH) { r0 = Math.max(0, r0 - 1); r1 = Math.min(rows - 1, r1 + 1); }
      out.push({ r0, c0, r1, c1 });
    }
    return out;
  }
  const inBounds = (b, r, c) => !!b && r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;
  function inPlot(r, c) {
    if (typeof Sim !== 'undefined' && Sim && typeof Sim.inPlot === 'function') { try { return !!Sim.inPlot(r, c); } catch (e) { /* fall through */ } }
    return !S.plot.bounds || inBounds(S.plot.bounds, r, c);
  }
  function ringOf(r, c) {
    const rings = S.plot.rings;
    for (let i = 0; i < rings.length; i++) if (inBounds(rings[i], r, c)) return i;
    return -1;
  }
  function debrisTexture(i) {
    return ST.bake('debris|' + i, 14, 14, g => {
      const rr = U.rng(7000 + i), n = 5 + Math.floor(rr() * 3);
      g.beginPath();
      for (let k = 0; k < n; k++) { const a = k / n * TAU, rad = 3.5 + rr() * 2.5; const x = 7 + Math.cos(a) * rad, y = 7 + Math.sin(a) * rad; if (k) g.lineTo(x, y); else g.moveTo(x, y); }
      g.closePath();
      const gr = g.createLinearGradient(3, 3, 11, 11);
      gr.addColorStop(0, '#9AA4B2'); gr.addColorStop(1, '#3A404C');
      g.fillStyle = gr; g.fill();
      g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 1; g.stroke();
    }).texture;
  }
  function ensurePlotNodes() {
    const P = S.plot; if (P.fieldG) return;
    P.fieldG = new PIXI.Graphics(); P.debrisRoot = new PIXI.Container(); P.bandG = new PIXI.Graphics(); P.pill = new PIXI.Graphics();
    P.label = ST.makeText('', { size: 13, color: U.pal('ice-hi') }); P.label.anchor.set(0.5, 0); P.label.visible = false;
    P.sweep = ST.sprite(ST.glowTexture(U.pal('ice-hi'), 16, 'core'), { blend: 'add', alpha: 0 });
    P.sweep.scale.set(2.2, 0.9);
    for (const n of [P.fieldG, P.debrisRoot, P.bandG, P.pill]) n.eventMode = 'none';
    ST.layers.world.shadow.addChildAt(P.debrisRoot, 0);
    ST.layers.world.shadow.addChildAt(P.fieldG, 0);
    ST.layers.world.scaffold.addChild(P.bandG, P.pill, P.label);
    ST.layers.world.emissive.addChild(P.sweep);
  }
  function perimPoint(x, y, w, h, p) {
    const per = 2 * (w + h); p = ((p % per) + per) % per;
    if (p < w) return { x: x + p, y };
    if (p < w + h) return { x: x + w, y: y + (p - w) };
    if (p < 2 * w + h) return { x: x + w - (p - w - h), y: y + h };
    return { x, y: y + h - (p - 2 * w - h) };
  }
  function dashedRect(g, x, y, w, h, dash, gap) {
    const per = 2 * (w + h), edges = [w, w + h, 2 * w + h, per];
    for (let p = 0; p < per; p += dash + gap) {
      let p1 = Math.min(p + dash, per);
      for (const e of edges) if (p < e && p1 > e) { p1 = e; break; }      // never round a corner mid-dash
      const a = perimPoint(x, y, w, h, p), b = perimPoint(x, y, w, h, p1);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
  }
  function rebuildPlot(s) {
    ensurePlotNodes();
    const P = S.plot, p = s.plot;
    P.bounds = (p && p.r0 != null) ? { r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1 } : null;
    P.rings = ringsFor(S.rows, S.cols, s.hub);
    P.clearing = (p && p.clearing) ? p.clearing : null;
    const clearRing = P.clearing ? P.rings[P.clearing.ring] : null;
    const g = P.fieldG; g.clear();
    const ice = U.int(U.pal('ice')), ivory = U.int(U.pal('ivory'));
    const unclaimed = [];
    if (P.bounds) {
      for (let r = 0; r < S.rows; r++) for (let c = 0; c < S.cols; c++) {
        if (inPlot(r, c)) continue;
        unclaimed.push({ r, c, clearing: !!(clearRing && inBounds(clearRing, r, c)) });
      }
      for (const pass of [false, true]) {
        const cells = unclaimed.filter(u => u.clearing === pass);
        if (!cells.length) continue;
        for (const u of cells) g.rect(wx(u.c), wy(u.r), CELL, CELL);
        g.fill({ color: ice, alpha: pass ? 0.035 : 0.015 });
        for (const u of cells) hatchCell(g, wx(u.c), wy(u.r), CELL / 5, 1);
        g.stroke({ width: 1, color: ice, alpha: pass ? 0.07 : 0.03 });
      }
      const b = P.bounds;
      dashedRect(g, wx(b.c0) + 1, wy(b.r0) + 1, (b.c1 - b.c0 + 1) * CELL - 2, (b.r1 - b.r0 + 1) * CELL - 2, 8, 6);
      g.stroke({ width: 1.5, color: ivory, alpha: 0.35 });
    }
    const per = DEBRIS_PER_CELL[ST.tier];
    const want = Math.min(DEBRIS_CAP, Math.ceil(unclaimed.length * per));
    const scale = unclaimed.length ? Math.min(1, DEBRIS_CAP / (unclaimed.length * per)) : 1;
    let i = 0;
    for (const u of unclaimed) {
      const n = Math.round(per * scale * (0.6 + 0.8 * U.rng(u.r * 131 + u.c * 17)()));   // 0..2 shards; some cells stay empty
      for (let k = 0; k < n && i < want; k++, i++) {
        let d = P.debris[i];
        if (!d) { d = { sp: ST.sprite(debrisTexture(k % 3)) }; P.debrisRoot.addChild(d.sp); P.debris[i] = d; }
        const rr = U.rng((u.r * 977 + u.c * 31 + k * 7) >>> 0);
        d.r = u.r; d.c = u.c;
        d.x = wx(u.c) + 8 + rr() * (CELL - 16); d.y = wy(u.r) + 8 + rr() * (CELL - 16);
        d.vx = (rr() - 0.5) * 5; d.vy = (rr() - 0.5) * 5; d.vr = (rr() - 0.5) * 0.4;
        d.sp.texture = debrisTexture(Math.floor(rr() * 3));
        d.sp.scale.set((0.45 + rr() * 0.55) * 0.8); d.sp.rotation = rr() * TAU; d.sp.alpha = u.clearing ? 0.5 : 0.28 + rr() * 0.17;
        d.sp.tint = u.clearing ? 0xBFE8F4 : 0xB8C4D0; d.sp.visible = true; d.sp.position.set(d.x, d.y);
      }
    }
    for (; i < P.debris.length; i++) P.debris[i].sp.visible = false;
    P.bandG.clear(); P.pill.clear(); P.label.visible = false; P.sweep.alpha = 0; P.lastText = '';
  }
  function updatePlot(s, dt) {
    const P = S.plot, p = s.plot;
    const key = p && p.r0 != null ? [p.ring, p.r0, p.c0, p.r1, p.c1, p.clearing ? p.clearing.ring : '-', S.rows, S.cols, ST.tier].join(',') : 'none|' + S.rows + ',' + S.cols;
    if (key !== P.key) { P.key = key; rebuildPlot(s); }
    if (!P.bounds) return;
    if (ST.tier > 0 && !ST.reduced) {
      for (const d of P.debris) {
        if (!d.sp.visible) continue;
        d.x += d.vx * dt; d.y += d.vy * dt; d.sp.rotation += d.vr * dt;
        const x0 = wx(d.c) + 6, x1 = wx(d.c + 1) - 6, y0 = wy(d.r) + 6, y1 = wy(d.r + 1) - 6;
        if (d.x < x0 || d.x > x1) { d.vx = -d.vx; d.x = U.clamp(d.x, x0, x1); }
        if (d.y < y0 || d.y > y1) { d.vy = -d.vy; d.y = U.clamp(d.y, y0, y1); }
        d.sp.position.set(d.x, d.y);
      }
    }
    const g = P.bandG; g.clear(); P.pill.clear();
    const cl = P.clearing, ring = cl ? P.rings[cl.ring] : null;
    if (ring) {
      const x = wx(ring.c0) + 3, y = wy(ring.r0) + 3, w = (ring.c1 - ring.c0 + 1) * CELL - 6, h = (ring.r1 - ring.r0 + 1) * CELL - 6, per = 2 * (w + h);
      const now = Date.now();
      const prog = cl.totalMs > 0 ? U.clamp(1 - (cl.endsAt - now) / cl.totalMs, 0, 1) : 0;
      const ice = U.int(U.pal('ice')), hi = U.int(U.pal('ice-hi'));
      g.rect(x, y, w, h).stroke({ width: 1, color: ice, alpha: 0.22 });
      const len = prog * per, step = 10;
      for (let q = 0; q < len; q += step) { const a = perimPoint(x, y, w, h, q), b = perimPoint(x, y, w, h, Math.min(q + step, len)); g.moveTo(a.x, a.y).lineTo(b.x, b.y); }
      if (len > 0) g.stroke({ width: 4, color: ice, alpha: 0.55 });
      const sw = ((ST.time / 4) % 1) * per, sp = perimPoint(x, y, w, h, sw), sq = perimPoint(x, y, w, h, sw - 6);
      P.sweep.position.set(sp.x, sp.y); P.sweep.rotation = Math.atan2(sp.y - sq.y, sp.x - sq.x);
      P.sweep.alpha = ST.tier > 0 && !ST.reduced ? 0.8 : 0.35;
      const b = P.bounds, txt = timeText(cl.endsAt - now);
      if (txt !== P.lastText) { P.lastText = txt; P.label.text = txt; }
      P.label.visible = true;
      P.label.position.set((wx(b.c0) + wx(b.c1 + 1)) / 2, wy(b.r1 + 1) + 7);
      const pw = P.label.width + 12, ph = P.label.height + 6;
      P.pill.roundRect(P.label.x - pw / 2, P.label.y - 3, pw, ph, 3).fill({ color: 0x04050A, alpha: 0.78 });
      ST.setTextColor(P.label, hi);
    } else { P.label.visible = false; P.sweep.alpha = 0; }
    if (P.reveal) {
      const k = (ST.time - P.reveal.t0) / 0.7, rb = P.reveal.bounds;
      if (k >= 1) P.reveal = null;
      else {
        const x = wx(rb.c0) + 2, y = wy(rb.r0) + 2, w = (rb.c1 - rb.c0 + 1) * CELL - 4, h = (rb.r1 - rb.r0 + 1) * CELL - 4;
        g.rect(x, y, w, h).stroke({ width: 4 + 6 * k, color: U.int(U.pal('ivory')), alpha: (1 - k) * (1 - k) * 0.9 });
        g.rect(x, y, w, h).fill({ color: U.int(U.pal('ice')), alpha: (1 - k) * 0.08 });
      }
    }
    while (P.pulses.length && P.pulses[0].at <= ST.time) { const q = P.pulses.shift(); EngineFX.facade.pulse(q.r, q.c, U.pal('ice')); }
  }
  // Sim event `plot {state:'start'|'done'|'skip', ring, bounds}`: the field follows Sim.state.plot every frame;
  // `done` and `skip` (Meta's paid completion) add the reveal: band flash, debris blown outward, pulses over 400 ms.
  function onPlot(d) {
    const P = S.plot;
    P.key = '';
    if (!d || (d.state !== 'done' && d.state !== 'skip')) return;
    const rb = d.bounds && d.bounds.r0 != null ? d.bounds : P.rings[d.ring];
    if (!rb) return;
    const prev = P.bounds;
    const cx = (wx(rb.c0) + wx(rb.c1 + 1)) / 2, cy = (wy(rb.r0) + wy(rb.r1 + 1)) / 2;
    const fresh = [];
    for (let r = rb.r0; r <= rb.r1; r++) for (let c = rb.c0; c <= rb.c1; c++) if (!inBounds(prev, r, c)) fresh.push({ r, c, a: Math.atan2(wy(r + 0.5) - cy, wx(c + 0.5) - cx) });
    if (!ST.reduced) {
      for (const dbr of P.debris) {
        if (!dbr.sp.visible || !inBounds(rb, dbr.r, dbr.c) || inBounds(prev, dbr.r, dbr.c)) continue;
        EngineFX.blow(dbr.x, dbr.y, Math.atan2(dbr.y - cy, dbr.x - cx), U.pal('ice-hi'), 3, 900);
        dbr.sp.visible = false;
      }
    }
    fresh.sort((a, b) => a.a - b.a);
    fresh.forEach((f, i) => P.pulses.push({ r: f.r, c: f.c, at: ST.time + (fresh.length > 1 ? i / (fresh.length - 1) : 0) * 0.4 }));
    P.reveal = { t0: ST.time, bounds: rb };
  }

  // ---------------------------------------------------------------- frame
  function update(dt) {
    const s = simState();
    const L = ST.layers;
    if (!s) { if (S.cells.length) rebuild(); L.cam.visible = false; return; }
    L.cam.visible = true;
    if (structureStale(s)) rebuild();
    frameShared(s);
    updatePlot(s, dt);
    const band = ST.bandFor(CAM.zoom);
    if (band !== S.band || !S.cellDev) setBand(band);
    const T = S.T, short = T.efficiency < 1, nowM = U.nowMs();
    const load = T.produced > 0 ? T.used / T.produced : (T.used > 0 ? 2 : 0);
    let padsKey = liveryId();
    for (const rec of S.cells) {
      const offline = rec.id === 'solar' && T.flare;
      const up = metaUpgrade(rec.r, rec.c);
      rec.lvl = up && up.lvl ? Math.max(1, Math.min(3, up.lvl | 0)) : 1;
      padsKey += '|' + rec.lvl;
      // construction state (Meta.build)
      const b = metaBuild(rec.r, rec.c);
      const building = !!(b && b.building);
      if (building !== rec.building) { rec.building = building; if (!building) hideScaffold(rec); }
      if (building) showScaffold(rec, b);
      // render arrival and the 240 ms cross-fade from the plate
      adoptArt(rec);
      let artK = rec.artState === 'art' ? 1 : 0;
      if (rec.artState === 'fading') { artK = U.clamp((nowM - rec.fadeT0) / FADE_MS, 0, 1); if (artK >= 1) rec.artState = 'art'; }
      if (rec.artState === 'none' || artK < 1) refreshBake(rec, offline ? 'offline' : 'normal');
      rec.plate.visible = artK < 1;
      // commit pop / landing
      let scale = 1;
      const pop = S.pops.get(rec.key);
      if (pop) {
        const k = (nowM - pop.t0) / pop.ms;
        if (k >= 1) S.pops.delete(rec.key);
        else scale = pop.kind === 'land' ? 1.15 - 0.15 * U.easeOutBack(k) : 0.7 + 0.3 * U.easeOutBack(k);
      }
      if (rec.plate.visible) placeCellSprite(rec.plate, rec.r, rec.c, scale);
      if (rec.mini.visible) placeMini(rec.mini, rec.r, rec.c, rec.id, scale);
      // treatments: construction (35%, desaturated), overdrawn power / flare-dark solar (grey at 70%)
      const powered = !offline && (rec.def.power >= 0 || !short);
      let alpha = 1, tint = 0xFFFFFF;
      if (building) { alpha = 0.35; tint = TINT_BUILDING; }
      else if (!powered) { alpha = 0.7; tint = TINT_OVERDRAW; }
      rec.mini.alpha = alpha * artK; rec.mini.tint = tint;
      rec.plate.alpha = alpha * (1 - artK); rec.plate.tint = tint;
      rec.shadow.alpha = building ? 0.11 : 0.27;
      // glow: one soft additive light per module; the reactor breathes with its load; dark while building
      const breathe = rec.id === 'reactor' ? 0.85 + 0.15 * Math.sin(ST.tellTime * TAU * (0.5 + 0.5 * Math.min(load, 1))) : 1;
      rec.glow.scale.set(rec.glowR * CELL * 2 / 64 * breathe);
      rec.glow.alpha = building ? 0 : rec.glowA * (powered ? 1 : 0.35) * breathe;
      if (rec.chase) updateChase(rec, S.dockInfo.get(rec.key), S.shipsByDock.get(rec.key));
      // bank chip above the render's top edge
      const h = building ? null : metaHopper(rec.r, rec.c);
      if (h && h.ready) showBank(rec, h); else hideBank(rec);
    }
    if (padsKey !== S.padsKey) { S.padsKey = padsKey; drawPads(); }
    if (S.trussDirty || !S.trussG) drawTruss();
    if (S.seamG) S.seamG.alpha = short ? 0.08 : 0.28 + 0.22 * (0.5 + 0.5 * Math.sin(ST.tellTime * TAU / 3));
    updateRunLights();
    drawOverlay(s, dt);
    handFloaters(s);
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
    S.padsKey = '';
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
  // Nearest module of `id` within `radius` cells (Chebyshev) of a cell; null when none. Used by traffic for the people roles.
  function nearModule(r, c, id, radius) {
    let best = null, bd = Infinity;
    for (const rec of S.cells) {
      if (rec.id !== id) continue;
      const d = Math.max(Math.abs(rec.r - r), Math.abs(rec.c - c));
      if (d <= radius && d < bd) { bd = d; best = { r: rec.r, c: rec.c }; }
    }
    return best;
  }

  // ---------------------------------------------------------------- thumbnail (A6: the resume card's diorama; state.grid only, no Sim calls)
  // Framed on the occupied cells (one cell of margin, never tighter than 5x3), each module on its family pad with
  // its three-quarter render when the texture is in, the flat family square otherwise.
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
    let r0 = rows, r1 = -1, c0 = cols, c1 = -1;
    for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) if (grid[r][cc]) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, cc); c1 = Math.max(c1, cc); }
    if (r1 < 0) return c;
    // frame: the occupied span centred, with 0.6 of a cell of breathing room on every side (a lone hub fills the card)
    const spanC = c1 - c0 + 1, spanR = r1 - r0 + 1;
    const cell = Math.max(2, Math.min(56, Math.floor(Math.min(w / Math.max(spanC + 1.2, 3.2), h / Math.max(spanR + 1.2, 2.2)))));
    const ox = Math.round((w - spanC * cell) / 2) - c0 * cell, oy = Math.round((h - spanR * cell) / 2) - r0 * cell;
    // a faint plate grid under the station, then the connectors between neighbours
    g.strokeStyle = U.rgba(U.pal('hull-edge'), 0.18); g.lineWidth = 1; g.beginPath();
    for (let x = ((ox % cell) + cell) % cell; x <= w; x += cell) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); }
    for (let y = ((oy % cell) + cell) % cell; y <= h; y += cell) { g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); }
    g.stroke();
    g.strokeStyle = U.rgba(U.pal('hull-edge'), 0.8); g.lineWidth = Math.max(1, Math.round(cell / 12)); g.beginPath();
    for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
      if (!grid[r][cc]) continue;
      const x = ox + cc * cell + cell / 2, y = oy + r * cell + cell / 2;
      if (cc + 1 < cols && grid[r][cc + 1]) { g.moveTo(x, y); g.lineTo(x + cell, y); }
      if (r + 1 < rows && grid[r + 1][cc]) { g.moveTo(x, y); g.lineTo(x, y + cell); }
    }
    g.stroke();
    const lv = liveryById(wantedLiveryId()), custom = lv.id !== 'default';
    const inset = Math.max(1, Math.round(cell * 5 / 54)), rad = Math.max(2, Math.round(cell / 9));
    const bar = Math.max(1, Math.round(cell / 18));
    for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
      const m = grid[r][cc]; if (!m) continue;
      const x = ox + cc * cell, y = oy + r * cell, px = x + inset, py = y + inset, pw = cell - inset * 2;
      const col = padColor(m.id);
      // the pad: dark seat, family fill and rim, exactly as the world draws it
      let p = new Path2D(); roundRectPath(p, px - 1.5, py - 1.5, pw + 3, pw + 3, rad + 1); g.fillStyle = 'rgba(3,4,10,0.55)'; g.fill(p);
      p = new Path2D(); roundRectPath(p, px, py, pw, pw, rad);
      g.fillStyle = U.rgba(col, 0.14); g.fill(p); g.strokeStyle = U.rgba(col, 0.6); g.lineWidth = 1; g.stroke(p);
      if (custom && m.id !== 'hub' && pw >= 8) { g.fillStyle = stripColor(m.id); g.fillRect(px + 2, py + 1, pw - 4, bar); }   // A5 livery strip
      // the render (1.0 x cell, the world's miniature scale); the flat family square when the texture is not in
      let drawn = false;
      try {
        const tex = ST.assets.texture(ST.assets.url('modules', m.id, 512));
        const src = tex && tex.source && tex.source.resource;
        if (src && (src.width || src.naturalWidth)) {
          g.save(); g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = Math.max(2, cell / 10); g.shadowOffsetY = Math.max(1, cell / 24);
          g.drawImage(src, x, y, cell, cell); g.restore(); drawn = true;
        }
      } catch (e) { drawn = false; }
      if (!drawn) {
        const sq = Math.max(2, pw - 4), p2 = new Path2D(); roundRectPath(p2, px + 2, py + 2, sq, sq, Math.max(1, sq / 4));
        g.fillStyle = U.rgba(m.id === 'hub' ? (lv.rim || U.pal('ivory')) : U.famColor(m.id), 0.8); g.fill(p2);
      }
    }
    return c;
  }

  function init() {
    setBand(ST.bandFor(1));
    ensureOverlay();
    ensurePads();
    ST.onFonts(() => { for (const rec of S.cells) rec.bakeKey = ''; });
  }

  return {
    init, update, rebuild, thumbnail,
    cellAt, cellCentre, cellBounds, occupied, bankAt, readyBanksNear, isScaffold, pathToStorage, nearModule, inPlot, ringOf,
    onBuilt, onDemolished, onBuildDone, onUpgrade, onHopper, onPlot,
    setLivery, get livery() { return livery(); },                      // A5
    setPointer(p) { S.pointer = p; },
    get placing() { return S.placing; }, set placing(v) { S.placing = v || null; },
    get selected() { return S.selected; }, set selected(v) { S.selected = v || null; },
    get hover() { return S.hover; }, set hover(v) { S.hover = v || null; },
    get station() { return S.station; },
    get band() { return S.band; },
    get artReady() { return S.cells.length > 0 && S.cells.every(r => r.artState !== 'none' || !r.artUrl); },
  };
})();

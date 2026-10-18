// ============================================================
// WAYSTATION — canvas renderer (DESIGN.md sections 0.3, 4.1, 7, 8.0,
// 9.3-9.6, 10, 11.2, 14.1). Engineer R1.
//
// Two canvases inside #canvas-wrap: #bg (alpha:false, baked: void,
// nebula, far stars, planet, vignette) and #station (dynamic: ambient
// stars, grid, trusses, module sprites + live layers, ships, FX,
// placement/selection feedback, floaters, readouts).
//
// Every dependency on art.js / fx.js / ships.js is feature-tested so this
// file never throws when a sibling export is missing; the fallback is a
// plain rounded plate with the module's two-letter tag.
// ============================================================
'use strict';

const Render = (() => {

  // ------------------------------------------------------------------
  // Section A. Palette access and color utilities
  // ------------------------------------------------------------------

  // Hex fallbacks from DESIGN.md section 2, used only when PAL is absent
  // or a token resolves empty. Keys follow the PAL convention (token
  // name without the leading dashes).
  const FALLBACK = {
    'void': '#04050A', bg: '#090B12', 'surface-1': '#0F1119', 'surface-2': '#161A25', 'surface-3': '#1E2432',
    hairline: '#262C3A', 'hairline-2': '#343B4C',
    hull: '#1B2030', 'hull-edge': '#2A3142', 'hull-rim': 'rgba(243,233,214,.25)', truss: '#232838',
    amber: '#E9A23B', 'amber-hi': '#FFC46A', ice: '#8FD3E8', 'ice-hi': '#BFE8F4', sage: '#A8C8A0', 'sage-hi': '#CBE2C4',
    rose: '#E58BB8', 'rose-hi': '#F2B6D3', gold: '#FFE28A', ivory: '#F3E9D6', lamp: '#FFE9B8',
    good: '#6FD3A3', warn: '#FF8F3D', bad: '#FF4F5E', ink: '#E6E8EC', 'ink-2': '#A3A7B0', 'ink-3': '#6B707C',
  };

  // Local family map, used only if art.js has not exported FAMILY/PAL.family.
  const LOCAL_FAMILY = {
    hub: 'ivory',
    dock: 'ice', comms: 'ice', customs: 'ice', security: 'ice', shipyard: 'ice',
    solar: 'gold', reactor: 'gold',
    warehouse: 'amber', fuel: 'amber', market: 'amber', bank: 'amber', refinery: 'amber',
    quarters: 'sage', cantina: 'sage', hydro: 'sage', clinic: 'sage', habitat: 'sage', school: 'sage',
    rec: 'rose', plaza: 'rose', menagerie: 'rose', observatory: 'rose', gate: 'rose',
  };

  // Registry tag prefixes (8.0 item 6). The hub carries no registry tag.
  const PREFIX = {
    dock: 'DK', warehouse: 'WH', solar: 'SO', fuel: 'FU', quarters: 'QU', cantina: 'CA', comms: 'CO', market: 'MA',
    rec: 'RE', hydro: 'HY', clinic: 'CL', habitat: 'HA', reactor: 'RX', customs: 'CU', security: 'SE', school: 'SC',
    bank: 'BA', plaza: 'PL', menagerie: 'ME', refinery: 'RF', shipyard: 'SH', observatory: 'OB', gate: 'GA', hub: 'HB',
  };

  // Tell classes (8.0). Used when ART[id].tellClass is missing.
  const CLASS_B = { cantina: 1, rec: 1, school: 1, customs: 1, observatory: 1, fuel: 1, hydro: 1 };
  // Tells that keep running under reduced motion (beacons + dock LEDs).
  const REDUCED_KEEP = { security: 1, habitat: 1, dock: 1 };

  const hasPAL = () => typeof PAL !== 'undefined' && PAL && typeof PAL === 'object';

  // Resolved token color (PAL first, section-2 hex second).
  function col(name) {
    if (hasPAL()) { const v = PAL[name]; if (typeof v === 'string' && v) return v; }
    return FALLBACK[name] || '#FFFFFF';
  }

  // Parse any css color we may meet (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba()) into [r,g,b,a].
  const parseCache = new Map();
  function parseColor(str) {
    let p = parseCache.get(str);
    if (p) return p;
    p = [255, 255, 255, 1];
    const s = String(str).trim();
    if (s[0] === '#') {
      const h = s.slice(1);
      if (h.length === 3 || h.length === 4) {
        p = [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1];
      } else if (h.length === 6 || h.length === 8) {
        p = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
      }
    } else {
      const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i);
      if (m) {
        let a = 1;
        if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        p = [+m[1], +m[2], +m[3], a];
      }
    }
    parseCache.set(str, p);
    return p;
  }

  // color + alpha -> rgba string, cached by (color, alpha). Uses art.js withAlpha when present.
  const alphaCache = new Map();
  function rgba(color, a) {
    const key = color + '|' + a;
    let v = alphaCache.get(key);
    if (v) return v;
    if (typeof withAlpha === 'function') {
      try { v = withAlpha(color, a); } catch (e) { v = null; }
    }
    if (!v) { const p = parseColor(color); v = `rgba(${p[0]},${p[1]},${p[2]},${+(p[3] * a).toFixed(3)})`; }
    alphaCache.set(key, v);
    return v;
  }

  // desat(hex, k): mix each channel toward its own luminance grey by k (2.2). Local fallback.
  const desatCache = new Map();
  function desatColor(color, k) {
    const key = color + '|' + k;
    let v = desatCache.get(key);
    if (v) return v;
    if (typeof desat === 'function') { try { v = desat(color, k); } catch (e) { v = null; } }
    if (!v) {
      const p = parseColor(color), L = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
      const f = c => Math.round(c + (L - c) * k);
      v = `rgb(${f(p[0])},${f(p[1])},${f(p[2])})`;
    }
    desatCache.set(key, v);
    return v;
  }

  // Family color for a module id: PAL.family -> FAMILY/FAMILY_COLOR -> local map.
  function famColor(id) {
    if (hasPAL() && typeof PAL.family === 'function') { try { const v = PAL.family(id); if (v) return v; } catch (e) { /* fall through */ } }
    if (typeof FAMILY !== 'undefined' && FAMILY && typeof FAMILY_COLOR !== 'undefined' && FAMILY_COLOR) {
      const tok = FAMILY_COLOR[FAMILY[id]];
      if (typeof tok === 'string') return col(tok.replace(/^--/, ''));
    }
    return col(LOCAL_FAMILY[id] || 'ivory');
  }

  // Company color through desat (2.2); COMPANY_COLOR when art.js exports it.
  function companyColor(id) {
    if (typeof COMPANY_COLOR !== 'undefined' && COMPANY_COLOR && COMPANY_COLOR[id]) return COMPANY_COLOR[id];
    const co = COMPANIES.find(c => c.id === id);
    return desatColor(co ? co.color : '#C9A86A', 0.15);
  }

  // Registry number for a station name: art.js registryOf, else local FNV-1a (6.2).
  function registryNumber(name) {
    if (typeof registryOf === 'function') {
      try {
        const v = registryOf(name || '');
        const n = typeof v === 'number' ? v : parseInt(String(v).replace(/\D/g, ''), 10);
        if (Number.isFinite(n)) return n;
      } catch (e) { /* fall through */ }
    }
    let h = 0x811c9dc5;
    const s = String(name || '');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 1000 + (h >>> 0) % 9000;
  }

  // ------------------------------------------------------------------
  // Section B. Math helpers: easing, seeded noise, geometry
  // ------------------------------------------------------------------

  const TAU = Math.PI * 2;
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInQuad = t => t * t;
  const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const lerp = (a, b, k) => a + (b - a) * k;

  // mulberry32 seeded PRNG
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Lattice hash for value noise, [0,1)
  function hash2(ix, iy, seed) {
    let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const smooth = t => t * t * (3 - 2 * t);
  function valueNoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  }
  function fbm(x, y, seed) {   // 4 octaves
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < 4; o++) { v += valueNoise(x * f, y * f, seed + o * 17) * amp; norm += amp; amp *= 0.5; f *= 2; }
    return v / norm;
  }

  // circle / axis-aligned rect overlap depth (>0 means intersecting)
  function circleRectOverlap(cx, cy, r, x0, y0, x1, y1) {
    const qx = Math.max(x0, Math.min(cx, x1)), qy = Math.max(y0, Math.min(cy, y1));
    const d = Math.hypot(cx - qx, cy - qy);
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) return r + Math.min(cx - x0, x1 - cx, cy - y0, y1 - cy);
    return r - d;
  }
  // segment / rect intersection (coarse: samples along the segment)
  function segmentHitsRect(ax, ay, bx, by, x0, y0, x1, y1) {
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
    }
    return false;
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function hexPath(g, cx, cy, R) {
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * Math.PI / 3, x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  }

  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const keyOf = (r, c) => r + ',' + c;

  // ------------------------------------------------------------------
  // Section C. Renderer state
  // ------------------------------------------------------------------

  const S = {
    canvas: null, ctx: null, bg: null, bctx: null, wrap: null,
    w: 0, h: 0, dpr: 1, cell: 40, cellDev: 40, ox: 0, oy: 0,
    time: 0, frameNow: 0, dt: 0,
    mouse: null,
    reduced: false, tier: 0,
    perfEma: 0, perfOver: 0, perfUnder: 0,
    fontsReady: false,
    // caches
    sprites: new Map(), textW: new Map(), glows: new Map(),
    // background
    bgName: null, bgTimer: 0, bgBaked: false, bgRequest: null,
    planet: null,
    midTile: null, nearStars: [], shoot: null, shootNext: 0,
    // grid
    dotsPath: null, ringsPath: null, dotAlpha: 0.09, gridRect: null, gridBox: null,
    // station structure (rebuilt on Sim 'change')
    cellsArr: [], dist: new Map(), tags: new Map(), dockInfo: new Map(),
    spars: [], trussFill: null, trussEdge: null, trussConduit: null, trussNodes: null, trussDirty: true,
    // effects
    pops: new Map(), entry: new WeakMap(), floaters: new WeakMap(), departAt: new WeakMap(), dockState: new Map(),
    ghost: null, hoverKey: null, hoverT0: 0, selKey: null, selT0: 0,
    lastStock: null, stockChangedAt: -1e9, stateRef: null, cellCount: 0, growCell: null,
    // per-frame scratch
    shipsByDock: new Map(), hoveredShip: null,
  };

  // Public object (hover / placing / selected are set by main.js and ui.js)
  const R = { hover: null, placing: null, selected: null, cell: 40 };

  // ------------------------------------------------------------------
  // Section D. Init, resize, mapping
  // ------------------------------------------------------------------

  function init(canvas) {
    S.canvas = canvas;
    S.ctx = canvas.getContext('2d');
    S.wrap = canvas.parentElement || document.getElementById('canvas-wrap') || document.body;
    // #bg must be the first child of #canvas-wrap
    let bg = document.getElementById('bg');
    if (!bg) {
      bg = document.createElement('canvas'); bg.id = 'bg';
      S.wrap.insertBefore(bg, S.wrap.firstChild);
    } else if (bg.parentElement === S.wrap && S.wrap.firstChild !== bg) {
      S.wrap.insertBefore(bg, S.wrap.firstChild);
    }
    S.bg = bg;
    S.bctx = bg.getContext('2d', { alpha: false }) || bg.getContext('2d');

    if (hasPAL() && !PAL.ready && typeof PAL.load === 'function') { try { PAL.load(); } catch (e) { /* art.js owns PAL */ } }

    // reduced motion
    try {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      S.mqReduced = mq;
      const onMq = () => updateReduced();
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    } catch (e) { S.mqReduced = null; }
    updateReduced();

    // fonts: tag-less sprites until both faces are loaded; purge on ready
    if (document.fonts && typeof document.fonts.load === 'function') {
      Promise.all([document.fonts.load('600 12px "Barlow Condensed"'), document.fonts.load('500 12px "JetBrains Mono"')])
        .then(() => { S.fontsReady = true; purgeSprites(); }, () => { S.fontsReady = true; purgeSprites(); });
      if (document.fonts.ready) document.fonts.ready.then(() => { S.fontsReady = true; purgeSprites(); });
    } else {
      S.fontsReady = true;
    }

    // sizing
    resize();
    try {
      const ro = new ResizeObserver(entries => {
        const en = entries[0];
        let devW = 0, devH = 0;
        try {
          if (en.devicePixelContentBoxSize && en.devicePixelContentBoxSize[0]) {
            devW = en.devicePixelContentBoxSize[0].inlineSize; devH = en.devicePixelContentBoxSize[0].blockSize;
          }
        } catch (e) { devW = devH = 0; }
        resize(devW, devH);
      });
      try { ro.observe(S.wrap, { box: 'device-pixel-content-box' }); }
      catch (e) { ro.observe(S.wrap); }
      S.ro = ro;
    } catch (e) {
      window.addEventListener('resize', () => resize());
    }
    window.addEventListener('resize', () => { if (!S.ro) resize(); });

    // Sim events
    if (typeof Sim !== 'undefined' && Sim && typeof Sim.on === 'function') {
      Sim.on('change', onChange);
      Sim.on('built', onBuilt);
      Sim.on('demolished', onDemolished);
      Sim.on('dock', onDock);
      Sim.on('depart', onDepart);
      Sim.on('spawn', onSpawn);
      Sim.on('levelup', () => { /* level touches only DOM tokens; nothing to rebake */ });
    }
    onChange();
    if (!S.midTile) midStarTile();
    scheduleBake(0);
  }

  function updateReduced() {
    let red = false;
    try { red = !!(S.mqReduced && S.mqReduced.matches); } catch (e) { red = false; }
    if (document.body && document.body.getAttribute('data-motion') === 'reduced') red = true;
    if (red !== S.reduced) {
      S.reduced = red;
      if (typeof FX !== 'undefined' && FX && typeof FX.setReduced === 'function') { try { FX.setReduced(red); } catch (e) { /* ignore */ } }
    }
  }

  // Resize both canvases. devW/devH are device px from the ResizeObserver
  // (device-pixel-content-box); fallback is contentRect x devicePixelRatio.
  function resize(devW, devH) {
    const wrap = S.wrap; if (!wrap) return;
    const cssW = Math.max(1, wrap.clientWidth), cssH = Math.max(1, wrap.clientHeight);
    let dpr = window.devicePixelRatio || 1;
    if (!(devW > 0 && devH > 0)) { devW = Math.round(cssW * dpr); devH = Math.round(cssH * dpr); }
    else dpr = devW / cssW;
    const sizeChanged = devW !== S.canvas.width || devH !== S.canvas.height || Math.abs(dpr - S.dpr) > 1e-6;
    S.w = cssW; S.h = cssH; S.dpr = dpr;
    if (S.canvas.width !== devW || S.canvas.height !== devH) { S.canvas.width = devW; S.canvas.height = devH; }
    if (S.bg.width !== devW || S.bg.height !== devH) { S.bg.width = devW; S.bg.height = devH; }
    S.canvas.style.width = S.bg.style.width = cssW + 'px';
    S.canvas.style.height = S.bg.style.height = cssH + 'px';
    S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.bctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 4.1: cell = floor(min(w/(COLS+4), h/(ROWS+4))), rounded down so cell*dpr is an integer
    const cell0 = Math.floor(Math.min(cssW / (GRID_COLS + 4), cssH / (GRID_ROWS + 4)));
    const cellDev = Math.max(8, Math.floor(cell0 * dpr));
    const cell = cellDev / dpr;
    const cellChanged = cellDev !== S.cellDev || Math.abs(cell - S.cell) > 1e-9;
    S.cell = cell; S.cellDev = cellDev; R.cell = cell;
    // origin snapped to the device grid
    S.ox = Math.round(((cssW - GRID_COLS * cell) / 2) * dpr) / dpr;
    S.oy = Math.round(((cssH - GRID_ROWS * cell) / 2) * dpr) / dpr;
    S.gridRect = { x0: S.ox, y0: S.oy, x1: S.ox + GRID_COLS * cell, y1: S.oy + GRID_ROWS * cell };
    S.gridBox = { x0: S.ox - cell * 0.5, y0: S.oy - cell * 0.5, x1: S.ox + (GRID_COLS + 0.5) * cell, y1: S.oy + (GRID_ROWS + 0.5) * cell };

    if (cellChanged) {
      purgeSprites();
      if (typeof Ships !== 'undefined' && Ships && typeof Ships.purge === 'function') { try { Ships.purge(); } catch (e) { /* ignore */ } }
      S.glows.clear();
      S.textW.clear();
    }
    buildGridPaths();
    S.trussDirty = true;
    placeNearStars();
    if (sizeChanged || cellChanged) { midStarTile(); scheduleBake(120); }
  }

  function purgeSprites() { S.sprites.clear(); }

  // grid coords (fractional) -> CSS px, top-down mapping (unchanged)
  const px = x => S.ox + x * S.cell;
  const py = y => S.oy + y * S.cell;

  function cellAt(mx, my) {
    const c = Math.floor((mx - S.ox) / S.cell), r = Math.floor((my - S.oy) / S.cell);
    return Sim.inBounds(r, c) ? { r, c } : null;
  }
  function shipAt(mx, my) {
    const s = Sim.state; if (!s) return null;
    const hasHL = typeof Ships !== 'undefined' && Ships && typeof Ships.halfLength === 'function';
    for (const sh of s.ships) {
      // hit radius tracks the hull: halfLength + 4px (the hover ring Ships draws at L+4)
      const L = hasHL ? Ships.halfLength(sh, S.cell) : (SHIP_CLASSES[sh.cls] || { size: 8 }).size * S.cell / 14;
      if (Math.hypot(mx - px(sh.x), my - py(sh.y)) < L + 4) return sh;
    }
    return null;
  }
  function mouse(mx, my) {
    if (mx == null || my == null || Number.isNaN(mx)) S.mouse = null; else S.mouse = { x: mx, y: my };
  }

  // 1px hairline snap: device-integer plus half a device pixel
  const snap = v => Math.round(v * S.dpr) / S.dpr + 0.5 / S.dpr;
  // CSS px size of n device px
  const devPx = n => n / S.dpr;

  // cached measureText (font must already be set on ctx)
  function textWidth(ctx, font, str) {
    const key = font + '|' + str;
    let w = S.textW.get(key);
    if (w == null) { w = ctx.measureText(str).width; S.textW.set(key, w); }
    return w;
  }

  // ------------------------------------------------------------------
  // Section E. Background bake (#bg): void, nebula, far stars, planet, vignette
  // Baked on resize, DPR change and name change, debounced 120ms (7.2).
  // ------------------------------------------------------------------

  // An explicit title-screen request (Render.bakeBackground(name)) wins over the live station's
  // name until the next Sim 'change' (commission / resume), so NEW over a running game previews.
  function currentName() {
    if (S.bgRequest) return S.bgRequest;
    if (typeof Sim !== 'undefined' && Sim && Sim.state && Sim.state.name) return Sim.state.name;
    return S.bgName || (typeof STATION_NAMES !== 'undefined' ? STATION_NAMES[0] : 'Waystation');
  }

  function scheduleBake(ms, name) {
    if (name) S.bgName = name;
    if (S.bgTimer) clearTimeout(S.bgTimer);
    if (ms <= 0) { S.bgTimer = 0; bakeBackground(); return; }
    S.bgTimer = setTimeout(() => { S.bgTimer = 0; bakeBackground(); }, ms);
  }

  // Planet geometry (7.3): computed from the inflated grid box so the disc
  // never intersects it; cut by the top and right canvas edges.
  function computePlanet() {
    const W = S.w, H = S.h, G = S.gridBox, m = Math.min(W, H);
    let r = 0.11 * m;
    const floor = 0.06 * m;
    let cx = W - 0.55 * r, cy = 0.55 * r;
    let overlap = circleRectOverlap(cx, cy, r, G.x0, G.y0, G.x1, G.y1);
    while (overlap > 0 && r - 2 >= floor) {
      r -= 2; cx = W - 0.55 * r; cy = 0.55 * r;
      overlap = circleRectOverlap(cx, cy, r, G.x0, G.y0, G.x1, G.y1);
    }
    if (overlap > 0) cy -= overlap + 1;   // floor reached: move the centre up by the overlap
    return { x: cx, y: cy, r };
  }

  function bakeBackground() {
    const g = S.bctx; if (!g || S.w < 2 || S.h < 2) return;
    const W = S.w, H = S.h, dpr = S.dpr;
    const name = currentName();
    S.bgName = name;
    const seed = registryNumber(name) >>> 0;

    // 1. void
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = col('void');
    g.fillRect(0, 0, W, H);

    // 2. nebula: 4-octave value noise at 1/6 resolution, two tints, alpha d*.22, luminance cap 16%
    {
      const nw = Math.max(2, Math.ceil(W / 6)), nh = Math.max(2, Math.ceil(H / 6));
      const nc = document.createElement('canvas'); nc.width = nw; nc.height = nh;
      const ng = nc.getContext('2d');
      const img = ng.createImageData(nw, nh), d = img.data;
      const vp = parseColor(col('void'));
      const sx = 3.2 / nw, sy = 3.2 / nh;           // ~3 noise cells across the canvas
      const rr = rng(seed);
      const offx = rr() * 100, offy = rr() * 100;
      const capL = 255 * 0.16;
      for (let y = 0; y < nh; y++) {
        for (let x = 0; x < nw; x++) {
          const n1 = fbm(x * sx + offx, y * sy + offy, seed);
          const n2 = fbm(x * sx * 0.7 + offx + 31.7, y * sy * 0.7 + offy + 11.3, seed + 97);
          // density: emphasise the upper band of the noise so most of the sky stays void
          const dens = Math.max(0, (n1 - 0.42) / 0.58);
          const a = Math.pow(dens, 1.4) * 0.22;
          // tint mix: warm indigo (44,36,84) <-> dusk teal (18,70,84)
          const k = smooth(Math.max(0, Math.min(1, (n2 - 0.3) / 0.4)));
          const tr = lerp(44, 18, k), tg = lerp(36, 70, k), tb = 84;
          let r = vp[0] + (tr - vp[0]) * a, gg = vp[1] + (tg - vp[1]) * a, b = vp[2] + (tb - vp[2]) * a;
          const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
          if (L > capL) { const f = capL / L; r *= f; gg *= f; b *= f; }
          const i = (y * nw + x) * 4;
          d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
        }
      }
      ng.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(nc, 0, 0, W, H);
    }

    // 3. far stars: 380 1x1 device px rects in three alpha buckets; near the grid alpha stays <= .3
    {
      g.setTransform(1, 0, 0, 1, 0, 0);
      const rr = rng(seed ^ 0x9E3779B9);
      const G = S.gridBox, devW = S.bg.width, devH = S.bg.height;
      const buckets = [0.3, 0.5, 0.8];
      for (let b = 0; b < 3; b++) {
        g.fillStyle = `rgba(236,232,222,${buckets[b]})`;
        const n = b === 0 ? 170 : b === 1 ? 130 : 80;
        for (let i = 0; i < n; i++) {
          const x = Math.floor(rr() * devW), y = Math.floor(rr() * devH);
          const cx = x / dpr, cy = y / dpr;
          const inGrid = cx >= G.x0 && cx <= G.x1 && cy >= G.y0 && cy <= G.y1;
          if (inGrid && b > 0) { g.fillStyle = 'rgba(236,232,222,.3)'; g.fillRect(x, y, 1, 1); g.fillStyle = `rgba(236,232,222,${buckets[b]})`; }
          else g.fillRect(x, y, 1, 1);
        }
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // 4. planet
    S.planet = computePlanet();
    drawPlanet(g, S.planet);

    // 5. vignette: transparent at 55% radius to rgba(0,0,0,.5) at the corners
    {
      const cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy);
      const vg = g.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.5)');
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }
    S.bgBaked = true;
  }

  function drawPlanet(g, P) {
    const { x, y, r } = P;
    const ivory = col('ivory');
    const tilt = 14 * Math.PI / 180, rx = r * 1.75, ry = r * 0.28;
    // ring, back half (under the body)
    g.save();
    g.strokeStyle = rgba(ivory, 0.22); g.lineWidth = 1;
    g.beginPath(); g.ellipse(x, y, rx, ry, tilt, Math.PI, TAU); g.stroke();
    g.restore();
    // body: lit limb top-left -> terminator
    const bg = g.createRadialGradient(x - r * 0.45, y - r * 0.45, r * 0.08, x, y, r);
    bg.addColorStop(0, '#8A5A3C'); bg.addColorStop(0.55, '#4A3030'); bg.addColorStop(1, '#2A1E22');
    g.fillStyle = bg; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    // terminator shadow, offset down-right
    g.save();
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.clip();
    const sg = g.createRadialGradient(x + r * 0.55, y + r * 0.55, r * 0.2, x + r * 0.35, y + r * 0.35, r * 1.1);
    sg.addColorStop(0, 'rgba(4,5,10,.6)'); sg.addColorStop(1, 'rgba(4,5,10,0)');
    g.fillStyle = sg; g.fillRect(x - r, y - r, r * 2, r * 2);
    g.restore();
    // atmosphere rim on the lit side only (-150deg .. 30deg)
    g.strokeStyle = 'rgba(243,233,214,.28)'; g.lineWidth = 2;
    g.beginPath(); g.arc(x, y, r - 1, -150 * Math.PI / 180, 30 * Math.PI / 180); g.stroke();
    // ring, front half
    g.strokeStyle = rgba(ivory, 0.22); g.lineWidth = 1;
    g.beginPath(); g.ellipse(x, y, rx, ry, tilt, 0, Math.PI); g.stroke();
  }

  // ------------------------------------------------------------------
  // Section F. Ambient motion (7.4): near stars, mid-star tile with parallax, shooting star
  // ------------------------------------------------------------------

  function midStarTile() {
    const dpr = S.dpr, size = 512, dev = Math.round(size * dpr);
    const c = document.createElement('canvas'); c.width = dev; c.height = dev;
    const g = c.getContext('2d');
    const rr = rng(0x51A7);
    for (let i = 0; i < 120; i++) {
      const a = 0.25 + rr() * 0.45;
      g.fillStyle = `rgba(236,232,222,${a.toFixed(2)})`;
      g.fillRect(Math.floor(rr() * dev), Math.floor(rr() * dev), 1, 1);
    }
    S.midTile = c;
  }

  // 36 near stars (2x2 device px), outside the inflated grid box so alpha near the grid stays low
  function placeNearStars() {
    const rr = rng(0x2A11), G = S.gridBox, out = [];
    let guard = 0;
    while (out.length < 36 && guard++ < 2000) {
      const x = rr() * S.w, y = rr() * S.h;
      if (G && x > G.x0 && x < G.x1 && y > G.y0 && y < G.y1) continue;
      out.push({ x, y, w: TAU / (4 + rr() * 4), ph: rr() * TAU });
    }
    S.nearStars = out;
  }

  function drawAmbient(ctx) {
    const t = S.time;
    // mid-star tile, wrapping, with mouse parallax (dropped at tier >= 1 and under reduced motion)
    if (S.midTile) {
      let offx = 0, offy = 0;
      if (S.mouse && S.tier === 0 && !S.reduced) { offx = (S.mouse.x - S.w / 2) * 0.006; offy = (S.mouse.y - S.h / 2) * 0.006; }
      const size = 512, dpr = S.dpr, W = S.w, H = S.h;
      const startX = ((offx % size) + size) % size - size, startY = ((offy % size) + size) % size - size;
      ctx.globalAlpha = 1;
      // each tile is clipped to the canvas via its source rect, so the pass costs one canvas of pixels
      for (let x = startX; x < W; x += size) for (let y = startY; y < H; y += size) {
        const dx = Math.round(x * dpr) / dpr, dy = Math.round(y * dpr) / dpr;
        const x0 = Math.max(dx, 0), y0 = Math.max(dy, 0);
        const x1 = Math.min(dx + size, W), y1 = Math.min(dy + size, H);
        if (x1 <= x0 || y1 <= y0) continue;
        const sx = Math.round((x0 - dx) * dpr), sy = Math.round((y0 - dy) * dpr);
        const sw = Math.round((x1 - x0) * dpr), sh = Math.round((y1 - y0) * dpr);
        if (sw <= 0 || sh <= 0) continue;
        ctx.drawImage(S.midTile, sx, sy, sw, sh, x0, y0, sw / dpr, sh / dpr);
      }
    }
    // near stars: 2x2 device px twinkling
    const d2 = devPx(2);
    if (S.reduced) {
      ctx.fillStyle = 'rgba(236,232,222,.6)';
      for (const st of S.nearStars) ctx.fillRect(st.x, st.y, d2, d2);
    } else {
      // group into 8 alpha buckets to limit fillStyle changes
      for (let b = 0; b < 8; b++) {
        const lo = b / 8, hi = (b + 1) / 8;
        let set = false;
        for (const st of S.nearStars) {
          const a = 0.4 + 0.4 * Math.sin(t * st.w + st.ph), u = (a - 0.0) / 0.8;
          if (u < lo || u >= hi) continue;
          if (!set) { ctx.fillStyle = `rgba(236,232,222,${(0.4 + 0.4 * (lo + hi) / 2).toFixed(2)})`; set = true; }
          ctx.fillRect(st.x, st.y, d2, d2);
        }
      }
    }
    // shooting star: every 25-50s, 60px, 500ms, alpha .6 -> 0, never crossing the grid rectangle
    if (!S.reduced) {
      if (!S.shoot && t >= S.shootNext) {
        const G = S.gridRect;
        for (let tries = 0; tries < 12 && !S.shoot; tries++) {
          const ax = Math.random() * S.w, ay = Math.random() * S.h, ang = Math.random() * TAU;
          const len = 60, travel = 90;
          const bx = ax + Math.cos(ang) * (len + travel), by = ay + Math.sin(ang) * (len + travel);
          if (!segmentHitsRect(ax, ay, bx, by, G.x0 - 8, G.y0 - 8, G.x1 + 8, G.y1 + 8)) S.shoot = { ax, ay, ang, t0: t, len, travel };
        }
        if (!S.shoot) S.shootNext = t + 5;
      }
      if (S.shoot) {
        const sh = S.shoot, k = (t - sh.t0) / 0.5;
        if (k >= 1) { S.shoot = null; S.shootNext = t + 25 + Math.random() * 25; }
        else {
          const hx = sh.ax + Math.cos(sh.ang) * sh.travel * k, hy = sh.ay + Math.sin(sh.ang) * sh.travel * k;
          ctx.strokeStyle = `rgba(236,232,222,${(0.6 * (1 - k)).toFixed(3)})`; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(hx - Math.cos(sh.ang) * sh.len, hy - Math.sin(sh.ang) * sh.len); ctx.lineTo(hx, hy); ctx.stroke();
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Section G. Grid presentation (7.5): dots, two range rings, bearing ticks, readout
  // ------------------------------------------------------------------

  function buildGridPaths() {
    const dots = new Path2D(), d1 = devPx(1);
    for (let r = 0; r <= GRID_ROWS; r++) for (let c = 0; c <= GRID_COLS; c++) {
      dots.rect(Math.round(px(c) * S.dpr) / S.dpr, Math.round(py(r) * S.dpr) / S.dpr, d1, d1);
    }
    S.dotsPath = dots;
    buildRingPath();
  }
  function buildRingPath() {
    const hub = (typeof Sim !== 'undefined' && Sim.state && Sim.state.hub) || { r: Math.floor(GRID_ROWS / 2), c: Math.floor(GRID_COLS / 2) };
    const cx = px(hub.c + 0.5), cy = py(hub.r + 0.5), cell = S.cell;
    const p = new Path2D();
    p.moveTo(cx + 4 * cell, cy); p.arc(cx, cy, 4 * cell, 0, TAU);
    p.moveTo(cx + 7 * cell, cy); p.arc(cx, cy, 7 * cell, 0, TAU);
    for (let i = 0; i < 36; i++) {
      const a = i * TAU / 36, r0 = 7 * cell, r1 = 7 * cell + 4;
      p.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); p.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
    S.ringsPath = p;
  }

  function drawGrid(ctx) {
    // dots .09 -> .22 while placing (tween 160ms)
    const target = R.placing ? 0.22 : 0.09;
    const k = Math.min(1, S.dt / 0.16);
    S.dotAlpha = Math.abs(target - S.dotAlpha) < 0.002 ? target : lerp(S.dotAlpha, target, k);
    ctx.fillStyle = rgba(col('ivory'), S.dotAlpha);
    ctx.fill(S.dotsPath);
    ctx.strokeStyle = rgba(col('ice'), 0.06); ctx.lineWidth = 1;
    ctx.stroke(S.ringsPath);
  }

  // Bottom-left mono readout: PLOT 15x9 . CELL r:cc (1-based; blank cell when none)
  function drawReadout(ctx) {
    const font = '500 10px "JetBrains Mono","Cascadia Mono",Consolas,monospace';
    ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const h = R.hover;
    const cellTxt = h ? `${h.r + 1}:${String(h.c + 1).padStart(2, '0')}` : '';
    const txt = `PLOT ${GRID_COLS}x${GRID_ROWS} · CELL ${cellTxt}`;
    ctx.fillStyle = rgba(col('ivory'), 0.35);
    ctx.fillText(txt, 14, S.h - 12);
  }

  // ------------------------------------------------------------------
  // Section H. Station structure, rebuilt on Sim 'change': cell list,
  // hub distances, registry/berth tags, dock open sides, truss spars
  // ------------------------------------------------------------------

  function onChange() {
    const s = (typeof Sim !== 'undefined' && Sim) ? Sim.state : null;
    S.bgRequest = null;                      // the live game's name wins again once play resumes
    if (!s) { S.cellsArr = []; S.spars = []; S.trussDirty = true; return; }
    const cells = Sim.cells();
    S.cellsArr = cells;
    const occ = new Set(cells.map(x => keyOf(x.r, x.c)));

    // BFS distance from the hub over occupied cells
    const dist = new Map();
    const hk = keyOf(s.hub.r, s.hub.c);
    if (occ.has(hk)) {
      dist.set(hk, 0);
      const q = [[s.hub.r, s.hub.c]];
      while (q.length) {
        const [r, c] = q.shift(), d = dist.get(keyOf(r, c));
        for (const [nr, nc] of Sim.neighbors(r, c)) {
          const k = keyOf(nr, nc);
          if (occ.has(k) && !dist.has(k)) { dist.set(k, d + 1); q.push([nr, nc]); }
        }
      }
    }
    S.dist = dist;

    // registry tags: NN per id ordered by built day, then r, then c; berths: hub 1, docks from 2
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

    // dock open sides (from berthPoint offset) for every berth-bearing module incl. the hub
    const dockInfo = new Map();
    for (const x of cells) {
      if (!((MODULES[x.m.id].docks || 0) > 0)) continue;
      const bp = Sim.berthPoint(x.r, x.c);
      let open = null;
      if (bp) {
        const dx = bp.x - (x.c + 0.5), dy = bp.y - (x.r + 0.5);
        open = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
      }
      dockInfo.set(keyOf(x.r, x.c), { open, usable: !!bp, berth: (tags.get(keyOf(x.r, x.c)) || {}).berth || 0, bp });
    }
    S.dockInfo = dockInfo;

    // spars: one per adjacent pair, oriented hub-side -> far side
    const old = new Map(S.spars.map(sp => [sp.key, sp]));
    const spars = [];
    const grow = S.growCell;
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
        spars.push({ key, a, b, born, far: b, phase: (b.r * 7 + b.c * 13) * 0.37 });
      }
    }
    S.growCell = null;
    S.spars = spars;
    S.trussDirty = true;

    // name change -> rebake background (debounced)
    if (S.bgName !== null && s.name !== S.bgName) scheduleBake(120, s.name);
    if (!S.bgBaked) scheduleBake(0, s.name);
    buildRingPath();
    // a new state object (newGame / load): forget the stock baseline so nothing flashes on boot
    if (S.stateRef !== s) { S.stateRef = s; S.lastStock = null; S.pops.clear(); S.dockState.clear(); S.hoverKey = S.selKey = null; }
    S.cellCount = cells.length;
  }

  // Cheap guard for grid changes that arrive without a 'change' event (Sim.load() emits none)
  function structureStale(s) {
    if (S.stateRef !== s) return true;
    let n = 0;
    const g = s.grid;
    for (let r = 0; r < g.length; r++) { const row = g[r]; for (let c = 0; c < row.length; c++) if (row[c]) n++; }
    return n !== S.cellCount;
  }

  // Build the static truss Path2Ds from fully grown spars (7.7)
  function buildTrussPaths() {
    const fill = new Path2D(), edge = new Path2D(), cond = new Path2D(), nodes = new Path2D();
    const cell = S.cell, w = 0.16 * cell, hw = w / 2, inset = 0.44 * cell, n2 = devPx(2);
    const now = nowMs();
    let pending = false;
    for (const sp of S.spars) {
      if (now - sp.born < 250) { pending = true; continue; }
      const ax = px(sp.a.c + 0.5), ay = py(sp.a.r + 0.5), bx = px(sp.b.c + 0.5), by = py(sp.b.r + 0.5);
      if (ay === by) {   // horizontal
        const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
        fill.rect(x0, ay - hw, x1 - x0, w);
        const yA = snap(ay - hw), yB = snap(ay + hw), yC = snap(ay);
        edge.moveTo(x0 + inset, yA); edge.lineTo(x1 - inset, yA);
        edge.moveTo(x0 + inset, yB); edge.lineTo(x1 - inset, yB);
        cond.moveTo(x0 + inset, yC); cond.lineTo(x1 - inset, yC);
        nodes.rect(x0 + inset - n2 / 2, ay - n2 / 2, n2, n2); nodes.rect(x1 - inset - n2 / 2, ay - n2 / 2, n2, n2);
      } else {           // vertical
        const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
        fill.rect(ax - hw, y0, w, y1 - y0);
        const xA = snap(ax - hw), xB = snap(ax + hw), xC = snap(ax);
        edge.moveTo(xA, y0 + inset); edge.lineTo(xA, y1 - inset);
        edge.moveTo(xB, y0 + inset); edge.lineTo(xB, y1 - inset);
        cond.moveTo(xC, y0 + inset); cond.lineTo(xC, y1 - inset);
        nodes.rect(ax - n2 / 2, y0 + inset - n2 / 2, n2, n2); nodes.rect(ax - n2 / 2, y1 - inset - n2 / 2, n2, n2);
      }
    }
    S.trussFill = fill; S.trussEdge = edge; S.trussConduit = cond; S.trussNodes = nodes;
    S.trussDirty = pending;   // rebuild again once growing spars finish
  }

  function drawTrusses(ctx) {
    if (S.trussDirty || !S.trussFill) buildTrussPaths();
    const cell = S.cell, w = 0.16 * cell, inset = 0.44 * cell;
    ctx.fillStyle = col('truss'); ctx.fill(S.trussFill);
    ctx.strokeStyle = col('hull-edge'); ctx.lineWidth = 1; ctx.stroke(S.trussEdge);
    ctx.strokeStyle = rgba(col('ice'), 0.3); ctx.stroke(S.trussConduit);
    ctx.fillStyle = col('ice'); ctx.fill(S.trussNodes);

    // growing spars (250ms from the hub side), drawn individually until baked into the paths
    const now = nowMs();
    for (const sp of S.spars) {
      const age = now - sp.born;
      if (age >= 250) continue;
      const p = easeOutCubic(Math.max(0, age) / 250);
      const ax = px(sp.a.c + 0.5), ay = py(sp.a.r + 0.5), bx = px(sp.b.c + 0.5), by = py(sp.b.r + 0.5);
      const ex = ax + (bx - ax) * p, ey = ay + (by - ay) * p;
      ctx.fillStyle = col('truss');
      if (ay === by) ctx.fillRect(Math.min(ax, ex), ay - w / 2, Math.abs(ex - ax), w);
      else ctx.fillRect(ax - w / 2, Math.min(ay, ey), w, Math.abs(ey - ay));
      ctx.strokeStyle = col('hull-edge'); ctx.lineWidth = 1;
      ctx.beginPath();
      if (ay === by) { const ya = snap(ay - w / 2), yb = snap(ay + w / 2); ctx.moveTo(ax, ya); ctx.lineTo(ex, ya); ctx.moveTo(ax, yb); ctx.lineTo(ex, yb); }
      else { const xa = snap(ax - w / 2), xb = snap(ax + w / 2); ctx.moveTo(xa, ay); ctx.lineTo(xa, ey); ctx.moveTo(xb, ay); ctx.lineTo(xb, ey); }
      ctx.stroke();
    }

    // running lights: one 2 device px lamp dot per spar, hub side -> far end over 1.2s every 2.5s
    if (!S.reduced && S.tier < 2) {
      const d2 = devPx(2), t = S.time;
      ctx.fillStyle = col('lamp');
      for (const sp of S.spars) {
        if (now - sp.born < 250) continue;
        const ph = ((t + sp.phase) % 2.5 + 2.5) % 2.5;
        if (ph >= 1.2) continue;
        const k = ph / 1.2;
        const ax = px(sp.a.c + 0.5), ay = py(sp.a.r + 0.5), bx = px(sp.b.c + 0.5), by = py(sp.b.r + 0.5);
        const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
        const sx = ax + ux * inset, sy = ay + uy * inset, tx = bx - ux * inset, ty = by - uy * inset;
        ctx.fillRect(sx + (tx - sx) * k - d2 / 2, sy + (ty - sy) * k - d2 / 2, d2, d2);
      }
    }
  }

  // BFS over occupied cells from (r0,c0) to the nearest cell whose id is in `targets`
  // (falls back to the hub). Returns the list of cells from start to target.
  function pathToStorage(r0, c0) {
    const s = Sim.state;
    const occ = new Set(S.cellsArr.map(x => keyOf(x.r, x.c)));
    const hasWh = S.cellsArr.some(x => x.m.id === 'warehouse');
    const isTarget = (r, c) => { const m = s.grid[r][c]; return m && (hasWh ? m.id === 'warehouse' : m.id === 'hub'); };
    const start = keyOf(r0, c0), parent = new Map([[start, null]]), q = [[r0, c0]];
    let found = null;
    while (q.length && !found) {
      const [r, c] = q.shift();
      if (!(r === r0 && c === c0) && isTarget(r, c)) { found = [r, c]; break; }
      for (const [nr, nc] of Sim.neighbors(r, c)) {
        const k = keyOf(nr, nc);
        if (occ.has(k) && !parent.has(k)) { parent.set(k, [r, c]); q.push([nr, nc]); }
      }
    }
    if (!found) return null;
    const path = [];
    let cur = found;
    while (cur) { path.unshift(cur); cur = parent.get(keyOf(cur[0], cur[1])); }
    return path;
  }

  // ------------------------------------------------------------------
  // Section I. Sprite baking (8.0): keyed id|cellDevicePx|variant|tag
  // ------------------------------------------------------------------

  const OFFLINE = { plate: '#2A2F3D', rim: '#55596A', strip: '#55596A', sil: '#6C7284' };

  function hasArt(id) { return typeof ART !== 'undefined' && ART && ART[id] && typeof ART[id] === 'object'; }

  // Tag string for a cell: registry tag and berth tag, or '' until fonts are ready / cell < 48px
  function tagStringFor(id, key) {
    if (!S.fontsReady || S.cell < 48) return '';
    const t = S.tags.get(key); if (!t) return '';
    const reg = t.reg || '';
    const berth = (id !== 'hub' && (MODULES[id].docks || 0) > 0 && t.berth) ? String(t.berth).padStart(2, '0') : '';
    return reg + '|' + berth;
  }

  // Open side ('e'|'w'|'s'|'n') baked into dock silhouettes so the U collar faces the berth;
  // '' for every other module (the hub is rotation-symmetric, its LEDs live in lit/tell).
  function openSideFor(id, key) {
    if (id === 'hub' || !((MODULES[id].docks || 0) > 0)) return '';
    const di = S.dockInfo.get(key);
    return (di && di.open) || 'e';
  }

  // Preview side for the placement ghost, derived from berthPoint exactly like onChange does
  function previewOpenSide(id, r, c) {
    if (id === 'hub' || !((MODULES[id].docks || 0) > 0)) return '';
    const bp = Sim.berthPoint(r, c);
    if (!bp) return 'e';
    const dx = bp.x - (c + 0.5), dy = bp.y - (r + 0.5);
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
  }

  function spriteFor(id, variant, tagStr, open) {
    open = open || '';
    const key = `${id}|${S.cellDev}|${variant}|${tagStr}|${open}`;
    let spr = S.sprites.get(key);
    if (!spr) { spr = bakeSprite(id, variant, tagStr, open); S.sprites.set(key, spr); }
    return spr;
  }

  function bakeSprite(id, variant, tagStr, open) {
    const pad = 6, cd = S.cellDev, size = cd + pad * 2;
    const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
    const g = cv.getContext('2d');
    const k = cd / 100, dpu = 100 / cd;            // k: device px per unit; dpu: units per device px
    const isHub = id === 'hub';
    const off = variant === 'offline';
    const fam = famColor(id);
    const plateCol = off ? OFFLINE.plate : col('hull');
    const rimCol = off ? OFFLINE.rim : col('hull-rim');
    const stripCol = off ? OFFLINE.strip : fam;
    const silCol = off ? OFFLINE.sil : fam;
    g.translate(pad, pad); g.scale(k, k);
    g.lineJoin = 'round'; g.lineCap = 'round';

    const shape = (inset) => {
      const p = new Path2D();
      if (isHub) hexPath(p, 50, 50, 48 + inset);
      else roundRect(p, 6 - inset, 6 - inset, 88 + 2 * inset, 88 + 2 * inset, 10 + inset);
      return p;
    };

    // 1. shadow skirt: three shapes at (+2,+3) device px, alpha .25/.15/.08, growing 1 device px each
    g.save(); g.translate(2 * dpu, 3 * dpu);
    const skirt = [[2, 0.08], [1, 0.15], [0, 0.25]];
    for (const [grow, a] of skirt) { g.fillStyle = `rgba(0,0,0,${a})`; g.fill(shape(grow * dpu)); }
    g.restore();

    // 2. plate: fill, 1.5u rim, 2 device px key-light edges (top/left highlight, bottom/right shade)
    const plate = shape(0);
    g.fillStyle = plateCol; g.fill(plate);
    g.save(); g.clip(plate);
    g.lineWidth = 2 * dpu;
    g.save(); g.translate(dpu, dpu); g.strokeStyle = 'rgba(255,255,255,.10)'; g.stroke(plate); g.restore();
    g.save(); g.translate(-dpu, -dpu); g.strokeStyle = 'rgba(0,0,0,.55)'; g.stroke(plate); g.restore();
    g.restore();
    g.strokeStyle = rimCol; g.lineWidth = isHub ? 2 : 1.5; g.stroke(plate);

    if (!isHub) {
      // 3. signal strip: 4u tall along the top edge inside the rim, inset by the radius
      g.fillStyle = stripCol; g.fillRect(16, 7.5, 68, 4);
      // 4. rivets: four r=2u dots at the plate corners
      g.fillStyle = 'rgba(255,255,255,.3)';
      for (const [x, y] of [[13, 13], [87, 13], [13, 87], [87, 87]]) { g.beginPath(); g.arc(x, y, 2, 0, TAU); g.fill(); }
    }

    // 5. silhouette (family color, 55% fill / 100% stroke 2u) by art.js; fallback plate + two-letter tag
    const st = {
      color: silCol, lamp: col('lamp'), cellPx: S.cell, dpr: S.dpr, variant, reduced: S.reduced,
      // docks: the collar opening is part of the baked silhouette (art-mod-a _dockFrame reads st.dock.open)
      dock: open ? { open, usable: true, approaching: false, docked: false, progress: 0, berth: 0 } : null,
    };
    let drawn = false;
    if (hasArt(id) && typeof ART[id].silhouette === 'function') {
      g.save();
      try { ART[id].silhouette(g, k / S.dpr, st); drawn = true; } catch (e) { drawn = false; }
      g.restore();
    }
    if (!drawn) fallbackSilhouette(g, id, silCol, isHub);

    // offline hatch (solar): 45deg, 3u pitch, rgba(255,255,255,.12), clipped to the plate
    if (off) {
      g.save(); g.clip(plate);
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = Math.max(dpu, 1);
      g.beginPath();
      for (let d = -100; d <= 200; d += 3) { g.moveTo(d, 0); g.lineTo(d - 100, 100); }
      g.stroke(); g.restore();
    }

    // 6. tags (fonts ready and cell >= 48 only; tagStr is '' otherwise)
    if (tagStr) {
      const [reg, berth] = tagStr.split('|');
      g.textAlign = 'right'; g.textBaseline = 'alphabetic';
      if (reg) {
        g.font = '500 12px "JetBrains Mono","Cascadia Mono",Consolas,monospace';
        g.fillStyle = rgba(col('ivory'), 0.3);
        g.fillText(reg, 90, 90);
      }
      if (berth) {
        g.font = '500 14px "JetBrains Mono","Cascadia Mono",Consolas,monospace';
        g.fillStyle = rgba(col('ivory'), 0.55);
        g.fillText(berth, 90, 26);
      }
    }
    return cv;
  }

  // Used when art.js (or a module bundle) is missing: rounded inner plate + two-letter tag
  function fallbackSilhouette(g, id, color, isHub) {
    g.fillStyle = rgba(color, 0.55); g.strokeStyle = color; g.lineWidth = 2;
    const p = new Path2D();
    if (isHub) hexPath(p, 50, 50, 34); else roundRect(p, 24, 24, 52, 52, 8);
    g.fill(p); g.stroke(p);
    g.fillStyle = col('ink');
    g.font = '600 28px "Barlow Condensed","Bahnschrift Condensed","Arial Narrow",sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((PREFIX[id] || id.slice(0, 2).toUpperCase()), 50, 51);
  }

  // Baked radial glow disc (bake-time gradient only), cached by color|radius(device px)
  function glowSprite(color, rDev) {
    const key = color + '|' + rDev;
    let c = S.glows.get(key);
    if (c) return c;
    c = document.createElement('canvas'); c.width = c.height = rDev * 2;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(rDev, rDev, 0, rDev, rDev, rDev);
    gr.addColorStop(0, rgba(color, 1)); gr.addColorStop(0.5, rgba(color, 0.35)); gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr; g.fillRect(0, 0, rDev * 2, rDev * 2);
    S.glows.set(key, c);
    return c;
  }

  // ------------------------------------------------------------------
  // Section J. Modules per frame: sprite blit, glow, lit, tell, status overlays
  // ------------------------------------------------------------------

  // Per-frame shared data computed once (Sim.totals() once per frame, 14.1)
  function frameShared(s) {
    const T = Sim.totals();
    const byDock = S.shipsByDock; byDock.clear();
    let linerNear = false;
    const hx = s.hub.c + 0.5, hy = s.hub.r + 0.5;
    for (const sh of s.ships) {
      if (sh.dock && (sh.state === 'approach' || sh.state === 'docked')) byDock.set(keyOf(sh.dock.r, sh.dock.c), sh);
      if (sh.cls === 'liner' && Math.hypot(sh.x - hx, sh.y - hy) < 6) linerNear = true;
    }
    // warehouse stock change flash (400ms)
    if (S.lastStock !== null && T.stockTotal !== S.lastStock) S.stockChangedAt = nowMs();
    S.lastStock = T.stockTotal;
    const cond = document.body ? document.body.getAttribute('data-condition') : null;
    const flags = {
      flare: !!T.flare,
      festival: s.day < (s.fx && s.fx.festivalUntil || 0),
      alert: cond === 'alert',
      loan: Object.values(s.companies).some(c => !!c.loan),
      converting: (s.stock.ore || 0) >= 6,
      xeno: (s.stock.xenofauna || 0) > 0,
      linerNear,
      shipAdjacent: false,
      stockChanged: nowMs() - S.stockChangedAt < 400,
    };
    S.hoveredShip = S.mouse ? shipAt(S.mouse.x, S.mouse.y) : null;
    return { T, flags };
  }

  // market trends: signs of (effPrice - base) for the four goods furthest from base
  function marketTrends(s) {
    const arr = GOOD_IDS.map(g => { const b = GOODS[g].base, d = Sim.effPrice(g) - b; return { k: Math.abs(d) / b, s: d > b * 0.02 ? 1 : d < -b * 0.02 ? -1 : 0 }; });
    arr.sort((a, b) => b.k - a.k);
    return arr.slice(0, 4).map(x => x.s);
  }

  function tellClassOf(id) {
    if (hasArt(id) && (ART[id].tellClass === 'A' || ART[id].tellClass === 'B')) return ART[id].tellClass;
    return CLASS_B[id] ? 'B' : 'A';
  }

  // Which class-B tells may run this frame (8.0): cell >= 44, within 3 cells of the mouse
  // or total modules <= 12, at most 16 (nearest the mouse win); none at tier 2.
  function bTellBudget(T) {
    const allowed = new Set();
    if (S.cell < 44 || S.tier >= 2 || S.reduced) return allowed;
    const few = (T.modules + 1) <= 12;
    const cand = [];
    for (const x of S.cellsArr) {
      if (tellClassOf(x.m.id) !== 'B') continue;
      let d = 0;
      if (S.mouse) d = Math.hypot(px(x.c + 0.5) - S.mouse.x, py(x.r + 0.5) - S.mouse.y) / S.cell;
      else d = few ? 0 : 99;
      if (few || d <= 3) cand.push({ k: keyOf(x.r, x.c), d });
    }
    cand.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(16, cand.length); i++) allowed.add(cand[i].k);
    return allowed;
  }

  function buildSt(id, key, r, c, def, T, flags, s, powered, trends) {
    const hov = !!(R.hover && R.hover.r === r && R.hover.c === c);
    const sel = !!(R.selected && R.selected.r === r && R.selected.c === c);
    let dock = null;
    if ((def.docks || 0) > 0) {
      const di = S.dockInfo.get(key) || { open: null, usable: false, berth: 0 };
      const sh = S.shipsByDock.get(key);
      const docked = !!(sh && sh.state === 'docked');
      let progress = 0;
      if (docked) { const dd = SHIP_CLASSES[sh.cls].dockDays || 1; progress = Math.max(0, Math.min(1, 1 - (sh.dockedUntil - Sim.now()) / dd)); }
      // clamp slide (9.3): 0 open .. 1 closed, eased over 300ms from the moment docked flips
      let ds = S.dockState.get(key);
      if (!ds) { ds = { docked, at: -1e12 }; S.dockState.set(key, ds); }
      else if (ds.docked !== docked) { ds.docked = docked; ds.at = nowMs(); }
      const kc = easeOutCubic(Math.max(0, Math.min(1, (nowMs() - ds.at) / 300)));
      const clamp = docked ? kc : 1 - kc;
      dock = { open: di.open, usable: di.usable, approaching: !!(sh && sh.state === 'approach'), docked, progress, berth: di.berth, clamp };
    }
    let ratio = 0, crowd = 0;
    if (id === 'quarters') ratio = T.beds ? Math.min(1, T.visitors / T.beds) : 0;
    else if (id === 'habitat') ratio = T.homes ? Math.min(1, s.residents / T.homes) : 0;
    else if (id === 'warehouse') ratio = T.storage ? Math.min(1, T.stockTotal / T.storage) : 0;
    else if (id === 'plaza') {
      // 8.1 plaza: crowd dots = clamp(round(residents/5), 0, 6); ratio keeps the art's ratio*6 fallback consistent
      crowd = Math.max(0, Math.min(6, Math.round((s.residents || 0) / 5)));
      ratio = Math.min(1, (s.residents || 0) / 30);
    }
    const load = T.produced > 0 ? T.used / T.produced : (T.used > 0 ? 2 : 0);
    // per-module flags: shipAdjacent (a docked ship on an adjacent berth)
    let shipAdjacent = false;
    for (const [nr, nc] of Sim.neighbors(r, c)) { const sh = S.shipsByDock.get(keyOf(nr, nc)); if (sh && sh.state === 'docked') { shipAdjacent = true; break; } }
    const f = Object.assign({}, flags, { shipAdjacent });
    return {
      color: famColor(id), lamp: col('lamp'),
      T, efficiency: T.efficiency, powered, hover: hov, selected: sel, reduced: S.reduced,
      cellPx: S.cell, dpr: S.dpr, dock, ratio, crowd, load, day: s.day + s.t,
      trends: id === 'market' ? trends : null, flags: f,
    };
  }

  function drawModules(ctx, s, T, flags) {
    const cell = S.cell, u = cell / 100, dpr = S.dpr, now = S.time;
    const short = T.efficiency < 1;
    const bAllowed = bTellBudget(T);
    const trends = T.hasMarket ? marketTrends(s) : null;
    const padCss = 6 / dpr;
    const nowM = nowMs();

    for (const { r, c, m } of S.cellsArr) {
      const id = m.id, def = MODULES[id]; if (!def) continue;
      const key = keyOf(r, c), x = px(c), y = py(r);
      const offline = id === 'solar' && T.flare;
      const variant = offline ? 'offline' : 'normal';
      const spr = spriteFor(id, variant, tagStringFor(id, key), openSideFor(id, key));
      const powered = !offline && (def.power >= 0 || !short);

      // commit pop: scale 0.7 -> 1.06 -> 1.0 over 180ms (ease-out-back)
      let scale = 1;
      const pop = S.pops.get(key);
      if (pop != null) {
        const k = (nowM - pop) / 180;
        if (k >= 1) S.pops.delete(key); else scale = 0.7 + 0.3 * easeOutBack(Math.max(0, k));
      }
      ctx.save();
      if (scale !== 1) { ctx.translate(x + cell / 2, y + cell / 2); ctx.scale(scale, scale); ctx.translate(-(x + cell / 2), -(y + cell / 2)); }

      // baked sprite, integer aligned (x,y are device-aligned, pad is a whole device px count)
      ctx.drawImage(spr, x - padCss, y - padCss, spr.width / dpr, spr.height / dpr);

      // one baked radial glow under hero cores (hub, reactor, gate); art-mod-b no longer draws its own
      if (id === 'hub' || id === 'reactor' || id === 'gate') {
        const gc = id === 'hub' ? col('ivory') : id === 'reactor' ? '#9FE8D8' : col('ice');
        const gr = id === 'hub' ? 16 : id === 'reactor' ? 12 : 20;
        const ga = id === 'hub' ? 0.35 : id === 'reactor' ? 0.4 : 0.4;
        const gs = glowSprite(gc, gr);
        ctx.globalAlpha = ga * (powered ? 1 : 0.5);
        ctx.drawImage(gs, x + cell / 2 - gr / dpr, y + cell / 2 - gr / dpr, gs.width / dpr, gs.height / dpr);
        ctx.globalAlpha = 1;
      }

      // live layers via art.js, in unit space
      const art = hasArt(id) ? ART[id] : null;
      if (art) {
        const st = buildSt(id, key, r, c, def, T, flags, s, powered, trends);
        if (!offline && typeof art.lit === 'function') {
          ctx.save();
          // unpowered dimming (8.0, 50%) is applied by the art bundles from st.powered, not here
          ctx.translate(x, y); ctx.scale(u, u);
          try { art.lit(ctx, u, st); } catch (e) { /* art error must not kill the frame */ }
          ctx.restore();
        }
        if (typeof art.tell === 'function' && tellAllowed(id, key, bAllowed)) {
          ctx.save();
          ctx.translate(x, y); ctx.scale(u, u);
          // unpowered consumers freeze at phase 0; offline solar is frozen too; hub/market tells
          // also carry static geometry (middle ring, ticker marks) so they run frozen when gated
          // (beacons and dock LEDs in REDUCED_KEEP keep their clock under reduced motion, 8.0)
          const frozen = !powered || S.cell < 36 || (S.reduced && !REDUCED_KEEP[id]);
          const t = frozen ? 0 : now + (r * 7 + c * 13) * 0.37;
          try { art.tell(ctx, u, t, st); } catch (e) { /* ignore */ }
          ctx.restore();
        }
      }

      // status overlay: power shortage on every consumer (dashed warn ring + 6u triangle)
      if (short && def.power < 0) drawPowerShortage(ctx, x, y, cell, now);

      ctx.restore();
    }
  }

  function tellAllowed(id, key, bAllowed) {
    // hub (middle ring) and market (ticker marks) draw silhouette geometry inside tell; always
    // called, with a frozen clock when gated (see drawModules)
    if (id === 'hub' || id === 'market') return true;
    if (S.cell < 36) return false;
    if (S.reduced) return !!REDUCED_KEEP[id];
    if (tellClassOf(id) === 'B') return bAllowed.has(key);
    return true;
  }

  function drawPowerShortage(ctx, x, y, cell, now) {
    const u = cell / 100, warn = col('warn');
    const inset = 2 * u, rad = 12 * u, w = cell - 2 * inset;
    const perim = 4 * w - (8 - TAU) * rad;
    ctx.save();
    ctx.strokeStyle = warn; ctx.lineWidth = 1;
    ctx.setLineDash([devPx(4), devPx(3)]);
    ctx.lineDashOffset = -((now / 12) % 1) * perim;
    ctx.beginPath(); roundRect(ctx, x + inset, y + inset, w, w, rad); ctx.stroke();
    ctx.setLineDash([]);
    // 6u warning triangle at the top-right corner
    const tx = x + cell - 8 * u, ty = y + 8 * u, h = 6 * u;
    ctx.fillStyle = warn;
    ctx.beginPath(); ctx.moveTo(tx, ty - h / 2); ctx.lineTo(tx + h / 2, ty + h / 2); ctx.lineTo(tx - h / 2, ty + h / 2); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Section K. Ships (9) and approach vectors (7.6)
  // ------------------------------------------------------------------

  // Stamp each ship's entry point on first sight; re-stamp when it leaves the queue for a berth
  function stampEntry(sh) {
    let e = S.entry.get(sh);
    if (!e) { e = { x0: sh.x, y0: sh.y, state: sh.state }; S.entry.set(sh, e); }
    else if (e.state !== sh.state) {
      if (sh.state === 'approach' && e.state === 'queue') { e.x0 = sh.x; e.y0 = sh.y; }
      e.state = sh.state;
    }
    return e;
  }

  function drawApproachVectors(ctx, s) {
    const ivory = rgba(col('ivory'), 0.07), ice = rgba(col('ice'), 0.2), cell = S.cell;
    ctx.save();
    ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
    for (const sh of s.ships) {
      const e = stampEntry(sh);
      if (sh.state !== 'approach' || !sh.target) continue;
      const ax = px(e.x0), ay = py(e.y0), bx = px(sh.target.x), by = py(sh.target.y);
      const L = Math.hypot(bx - ax, by - ay) || 1, cut = Math.max(0, L - 2 * cell) / L;
      const mx = ax + (bx - ax) * cut, my = ay + (by - ay) * cut;
      ctx.strokeStyle = ivory; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(mx, my); ctx.stroke();
      ctx.strokeStyle = ice; ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawShips(ctx, s) {
    const cell = S.cell, hov = S.hoveredShip, now = Sim.now();
    const useShips = typeof Ships !== 'undefined' && Ships && typeof Ships.draw === 'function';
    for (const sh of s.ships) {
      const x = px(sh.x), y = py(sh.y);
      const cu = cellAt(x, y);
      const overHull = !!(cu && s.grid[cu.r][cu.c]);
      // speed is the 0..1 ship-speed fraction (ships fly at the constant SHIP_SPEED), never the game speed;
      // bloomK ramps the engine bloom 0 -> 1 over 400ms after 'depart' (9.3)
      let bloomK = 1;
      if (sh.state === 'depart') { const d0 = S.departAt.get(sh); if (d0 != null) bloomK = Math.max(0, Math.min(1, (nowMs() - d0) / 400)); }
      const o = { x, y, cell, t: S.time, now, hovered: sh === hov, overHull, reduced: S.reduced, tier: S.tier, speed: 1, bloomK };
      if (useShips) {
        ctx.save();
        try { Ships.draw(ctx, sh, o); } catch (e) { ctx.restore(); ctx.save(); fallbackShip(ctx, sh, o); }
        ctx.restore();
      } else { ctx.save(); fallbackShip(ctx, sh, o); ctx.restore(); }
    }
  }

  // Minimal hull when ships.js is absent: company-colored dart with outline and hover ring
  function fallbackShip(ctx, sh, o) {
    const cls = SHIP_CLASSES[sh.cls], L = cls.size * o.cell / 14, color = companyColor(sh.company);
    ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(sh.angle);
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, 0); ctx.lineTo(-L * 0.8, -L * 0.55); ctx.lineTo(-L * 0.45, 0); ctx.lineTo(-L * 0.8, L * 0.55); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    if (o.hovered) { ctx.strokeStyle = col('ivory'); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(o.x, o.y, L + 4, 0, TAU); ctx.stroke(); }
  }

  // ------------------------------------------------------------------
  // Section L. Placement feedback (10): dim + punch-out, brackets, ghost,
  // preview spars, dock lane, reason and advisory plates
  // ------------------------------------------------------------------

  // Four L-brackets of length `len` at the corners of a cell, inset by `inset`
  function addBrackets(p, x, y, size, len, inset) {
    const x0 = snap(x + inset), y0 = snap(y + inset), x1 = snap(x + size - inset), y1 = snap(y + size - inset);
    p.moveTo(x0, y0 + len); p.lineTo(x0, y0); p.lineTo(x0 + len, y0);
    p.moveTo(x1 - len, y0); p.lineTo(x1, y0); p.lineTo(x1, y0 + len);
    p.moveTo(x1, y1 - len); p.lineTo(x1, y1); p.lineTo(x1 - len, y1);
    p.moveTo(x0 + len, y1); p.lineTo(x0, y1); p.lineTo(x0, y1 - len);
  }

  // Drawn before trusses and modules: dims every non-candidate cell, brackets candidates
  function drawPlacementField(ctx, s) {
    const id = R.placing, cell = S.cell, G = S.gridRect;
    const legal = [], illegal = [];
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
      if (s.grid[r][c]) continue;
      if (!Sim.neighbors(r, c).some(([nr, nc]) => Sim.occupied(nr, nc))) continue;
      (Sim.canPlace(id, r, c).ok ? legal : illegal).push({ r, c });
    }
    // one rgba(4,5,10,.4) fill of the grid rectangle with every legal cell punched out
    const dim = new Path2D();
    dim.rect(G.x0, G.y0, G.x1 - G.x0, G.y1 - G.y0);
    for (const { r, c } of legal) dim.rect(px(c), py(r), cell, cell);
    ctx.fillStyle = 'rgba(4,5,10,.4)'; ctx.fill(dim, 'evenodd');
    // legal brackets: ivory .55 +- .15 on a 2.5s sine, one Path2D stroked once
    if (legal.length) {
      const p = new Path2D();
      for (const { r, c } of legal) addBrackets(p, px(c), py(r), cell, 6, 2);
      ctx.strokeStyle = rgba(col('ivory'), 0.55 + 0.15 * Math.sin(S.time * TAU / 2.5)); ctx.lineWidth = 1; ctx.stroke(p);
    }
    // illegal-but-adjacent: bad brackets at .3 plus a 45deg hatch at 10%
    if (illegal.length) {
      const p = new Path2D(), hatch = new Path2D(), clip = new Path2D();
      for (const { r, c } of illegal) {
        const x = px(c), y = py(r);
        addBrackets(p, x, y, cell, 6, 2);
        clip.rect(x, y, cell, cell);
        for (let d = 0; d < cell * 2; d += 6) { hatch.moveTo(x + d, y); hatch.lineTo(x + d - cell, y + cell); }
      }
      ctx.save(); ctx.clip(clip);
      ctx.strokeStyle = rgba(col('bad'), 0.10); ctx.lineWidth = 1; ctx.stroke(hatch);
      ctx.restore();
      ctx.strokeStyle = rgba(col('bad'), 0.3); ctx.stroke(p);
    }
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

  // Advisories (placement still allowed): dock with no open side left; blocking another berth's last side
  function advisoryFor(id, r, c, s) {
    const def = MODULES[id];
    if ((def.docks || 0) > 0) {
      const nb = Sim.neighbors(r, c).filter(([nr, nc]) => Sim.inBounds(nr, nc));
      if (nb.length && nb.every(([nr, nc]) => Sim.occupied(nr, nc))) return 'BERTH WILL BE BLOCKED';
    }
    for (const [nr, nc] of Sim.neighbors(r, c)) {
      if (!Sim.occupied(nr, nc)) continue;
      const m = s.grid[nr][nc];
      if (!((MODULES[m.id].docks || 0) > 0)) continue;
      const empties = Sim.neighbors(nr, nc).filter(([ar, ac]) => Sim.inBounds(ar, ac) && !Sim.occupied(ar, ac));
      if (empties.length === 1) {
        const tag = S.tags.get(keyOf(nr, nc));
        return `BLOCKS BERTH ${String(tag ? tag.berth : 0).padStart(2, '0')}`;
      }
    }
    return null;
  }

  // Text on an rgba(4,5,10,.8) plate centred at cx with its top at topY. ctx.font is set by the caller.
  function drawPlate(ctx, cx, topY, text, color, font, h) {
    const w = textWidth(ctx, font, text) + 12;
    const x = Math.round(cx - w / 2);
    ctx.fillStyle = 'rgba(4,5,10,.8)'; ctx.fillRect(x, topY, w, h);
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, topY + h / 2 + 0.5);
    return { x, y: topY, w, h };
  }

  const FONT_MONO10 = '500 10px "JetBrains Mono","Cascadia Mono",Consolas,monospace';
  const FONT_CHIP = '600 11px "Barlow Condensed","Bahnschrift Condensed","Arial Narrow",sans-serif';

  // Drawn after modules: ghost sprite, outline, preview spars, dock lane, reason plate
  function drawGhost(ctx, s) {
    const id = R.placing, h = R.hover;
    if (!id || !h) { S.ghost = null; return; }
    const def = MODULES[id], cell = S.cell, dpr = S.dpr;
    const tx = px(h.c), ty = py(h.r);
    if (!S.ghost) S.ghost = { x: tx, y: ty };
    else { const k = Math.min(1, S.dt / 0.08); S.ghost.x = lerp(S.ghost.x, tx, k); S.ghost.y = lerp(S.ghost.y, ty, k); if (Math.abs(S.ghost.x - tx) < 0.2) S.ghost.x = tx; if (Math.abs(S.ghost.y - ty) < 0.2) S.ghost.y = ty; }
    const gx = S.ghost.x, gy = S.ghost.y, cx = gx + cell / 2, cy = gy + cell / 2;
    const occupied = !!s.grid[h.r][h.c];
    const chk = Sim.canPlace(id, h.r, h.c);

    if (!occupied) {
      // preview spars to each occupied neighbour at 40%
      ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = col('truss');
      const w = 0.16 * cell;
      for (const [nr, nc] of Sim.neighbors(h.r, h.c)) {
        if (!Sim.occupied(nr, nc)) continue;
        const nx = px(nc + 0.5), ny = py(nr + 0.5);
        if (ny === cy || nr === h.r) ctx.fillRect(Math.min(cx, nx), cy - w / 2, Math.abs(nx - cx), w);
        else ctx.fillRect(cx - w / 2, Math.min(cy, ny), w, Math.abs(ny - cy));
      }
      ctx.restore();
      // dock: open side previewed with a 1px dotted ice lane, 2 cells long
      if ((def.docks || 0) > 0) {
        const bp = Sim.berthPoint(h.r, h.c);
        if (bp) {
          const dx = Math.sign(bp.x - (h.c + 0.5)), dy = Math.sign(bp.y - (h.r + 0.5));
          ctx.save(); ctx.strokeStyle = col('ice'); ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
          ctx.beginPath(); ctx.moveTo(cx + dx * cell * 0.5, cy + dy * cell * 0.5); ctx.lineTo(cx + dx * cell * 2.5, cy + dy * cell * 2.5); ctx.stroke();
          ctx.restore();
        }
      }
      // the real sprite at 55% (docks: collar already facing the previewed lane)
      const spr = spriteFor(id, 'normal', '', previewOpenSide(id, h.r, h.c));
      ctx.save(); ctx.globalAlpha = 0.55;
      ctx.drawImage(spr, gx - 6 / dpr, gy - 6 / dpr, spr.width / dpr, spr.height / dpr);
      ctx.restore();
    }
    // dashed outline: ivory, or bad on an illegal cell
    ctx.save();
    ctx.strokeStyle = chk.ok ? col('ivory') : col('bad'); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.strokeRect(snap(gx), snap(gy), cell - 1 / dpr, cell - 1 / dpr);
    ctx.restore();
    // reason (bad) or advisory (warn) plate under the cell
    let text = null, color = null;
    if (!chk.ok) { text = mapReason(chk.why, def, s); color = col('bad'); }
    else { const adv = advisoryFor(id, h.r, h.c, s); if (adv) { text = adv; color = col('warn'); } }
    if (text) {
      ctx.font = FONT_MONO10;
      drawPlate(ctx, cx, gy + cell + 4, text, color, FONT_MONO10, 16);
    }
  }

  // ------------------------------------------------------------------
  // Section M. Hover and selection (10): outline, brackets, leader line, readout chip
  // ------------------------------------------------------------------

  function chipText(r, c, m) {
    const key = keyOf(r, c), def = MODULES[m.id], tag = S.tags.get(key) || { nn: 1, berth: 0 };
    const nn = String(tag.nn).padStart(2, '0');
    if ((def.docks || 0) > 0) {
      const di = S.dockInfo.get(key), sh = S.shipsByDock.get(key);
      const status = sh && sh.state === 'docked' ? 'DOCKED' : (di && di.usable) ? 'BERTH CLEAR' : 'BERTH BLOCKED';
      // the hub's collar is routinely built around: never alarm about it (matches ui.js hintFor/cellTip)
      if (m.id === 'hub') return status === 'BERTH BLOCKED' ? 'CORE HUB · BERTH 01' : `CORE HUB · BERTH 01 · ${status}`;
      return `DOCK ${nn} · BERTH ${String(tag.berth).padStart(2, '0')} · ${status}`;
    }
    const p = def.power || 0;
    return `${m.id.toUpperCase()} ${nn} · PWR ${p >= 0 ? '+' : '-'}${Math.abs(p)}`;
  }

  // Chip above the cell (below it in the top row) with a leader line from the cell edge
  function drawChip(ctx, r, c, m, gap) {
    const cell = S.cell, x = px(c), y = py(r), cx = x + cell / 2;
    const text = chipText(r, c, m);
    ctx.font = FONT_CHIP;
    const h = 18, below = r === 0;
    const topY = below ? y + cell + 10 : y - 10 - h;
    ctx.strokeStyle = rgba(col('ivory'), 0.5); ctx.lineWidth = 1;
    ctx.beginPath();
    if (below) { ctx.moveTo(snap(cx), y + cell + gap); ctx.lineTo(snap(cx), topY); }
    else { ctx.moveTo(snap(cx), y - gap); ctx.lineTo(snap(cx), topY + h); }
    ctx.stroke();
    drawPlate(ctx, cx, topY, text, col('ivory'), FONT_CHIP, h);
  }

  function drawSelection(ctx, s) {
    const cell = S.cell, dpr = S.dpr, nowM = nowMs();
    // hover outline (not placing)
    const hv = R.hover;
    if (!R.placing && hv && s.grid[hv.r] && s.grid[hv.r][hv.c]) {
      const key = keyOf(hv.r, hv.c);
      if (key !== S.hoverKey) { S.hoverKey = key; S.hoverT0 = nowM; }
      const x = px(hv.c), y = py(hv.r);
      ctx.strokeStyle = rgba(col('ivory'), 0.35); ctx.lineWidth = 1;
      ctx.strokeRect(snap(x), snap(y), cell - 1 / dpr, cell - 1 / dpr);
      const isSel = R.selected && R.selected.r === hv.r && R.selected.c === hv.c;
      if (!isSel && nowM - S.hoverT0 > 300) drawChip(ctx, hv.r, hv.c, s.grid[hv.r][hv.c], 2);
    } else S.hoverKey = null;

    // selected: four 10px brackets drawing in over 160ms, breathing 2px on a 3s sine, leader + chip
    const sel = R.selected;
    if (sel && s.grid[sel.r] && s.grid[sel.r][sel.c]) {
      const key = keyOf(sel.r, sel.c);
      if (key !== S.selKey) { S.selKey = key; S.selT0 = nowM; }
      const k = Math.min(1, (nowM - S.selT0) / 160), len = 10 * easeOutCubic(k);
      const breathe = S.reduced ? 1 : 1 + Math.sin(S.time * TAU / 3);   // 0..2 px outward
      const p = new Path2D();
      addBrackets(p, px(sel.c) - breathe, py(sel.r) - breathe, cell + 2 * breathe, len, 0);
      ctx.strokeStyle = col('ivory'); ctx.lineWidth = 1; ctx.stroke(p);
      drawChip(ctx, sel.r, sel.c, s.grid[sel.r][sel.c], breathe + 1);
    } else S.selKey = null;
  }

  // ------------------------------------------------------------------
  // Section N. Floaters (9.6): Render owns presentation via a WeakMap
  // ------------------------------------------------------------------

  const COMPANY_RAW = new Set(COMPANIES.map(c => c.color));
  function floaterColor(raw) {
    const c = String(raw || '').toLowerCase();
    if (c === '#ff9d5a') return col('warn');      // cost floater
    if (c === '#7ee787') return col('good');      // refund default
    if (COMPANY_RAW.has(raw)) return desatColor(raw, 0.15);
    return raw || col('ink');
  }

  function drawFloaters(ctx) {
    const list = Sim.floaters; if (!list || !list.length) return;
    const nowM = nowMs(), cell = S.cell;
    const live = [];
    // stamp new floaters, coalesce, enforce the visible cap
    for (const f of list) {
      let e = S.floaters.get(f);
      if (!e) {
        const num = parseFloat(String(f.text).replace(/[^\d.-]/g, '')) || 0;
        const sign = String(f.text).trim()[0] === '-' ? -1 : 1;
        e = { t0: nowM, x0: f.x, y0: f.y, value: Math.abs(num) * sign, sign, text: f.text, color: floaterColor(f.color), hidden: false, numeric: /\d/.test(f.text) };
        // coalesce into a live floater within 0.3s and 0.3 cells with the same sign
        for (const o of list) {
          if (o === f) continue;
          const oe = S.floaters.get(o);
          if (!oe || oe.hidden || !oe.numeric || !e.numeric) continue;
          if (nowM - oe.t0 < 300 && oe.sign === e.sign && Math.hypot(oe.x0 - f.x, oe.y0 - f.y) < 0.3) {
            oe.value += e.value;
            oe.text = (oe.sign < 0 ? '-' : '+') + fmt(Math.abs(oe.value));
            e.hidden = true; break;
          }
        }
        S.floaters.set(f, e);
      }
      if (!e.hidden && nowM - e.t0 < 1000) live.push(e);
    }
    if (live.length > 6) { live.sort((a, b) => a.t0 - b.t0); for (let i = 0; i < live.length - 6; i++) live[i].hidden = true; }
    if (!live.length) return;
    const size = Math.max(12, cell * 0.3);
    ctx.save();
    ctx.font = `600 ${size}px "JetBrains Mono","Cascadia Mono",Consolas,monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,5,10,.9)'; ctx.lineJoin = 'round';
    for (const e of live) {
      if (e.hidden) continue;
      const age = (nowM - e.t0) / 1000;
      const y = py(e.y0) - 0.5 * cell * easeOutCubic(age), x = px(e.x0);
      ctx.globalAlpha = age > 0.7 ? Math.max(0, 1 - (age - 0.7) / 0.3) : 1;
      ctx.strokeText(e.text, x, y);
      ctx.fillStyle = e.color; ctx.fillText(e.text, x, y);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Section O. Sim event handlers -> FX (9.3-9.5, 10 commit)
  // ------------------------------------------------------------------

  const hasFX = fn => typeof FX !== 'undefined' && FX && typeof FX[fn] === 'function';

  function onBuilt(d) {
    if (!d) return;
    const key = keyOf(d.r, d.c), cell = S.cell, cx = px(d.c + 0.5), cy = py(d.r + 0.5);
    S.pops.set(key, nowMs());
    S.growCell = { r: d.r, c: d.c, t: nowMs() };
    try {
      if (hasFX('sparks')) FX.sparks(cx, cy, famColor(d.id), 12, 300);
      if (hasFX('ring')) FX.ring(cx, cy, 0.5 * cell, 1.3 * cell, col('ivory'), 400);
    } catch (e) { /* fx is decorative */ }
  }

  function onDemolished(d) {
    if (!d) return;
    S.pops.delete(keyOf(d.r, d.c));
    S.hoverKey = null;
  }

  function onDock(ship) {
    if (!ship || !ship.dock) return;
    const cell = S.cell, cx = px(ship.dock.c + 0.5), cy = py(ship.dock.r + 0.5);
    try {
      if (hasFX('ring')) FX.ring(cx, cy, 0.2 * cell, 0.6 * cell, col('ice'), 300);
      if (hasFX('motes')) {
        const path = pathToStorage(ship.dock.r, ship.dock.c);
        if (path && path.length > 1) {
          const pts = path.map(([r, c]) => ({ x: px(c + 0.5), y: py(r + 0.5) }));
          const bought = ship.trades.some(t => /^Bought/.test(t));
          const sold = ship.trades.some(t => /^(Sold|Took)/.test(t));
          if (bought) FX.motes(pts, col('amber'), 3, 600, easeOutCubic);
          if (sold) FX.motes(pts.slice().reverse(), col('amber'), 3, 600, easeOutCubic);
        }
      }
    } catch (e) { /* ignore */ }
  }

  function onDepart(ship) {
    if (!ship) return;
    S.departAt.set(ship, nowMs());           // bloom ramp 0 -> full over 400ms (9.3)
    if (!(ship.earned > 0)) return;
    try {
      if (hasFX('motes')) FX.motes([{ x: px(ship.x), y: py(ship.y) }, { x: 16, y: 16 }], col('amber-hi'), 6, 600, easeInQuad);
    } catch (e) { /* ignore */ }
  }

  function onSpawn(ship) { if (ship) stampEntry(ship); }

  // ------------------------------------------------------------------
  // Section P. Frame, perf tiers (14.1), thumbnail, public API
  // ------------------------------------------------------------------

  function perfSample(ms) {
    S.perfEma = S.perfEma ? S.perfEma * 0.9 + ms * 0.1 : ms;
    if (S.perfEma > 8) { S.perfOver++; S.perfUnder = 0; } else { S.perfOver = 0; if (S.perfEma < 4) S.perfUnder++; else S.perfUnder = 0; }
    let tier = S.tier;
    if (S.perfOver >= 60 && tier < 2) { tier++; S.perfOver = 0; }
    else if (S.perfUnder >= 600 && tier > 0) { tier--; S.perfUnder = 0; }
    if (tier !== S.tier) {
      S.tier = tier;
      if (hasFX('setTier')) { try { FX.setTier(tier); } catch (e) { /* ignore */ } }
    }
  }

  function draw(dt) {
    const t0 = nowMs();
    S.dt = dt; S.time += dt;
    updateReduced();
    const ctx = S.ctx; if (!ctx) return;
    if (!S.bgBaked) bakeBackground();
    ctx.clearRect(0, 0, S.w, S.h);
    drawAmbient(ctx);
    const s = (typeof Sim !== 'undefined' && Sim) ? Sim.state : null;
    if (hasFX('update')) { try { FX.update(dt); } catch (e) { /* ignore */ } }
    if (!s) {
      if (hasFX('draw')) { try { FX.draw(ctx); } catch (e) { /* ignore */ } }
      perfSample(nowMs() - t0);
      return;
    }
    if (structureStale(s)) onChange();
    const { T, flags } = frameShared(s);
    drawGrid(ctx);
    if (R.placing) drawPlacementField(ctx, s);
    drawApproachVectors(ctx, s);
    drawTrusses(ctx);
    drawModules(ctx, s, T, flags);
    if (R.placing) drawGhost(ctx, s); else S.ghost = null;
    drawShips(ctx, s);
    if (hasFX('draw')) { try { FX.draw(ctx); } catch (e) { /* ignore */ } }
    drawSelection(ctx, s);
    drawFloaters(ctx);
    drawReadout(ctx);
    perfSample(nowMs() - t0);
  }

  // Baked plan of state.grid only (no Sim calls), for the title screen resume card
  function thumbnail(state, w, h) {
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = col('void'); g.fillRect(0, 0, w, h);
    const grid = state && state.grid;
    if (!grid || !grid.length) return c;
    const rows = grid.length, cols = grid[0].length;
    const cell = Math.floor(Math.min(w / cols, h / rows));
    const ox = Math.floor((w - cols * cell) / 2), oy = Math.floor((h - rows * cell) / 2);
    // trusses 2px
    g.strokeStyle = col('hull-edge'); g.lineWidth = 2; g.beginPath();
    for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) {
      if (!grid[r][cc]) continue;
      const x = ox + cc * cell + cell / 2, y = oy + r * cell + cell / 2;
      if (cc + 1 < cols && grid[r][cc + 1]) { g.moveTo(x, y); g.lineTo(x + cell, y); }
      if (r + 1 < rows && grid[r + 1][cc]) { g.moveTo(x, y); g.lineTo(x, y + cell); }
    }
    g.stroke();
    // plates: rounded rects (cell-2 px, 6px at 120x72) in family colors at 80%, hub ivory
    const size = Math.max(2, cell - 2), rad = Math.max(1, size / 4);
    for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) {
      const m = grid[r][cc]; if (!m) continue;
      g.fillStyle = rgba(m.id === 'hub' ? col('ivory') : famColor(m.id), 0.8);
      g.beginPath(); roundRect(g, ox + cc * cell + 1, oy + r * cell + 1, size, size, rad); g.fill();
    }
    return c;
  }

  function perf() { return { ms: +S.perfEma.toFixed(2), tier: S.tier }; }

  // Public API
  R.init = init;
  R.resize = () => resize();
  R.px = px; R.py = py;
  R.cellAt = cellAt; R.shipAt = shipAt;
  R.draw = draw;
  R.mouse = mouse;
  R.thumbnail = thumbnail;
  R.perf = perf;
  // Additive: rebake #bg for a station name (title-screen reroll), debounced 120ms
  R.bakeBackground = name => { S.bgRequest = name ? String(name) : null; scheduleBake(120, name); };
  Object.defineProperty(R, 'ox', { get: () => S.ox });
  Object.defineProperty(R, 'oy', { get: () => S.oy });
  Object.defineProperty(R, 'fontsReady', { get: () => S.fontsReady });
  return R;
})();

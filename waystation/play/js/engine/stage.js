// ============================================================
// WAYSTATION v2 — engine/stage.js (Engineer E)
// Pixi application, layer tree, resize/DPR, ticker, texture baking,
// fonts, perf tiers (DESIGN2.md 3.1, 3.7 tiers, 0.3 Engine.perf).
//
// Also exports EngineUtil: the colour, easing, noise and canvas helpers
// shared by every engine file. Classic scripts, top-level globals:
//   EngineUtil, EngineStage
// Load order: stage, camera, space, world, traffic, fx, post, input, index.
// ============================================================
'use strict';

// ------------------------------------------------------------------
// EngineUtil — shared helpers (no Pixi dependency)
// ------------------------------------------------------------------
const EngineUtil = (() => {
  const TAU = Math.PI * 2;

  // Section-2 hex fallbacks, used only when art.js PAL is absent or a token is empty.
  const FALLBACK = {
    'void': '#04050A', 'space-0': '#03040A', 'space-1': '#070B18', 'space-2': '#0B1226',
    bg: '#090B12', 'surface-1': '#0F1119', 'surface-2': '#161A25', 'surface-3': '#1E2432',
    hairline: '#262C3A', 'hairline-2': '#343B4C',
    hull: '#1B2030', 'hull-edge': '#2A3142', 'hull-rim': 'rgba(243,233,214,.25)', truss: '#232838',
    amber: '#E9A23B', 'amber-hi': '#FFC46A', ice: '#8FD3E8', 'ice-hi': '#BFE8F4', sage: '#A8C8A0', 'sage-hi': '#CBE2C4',
    rose: '#E58BB8', 'rose-hi': '#F2B6D3', gold: '#FFE28A', ivory: '#F3E9D6', lamp: '#FFE9B8',
    good: '#6FD3A3', warn: '#FF8F3D', bad: '#FF4F5E', ink: '#E6E8EC', 'ink-2': '#A3A7B0', 'ink-3': '#6B707C',
    'on-accent': '#140C00', am: '#C084FF', 'am-hi': '#DDB8FF',
  };
  const LOCAL_FAMILY = {
    hub: 'ivory',
    dock: 'ice', comms: 'ice', customs: 'ice', security: 'ice', shipyard: 'ice',
    solar: 'gold', reactor: 'gold',
    warehouse: 'amber', fuel: 'amber', market: 'amber', bank: 'amber', refinery: 'amber',
    quarters: 'sage', cantina: 'sage', hydro: 'sage', clinic: 'sage', habitat: 'sage', school: 'sage',
    rec: 'rose', plaza: 'rose', menagerie: 'rose', observatory: 'rose', gate: 'rose',
  };

  const hasPAL = () => typeof PAL !== 'undefined' && PAL && typeof PAL === 'object';

  // Resolved token colour (PAL first, fallback hex second).
  function pal(name) {
    if (hasPAL()) { const v = PAL[name]; if (typeof v === 'string' && v) return v; }
    return FALLBACK[name] || '#FFFFFF';
  }

  // Parse any CSS colour we may meet into [r,g,b,a]; cached.
  const parseCache = new Map();
  function parse(str) {
    if (typeof str === 'number') return [(str >> 16) & 255, (str >> 8) & 255, str & 255, 1];
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
    if (p.some(n => Number.isNaN(n))) p = [255, 255, 255, 1];
    parseCache.set(str, p);
    return p;
  }

  // CSS colour -> 0xRRGGBB (Pixi tint / fill).
  function int(color) {
    if (typeof color === 'number') return color;
    const p = parse(color);
    return (Math.round(p[0]) << 16) | (Math.round(p[1]) << 8) | Math.round(p[2]);
  }
  const rgbaCache = new Map();
  function rgba(color, a) {
    const key = color + '|' + a;
    let v = rgbaCache.get(key);
    if (v) return v;
    const p = parse(color);
    v = `rgba(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])},${+Math.max(0, Math.min(1, a)).toFixed(3)})`;
    rgbaCache.set(key, v);
    return v;
  }
  function mix(a, b, k) {
    const p = parse(a), q = parse(b);
    k = Math.max(0, Math.min(1, k));
    const r = Math.round(p[0] + (q[0] - p[0]) * k), g = Math.round(p[1] + (q[1] - p[1]) * k), bl = Math.round(p[2] + (q[2] - p[2]) * k);
    return '#' + [r, g, bl].map(n => (n < 16 ? '0' : '') + n.toString(16)).join('');
  }
  function desatColor(color, k) {
    if (typeof desat === 'function') { try { return desat(color, k); } catch (e) { /* fall through */ } }
    const p = parse(color), L = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    const f = c => Math.round(c + (L - c) * k);
    return `rgb(${f(p[0])},${f(p[1])},${f(p[2])})`;
  }
  function famColor(id) {
    if (hasPAL() && typeof PAL.family === 'function') { try { const v = PAL.family(id); if (v) return v; } catch (e) { /* fall through */ } }
    return pal(LOCAL_FAMILY[id] || 'ivory');
  }
  function companyColor(id) {
    if (typeof COMPANY_COLOR !== 'undefined' && COMPANY_COLOR && COMPANY_COLOR[id]) return COMPANY_COLOR[id];
    const co = (typeof COMPANIES !== 'undefined') ? COMPANIES.find(c => c.id === id) : null;
    return desatColor(co ? co.color : '#C9A86A', 0.15);
  }
  function registryNumber(name) {
    if (typeof registryOf === 'function') {
      try { const n = parseInt(String(registryOf(name || '')).replace(/\D/g, ''), 10); if (Number.isFinite(n)) return n; } catch (e) { /* fall through */ }
    }
    let h = 0x811c9dc5;
    const s = String(name || '');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 1000 + (h >>> 0) % 9000;
  }

  // ---- math
  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const easeOutCubic = t => 1 - Math.pow(1 - clamp01(t), 3);
  const easeInOutCubic = t => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  const easeInQuad = t => { t = clamp01(t); return t * t; };
  const easeOutBack = t => { t = clamp01(t); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const easeInOutSine = t => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;

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
  // Periodic-in-x value noise (period px in lattice units) for wrapped planet bands.
  function valueNoiseWrap(x, y, seed, period) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const wx = ((ix % period) + period) % period, wx1 = (wx + 1) % period;
    const a = hash2(wx, iy, seed), b = hash2(wx1, iy, seed), c = hash2(wx, iy + 1, seed), d = hash2(wx1, iy + 1, seed);
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  }
  function fbm(x, y, seed, octaves) {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    const n = octaves || 4;
    for (let o = 0; o < n; o++) { v += valueNoise(x * f, y * f, seed + o * 17) * amp; norm += amp; amp *= 0.5; f *= 2; }
    return v / norm;
  }
  function fbmWrap(x, y, seed, octaves, period) {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    const n = octaves || 4;
    for (let o = 0; o < n; o++) { v += valueNoiseWrap(x * f, y * f, seed + o * 17, period * f) * amp; norm += amp; amp *= 0.5; f *= 2; }
    return v / norm;
  }

  // ---- canvas
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }
  // Soft radial disc: colour at the centre fading to transparent at the edge. Cached by (colour, radius, profile).
  const glowCache = new Map();
  function glowCanvas(color, rDev, profile) {
    const key = color + '|' + rDev + '|' + (profile || 'soft');
    let c = glowCache.get(key);
    if (c) return c;
    c = makeCanvas(rDev * 2, rDev * 2);
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(rDev, rDev, 0, rDev, rDev, rDev);
    if (profile === 'hard') { gr.addColorStop(0, rgba(color, 1)); gr.addColorStop(0.7, rgba(color, 0.8)); gr.addColorStop(1, rgba(color, 0)); }
    else if (profile === 'core') { gr.addColorStop(0, rgba('#FFFFFF', 0.95)); gr.addColorStop(0.18, rgba(color, 0.9)); gr.addColorStop(0.5, rgba(color, 0.3)); gr.addColorStop(1, rgba(color, 0)); }
    else { gr.addColorStop(0, rgba(color, 1)); gr.addColorStop(0.5, rgba(color, 0.35)); gr.addColorStop(1, rgba(color, 0)); }
    g.fillStyle = gr; g.fillRect(0, 0, rDev * 2, rDev * 2);
    glowCache.set(key, c);
    return c;
  }
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const keyOf = (r, c) => r + ',' + c;

  return {
    TAU, pal, parse, int, rgba, mix, desatColor, famColor, companyColor, registryNumber,
    lerp, clamp, clamp01, easeOutCubic, easeInOutCubic, easeInQuad, easeOutBack, easeInOutSine,
    rng, fbm, fbmWrap, smooth, makeCanvas, glowCanvas, nowMs, keyOf,
  };
})();

// ------------------------------------------------------------------
// EngineStage — the Pixi application and everything shared by the layers
// ------------------------------------------------------------------
const EngineStage = (() => {
  const U = EngineUtil;

  // World cell size in CSS px at zoom 1 (v1 cell at 1440x900 was 55px).
  const CELL = 56;
  // Zoom bands: textures are baked at the band's upper bound so art stays crisp (3.1).
  const BANDS = [0.75, 1.25, 2.0, 2.6];
  const TIER_FPS_DOWN = 45, TIER_FPS_UP = 57;

  const S = {
    app: null, host: null, canvas: null,
    w: 1, h: 1, dpr: 1, ready: false,
    layers: null,
    time: 0, tellTime: 0, dt: 0, frame: 0,
    paused: false, reduced: false, mqReduced: null,
    tier: 2, tierOverride: null, bodyTier: null, fps: 60, fpsEma: 60, lowFrames: 0, highFrames: 0, warm: 0, frameT0: 0, frameMs: 0,
    tierListeners: [], resizeListeners: [], frameFns: [],
    bakes: new Map(),
    fontsReady: false, bitmapMono: false, bitmapDisplay: false,
    condition: null,
  };

  // ---------------------------------------------------------------- init
  async function init(host) {
    S.host = host;
    const app = new PIXI.Application();
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    await app.init({
      background: U.int(U.pal('space-0')),
      resizeTo: host,
      antialias: true,
      resolution: S.dpr,
      autoDensity: true,
      preference: 'webgl',
      powerPreference: 'high-performance',
    });
    S.app = app;
    S.canvas = app.canvas;
    app.canvas.style.display = 'block';
    app.canvas.style.touchAction = 'none';
    app.canvas.style.userSelect = 'none';
    host.appendChild(app.canvas);
    S.w = Math.max(1, host.clientWidth); S.h = Math.max(1, host.clientHeight);

    buildLayers();
    installReducedMotion();
    installBodyObserver();
    loadFonts();

    app.renderer.on('resize', (w, h) => onResized(w, h));
    try {
      const ro = new ResizeObserver(() => resize());
      ro.observe(host);
      S.ro = ro;
    } catch (e) { window.addEventListener('resize', () => resize()); }

    app.ticker.add(tick);
    // CPU frame time: from before our updates (HIGH) to after Pixi's render pass (UTILITY runs after LOW)
    app.ticker.add(() => { S.frameT0 = U.nowMs(); }, null, PIXI.UPDATE_PRIORITY.HIGH);
    app.ticker.add(() => { const ms = U.nowMs() - S.frameT0; S.frameMs = S.frameMs ? S.frameMs * 0.9 + ms * 0.1 : ms; }, null, PIXI.UPDATE_PRIORITY.UTILITY);
    S.ready = true;
    return app;
  }

  // Layer tree (3.1). Space layers move with a fraction of the camera; everything from
  // world.shadow up lives in `cam`. `bloomGroup` wraps emissive + trafficGlow (engine bloom, nav
  // lights, trails) so one filter serves both; hulls sit in `traffic` above it so they stay crisp.
  function buildLayers() {
    const C = () => new PIXI.Container();
    const L = {
      space: {
        far: { root: C(), fixed: C(), moving: C() },
        mid: { root: C(), fixed: C(), moving: C() },
      },
      cam: C(),
      lanes: C(),
      world: { shadow: C(), truss: C(), plates: C(), scaffold: C(), emissive: C() },
      bloomGroup: C(),
      trafficGlow: C(),
      traffic: C(),
      fx: C(),
      overlay: C(),
      fxScreen: C(),
      post: C(),
    };
    for (const k of ['far', 'mid']) { L.space[k].root.addChild(L.space[k].fixed, L.space[k].moving); L.space[k].root.label = 'space.' + k; }
    L.bloomGroup.addChild(L.world.emissive, L.trafficGlow);
    L.cam.addChild(L.lanes, L.world.shadow, L.world.truss, L.world.plates, L.world.scaffold, L.bloomGroup, L.traffic, L.fx, L.overlay);
    L.cam.label = 'cam'; L.bloomGroup.label = 'bloom'; L.fxScreen.label = 'fxScreen'; L.post.label = 'post';
    for (const k in L.world) L.world[k].label = 'world.' + k;
    L.cam.eventMode = 'none'; L.post.eventMode = 'none'; L.fxScreen.eventMode = 'none';
    S.app.stage.eventMode = 'none';
    S.app.stage.addChild(L.space.far.root, L.space.mid.root, L.cam, L.fxScreen, L.post);
    S.layers = L;
  }

  // ---------------------------------------------------------------- resize
  function resize() {
    if (!S.app) return;
    const w = Math.max(1, S.host.clientWidth), h = Math.max(1, S.host.clientHeight);
    if (w !== S.w || h !== S.h) S.app.renderer.resize(w, h);
    else onResized(w, h);
  }
  function onResized(w, h) {
    S.w = Math.max(1, w); S.h = Math.max(1, h);
    for (const fn of S.resizeListeners) { try { fn(S.w, S.h); } catch (e) { reportError('resize', e); } }
  }
  function onResize(fn) { S.resizeListeners.push(fn); }

  // ---------------------------------------------------------------- ticker
  // Frame functions run in registration order; dt is clamped so a hidden tab does not leap.
  function onFrame(fn) { S.frameFns.push(fn); }
  function tick(t) {
    let dtMs = t.deltaMS;
    if (!(dtMs > 0)) dtMs = 16.7;
    perfSample(dtMs);
    const dt = Math.min(dtMs, 100) / 1000;
    S.dt = dt; S.time += dt; S.frame++;
    if (!S.paused) S.tellTime += dt;
    for (const fn of S.frameFns) { try { fn(dt); } catch (e) { reportError('frame', e); } }
  }
  const errorsSeen = new Set();
  function reportError(where, e) {
    // One console line per distinct failure site; a sibling error must never kill the frame loop.
    const key = where + ':' + (e && e.message);
    if (errorsSeen.has(key)) return;
    errorsSeen.add(key);
    console.error('[engine ' + where + ']', e);
  }

  // ---------------------------------------------------------------- perf tiers
  function perfSample(dtMs) {
    if (dtMs > 250) return;                                   // tab was hidden: not a frame
    const fps = 1000 / dtMs;
    S.fpsEma = S.fpsEma * 0.92 + fps * 0.08;
    S.fps = S.fpsEma;
    if (S.warm < 120) { S.warm++; return; }
    if (S.tierOverride != null || S.bodyTier != null) return;
    if (S.fpsEma < TIER_FPS_DOWN) { S.lowFrames++; S.highFrames = 0; } else { S.lowFrames = 0; if (S.fpsEma > TIER_FPS_UP) S.highFrames++; else S.highFrames = 0; }
    if (S.lowFrames >= 90 && S.tier > 0) { applyTier(S.tier - 1); S.lowFrames = 0; S.warm = 60; }
    else if (S.highFrames >= 900 && S.tier < 2) { applyTier(S.tier + 1); S.highFrames = 0; S.warm = 60; }
  }
  function applyTier(t) {
    t = Math.max(0, Math.min(2, t | 0));
    if (t === S.tier) return;
    S.tier = t;
    for (const fn of S.tierListeners) { try { fn(t); } catch (e) { reportError('tier', e); } }
  }
  function effectiveTier() { return S.tierOverride != null ? S.tierOverride : S.bodyTier != null ? S.bodyTier : S.tier; }
  // Explicit override (harness / settings): null returns to automatic.
  function setTier(t) {
    S.tierOverride = (t == null) ? null : Math.max(0, Math.min(2, t | 0));
    S.lowFrames = S.highFrames = 0; S.warm = 0;
    if (S.tierOverride != null) applyTier(S.tierOverride);
    else if (S.bodyTier != null) applyTier(S.bodyTier);
  }
  function onTier(fn) { S.tierListeners.push(fn); }

  // ---------------------------------------------------------------- reduced motion, body attributes
  function installReducedMotion() {
    try {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      S.mqReduced = mq;
      const onMq = () => updateReduced();
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    } catch (e) { S.mqReduced = null; }
    updateReduced();
  }
  function updateReduced() {
    let red = false;
    try { red = !!(S.mqReduced && S.mqReduced.matches); } catch (e) { red = false; }
    if (document.body && document.body.getAttribute('data-motion') === 'reduced') red = true;
    S.reduced = red;
  }
  function readBody() {
    const b = document.body; if (!b) return;
    updateReduced();
    const perf = b.getAttribute('data-perf');
    const bt = (perf === '0' || perf === '1' || perf === '2') ? +perf : null;
    if (bt !== S.bodyTier) { S.bodyTier = bt; if (S.tierOverride == null) { if (bt != null) applyTier(bt); } }
    S.condition = b.getAttribute('data-condition');
  }
  function installBodyObserver() {
    readBody();
    if (!document.body || typeof MutationObserver === 'undefined') return;
    try {
      const mo = new MutationObserver(readBody);
      mo.observe(document.body, { attributes: true, attributeFilter: ['data-motion', 'data-perf', 'data-condition'] });
    } catch (e) { /* attributes are re-read on demand through readBody() */ }
  }

  // ---------------------------------------------------------------- fonts and text
  const MONO = '"JetBrains Mono","Cascadia Mono",Consolas,monospace';
  const DISPLAY = '"Barlow Condensed","Bahnschrift Condensed","Arial Narrow",sans-serif';
  const CHARS = [['a', 'z'], ['A', 'Z'], ['0', '9'], ' .,:;·+-−×/%()[]|_\'"!?&#*=<>'];

  function loadFonts() {
    const done = () => { S.fontsReady = true; installBitmapFonts(); for (const fn of S.fontListeners) { try { fn(); } catch (e) { reportError('fonts', e); } } };
    if (document.fonts && typeof document.fonts.load === 'function') {
      Promise.all([document.fonts.load('600 32px "JetBrains Mono"'), document.fonts.load('600 32px "Barlow Condensed"')]).then(done, done);
    } else done();
  }
  S.fontListeners = [];
  function onFonts(fn) { if (S.fontsReady) fn(); else S.fontListeners.push(fn); }

  function installBitmapFonts() {
    if (!PIXI.BitmapFont || typeof PIXI.BitmapFont.install !== 'function') return;
    try {
      PIXI.BitmapFont.install({ name: 'EngineMono', style: { fontFamily: MONO, fontSize: 32, fontWeight: '600', fill: 0xffffff }, chars: CHARS, resolution: Math.min(2, S.dpr * 1.5), padding: 4 });
      S.bitmapMono = true;
    } catch (e) { S.bitmapMono = false; }
    try {
      PIXI.BitmapFont.install({ name: 'EngineDisplay', style: { fontFamily: DISPLAY, fontSize: 32, fontWeight: '600', fill: 0xffffff }, chars: CHARS, resolution: Math.min(2, S.dpr * 1.5), padding: 4 });
      S.bitmapDisplay = true;
    } catch (e) { S.bitmapDisplay = false; }
  }

  // Text factory: BitmapText (cheap to retint and update) once the fonts are installed, PIXI.Text before.
  // opts: { size, color, family: 'mono'|'display', weight }
  function makeText(str, opts) {
    const o = opts || {};
    const size = o.size || 12, color = o.color != null ? o.color : 0xffffff;
    const display = o.family === 'display';
    const bitmap = display ? S.bitmapDisplay : S.bitmapMono;
    let t;
    if (bitmap) {
      t = new PIXI.BitmapText({ text: String(str), style: { fontFamily: display ? 'EngineDisplay' : 'EngineMono', fontSize: size } });
      t.tint = U.int(color);
    } else {
      t = new PIXI.Text({ text: String(str), style: { fontFamily: display ? DISPLAY : MONO, fontSize: size, fontWeight: o.weight || '600', fill: U.int(color) }, resolution: Math.min(2, S.dpr * 1.5) });
    }
    t.eventMode = 'none';
    return t;
  }
  function setTextColor(t, color) { t.tint = U.int(color); }

  // ---------------------------------------------------------------- textures
  function textureFromCanvas(canvas) {
    const source = new PIXI.CanvasSource({ resource: canvas, autoGarbageCollect: false });
    return new PIXI.Texture({ source });
  }
  function updateTexture(tex) { if (tex && tex.source) tex.source.update(); }
  function destroyTexture(tex) { if (tex) { try { tex.destroy(true); } catch (e) { /* already gone */ } } }

  // Cached bake: draw(ctx, canvas) paints an offscreen canvas of w x h device px once per key.
  // Returns { canvas, texture, w, h }.
  function bake(key, w, h, draw) {
    let rec = S.bakes.get(key);
    if (rec) return rec;
    const canvas = U.makeCanvas(w, h);
    const g = canvas.getContext('2d');
    draw(g, canvas);
    rec = { canvas, texture: textureFromCanvas(canvas), w: canvas.width, h: canvas.height, key };
    S.bakes.set(key, rec);
    return rec;
  }
  // Soft glow texture (additive discs for lamps, engines, planet rims).
  function glowTexture(color, rDev, profile) {
    const key = 'glow|' + color + '|' + rDev + '|' + (profile || 'soft');
    return bake(key, rDev * 2, rDev * 2, g => { g.drawImage(U.glowCanvas(color, rDev, profile), 0, 0); }).texture;
  }
  function sprite(texture, opts) {
    const sp = new PIXI.Sprite(texture);
    sp.anchor.set(0.5);
    sp.eventMode = 'none';
    if (opts) {
      if (opts.blend) sp.blendMode = opts.blend;
      if (opts.alpha != null) sp.alpha = opts.alpha;
      if (opts.tint != null) sp.tint = U.int(opts.tint);
    }
    return sp;
  }

  // Zoom band for a camera zoom: the bake scale (>= zoom) so sprites are never upscaled.
  function bandFor(zoom) {
    for (const b of BANDS) if (zoom <= b + 1e-6) return b;
    return BANDS[BANDS.length - 1];
  }

  // ---------------------------------------------------------------- public
  return {
    CELL, BANDS,
    init, resize, onResize, onFrame, onTier, onFonts,
    makeText, setTextColor, bake, glowTexture, textureFromCanvas, updateTexture, destroyTexture, sprite, bandFor,
    setTier, reportError,
    get app() { return S.app; },
    get canvas() { return S.canvas; },
    get host() { return S.host; },
    get layers() { return S.layers; },
    get w() { return S.w; }, get h() { return S.h; }, get dpr() { return S.dpr; },
    get time() { return S.time; }, get tellTime() { return S.tellTime; }, get dt() { return S.dt; }, get frame() { return S.frame; },
    get paused() { return S.paused; }, set paused(v) { S.paused = !!v; },
    get reduced() { return S.reduced; },
    get tier() { return effectiveTier(); },
    get fps() { return S.fps; },
    get frameMs() { return S.frameMs; },
    get fontsReady() { return S.fontsReady; },
    get bitmapFonts() { return S.bitmapMono && S.bitmapDisplay; },
    get condition() { return S.condition; },
    get ready() { return S.ready; },
  };
})();

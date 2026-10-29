// ============================================================
// PORT SOLACE — Ships: hull sprites, engine bloom, nav lights, shadow,
// HOLD plate and hover ring (DESIGN.md section 9, "Ships API" in 0.1)
// ============================================================
// Hulls are drawn in a 64x64 design space with the nose at +x and baked to
// offscreen canvases per (class, company, cellPx, dpr). The sprite is scaled
// so nose-to-tail equals 2 * halfLength, halfLength = SHIP_CLASSES[cls].size
// * cell / 14 (identical to the old renderer, so shipAt hit radii hold).
// Engine blooms are additive radial sprites baked once per company color at
// radii 8 / 16 / 32 device px (createRadialGradient at bake time only).
// Everything state-dependent (bloom strength, nav blink, HOLD plate, hover
// ring, exhaust) is drawn live. Used only by render.js.
// Classic script: exports the global `Ships`.
'use strict';

const Ships = (() => {
  // ---------------------------------------------------------- palette
  const HULL_BASE = '#B8B2A6';
  const HULL_ALT = '#A9A396';          // alternating container shade
  const HULL_DARK = '#8E897E';         // engine blocks, bridge, fin
  const CANOPY = '#3A3F4D';            // cockpit glass
  const OUTLINE = 'rgba(255,255,255,.5)';
  const SEAM = 'rgba(0,0,0,.35)';
  const NAV_PORT = '#FF5A5A';
  const NAV_STBD = '#5AE08A';
  const SHADOW = 'rgba(0,0,0,.35)';
  const PLATE_BG = 'rgba(4,5,10,.8)';
  const FALLBACK = { warn: '#FF8F3D', ivory: '#F3E9D6', lamp: '#FFE9B8', void: '#04050A' };

  function pal(name) {
    if (typeof PAL !== 'undefined' && PAL && PAL[name]) return PAL[name];
    return FALLBACK[name] || '#F3E9D6';
  }

  // ---------------------------------------------------------- color helpers
  function hexToRgb(hex) {
    const h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    if (h.length >= 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    const m = String(hex).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [184, 178, 166];
  }
  function rgba(hex, a) {
    const c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  // local desaturation, same formula as art.js desat(): mix toward own luminance by k
  function localDesat(hex, k) {
    const c = hexToRgb(hex);
    const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const f = v => Math.round(v + (L - v) * k);
    const h = v => ('0' + f(v).toString(16)).slice(-2);
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }
  const coColorCache = new Map();
  function companyColor(id) {
    if (typeof COMPANY_COLOR !== 'undefined' && COMPANY_COLOR && COMPANY_COLOR[id]) return COMPANY_COLOR[id];
    let c = coColorCache.get(id);
    if (c) return c;
    const def = (typeof COMPANIES !== 'undefined') ? COMPANIES.find(x => x.id === id) : null;
    const raw = def ? def.color : '#B8B2A6';
    c = (typeof desat === 'function') ? desat(raw, 0.15) : localDesat(raw, 0.15);
    coColorCache.set(id, c);
    return c;
  }
  function dpr() { return (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1; }

  // ---------------------------------------------------------- hull geometry (design units)
  // nose/tail: x extents (length = nose - tail); halfW: max |y|;
  // engines: bloom origins; exhaust: particle origin; nav: [port, starboard]
  const HULLS = {
    courier:   { nose: 32, tail: -28, halfW: 17, exhaust: { x: -24, y: 0 },
                 engines: [{ x: -24, y: 0 }], nav: [{ x: -10, y: -14 }, { x: -10, y: 14 }] },
    freighter: { nose: 26, tail: -26, halfW: 13, exhaust: { x: -26, y: 0 },
                 engines: [{ x: -26, y: -6 }, { x: -26, y: 6 }], nav: [{ x: 2, y: -12 }, { x: 2, y: 12 }] },
    hauler:    { nose: 30, tail: -30, halfW: 17, exhaust: { x: -30, y: 0 },
                 engines: [{ x: -30, y: -7.5 }, { x: -30, y: 7.5 }], nav: [{ x: -2, y: -16 }, { x: -2, y: 16 }] },
    liner:     { nose: 30, tail: -34, halfW: 11, exhaust: { x: -31, y: 0 },
                 engines: [{ x: -30, y: -6 }, { x: -30, y: 0 }, { x: -30, y: 6 }], nav: [{ x: 0, y: -10 }, { x: 0, y: 10 }] },
  };
  function hullDef(cls) { return HULLS[cls] || HULLS.freighter; }
  function hullLength(cls) { const h = hullDef(cls); return h.nose - h.tail; }

  // ---------------------------------------------------------- hull painter
  // g is transformed so 1 unit = 1 design unit, origin at the hull centre.
  // pxu = design units per CSS px (so 1px lines are pxu wide).
  function paintHull(g, cls, coHex, pxu) {
    const co = coHex, co55 = rgba(coHex, 0.55), lamp = pal('lamp');
    g.lineJoin = 'round'; g.lineCap = 'butt';
    const outline = () => { g.strokeStyle = OUTLINE; g.lineWidth = pxu; g.stroke(); };
    const box = (x, y, w, h, fill) => { g.fillStyle = fill; g.beginPath(); g.rect(x, y, w, h); g.fill(); outline(); };
    const stripe = (x0, y0, x1, y1) => {
      g.strokeStyle = co; g.lineWidth = 2 * pxu; g.lineCap = 'butt';
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    };

    if (cls === 'courier') {
      // nacelle pylon (behind hull)
      g.fillStyle = HULL_DARK; g.fillRect(-13, -14, 4, 28);
      // nacelles 10x4 at (-10, +-14), tips in company color at 55%
      for (const sy of [-1, 1]) {
        box(-15, sy * 14 - 2, 10, 4, HULL_BASE);
        g.fillStyle = co55; g.fillRect(-15, sy * 14 - 2, 3, 4);
      }
      // dart hull: nose (32,0), tail (-28,+-10), notch at (-24,0)
      g.fillStyle = HULL_BASE; g.beginPath();
      g.moveTo(32, 0); g.lineTo(-28, -10); g.lineTo(-24, 0); g.lineTo(-28, 10); g.closePath();
      g.fill(); outline();
      // centre-line stripe
      stripe(26, 0, -20, 0);
      // canopy
      g.fillStyle = CANOPY; g.beginPath(); g.ellipse(14, 0, 5, 2.2, 0, 0, Math.PI * 2); g.fill();
    } else if (cls === 'freighter') {
      // boxy hull 52x24 with a chamfered nose
      g.fillStyle = HULL_BASE; g.beginPath();
      g.moveTo(22, -12); g.lineTo(26, -8); g.lineTo(26, 8); g.lineTo(22, 12);
      g.lineTo(-26, 12); g.lineTo(-26, -12); g.closePath();
      g.fill(); outline();
      // 3 container segments x -24..8, alternating shade, 1px seams
      const segW = 32 / 3;
      for (let i = 0; i < 3; i++) {
        g.fillStyle = i % 2 === 0 ? HULL_ALT : HULL_BASE;
        g.fillRect(-24 + i * segW, -10, segW, 20);
      }
      g.strokeStyle = SEAM; g.lineWidth = pxu; g.beginPath();
      for (let i = 0; i <= 3; i++) { const x = -24 + i * segW; g.moveTo(x, -10); g.lineTo(x, 10); }
      g.moveTo(-24, -10); g.lineTo(8, -10); g.moveTo(-24, 10); g.lineTo(8, 10);
      g.stroke();
      // livery stripe across the containers (along the spine)
      stripe(-24, 0, 8, 0);
      // engine blocks at the tail
      box(-26, -9, 5, 5, HULL_DARK); box(-26, 4, 5, 5, HULL_DARK);
      // forward bridge block 10x14 with a lamp window strip
      box(12, -7, 10, 14, HULL_DARK);
      g.fillStyle = lamp; g.globalAlpha = 0.9; g.fillRect(20, -5, 1.5, 10); g.globalAlpha = 1;
    } else if (cls === 'hauler') {
      // engine blocks at the tail
      box(-30, -11, 8, 7, HULL_DARK); box(-30, 4, 8, 7, HULL_DARK);
      // spine 60x8 with a nose cap
      g.fillStyle = HULL_BASE; g.beginPath();
      g.moveTo(-30, -4); g.lineTo(26, -4); g.lineTo(30, 0); g.lineTo(26, 4); g.lineTo(-30, 4); g.closePath();
      g.fill(); outline();
      // 4 cargo pods 12x12, two per side, company color at 55%
      for (const cx of [-12, 8]) for (const sy of [-1, 1]) {
        const y = sy > 0 ? 4 : -16;
        g.fillStyle = HULL_BASE; g.fillRect(cx - 6, y, 12, 12);
        g.fillStyle = co55; g.fillRect(cx - 6, y, 12, 12);
        g.strokeStyle = OUTLINE; g.lineWidth = pxu; g.beginPath(); g.rect(cx - 6, y, 12, 12); g.stroke();
        g.strokeStyle = SEAM; g.beginPath(); g.moveTo(cx, y + 1); g.lineTo(cx, y + 11); g.stroke();
      }
      // livery stripe on the spine
      stripe(-20, 0, 24, 0);
      // canopy
      g.fillStyle = CANOPY; g.fillRect(22, -2, 5, 4);
    } else {
      // liner: tail fin 8x14 (protrudes behind the oval)
      box(-34, -7, 8, 14, HULL_DARK);
      // elongated oval 60x20
      g.fillStyle = HULL_BASE; g.beginPath(); g.ellipse(0, 0, 30, 10, 0, 0, Math.PI * 2); g.fill(); outline();
      // livery band behind the bridge, clipped to the hull
      g.save(); g.beginPath(); g.ellipse(0, 0, 30, 10, 0, 0, Math.PI * 2); g.clip();
      g.fillStyle = co; g.fillRect(12, -11, 3, 22);
      g.fillStyle = co55; g.fillRect(9, -11, 2, 22);
      g.restore();
      // bridge canopy
      g.fillStyle = CANOPY; g.beginPath(); g.ellipse(21, 0, 4.5, 3, 0, 0, Math.PI * 2); g.fill();
      // 8 lamp window dots along the centre line at 80%
      g.fillStyle = lamp; g.globalAlpha = 0.8;
      for (let i = 0; i < 8; i++) { g.beginPath(); g.arc(-20 + i * 3.8, 0, 1.1, 0, Math.PI * 2); g.fill(); }
      g.globalAlpha = 1;
      // three engines at the tail
      for (const y of [-8, -2, 4]) box(-32, y, 4, 4, HULL_DARK);
    }
  }

  // silhouette only (for the shadow sprite)
  function paintSilhouette(g, cls) {
    g.fillStyle = SHADOW;
    if (cls === 'courier') {
      g.fillRect(-15, -16, 10, 4); g.fillRect(-15, 12, 10, 4); g.fillRect(-13, -14, 4, 28);
      g.beginPath(); g.moveTo(32, 0); g.lineTo(-28, -10); g.lineTo(-24, 0); g.lineTo(-28, 10); g.closePath(); g.fill();
    } else if (cls === 'freighter') {
      g.beginPath(); g.moveTo(22, -12); g.lineTo(26, -8); g.lineTo(26, 8); g.lineTo(22, 12);
      g.lineTo(-26, 12); g.lineTo(-26, -12); g.closePath(); g.fill();
    } else if (cls === 'hauler') {
      g.fillRect(-30, -11, 8, 7); g.fillRect(-30, 4, 8, 7);
      g.beginPath(); g.moveTo(-30, -4); g.lineTo(26, -4); g.lineTo(30, 0); g.lineTo(26, 4); g.lineTo(-30, 4); g.closePath(); g.fill();
      for (const cx of [-12, 8]) { g.fillRect(cx - 6, 4, 12, 12); g.fillRect(cx - 6, -16, 12, 12); }
    } else {
      g.fillRect(-34, -7, 8, 14);
      g.beginPath(); g.ellipse(0, 0, 30, 10, 0, 0, Math.PI * 2); g.fill();
    }
  }

  // ---------------------------------------------------------- caches
  const hullCache = new Map();     // `${cls}|${co}|${cellPx}|${dpr}` -> sprite record
  const shadowCache = new Map();   // `${cls}|${cellPx}|${dpr}`
  const bloomCache = new Map();    // `${color}|${rDev}` -> canvas
  const measureCache = new Map();  // plate text -> width (CSS px)

  function makeCanvas(w, h) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, w | 0); cv.height = Math.max(1, h | 0);
    return cv;
  }

  // sprite record: { cv, ax, ay (device px of hull origin), k (device px per unit), u (CSS px per unit) }
  function bakeHull(cls, coId, cellPx, d) {
    const key = cls + '|' + coId + '|' + cellPx + '|' + d;
    let rec = hullCache.get(key);
    if (rec) return rec;
    const h = hullDef(cls);
    const sz = (typeof SHIP_CLASSES !== 'undefined' && SHIP_CLASSES[cls]) ? SHIP_CLASSES[cls].size : 8;
    const L = sz * cellPx / 14;                   // half-length, CSS px
    const len = h.nose - h.tail;
    const u = 2 * L / len;                        // CSS px per unit
    const k = u * d;                              // device px per unit
    const pad = 4;                                // device px
    const w = Math.ceil(len * k + pad * 2), hh = Math.ceil(h.halfW * 2 * k + pad * 2);
    const cv = makeCanvas(w, hh);
    const ax = pad - h.tail * k, ay = hh / 2;      // hull origin inside the sprite
    const g = cv.getContext('2d');
    g.setTransform(k, 0, 0, k, ax, ay);
    paintHull(g, cls, companyColor(coId), d / k);
    rec = { cv, ax, ay, k, u, L, cls, coId, cellPx, dpr: d };
    cv.style.width = (w / d) + 'px'; cv.style.height = (hh / d) + 'px';
    cv.anchorX = ax; cv.anchorY = ay; cv.unit = k; cv.halfLength = L;
    hullCache.set(key, rec);
    return rec;
  }

  function bakeShadow(cls, cellPx, d) {
    const key = cls + '|' + cellPx + '|' + d;
    let rec = shadowCache.get(key);
    if (rec) return rec;
    const h = hullDef(cls);
    const sz = (typeof SHIP_CLASSES !== 'undefined' && SHIP_CLASSES[cls]) ? SHIP_CLASSES[cls].size : 8;
    const L = sz * cellPx / 14, len = h.nose - h.tail, k = 2 * L / len * d, pad = 4;
    const w = Math.ceil(len * k + pad * 2), hh = Math.ceil(h.halfW * 2 * k + pad * 2);
    const cv = makeCanvas(w, hh);
    const ax = pad - h.tail * k, ay = hh / 2;
    const g = cv.getContext('2d');
    g.setTransform(k, 0, 0, k, ax, ay);
    paintSilhouette(g, cls);
    rec = { cv, ax, ay, k };
    shadowCache.set(key, rec);
    return rec;
  }

  // additive radial bloom sprite, one per (color, radius in device px)
  function bakeBloom(color, rDev) {
    const key = color + '|' + rDev;
    let cv = bloomCache.get(key);
    if (cv) return cv;
    cv = makeCanvas(rDev * 2, rDev * 2);
    const g = cv.getContext('2d');
    const c = hexToRgb(color);
    // core: mix 30% toward white, soft falloff so neighbouring hulls are not washed
    const cr = Math.round(c[0] + (255 - c[0]) * 0.3), cg = Math.round(c[1] + (255 - c[1]) * 0.3), cb = Math.round(c[2] + (255 - c[2]) * 0.3);
    const grad = g.createRadialGradient(rDev, rDev, 0, rDev, rDev, rDev);   // bake time only
    grad.addColorStop(0, 'rgba(' + cr + ',' + cg + ',' + cb + ',.9)');
    grad.addColorStop(0.25, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',.4)');
    grad.addColorStop(0.6, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',.1)');
    grad.addColorStop(1, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0)');
    g.fillStyle = grad; g.fillRect(0, 0, rDev * 2, rDev * 2);
    bloomCache.set(key, cv);
    return cv;
  }
  function bloomFor(color, rCss, d) {
    const need = rCss * d;
    const rDev = need <= 8 ? 8 : need <= 16 ? 16 : 32;
    return bakeBloom(color, rDev);
  }

  // ---------------------------------------------------------- public: geometry
  function halfLength(ship, cell) {
    const cls = (typeof SHIP_CLASSES !== 'undefined' && SHIP_CLASSES[ship.cls]) ? SHIP_CLASSES[ship.cls] : { size: 8 };
    return cls.size * cell / 14;
  }

  // ---------------------------------------------------------- public: draw
  const PLATE_FONT = '500 10px "JetBrains Mono","Cascadia Mono",Consolas,monospace';
  const TWO_PI = Math.PI * 2;

  function draw(ctx, ship, o) {
    const d = dpr();
    const cell = o.cell || 48;
    const x = o.x, y = o.y, ang = ship.angle || 0;
    const t = typeof o.t === 'number' ? o.t : performance.now() / 1000;
    const h = hullDef(ship.cls);
    const rec = bakeHull(ship.cls, ship.company, cell, d);
    const u = rec.u, L = rec.L;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const co = companyColor(ship.company);
    const state = ship.state;
    const moving = state === 'approach' || state === 'depart';
    const queued = state === 'queue';

    // 1. shadow (35% black at +2,+3 device px) when over hull
    if (o.overHull) {
      const sh = bakeShadow(ship.cls, cell, d);
      ctx.save();
      ctx.translate(x + 2 / d, y + 3 / d);
      ctx.rotate(ang);
      ctx.scale(1 / d, 1 / d);
      ctx.drawImage(sh.cv, -sh.ax, -sh.ay);
      ctx.restore();
    }

    // 2. engine bloom + exhaust request
    let bloomA = 0, bloomScale = 0;
    if (moving) {
      const sp = typeof o.speed === 'number' ? Math.max(0, Math.min(1, o.speed)) : 1;
      // undocking (9.3): Render passes bloomK 0..1 over the first 400ms after 'depart'
      const ramp = (state === 'depart' && typeof o.bloomK === 'number') ? Math.max(0, Math.min(1, o.bloomK)) : 1;
      bloomA = 0.6 * ramp; bloomScale = 0.6 + sp;
    } else if (queued) {
      bloomA = 0.25; bloomScale = 0.6;
    }
    if (bloomA > 0) {
      const nEng = h.engines.length;
      const rBase = Math.max(4, L * 0.3) * bloomScale / (1 + 0.3 * (nEng - 1));
      const cv = bloomFor(co, rBase, d);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = bloomA;
      ctx.translate(x, y);
      ctx.rotate(ang);
      for (let i = 0; i < nEng; i++) {
        const e = h.engines[i];
        const ex = e.x * u - rBase * 0.6, ey = e.y * u;
        // stretched 2.2x along the heading so the bloom trails the tail
        ctx.drawImage(cv, ex - rBase * 1.1, ey - rBase, rBase * 2.2, rBase * 2);
      }
      ctx.restore();
      if (moving && !o.reduced && typeof FX !== 'undefined') {
        const tx = x + (h.exhaust.x * cos - h.exhaust.y * sin) * u;
        const ty = y + (h.exhaust.x * sin + h.exhaust.y * cos) * u;
        FX.exhaust(tx, ty, ang, co);
      }
    }

    // 3. hull sprite rotated by ship.angle
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.scale(1 / d, 1 / d);
    ctx.drawImage(rec.cv, -rec.ax, -rec.ay);
    ctx.restore();

    // 4. nav lights: port red, starboard green, 1.5px, 1Hz blink with per-ship phase
    const phase = ((ship.id || 0) * 0.37) % 1;
    const blink = ((t + phase) % 1) < 0.55;
    const navA = blink ? 1 : 0.18;
    const ns = 1.5;
    ctx.globalAlpha = navA;
    for (let i = 0; i < 2; i++) {
      const p = h.nav[i];
      const nx = x + (p.x * cos - p.y * sin) * u, ny = y + (p.x * sin + p.y * cos) * u;
      ctx.fillStyle = i === 0 ? NAV_PORT : NAV_STBD;
      ctx.fillRect(nx - ns / 2, ny - ns / 2, ns, ns);
    }
    ctx.globalAlpha = 1;

    // 5. HOLD plate while queued
    if (queued) {
      const now = typeof o.now === 'number' ? o.now : 0;
      const days = Math.max(0, now - (ship.waitStart || 0));
      const text = 'HOLD ' + days.toFixed(1) + 'd';
      ctx.font = PLATE_FONT;                      // the only ctx.font set in this file
      let tw = measureCache.get(text);
      if (tw === undefined) { tw = ctx.measureText(text).width; measureCache.set(text, tw); }
      const warn = pal('warn');
      const pw = Math.ceil(tw + 10), ph = 14;
      const pxl = Math.round(x - pw / 2), pyt = Math.round(y - L - 8 - ph);
      // plate
      ctx.fillStyle = PLATE_BG; ctx.fillRect(pxl, pyt, pw, ph);
      ctx.fillStyle = warn; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, pxl + pw / 2, pyt + ph / 2 + 0.5);
      // bracket pair: two 8px L-brackets, top-left and bottom-right, 1px, 2px outside the plate
      ctx.strokeStyle = warn; ctx.lineWidth = 1; ctx.lineCap = 'butt';
      const bl = 8, bx0 = pxl - 2 + 0.5, by0 = pyt - 2 + 0.5, bx1 = pxl + pw + 2 - 0.5, by1 = pyt + ph + 2 - 0.5;
      ctx.beginPath();
      ctx.moveTo(bx0, by0 + bl); ctx.lineTo(bx0, by0); ctx.lineTo(bx0 + bl, by0);
      ctx.moveTo(bx1 - bl, by1); ctx.lineTo(bx1, by1); ctx.lineTo(bx1, by1 - bl);
      ctx.stroke();
    }

    // 6. hover ring: 1px ivory at R = L + 4
    if (o.hovered) {
      ctx.strokeStyle = pal('ivory'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, L + 4, 0, TWO_PI); ctx.stroke();
    }
  }

  // ---------------------------------------------------------- public: sprites for the DOM
  // Baked hull canvas (device px) for the tooltip/hover plate; pass cellPx*1.5 for 1.5x.
  // The canvas carries anchorX/anchorY (device px of the hull origin), unit
  // (device px per design unit) and halfLength (CSS px), and has style width/height set.
  function hullCanvas(cls, companyId, cellPx) {
    return bakeHull(cls, companyId, cellPx, dpr()).cv;
  }

  // Small square canvas (size CSS px) with the hull drawn to fit, nose at +x.
  function thumb(cls, companyId, size) {
    const d = dpr(), s = size > 0 ? size : 32;
    const cv = makeCanvas(s * d, s * d);
    cv.style.width = s + 'px'; cv.style.height = s + 'px';
    const h = hullDef(cls);
    const len = h.nose - h.tail;
    const k = (s * d * 0.86) / Math.max(len, h.halfW * 2);
    const g = cv.getContext('2d');
    const cx = s * d / 2 - (h.nose + h.tail) / 2 * k;
    g.setTransform(k, 0, 0, k, cx, s * d / 2);
    paintHull(g, cls, companyColor(companyId), d / k);
    return cv;
  }

  function purge() {
    hullCache.clear(); shadowCache.clear(); bloomCache.clear(); measureCache.clear(); coColorCache.clear();
  }

  return { draw, purge, halfLength, hullCanvas, thumb, hullLength, companyColor, HULLS };
})();

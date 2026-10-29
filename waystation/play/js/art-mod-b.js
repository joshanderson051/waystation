'use strict';
// =====================================================================
// PORT SOLACE - js/art-mod-b.js (Engineer A3)
//
// ART entries for: habitat, reactor, customs, security, school, bank,
// plaza, menagerie, refinery, shipyard, observatory, gate.
//
// Contract: DESIGN.md 8.0 / 8.1 / 8.2 (file list amended in 0.1).
//   ART[id] = { tellClass, silhouette(g,u,st), lit(g,u,st), tell(g,u,t,st) }
//   g  : CanvasRenderingContext2D already translated to the cell's top-left
//        and scaled so 1 unit = cell/100 CSS px. Everything is drawn in
//        0..100 units. Render wraps every call in save()/restore().
//   u  : CSS px per unit (cell/100), used only for device-px clamps.
//   st : per-frame state object (8.2). Nothing here ever touches Sim.
//
// Dependencies: the ART registry (art.js) and PAL token colors. Every
// drawing helper is local (the _B namespace) so this file never relies
// on a helper signature it cannot see; PAL lookups fall back to the
// section-2 hex values when a token is not loaded yet.
// =====================================================================

const _B = (() => {
  const G = (typeof globalThis !== 'undefined') ? globalThis : window;
  const TAU = Math.PI * 2;

  // Section 2 fallbacks, used only when PAL has no value for a token.
  const FALLBACK = {
    lamp: '#FFE9B8', warn: '#FF8F3D', bad: '#FF4F5E', good: '#6FD3A3',
    ivory: '#F3E9D6', ice: '#8FD3E8', 'ice-hi': '#BFE8F4', gold: '#FFE28A',
    amber: '#E9A23B', sage: '#A8C8A0', rose: '#E58BB8',
    'ink-2': '#A3A7B0', hull: '#1B2030', void: '#04050A'
  };

  function pal(name) {
    const P = G.PAL;
    const v = P && P[name];
    return (typeof v === 'string' && v.length) ? v : (FALLBACK[name] || '#FFFFFF');
  }

  // ---- color utilities -------------------------------------------------
  function parse(c) {
    if (typeof c !== 'string') return null;
    c = c.trim();
    if (c[0] === '#') {
      let h = c.slice(1);
      if (h.length === 3 || h.length === 4) h = h.split('').map(x => x + x).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      const n = parseInt(h.slice(0, 6), 16);
      if (isNaN(n)) return null;
      const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
    }
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(c);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    return null;
  }
  // withAlpha equivalent: same color, alpha replaced.
  function a(c, alpha) {
    const p = parse(c);
    if (!p) return c;
    return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + (+alpha.toFixed(3)) + ')';
  }
  function mix(c1, c2, k) {
    const p = parse(c1), q = parse(c2);
    if (!p || !q) return c1;
    const r = Math.round(p[0] + (q[0] - p[0]) * k);
    const g = Math.round(p[1] + (q[1] - p[1]) * k);
    const b = Math.round(p[2] + (q[2] - p[2]) * k);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // ---- numeric utilities -----------------------------------------------
  function cl(v, lo, hi) { v = +v; if (!(v === v)) v = 0; return v < lo ? lo : (v > hi ? hi : v); }
  function hash01(x, y, z) {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return s - Math.floor(s);
  }
  function easeInOutSine(k) { return -(Math.cos(Math.PI * k) - 1) / 2; }
  function dprOf(st) { return (st && st.dpr) || G.devicePixelRatio || 1; }
  function uOf(st, u) { return u || (st && st.cellPx ? st.cellPx / 100 : 0.5); }
  // Units needed for `devPx` device pixels.
  function minU(st, u, devPx) { return devPx / (uOf(st, u) * dprOf(st)); }
  // Units for one CSS px.
  function cssU(st, u) { return 1 / uOf(st, u); }
  // Lit elements drop to 50% when the module is unpowered.
  function lampA(st) { return (st && st.powered === false) ? 0.5 : 1; }
  // Tell time: frozen at phase 0 when unpowered or under reduced motion.
  function tt(t, st) { return (st && (st.powered === false || st.reduced)) ? 0 : (t || 0); }
  function flag(st, name) { return !!(st && st.flags && st.flags[name]); }

  // ---- path helpers (path only; caller fills/strokes) ------------------
  function rect(g, x, y, w, h) { g.beginPath(); g.rect(x, y, w, h); }
  function rrect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function poly(g, pts) {
    g.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) g.moveTo(pts[0], pts[1]); else g.lineTo(pts[i], pts[i + 1]);
    }
    g.closePath();
  }
  function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); }
  function fs(g) { g.fill(); g.stroke(); }
  function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
  function arc(g, x, y, r, a0, a1, lw, style) {
    g.beginPath(); g.arc(x, y, r, a0, a1);
    g.lineWidth = lw; g.strokeStyle = style; g.lineCap = 'butt'; g.stroke();
  }

  // Silhouette paint: family color at 55% fill, 2u stroke at 100% (>= 1 device px).
  function sil(g, st, u, fallbackTok) {
    const color = (st && st.color) || pal(fallbackTok);
    g.fillStyle = a(color, 0.55);
    g.strokeStyle = color;
    g.lineWidth = Math.max(2, minU(st, u, 1));
    g.lineJoin = 'round';
    g.lineCap = 'round';
    return color;
  }
  // Lamp dot r=2u (>= 2 device px diameter).
  function dot(g, st, u, x, y, color, alpha, r) {
    r = Math.max(r || 2, minU(st, u, 1));
    g.globalAlpha = cl(alpha, 0, 1);
    g.fillStyle = color;
    circle(g, x, y, r); g.fill();
    g.globalAlpha = 1;
  }
  // Lamp square s u (>= 2 device px), centred on x,y.
  function sq(g, st, u, x, y, s, color, alpha) {
    s = Math.max(s || 4, minU(st, u, 2));
    g.globalAlpha = cl(alpha, 0, 1);
    g.fillStyle = color;
    g.fillRect(x - s / 2, y - s / 2, s, s);
    g.globalAlpha = 1;
  }

  // ---- baked radial glow (gradient at bake time only, never per frame) --
  const glows = new Map();
  function glow(g, st, u, cx, cy, color, rDev, alpha) {
    if (typeof document === 'undefined' || typeof g.drawImage !== 'function') return;
    const key = color + '|' + rDev + '|' + alpha;
    let cv = glows.get(key);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = cv.height = rDev * 2;
      const c = cv.getContext('2d');
      const gr = c.createRadialGradient(rDev, rDev, 0, rDev, rDev, rDev);
      gr.addColorStop(0, a(color, alpha));
      gr.addColorStop(0.5, a(color, alpha * 0.35));
      gr.addColorStop(1, a(color, 0));
      c.fillStyle = gr;
      c.fillRect(0, 0, rDev * 2, rDev * 2);
      glows.set(key, cv);
    }
    const s = (rDev * 2) / (uOf(st, u) * dprOf(st));   // device px -> units
    g.drawImage(cv, cx - s / 2, cy - s / 2, s, s);
  }

  // ---- FX bridge: emit a spark at a unit-space point -------------------
  // Converts through the live transform (g is translated+scaled by Render,
  // with the dpr transform underneath), so FX receives CSS px like Render.
  // Rate-limited per cell origin so a tell emits at most one spark per bucket.
  const sparkLast = new Map();
  function sparkAt(g, st, x, y, t, color, perSecond) {
    const FXo = G.FX;
    if (!FXo || typeof FXo.sparks !== 'function' || typeof g.getTransform !== 'function') return;
    let m;
    try { m = g.getTransform(); } catch (e) { return; }
    const dpr = dprOf(st);
    const X = (m.a * x + m.c * y + m.e) / dpr;
    const Y = (m.b * x + m.d * y + m.f) / dpr;
    const key = Math.round(m.e) + ',' + Math.round(m.f);
    const bucket = Math.floor((t || 0) * perSecond);
    if (sparkLast.get(key) === bucket) return;
    sparkLast.set(key, bucket);
    if (sparkLast.size > 512) sparkLast.clear();
    try { FXo.sparks(X, Y, color, 1, 350); } catch (e) { /* FX unavailable */ }
  }

  return { TAU, pal, parse, a, mix, cl, hash01, easeInOutSine, minU, cssU, lampA, tt, flag,
           rect, rrect, poly, circle, fs, line, arc, sil, dot, sq, glow, sparkAt };
})();

// Registry: art.js declares `const ART = {}`; fall back to a global object
// only if this file is ever loaded without it.
const _ART_B = (typeof ART !== 'undefined') ? ART
  : (((typeof globalThis !== 'undefined') ? globalThis : window).ART = {});

// =====================================================================
// HABITAT (life / sage) - class A
// Ring of 8 window squares (10u) around a 24u courtyard; 3u antenna with
// a dot; courtyard tree dot. Windows lit = round(ratio*8); one lit window
// toggles every 5s via hash; antenna lamp blinks 0.5Hz (beacon).
// =====================================================================
const _B_HAB_WIN = [[31, 31], [50, 31], [69, 31], [69, 50], [69, 69], [50, 69], [31, 69], [31, 50]];

_ART_B.habitat = {
  tellClass: 'A',
  silhouette(g, u, st) {
    const color = _B.sil(g, st, u, 'sage');
    for (const w of _B_HAB_WIN) { _B.rrect(g, w[0] - 5, w[1] - 5, 10, 10, 1.5); _B.fs(g); }
    _B.rrect(g, 38, 38, 24, 24, 3); g.stroke();          // courtyard
    g.fillStyle = color;
    _B.circle(g, 50, 50, 3.5); g.fill();                  // tree dot
    _B.rect(g, 80.5, 14, 3, 14); g.fill();                // antenna mast 3u
    _B.circle(g, 82, 13, 2.5); g.fill();                  // antenna dot
  },
  lit(g, u, st) {
    const A = _B.lampA(st);
    const n = Math.round(_B.cl(st.ratio, 0, 1) * 8);
    if (n === 0) {                                        // residents 0: windows 20%
      for (const w of _B_HAB_WIN) _B.sq(g, st, u, w[0], w[1], 6, st.lamp, 0.2 * A);
      return;
    }
    for (let i = 0; i < n; i++) _B.sq(g, st, u, _B_HAB_WIN[i][0], _B_HAB_WIN[i][1], 6, st.lamp, A);
  },
  tell(g, u, t, st) {
    const A = _B.lampA(st);
    // one lit window toggles every 5s (frozen when unpowered, off under reduced motion)
    if (!st.reduced) {
      const T = _B.tt(t, st);
      const n = Math.round(_B.cl(st.ratio, 0, 1) * 8);
      if (n > 0) {
        const idx = Math.floor(_B.hash01(Math.floor(T / 5), 3, 7) * 8) % 8;
        const w = _B_HAB_WIN[idx];
        if (idx < n) { g.fillStyle = _B.pal('hull'); g.fillRect(w[0] - 3.5, w[1] - 3.5, 7, 7); }
        else _B.sq(g, st, u, w[0], w[1], 6, st.lamp, 0.9 * A);
      }
    }
    // antenna beacon 0.5Hz: survives reduced motion; steady on when unpowered
    const tb = (st.powered === false) ? 0 : (t || 0);
    if ((tb % 2) < 1) _B.dot(g, st, u, 82, 13, st.lamp, A, 2);
  }
};

// =====================================================================
// REACTOR (power / gold) - class A
// Torus ring R 30u, 10u thick; core R 10u in #9FE8D8; two coolant pipes
// 4u to the plate edge. Three thin orbit arcs (R 36/40/44, 120 deg) rotate
// at 1 rev/5s, /7s, /11s; the core breathes at 1 + 3*load Hz and turns
// warn above 90% load. Baked radial glow (r 12 device px) under the core.
// =====================================================================
const _B_CORE = '#9FE8D8';

_ART_B.reactor = {
  tellClass: 'A',
  silhouette(g, u, st) {
    _B.sil(g, st, u, 'gold');
    g.beginPath();                                        // torus
    g.arc(50, 50, 35, 0, _B.TAU);
    g.arc(50, 50, 25, 0, _B.TAU, true);
    _B.fs(g);
    _B.rect(g, 6, 48, 10, 4); _B.fs(g);                   // coolant pipes
    _B.rect(g, 84, 48, 10, 4); _B.fs(g);
    g.fillStyle = _B.a(_B_CORE, 0.55); g.strokeStyle = _B_CORE;
    _B.circle(g, 50, 50, 10); _B.fs(g);                   // core
  },
  lit(g, u, st) {
    const A = _B.lampA(st);
    // the baked radial glow (r 12 device px) is Render's single glowSprite; none drawn here (8.1)
    _B.dot(g, st, u, 50, 50, st.lamp, A, 4);              // core hot spot
  },
  tell(g, u, t, st) {
    const T = _B.tt(t, st);
    const load = _B.cl(st.load, 0, 2);
    // three orbit arcs, 1 CSS px, 120 deg spans, alternating direction
    const lw = Math.max(_B.cssU(st, u), _B.minU(st, u, 1));
    const col = _B.a(st.color, 0.75);
    const P = [5, 7, 11], R = [36, 40, 44];
    for (let i = 0; i < 3; i++) {
      const dir = (i % 2) ? -1 : 1;
      const a0 = dir * _B.TAU * T / P[i] + i * 2.1;
      _B.arc(g, 50, 50, R[i], a0, a0 + _B.TAU / 3, lw, col);
    }
    // breathing core
    const f = 1 + 3 * Math.min(load, 1);
    const r = 10 + 2 * Math.sin(_B.TAU * f * T);
    const cc = load > 0.9 ? _B.pal('warn') : _B_CORE;
    g.fillStyle = _B.a(cc, 0.35); g.strokeStyle = cc; g.lineWidth = Math.max(2, _B.minU(st, u, 1));
    _B.circle(g, 50, 50, r); _B.fs(g);
  }
};

// =====================================================================
// CUSTOMS (ops / ice) - class B
// Checkpoint box 36x28u with a gate bar across a vertical lane; stamp
// square 10u on the box; 3 barrier ticks; lamp on the box. Tell: a 2u
// scan bar sweeps down the lane every 3s.
// =====================================================================
_ART_B.customs = {
  tellClass: 'B',
  silhouette(g, u, st) {
    _B.sil(g, st, u, 'ice');
    _B.line(g, 52, 10, 52, 90);                           // lane edges
    _B.line(g, 90, 10, 90, 90);
    _B.rrect(g, 40, 48, 52, 4, 1); _B.fs(g);              // gate bar
    _B.rrect(g, 8, 36, 36, 28, 3); _B.fs(g);              // checkpoint box
    _B.rect(g, 19, 45, 10, 10); g.stroke();               // stamp square
    g.fillStyle = _B.a(_B.pal('void'), 0.7);               // barrier ticks
    for (const x of [58, 68, 78]) g.fillRect(x, 47, 3, 6);
  },
  lit(g, u, st) {
    _B.dot(g, st, u, 38, 41, st.lamp, _B.lampA(st), 2);
  },
  tell(g, u, t, st) {
    const T = _B.tt(t, st);
    const p = (T / 3) % 1;
    const y = 12 + 76 * p;
    const h = Math.max(2, _B.minU(st, u, 1));
    g.fillStyle = _B.a(st.color, 0.65);
    g.fillRect(54, y - h / 2, 34, h);
  }
};

// =====================================================================
// SECURITY (ops / ice) - class A
// Shield chevron 44x50u with two 8u turret stubs at the shoulders; beacon
// post top centre. Tell: a 60 deg sweep wedge from the centre rotates
// 1 rev/6s at 15%; beacon turns bad and blinks 1Hz during alert (beacon
// survives reduced motion).
// =====================================================================
_ART_B.security = {
  tellClass: 'A',
  silhouette(g, u, st) {
    _B.sil(g, st, u, 'ice');
    _B.poly(g, [28, 24, 72, 24, 72, 48, 50, 74, 28, 48]); _B.fs(g);   // shield
    _B.poly(g, [34, 30, 66, 30, 66, 46, 50, 66, 34, 46]); g.stroke(); // inner shield line
    _B.rect(g, 20, 22, 8, 8); _B.fs(g);                   // turret stubs
    _B.rect(g, 72, 22, 8, 8); _B.fs(g);
    _B.rect(g, 48, 14, 4, 10); _B.fs(g);                  // beacon post
  },
  lit(g, u, st) {
    _B.dot(g, st, u, 50, 14, st.lamp, _B.lampA(st), 2);
  },
  tell(g, u, t, st) {
    if (!st.reduced) {
      const T = _B.tt(t, st);
      const ang = _B.TAU * T / 6 - Math.PI / 2;
      g.fillStyle = _B.a(st.color, 0.15);
      g.beginPath();
      g.moveTo(50, 46);
      g.arc(50, 46, 24, ang - Math.PI / 6, ang + Math.PI / 6);
      g.closePath();
      g.fill();
    }
    if (_B.flag(st, 'alert')) {                            // alert beacon, 1Hz
      const on = ((t || 0) % 1) < 0.5;
      if (on) _B.dot(g, st, u, 50, 14, _B.pal('bad'), 1, 3);
      else _B.dot(g, st, u, 50, 14, _B.pal('hull'), 1, 2.5);
    }
  }
};

// =====================================================================
// SCHOOL (life / sage) - class B
// Tiered semicircle (lecture bowl) R 32u open toward the top with 3 tier
// lines; lectern at the focus. Tell: two dots orbit on tilted ellipses
// above the bowl, 1 rev/4s and /6s.
// =====================================================================
function _B_orbit(cx, cy, rx, ry, tilt, ang) {
  const x = rx * Math.cos(ang), y = ry * Math.sin(ang);
  const c = Math.cos(tilt), s = Math.sin(tilt);
  return [cx + x * c - y * s, cy + x * s + y * c];
}

_ART_B.school = {
  tellClass: 'B',
  silhouette(g, u, st) {
    _B.sil(g, st, u, 'sage');
    g.beginPath(); g.arc(50, 44, 32, 0, Math.PI); g.closePath(); _B.fs(g);   // bowl
    for (const R of [24, 16, 8]) { g.beginPath(); g.arc(50, 44, R, 0, Math.PI); g.stroke(); }
    _B.rrect(g, 46, 38, 8, 6, 1); _B.fs(g);               // lectern
  },
  lit(g, u, st) {
    _B.dot(g, st, u, 50, 41, st.lamp, _B.lampA(st), 2);
  },
  tell(g, u, t, st) {
    const T = _B.tt(t, st);
    const lw = Math.max(_B.cssU(st, u), _B.minU(st, u, 1));
    g.strokeStyle = _B.a(st.color, 0.2); g.lineWidth = lw;
    if (typeof g.ellipse === 'function') {
      g.beginPath(); g.ellipse(50, 26, 22, 7, 0.3, 0, _B.TAU); g.stroke();
      g.beginPath(); g.ellipse(50, 26, 18, 9, -0.4, 0, _B.TAU); g.stroke();
    }
    const p1 = _B_orbit(50, 26, 22, 7, 0.3, _B.TAU * T / 4);
    const p2 = _B_orbit(50, 26, 18, 9, -0.4, -_B.TAU * T / 6 + 1);
    _B.dot(g, st, u, p1[0], p1[1], st.color, 0.95, 2);
    _B.dot(g, st, u, p2[0], p2[1], st.color, 0.95, 2);
  }
};

// =====================================================================
// BANK (trade / amber) - class A
// Column facade: 4 columns 6x36u under a 56x6u lintel; vault circle R 14u
// below with 8 spokes; 2u lintel highlight; lamp over the door. Tell: a
// specular glint sweeps the vault disc every 5s, warn while any loan is out.
// =====================================================================
_ART_B.bank = {
  tellClass: 'A',
  silhouette(g, u, st) {
    const color = _B.sil(g, st, u, 'amber');
    _B.rrect(g, 22, 12, 56, 6, 1); _B.fs(g);              // lintel
    for (const x of [24, 40, 56, 72]) { _B.rect(g, x, 18, 6, 36); _B.fs(g); }   // columns
    g.fillStyle = _B.a(_B.pal('void'), 0.6);
    g.fillRect(48, 42, 6, 12);                            // door
    g.fillStyle = _B.a(color, 0.55);
    _B.circle(g, 50, 74, 14); _B.fs(g);                   // vault
    g.beginPath();                                        // 8 spokes
    for (let k = 0; k < 8; k++) {
      const ang = k * Math.PI / 4, c = Math.cos(ang), s = Math.sin(ang);
      g.moveTo(50 + 4 * c, 74 + 4 * s); g.lineTo(50 + 12 * c, 74 + 12 * s);
    }
    g.stroke();
    g.fillStyle = color; _B.circle(g, 50, 74, 3); g.fill();          // vault hub
    g.strokeStyle = _B.mix(color, '#FFFFFF', 0.4);                   // lintel highlight 2u
    _B.line(g, 24, 13.5, 76, 13.5);
  },
  lit(g, u, st) {
    _B.dot(g, st, u, 51, 37, st.lamp, _B.lampA(st), 2);
  },
  tell(g, u, t, st) {
    const T = _B.tt(t, st);
    const cyc = T % 5;
    if (cyc >= 1.2) return;                               // glint lasts 1.2s of each 5s
    const p = cyc / 1.2;
    g.save();
    _B.circle(g, 50, 74, 13); g.clip();
    g.fillStyle = _B.flag(st, 'loan') ? _B.a(_B.pal('warn'), 0.7) : 'rgba(255,255,255,0.18)';
    g.translate(30 + 40 * p, 74);
    g.rotate(0.35);
    g.fillRect(-2.5, -18, 5, 36);
    g.restore();
  }
};

// =====================================================================
// PLAZA (culture / rose) - class A
// Cross-shaped concourse (arms 20u) with 4 stall squares 12u in the
// corners; 2u awning ticks facing the concourse. Awning lamps at 70%
// (100% during festival). Tell: crowd dots random-walk along the arms;
// count = clamp(round(residents/5),0,6), doubled during festival.
// =====================================================================
const _B_STALLS = [[18, 18], [70, 18], [18, 70], [70, 70]];
function _B_awningY(y) { return y < 50 ? y + 13 : y - 3; }

_ART_B.plaza = {
  tellClass: 'A',
  silhouette(g, u, st) {
    const color = _B.sil(g, st, u, 'rose');
    _B.poly(g, [40, 10, 60, 10, 60, 40, 90, 40, 90, 60, 60, 60, 60, 90, 40, 90, 40, 60, 10, 60, 10, 40, 40, 40]);
    _B.fs(g);                                             // concourse cross
    for (const s of _B_STALLS) { _B.rrect(g, s[0], s[1], 12, 12, 1.5); _B.fs(g); }
    g.fillStyle = color;
    for (const s of _B_STALLS) g.fillRect(s[0] - 2, _B_awningY(s[1]), 16, 2);   // awning ticks
  },
  lit(g, u, st) {
    const alpha = (_B.flag(st, 'festival') ? 1 : 0.7) * _B.lampA(st);
    for (const s of _B_STALLS) _B.sq(g, st, u, s[0] + 6, _B_awningY(s[1]) + 1, 4, st.lamp, alpha);
  },
  tell(g, u, t, st) {
    const T = _B.tt(t, st);
    let n;
    if (typeof st.crowd === 'number') n = st.crowd;
    else if (typeof st.ratio === 'number') n = st.ratio * 6;
    else n = 3;
    n = Math.round(_B.cl(n, 0, 6));
    if (_B.flag(st, 'festival')) n = Math.min(12, n * 2);
    if (n <= 0) return;
    const s = Math.max(2.5, _B.minU(st, u, 1.5));
    g.fillStyle = _B.a(st.lamp, 0.7);
    for (let i = 0; i < n; i++) {
      const h = _B.hash01(i, 1, 1), h2 = _B.hash01(i, 2, 2);
      const sp = 0.12 + 0.08 * h;
      const along = 50 + 34 * Math.sin(_B.TAU * sp * T + h * _B.TAU);
      const across = 50 + 6 * Math.sin(_B.TAU * sp * 1.7 * T + h2 * _B.TAU);
      const x = (i % 2) ? across : along, y = (i % 2) ? along : across;
      g.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }
};

// =====================================================================
// MENAGERIE (culture / rose) - class A
// Dome grid (3x2 panes) 70x50u over a 10u glass band; foliage dots. The
// band is lit rose at 40% when xenofauna is in stock, dark otherwise.
// Tell: a two-hump creature silhouette paces behind the band over 6s,
// only while xenofauna is in stock.
// =====================================================================
_ART_B.menagerie = {
  tellClass: 'A',
  silhouette(g, u, st) {
    const color = _B.sil(g, st, u, 'rose');
    g.beginPath();                                        // dome: flat sides, arched top
    g.moveTo(15, 64); g.lineTo(15, 34);
    g.arc(35, 34, 20, Math.PI, Math.PI * 1.5);
    g.lineTo(65, 14);
    g.arc(65, 34, 20, Math.PI * 1.5, _B.TAU);
    g.lineTo(85, 64); g.closePath();
    _B.fs(g);
    g.beginPath();                                        // 3x2 pane lines
    g.moveTo(38.3, 14); g.lineTo(38.3, 64);
    g.moveTo(61.7, 14); g.lineTo(61.7, 64);
    g.moveTo(15, 39); g.lineTo(85, 39);
    g.stroke();
    _B.rect(g, 15, 66, 70, 10); g.stroke();               // glass band (dark interior)
    g.fillStyle = color;
    for (const x of [28, 50, 72]) { _B.circle(g, x, 58, 3); g.fill(); }   // foliage dots
  },
  lit(g, u, st) {
    if (!_B.flag(st, 'xeno')) return;                     // dark when no xenofauna
    g.fillStyle = _B.a(st.color, 0.4 * _B.lampA(st));
    g.fillRect(16, 67, 68, 8);
  },
  tell(g, u, t, st) {
    if (!_B.flag(st, 'xeno')) return;
    const T = _B.tt(t, st);
    const cx = 50 + 24 * Math.sin(_B.TAU * T / 6);
    g.fillStyle = 'rgba(4,5,10,0.85)';
    g.beginPath();                                        // two-hump creature behind the glass
    g.moveTo(cx - 9, 75); g.lineTo(cx - 9, 72);
    g.arc(cx - 4.5, 72, 4.5, Math.PI, 0);
    g.arc(cx + 4.5, 72, 4.5, Math.PI, 0);
    g.lineTo(cx + 9, 75); g.closePath();
    g.fill();
  }
};

// =====================================================================
// REFINERY (trade / amber) - class A
// Three stacks 10x40u over a 60x24u hopper; a 4u hazard band on the
// hopper; a 40x4u molten channel in warn (not lamp). Channel: converting
// .6 pulsing to 1 over 2s, idle 30%. Tell: a 3u puff rises from a stack
// every 2s only while converting.
// =====================================================================
const _B_STACKS = [27, 45, 63];

_ART_B.refinery = {
  tellClass: 'A',
  silhouette(g, u, st) {
    _B.sil(g, st, u, 'amber');
    _B.poly(g, [20, 58, 80, 58, 70, 82, 30, 82]); _B.fs(g);           // hopper
    for (const x of _B_STACKS) { _B.rrect(g, x, 18, 10, 40, 2); _B.fs(g); }   // stacks
    g.fillStyle = _B.a(_B.pal('void'), 0.65);                        // hazard band ticks
    for (let k = 0; k < 7; k++) g.fillRect(24 + 8 * k, 60, 3, 4);
    _B.rect(g, 30, 69, 40, 4); g.stroke();                            // molten channel slot
  },
  lit(g, u, st) {
    const alpha = (_B.flag(st, 'converting') ? 0.6 : 0.3) * _B.lampA(st);
    g.fillStyle = _B.a(_B.pal('warn'), alpha);
    g.fillRect(30.5, 69.5, 39, 3);
  },
  tell(g, u, t, st) {
    if (!_B.flag(st, 'converting') || st.powered === false) return;   // idle: static channel, no puffs
    const T = _B.tt(t, st);
    const pulse = 0.5 + 0.5 * Math.sin(_B.TAU * T / 2);
    g.fillStyle = _B.a(_B.pal('warn'), 0.4 * pulse);                 // channel glow .6 -> 1
    g.fillRect(30.5, 69.5, 39, 3);
    if (st.reduced) return;
    const k = Math.floor(T / 2) % 3, p = (T % 2) / 2;
    const x = _B_STACKS[k] + 5, y = 16 - 14 * p;
    const r = Math.max(1.5 + 1.5 * p, _B.minU(st, u, 1));
    _B.dot(g, st, u, x, y, _B.pal('ink-2'), 0.8 * (1 - p), r);        // puff tick
  }
};

// =====================================================================
// SHIPYARD (ops / ice) - class A
// Gantry frame 70x56u around an empty hull outline; two rail posts on the
// top beam; wrench tick; lamp on the gantry. Tell: the crane traverses the
// beam over 3s and FX.sparks emits 2 sparks/s at the crane while a ship is
// docked on an adjacent dock.
// =====================================================================
_ART_B.shipyard = {
  tellClass: 'A',
  silhouette(g, u, st) {
    const color = _B.sil(g, st, u, 'ice');
    g.beginPath();                                        // gantry ring (8u top beam, 5u sides)
    g.rect(15, 22, 70, 56);
    g.rect(20, 30, 60, 43);
    g.fill('evenodd'); g.stroke();
    _B.poly(g, [28, 52, 60, 43, 72, 52, 60, 61]); g.stroke();          // empty hull outline
    _B.line(g, 28, 52, 60, 52);                                       // keel line
    g.fillStyle = color;
    _B.circle(g, 22, 26, 2.5); g.fill();                              // rail posts
    _B.circle(g, 78, 26, 2.5); g.fill();
    _B.line(g, 22, 70, 28, 64);                                       // wrench tick
    _B.circle(g, 29, 63, 2); g.stroke();
  },
  lit(g, u, st) {
    _B.dot(g, st, u, 50, 75.5, st.lamp, _B.lampA(st), 2);
  },
  tell(g, u, t, st) {
    const T = _B.tt(t, st);
    const ph = (T / 3) % 2;
    const k = _B.easeInOutSine(ph < 1 ? ph : 2 - ph);
    const x = 26 + 48 * k;
    g.fillStyle = st.color;
    g.fillRect(x - 4, 23, 8, 6);                          // trolley
    g.strokeStyle = _B.a(st.color, 0.85); g.lineWidth = Math.max(2, _B.minU(st, u, 1)); g.lineCap = 'round';
    _B.line(g, x, 29, x, 38);                             // hook line
    if (_B.flag(st, 'shipAdjacent') && !st.reduced && st.powered !== false) {
      _B.sparkAt(g, st, x, 38, t, st.color, 2);
    }
  }
};

// =====================================================================
// OBSERVATORY (culture / rose) - class B
// Half-dome R 30u on a base with a tripod mark; central seam; lens at the
// pivot. Tell: the 6u slit (dark slot) tracks across the dome face over a
// 30s period with its telescope line from the centre; the lens glints
// every 7s.
// =====================================================================
_ART_B.observatory = {
  tellClass: 'B',
  silhouette(g, u, st) {
    const color = _B.sil(g, st, u, 'rose');
    g.beginPath(); g.arc(50, 58, 30, Math.PI, _B.TAU); g.closePath(); _B.fs(g);   // half-dome
    _B.rrect(g, 16, 58, 68, 8, 1); _B.fs(g);              // base
    g.beginPath();                                        // tripod mark
    g.moveTo(50, 66); g.lineTo(36, 84);
    g.moveTo(50, 66); g.lineTo(64, 84);
    g.moveTo(50, 66); g.lineTo(50, 84);
    g.stroke();
    _B.line(g, 50, 56, 50, 29);                           // telescope line at rest (dome seam)
    g.fillStyle = color;
    _B.circle(g, 50, 56, 3.5); g.fill();                  // lens / pivot
  },
  lit(g, u, st) {
    _B.dot(g, st, u, 50, 56, st.lamp, _B.lampA(st), 2);
  },
  tell(g, u, t, st) {
    const T = _B.tt(t, st);
    const x = 50 + 22 * Math.sin(_B.TAU * T / 30);
    const yTop = 58 - Math.sqrt(Math.max(0, 900 - (x - 50) * (x - 50)));
    g.save();                                             // slit: dark 6u slot clipped to the dome
    g.beginPath(); g.arc(50, 58, 29, Math.PI, _B.TAU); g.closePath(); g.clip();
    g.fillStyle = 'rgba(4,5,10,0.55)';
    g.fillRect(x - 3, 20, 6, 40);
    g.restore();
    g.strokeStyle = st.color; g.lineWidth = Math.max(2, _B.minU(st, u, 1)); g.lineCap = 'round';
    _B.line(g, 50, 56, x, yTop + 3);                      // telescope line to the slit
    if (!st.reduced && (T % 7) < 0.5) _B.dot(g, st, u, x, yTop + 4, st.lamp, 1, 2.5);   // lens glint
  }
};

// =====================================================================
// GATE (culture / rose, lens core ice-hi) - class A, the showpiece
// Two concentric rings R 42/32u, 6u thick, 12 rune ticks on the outer
// ring, a chevron at the top; lens core R 10u in ice-hi. Lit: lens at 40%
// rising to 100% as a liner nears; baked glow r 20 device px ice .4.
// Tell: energy arcs counter-rotate on the rings (1 rev/12s outer, /18s
// inner); two 90 deg arcs swirl in the lens.
// =====================================================================
_ART_B.gate = {
  tellClass: 'A',
  silhouette(g, u, st) {
    const color = _B.sil(g, st, u, 'rose');
    g.beginPath();                                        // outer ring
    g.arc(50, 50, 45, 0, _B.TAU); g.arc(50, 50, 39, 0, _B.TAU, true);
    _B.fs(g);
    g.beginPath();                                        // inner ring
    g.arc(50, 50, 35, 0, _B.TAU); g.arc(50, 50, 29, 0, _B.TAU, true);
    _B.fs(g);
    g.strokeStyle = _B.a(_B.pal('void'), 0.75);           // 12 rune ticks
    g.lineWidth = Math.max(2, _B.minU(st, u, 1)); g.lineCap = 'butt';
    g.beginPath();
    for (let k = 0; k < 12; k++) {
      const ang = k * Math.PI / 6, c = Math.cos(ang), s = Math.sin(ang);
      g.moveTo(50 + 40 * c, 50 + 40 * s); g.lineTo(50 + 44 * c, 50 + 44 * s);
    }
    g.stroke();
    g.fillStyle = color;
    _B.poly(g, [41, 13, 50, 4, 59, 13, 50, 9]); g.fill();  // chevron
    const ice = _B.pal('ice-hi');
    g.fillStyle = _B.a(ice, 0.55); g.strokeStyle = ice;
    _B.circle(g, 50, 50, 10); _B.fs(g);                    // lens core
  },
  lit(g, u, st) {
    const near = (st.flags && st.flags.linerNear);
    const k = (typeof near === 'number') ? _B.cl(near, 0, 1) : (near ? 1 : 0);
    const alpha = (0.4 + 0.6 * k) * _B.lampA(st);
    const ice = _B.pal('ice-hi');
    // the baked radial glow (r 20 device px, ice .4) is Render's single glowSprite; none drawn here (8.1)
    g.fillStyle = _B.a(ice, alpha);
    _B.circle(g, 50, 50, 9); g.fill();
  },
  tell(g, u, t, st) {
    const T = _B.tt(t, st);
    const ice = _B.pal('ice-hi');
    const ring = _B.a(st.color, 0.55);
    const a0 = _B.TAU * T / 12;                           // outer ring, 1 rev/12s
    _B.arc(g, 50, 50, 42, a0, a0 + Math.PI / 2, 4, ring);
    const a1 = -_B.TAU * T / 18 + 1;                      // inner ring, counter, 1 rev/18s
    _B.arc(g, 50, 50, 32, a1, a1 + Math.PI / 2, 4, ring);
    const a2 = _B.TAU * T / 2;                            // lens swirl arcs
    _B.arc(g, 50, 50, 6, a2, a2 + Math.PI / 2, 2.5, _B.a(ice, 0.6));
    const a3 = -_B.TAU * T / 3 + 2;
    _B.arc(g, 50, 50, 3.5, a3, a3 + Math.PI / 2, 2, _B.a(ice, 0.5));
  }
};

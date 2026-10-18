'use strict';
/* ============================================================================
 * art-mod-a.js  (Engineer A2)
 * Module art bundles: hub, dock, warehouse, solar, fuel, quarters,
 *                     cantina, comms, market, rec, hydro, clinic
 *
 * Contract: DESIGN.md 8.0 / 8.1 / 8.2 (amended in 0.1).
 *   ART[id] = { tellClass:'A'|'B', silhouette(g,u,st), lit(g,u,st), tell(g,u,t,st) }
 *   g  : CanvasRenderingContext2D translated to the cell's top-left and scaled so
 *        1 unit = cell/100 CSS px. Everything here is drawn in 0..100 units.
 *   u  : CSS px per unit (cell/100), for device-pixel clamps.
 *   st : per-frame state object (8.2). Never calls Sim.
 *   t  : seconds, already phase-offset per cell by Render.
 *
 * Render wraps every call in save()/restore(); nothing here relies on leaked
 * state. Render draws plate, rim, strip, rivets and text tags itself, plus the
 * generic status overlays (power-shortage ring, hover, selection, flare plate).
 *
 * Dependencies: only the globals ART (art.js), PAL and withAlpha. Every other
 * helper lives in the local _A namespace below, with fallbacks when PAL or
 * withAlpha are missing, so this file never breaks on load order of helpers.
 * ========================================================================== */

if (typeof ART === 'undefined') {
  throw new Error('art-mod-a.js: art.js (const ART = {}) must load before this file');
}

/* ----------------------------------------------------------------------------
 * _A : local helper namespace (no dependency on ArtKit)
 * -------------------------------------------------------------------------- */
const _A = (() => {
  const TAU = Math.PI * 2;

  // Section 2 hex fallbacks, used only when PAL has not been loaded.
  const FALLBACK = {
    lamp: '#FFE9B8', ice: '#8FD3E8', 'ice-hi': '#BFE8F4', ivory: '#F3E9D6', gold: '#FFE28A',
    amber: '#E9A23B', sage: '#A8C8A0', rose: '#E58BB8', good: '#6FD3A3', warn: '#FF8F3D',
    bad: '#FF4F5E', ink: '#E6E8EC', 'ink-2': '#A3A7B0', 'ink-3': '#6B707C', void: '#04050A',
    'on-accent': '#140C00',
  };

  // Family color per owned module, used only if st.color is missing.
  const FAM = {
    hub: 'ivory', dock: 'ice', comms: 'ice',
    warehouse: 'amber', fuel: 'amber', market: 'amber',
    solar: 'gold',
    quarters: 'sage', cantina: 'sage', hydro: 'sage', clinic: 'sage',
    rec: 'rose',
  };

  // Unit vectors for the four collar sides (canvas y points down).
  const DIR = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 } };

  function pal(name) {
    const v = (typeof PAL !== 'undefined' && PAL) ? PAL[name] : undefined;
    return (typeof v === 'string' && v) ? v : FALLBACK[name];
  }

  function parse(c) {
    if (typeof c !== 'string') return [243, 233, 214];
    c = c.trim();
    if (c[0] === '#') {
      let h = c.slice(1);
      if (h.length === 3 || h.length === 4) h = h.split('').map(ch => ch + ch).join('');
      const n = parseInt(h.slice(0, 6), 16);
      return isNaN(n) ? [243, 233, 214] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = c.match(/[\d.]+/g);
    return (m && m.length >= 3) ? [+m[0], +m[1], +m[2]] : [243, 233, 214];
  }

  // withAlpha(color, a) from art.js when present; otherwise a local parser.
  function alpha(color, a) {
    if (typeof withAlpha === 'function') return withAlpha(color, a);
    const [r, g, b] = parse(color);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
  }

  function color(st, id) { return (st && st.color) || pal(FAM[id]); }
  function lamp(st) { return (st && st.lamp) || pal('lamp'); }
  function powered(st) { return !(st && st.powered === false); }

  // Smallest length in units that is at least `dev` device px.
  function minU(dev, u, st) {
    const dpr = (st && st.dpr) || 1;
    return dev / Math.max(1e-6, (u || 1) * dpr);
  }
  // Line width in units, never thinner than 1 device px.
  function lw(g, units, u, st) { g.lineWidth = Math.max(units, minU(1, u, st)); }
  // A CSS-pixel line width expressed in units (for the "2px" arcs/traces).
  function cssPx(px, u, st) { return Math.max(px / Math.max(1e-6, u || 1), minU(1, u, st)); }

  // Reset the bits of state a previous call might have set (belt and braces).
  function begin(g) {
    g.globalAlpha = 1;
    g.setLineDash([]);
    g.lineJoin = 'round';
    g.lineCap = 'round';
  }

  // Silhouette style: family fill at 55%, stroke 2u at 100%.
  function silStyle(g, u, st, col) {
    g.fillStyle = alpha(col, .55);
    g.strokeStyle = col;
    lw(g, 2, u, st);
  }
  function fs(g) { g.fill(); g.stroke(); }

  // --- path builders (no fill/stroke) ---
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
  // pts: flat array [x0,y0,x1,y1,...]
  function poly(g, pts) {
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath();
  }
  // Appends a closed polygon to the current path (for evenodd cut-outs).
  function polyAdd(g, pts) {
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath();
  }
  function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); }
  function hex(g, cx, cy, R, a0) {
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = a0 + k * Math.PI / 3, x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  }

  // --- immediate drawing ---
  function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }

  // Lamp dot: r in units, clamped so the diameter is >= 2 device px. Fills immediately.
  function dot(g, x, y, r, u, st) {
    const rr = Math.max(r, minU(2, u, st) / 2);
    g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
  }
  // Adds a dot to the current path (so several lamps cost one fill).
  function dotAdd(g, x, y, r, u, st) {
    const rr = Math.max(r, minU(2, u, st) / 2);
    g.moveTo(x + rr, y); g.arc(x, y, rr, 0, TAU);
  }
  // Lamp square centred at (x,y), side in units, clamped >= 2 device px. Fills immediately.
  function sq(g, x, y, side, u, st) {
    const s = Math.max(side, minU(2, u, st));
    g.fillRect(x - s / 2, y - s / 2, s, s);
  }
  // Rect whose height is clamped >= 2 device px (lamp strips).
  function strip(g, x, y, w, h, u, st) {
    const hh = Math.max(h, minU(2, u, st));
    g.fillRect(x, y - (hh - h) / 2, w, hh);
  }

  // Diagonal stroke lines covering a w x h box (caller clips and sets style).
  function hatchLines(g, x, y, w, h, pitch, angleDeg) {
    const a = angleDeg * Math.PI / 180, cx = x + w / 2, cy = y + h / 2, L = Math.hypot(w, h);
    g.save();
    g.translate(cx, cy); g.rotate(a);
    g.beginPath();
    for (let d = -L; d <= L; d += pitch) { g.moveTo(d, -L); g.lineTo(d, L); }
    g.stroke();
    g.restore();
  }
  // Hatch clipped to one rect.
  function hatch(g, x, y, w, h, pitch, angleDeg) {
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    hatchLines(g, x, y, w, h, pitch, angleDeg);
    g.restore();
  }

  // Deterministic hash of three integers -> [0,1).
  function hash01(a, b, c) {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  const clamp01 = v => (v > 1 ? 1 : v < 0 ? 0 : (v || 0));

  return {
    TAU, DIR, pal, alpha, color, lamp, powered, minU, lw, cssPx, begin, silStyle, fs,
    rrect, poly, polyAdd, circle, hex, line, dot, dotAdd, sq, strip, hatchLines, hatch, hash01, clamp01,
  };
})();

/* ============================================================================
 * HUB  (family ivory, class A)
 *   silhouette: hexagon R 48u, rings R 26 (ivory) and R 42 (ice), six radial seams
 *   lit       : 6 lamp dots at the vertices, lamp core r 6u, collar-state LEDs
 *               near the open side, deficit -> dashed warn ring at R 42
 *   tell      : middle ring (R 34, 6 arcs with 4u gaps) rotates 1 rev/20s;
 *               core breath halo +-2u over 3s (2s when load > .9);
 *               approach chase on the collar LEDs
 *   The hexagon is drawn pointy-top (a vertex at 12 o'clock), so R 48 fits 2..98.
 *   The baked radial glow under the core belongs to Render (bake-time only).
 * ========================================================================== */
const _HUB_A0 = -Math.PI / 2;

// Three LED positions just inside the hexagon on the collar's open side.
function _hubLeds(g, st, u, open) {
  const d = _A.DIR[open]; if (!d) return;
  const a = Math.atan2(d.y, d.x);
  g.beginPath();
  for (let k = -1; k <= 1; k++) {
    const ak = a + k * .17;
    _A.dotAdd(g, 50 + 38 * Math.cos(ak), 50 + 38 * Math.sin(ak), 2, u, st);
  }
  g.fill();
}

ART.hub = {
  tellClass: 'A',

  silhouette(g, u, st) {
    const col = _A.color(st, 'hub'), ice = _A.pal('ice');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    _A.hex(g, 50, 50, 48, _HUB_A0); _A.fs(g);               // hexagon plate, ivory rim 2u
    g.strokeStyle = ice; _A.circle(g, 50, 50, 42); g.stroke(); // ice inner ring
    g.strokeStyle = col; _A.circle(g, 50, 50, 26); g.stroke(); // inner ivory ring
    g.beginPath();                                            // six radial seams, R 26 -> R 46
    for (let k = 0; k < 6; k++) {
      const a = _HUB_A0 + k * Math.PI / 3;
      g.moveTo(50 + 26 * Math.cos(a), 50 + 26 * Math.sin(a));
      g.lineTo(50 + 46 * Math.cos(a), 50 + 46 * Math.sin(a));
    }
    g.stroke();
  },

  lit(g, u, st) {
    const L = _A.lamp(st), D = st.dock || null;
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    // six vertex lamps (one fill)
    g.fillStyle = L;
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = _HUB_A0 + k * Math.PI / 3;
      _A.dotAdd(g, 50 + 44 * Math.cos(a), 50 + 44 * Math.sin(a), 2, u, st);
    }
    g.fill();
    // core
    _A.dot(g, 50, 50, 6, u, st);
    // collar state, subtly: three LEDs near the open side
    if (D && D.open && D.usable !== false) {
      if (D.docked) g.fillStyle = _A.pal('ice');
      else if (D.approaching) g.fillStyle = _A.alpha(L, .35);   // dim base; the tell chases over it
      else g.fillStyle = _A.pal('good');
      _hubLeds(g, st, u, D.open);
    }
    // module status: power deficit -> the inner ring turns dashed warn
    const deficit = (st.load > 1) || (typeof st.efficiency === 'number' && st.efficiency < 1);
    if (deficit) {
      g.strokeStyle = _A.pal('warn'); _A.lw(g, 2, u, st);
      g.setLineDash([4, 3]);
      _A.circle(g, 50, 50, 42); g.stroke();
      g.setLineDash([]);
    }
  },

  tell(g, u, t, st) {
    const col = _A.color(st, 'hub'), L = _A.lamp(st), D = st.dock || null;
    const tt = (_A.powered(st) && !st.reduced) ? t : 0;      // frozen at phase 0 when unpowered / reduced
    _A.begin(g);
    // middle ring: six arcs at R 34 with 4u gaps, 1 rev / 20 s
    const rot = tt * _A.TAU / 20, gap = 4 / 34, seg = Math.PI / 3;
    g.strokeStyle = col; _A.lw(g, 2, u, st);
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a0 = rot + k * seg + gap / 2, a1 = rot + (k + 1) * seg - gap / 2;
      g.moveTo(50 + 34 * Math.cos(a0), 50 + 34 * Math.sin(a0));
      g.arc(50, 50, 34, a0, a1);
    }
    g.stroke();
    // core breath: a lamp halo ring at r 8 +- 2u; 3 s normally, 2 s above 90% load
    const period = (st.load > .9) ? 2 : 3;
    const r = 8 + 2 * Math.sin(_A.TAU * tt / period);
    g.strokeStyle = _A.alpha(L, .6); _A.lw(g, 2, u, st);
    _A.circle(g, 50, 50, r); g.stroke();
    // approach chase on the collar LEDs: centre, then both ends, then dark (1 step / s)
    if (D && D.open && D.approaching && !D.docked && D.usable !== false) {
      const step = Math.floor(tt) % 3;
      if (step < 2) {
        const d = _A.DIR[D.open], a = Math.atan2(d.y, d.x);
        g.fillStyle = L;
        g.beginPath();
        if (step === 0) _A.dotAdd(g, 50 + 38 * Math.cos(a), 50 + 38 * Math.sin(a), 2, u, st);
        else {
          _A.dotAdd(g, 50 + 38 * Math.cos(a - .17), 50 + 38 * Math.sin(a - .17), 2, u, st);
          _A.dotAdd(g, 50 + 38 * Math.cos(a + .17), 50 + 38 * Math.sin(a + .17), 2, u, st);
        }
        g.fill();
      }
    }
  },
};

/* ============================================================================
 * DOCK  (family ice, class A)
 *   Drawn in a local frame whose mouth faces +x (east), then rotated so the
 *   opening faces st.dock.open ('e' when unknown).
 *   silhouette: U collar, arms 14u thick (outer box 18..82), umbilical stub 4u
 *               on the back wall toward the hub side, dark 4u LED slit across
 *               the mouth between the arm tips
 *   lit       : clamp pads 10x6u (ice) at the arm tips, slid closed 6u when docked;
 *               3 LEDs on the slit: free good / docked ice / approaching dim lamp
 *               (the tell chases over it) / blocked off; progress arc (2px ice-hi)
 *               3u outside the collar's outer edge while docked; blocked status:
 *               hazard hatch along the rim + three 6u bad chevrons pointing inward
 *   tell      : approach chase, centre -> both ends -> dark, 1 step / s
 * ========================================================================== */
const _DOCK_ROT = { e: 0, s: Math.PI / 2, w: Math.PI, n: -Math.PI / 2 };

function _dockFrame(g, st) {
  const open = (st && st.dock && st.dock.open) || 'e';
  g.translate(50, 50); g.rotate(_DOCK_ROT[open] || 0); g.translate(-50, -50);
}

ART.dock = {
  tellClass: 'A',

  silhouette(g, u, st) {
    const col = _A.color(st, 'dock');
    _A.begin(g);
    _dockFrame(g, st);
    _A.silStyle(g, u, st, col);
    // U collar: back wall x 18..32, arms y 18..32 and 68..82, mouth on +x
    _A.poly(g, [18, 18, 82, 18, 82, 32, 32, 32, 32, 68, 82, 68, 82, 82, 18, 82]); _A.fs(g);
    // umbilical stub 4u from the back wall toward the plate edge (hub side)
    g.fillStyle = col; g.fillRect(7, 48, 11, 4);
    // dark LED slit 4u along the open edge, between the arm tips
    g.fillStyle = _A.alpha(_A.pal('void'), .75); g.fillRect(74, 36, 4, 28);
  },

  lit(g, u, st) {
    const D = st.dock || {}, L = _A.lamp(st), ice = _A.pal('ice');
    _A.begin(g);
    _dockFrame(g, st);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    const blocked = D.usable === false;
    // clamp pads at the arm tips; slide closed by 6u while a ship is docked (Render eases
    // D.clamp 0..1 over 300ms per 9.3; a bare docked flag snaps)
    const slide = 6 * (typeof D.clamp === 'number' ? Math.max(0, Math.min(1, D.clamp)) : (D.docked ? 1 : 0));
    g.fillStyle = ice;
    g.fillRect(72, 32 + slide, 10, 6);
    g.fillRect(72, 62 - slide, 10, 6);
    // three LEDs on the slit (blocked: off)
    if (!blocked) {
      if (D.docked) g.fillStyle = ice;
      else if (D.approaching) g.fillStyle = _A.alpha(L, .35);
      else g.fillStyle = _A.pal('good');
      g.beginPath();
      _A.dotAdd(g, 76, 40, 2, u, st); _A.dotAdd(g, 76, 50, 2, u, st); _A.dotAdd(g, 76, 60, 2, u, st);
      g.fill();
    }
    // progress arc while docked: 2px, 3u outside the outer edge (so it clears the ice stroke)
    if (D.docked && D.progress > 0) {
      const len = 204 * Math.min(1, D.progress);       // 67 + 70 + 67 along x=15 / y=15 / y=85
      g.strokeStyle = _A.pal('ice-hi'); g.lineWidth = _A.cssPx(2, u, st); g.lineCap = 'butt';
      g.beginPath(); g.moveTo(82, 15);
      if (len <= 67) g.lineTo(82 - len, 15);
      else {
        g.lineTo(15, 15);
        if (len <= 137) g.lineTo(15, 15 + (len - 67));
        else { g.lineTo(15, 85); g.lineTo(15 + (len - 137), 85); }
      }
      g.stroke();
    }
    // blocked status: hazard hatch along the collar rim + chevrons pointing inward
    if (blocked) {
      g.globalAlpha = 1;
      g.beginPath();
      g.rect(18, 18, 64, 4); g.rect(18, 18, 4, 64); g.rect(18, 78, 64, 4);   // outer rim strips
      g.rect(78, 18, 4, 14); g.rect(78, 68, 4, 14);                            // arm tips
      g.fillStyle = '#140C00'; g.fill();
      g.save(); g.clip();
      g.strokeStyle = _A.pal('warn'); _A.lw(g, 3, u, st); g.lineCap = 'butt';
      _A.hatchLines(g, 18, 18, 64, 64, 7, 45);
      g.restore();
      g.strokeStyle = _A.pal('bad'); _A.lw(g, 2, u, st);
      g.beginPath();
      g.moveTo(44, 22); g.lineTo(50, 28); g.lineTo(56, 22);   // top arm, pointing in
      g.moveTo(22, 44); g.lineTo(28, 50); g.lineTo(22, 56);   // back wall, pointing in
      g.moveTo(44, 78); g.lineTo(50, 72); g.lineTo(56, 78);   // bottom arm, pointing in
      g.stroke();
    }
  },

  tell(g, u, t, st) {
    const D = st.dock || {};
    if (D.usable === false || D.docked || !D.approaching) return;   // only the approach chase animates
    const tt = (_A.powered(st) && !st.reduced) ? t : 0;             // reduced: LEDs stay, chase freezes
    _A.begin(g);
    _dockFrame(g, st);
    const step = Math.floor(tt) % 3;
    if (step === 2) return;                                          // dark beat
    g.fillStyle = _A.lamp(st);
    g.beginPath();
    if (step === 0) _A.dotAdd(g, 76, 50, 2, u, st);
    else { _A.dotAdd(g, 76, 40, 2, u, st); _A.dotAdd(g, 76, 60, 2, u, st); }
    g.fill();
  },
};

/* ============================================================================
 * WAREHOUSE  (family amber, class A)
 *   silhouette: 3x3 crates 20u with 4u gaps (16/40/64), one lid highlight 2u
 *               lighter on the top-left crate, a 2u diagonal strap on the centre
 *   lit       : crates fill bottom-up (row 3 left->right, then row 2, then row 1):
 *               filled = round(ratio*9) at 100% family color, the rest dimmed to ~35%;
 *               while flags.stockChanged the boundary crate flashes lamp;
 *               ratio >= .95 -> 2u warn outline round the top row
 *   tell      : nothing animates on its own (the flash is state-driven in lit)
 * ========================================================================== */
const _WH_POS = [16, 40, 64];
function _whCrate(i) {               // i: 0..8 in fill order -> {x, y}
  const row = 2 - Math.floor(i / 3), col = i % 3;
  return { x: _WH_POS[col], y: _WH_POS[row] };
}

ART.warehouse = {
  tellClass: 'A',

  silhouette(g, u, st) {
    const col = _A.color(st, 'warehouse');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      _A.rrect(g, _WH_POS[c], _WH_POS[r], 20, 20, 2); _A.fs(g);
    }
    g.fillStyle = 'rgba(255,255,255,.3)'; g.fillRect(17, 17, 18, 2);       // highlighted lid
    g.strokeStyle = col; _A.lw(g, 2, u, st); _A.line(g, 42, 42, 58, 58);     // strap on the centre crate
  },

  lit(g, u, st) {
    const col = _A.color(st, 'warehouse'), F = st.flags || {};
    const ratio = _A.clamp01(st.ratio), n = Math.round(ratio * 9);
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    // filled crates at 100%
    if (n > 0) {
      g.fillStyle = col; g.beginPath();
      for (let i = 0; i < n; i++) { const p = _whCrate(i); g.rect(p.x + 1, p.y + 1, 18, 18); }
      g.fill();
    }
    // unfilled crates dimmed toward 35%
    if (n < 9) {
      g.fillStyle = _A.alpha(_A.pal('void'), .4); g.beginPath();
      for (let i = n; i < 9; i++) { const p = _whCrate(i); g.rect(p.x + 1, p.y + 1, 18, 18); }
      g.fill();
    }
    // stock change flash on the boundary crate (Render holds the flag ~400 ms)
    if (F.stockChanged) {
      const p = _whCrate(Math.min(8, Math.max(0, n - 1)));
      g.fillStyle = _A.alpha(_A.lamp(st), .7); g.fillRect(p.x + 1, p.y + 1, 18, 18);
    }
    // status: storage >= 95% -> warn outline round the top row
    // (warn and amber are close in hue, so a dark backing stroke separates the outline from the crates)
    if (ratio >= .95) {
      g.globalAlpha = 1;
      g.strokeStyle = _A.alpha(_A.pal('void'), .8); _A.lw(g, 4, u, st);
      g.strokeRect(14, 14, 72, 24);
      g.strokeStyle = _A.pal('warn'); _A.lw(g, 2, u, st);
      g.strokeRect(14, 14, 72, 24);
    }
  },

  tell(/* g, u, t, st */) { /* class A, state-driven: the flash lives in lit so it survives tell gating */ },
};

/* ============================================================================
 * SOLAR  (family gold, class A)
 *   silhouette: 6u spine (47..53, 12..88), two wings 30x56u (14..44 / 56..86,
 *               22..78) with 2x4 cells split by 2u dark lines, 8u junction box
 *   lit       : one lamp dot on the junction box (off during a flare)
 *   tell      : 6u specular band sweeps each wing every 6 s; tilt over the game
 *               day is suggested by a shade strip on the trailing wing edge whose
 *               width is 6u * |sin(day*2pi)| (the baked wings cannot rotate)
 *   Flare: Render swaps the plate to the offline variant; lamp off, tell frozen.
 * ========================================================================== */
ART.solar = {
  tellClass: 'A',

  silhouette(g, u, st) {
    const col = _A.color(st, 'solar');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    _A.rrect(g, 47, 12, 6, 76, 2); _A.fs(g);                 // spine
    _A.rrect(g, 14, 22, 30, 56, 3); _A.fs(g);                // left wing
    _A.rrect(g, 56, 22, 30, 56, 3); _A.fs(g);                // right wing
    g.strokeStyle = _A.alpha(_A.pal('void'), .7); _A.lw(g, 2, u, st); g.lineCap = 'butt';
    g.beginPath();                                           // 2x4 cell seams on each wing
    for (const wx of [14, 56]) {
      g.moveTo(wx + 15, 23); g.lineTo(wx + 15, 77);
      for (let k = 1; k < 4; k++) { g.moveTo(wx + 1, 22 + 14 * k); g.lineTo(wx + 29, 22 + 14 * k); }
    }
    g.stroke();
    g.fillStyle = col; g.strokeStyle = col;
    _A.rrect(g, 46, 46, 8, 8, 1); _A.fs(g);                  // junction box
  },

  lit(g, u, st) {
    const F = st.flags || {};
    if (F.flare) return;                                     // arrays dark during a flare
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    g.fillStyle = _A.lamp(st);
    _A.dot(g, 50, 50, 2.5, u, st);
  },

  tell(g, u, t, st) {
    const F = st.flags || {};
    if (F.flare || st.reduced) return;                       // frozen offline / reduced motion
    const tt = _A.powered(st) ? t : 0;
    _A.begin(g);
    g.beginPath(); g.rect(14, 22, 30, 56); g.rect(56, 22, 30, 56); g.clip();
    // specular band: 6u wide, sweeps both wings every 6 s
    const p = (tt / 6) % 1, bx = p * 36 - 6;
    g.fillStyle = 'rgba(255,255,255,.18)';
    g.fillRect(14 + bx, 22, 6, 56);
    g.fillRect(56 + bx, 22, 6, 56);
    // tilt cue: shade on the trailing edge, width 6u * |sin(day * 2pi)|
    const s = Math.sin((st.day || 0) * _A.TAU), w = 6 * Math.abs(s);
    if (w > .5) {
      g.fillStyle = _A.alpha(_A.pal('void'), .35);
      if (s > 0) { g.fillRect(44 - w, 22, w, 56); g.fillRect(86 - w, 22, w, 56); }
      else { g.fillRect(14, 22, w, 56); g.fillRect(56, 22, w, 56); }
    }
  },
};

/* ============================================================================
 * FUEL  (family amber, class B)
 *   silhouette: twin cylinders 24x60u (22..46 / 54..78, y 20..80), 8u apart;
 *               hazard band 6u (3 amber stripes on dark) at 70% height on the
 *               right cylinder; gauge slit 4x40u on the left cylinder; 3u hose
 *               loop from the right cylinder to the plate edge
 *   lit       : 2 lamp valve dots at the cylinder tops
 *   tell      : gauge level drifts +-5% round 60% over 8 s; a lamp drip dot falls
 *               10u every 2 s from the hose end while a ship is docked adjacent
 * ========================================================================== */
ART.fuel = {
  tellClass: 'B',

  silhouette(g, u, st) {
    const col = _A.color(st, 'fuel');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    _A.rrect(g, 22, 20, 24, 60, 11); _A.fs(g);               // left cylinder
    _A.rrect(g, 54, 20, 24, 60, 11); _A.fs(g);               // right cylinder
    // hazard band at 70% height on the right cylinder: dark with 3 amber stripes
    g.fillStyle = '#140C00'; g.fillRect(55, 35, 22, 6);
    g.fillStyle = col;
    g.fillRect(57, 35, 4, 6); g.fillRect(64, 35, 4, 6); g.fillRect(71, 35, 4, 6);
    // gauge slit 4x40u on the left cylinder
    g.fillStyle = _A.alpha(_A.pal('void'), .75); g.fillRect(32, 30, 4, 40);
    // hose loop 3u from the right cylinder to the plate edge
    g.strokeStyle = col; _A.lw(g, 3, u, st);
    g.beginPath(); g.moveTo(78, 46); g.bezierCurveTo(98, 42, 98, 66, 86, 66); g.stroke();
  },

  lit(g, u, st) {
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    g.fillStyle = _A.lamp(st);
    g.beginPath(); _A.dotAdd(g, 34, 20, 2, u, st); _A.dotAdd(g, 66, 20, 2, u, st); g.fill();
  },

  tell(g, u, t, st) {
    if (st.reduced) return;
    const tt = _A.powered(st) ? t : 0, F = st.flags || {};
    _A.begin(g);
    // gauge level inside the slit
    const level = .6 + .05 * Math.sin(_A.TAU * tt / 8), h = 40 * level;
    g.fillStyle = _A.alpha(_A.color(st, 'fuel'), .9);
    g.fillRect(32, 70 - h, 4, h);
    // drip from the hose end while a ship is docked adjacent
    if (F.shipAdjacent) {
      const p = (tt % 2) / 2;
      g.fillStyle = _A.alpha(_A.lamp(st), 1 - p);
      _A.dot(g, 86, 68 + 10 * p, 2, u, st);
    }
  },
};

/* ============================================================================
 * QUARTERS  (family sage, class A)
 *   silhouette: rounded bay 70x56u (15..85, 22..78) r 8; 2 rows of 4 bunk slits
 *               10x6u (x 21/37/53/69, y 36/58) as dark cut-outs; door notch 8u
 *               on the bottom edge (the hub side is not known to the art)
 *   lit       : slits lit = round(ratio*8), in order left->right, top row first;
 *               ratio 0 -> all eight at 20%
 *   tell      : one slit toggles state every ~4 s via hash(floor(t/4))
 * ========================================================================== */
const _QT_X = [21, 37, 53, 69], _QT_Y = [36, 58];
function _qtSlot(i) { return { x: _QT_X[i % 4], y: _QT_Y[Math.floor(i / 4)] }; }

ART.quarters = {
  tellClass: 'A',

  silhouette(g, u, st) {
    const col = _A.color(st, 'quarters');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    _A.rrect(g, 15, 22, 70, 56, 8); _A.fs(g);               // bay
    g.fillStyle = _A.alpha(_A.pal('void'), .6);
    g.beginPath();                                          // eight bunk slits (cut-outs)
    for (let i = 0; i < 8; i++) { const p = _qtSlot(i); g.rect(p.x, p.y, 10, 6); }
    g.rect(46, 72, 8, 6);                                   // door notch on the bottom edge
    g.fill();
  },

  lit(g, u, st) {
    const ratio = _A.clamp01(st.ratio), n = Math.round(ratio * 8), L = _A.lamp(st);
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    if (ratio <= 0) {                                       // status: no visitors -> all windows at 20%
      g.fillStyle = _A.alpha(L, .2); g.beginPath();
      for (let i = 0; i < 8; i++) { const p = _qtSlot(i); g.rect(p.x, p.y, 10, 6); }
      g.fill();
      return;
    }
    if (n > 0) {
      g.fillStyle = L; g.beginPath();
      for (let i = 0; i < n; i++) { const p = _qtSlot(i); g.rect(p.x, p.y, 10, 6); }
      g.fill();
    }
  },

  tell(g, u, t, st) {
    if (st.reduced) return;
    const tt = _A.powered(st) ? t : 0;
    const ratio = _A.clamp01(st.ratio), n = Math.round(ratio * 8);
    if (ratio <= 0) return;
    _A.begin(g);
    const idx = Math.floor(_A.hash01(Math.floor(tt / 4), 7, 13) * 8), p = _qtSlot(idx);
    if (idx < n) g.fillStyle = _A.alpha(_A.pal('void'), .6);   // a lit slit goes dark
    else g.fillStyle = _A.lamp(st);                            // a dark slit lights
    g.fillRect(p.x, p.y, 10, 6);
  },
};

/* ============================================================================
 * CANTINA  (family sage, class B)
 *   silhouette: round table disc R 22u at (50,44) with 6 seat ticks (3u, R 25..31);
 *               service counter 50x8u along the bottom (25..75, 76..84) with a
 *               2u rose neon line on its top edge
 *   lit       : lamp strip along the counter; door glow dot at the left edge
 *   tell      : three steam ticks (2u) rise 12u over 1.2 s and fade, staggered
 * ========================================================================== */
ART.cantina = {
  tellClass: 'B',

  silhouette(g, u, st) {
    const col = _A.color(st, 'cantina');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    _A.circle(g, 50, 44, 22); _A.fs(g);                     // table
    _A.lw(g, 3, u, st); g.lineCap = 'butt';
    g.beginPath();                                          // six seat ticks
    for (let k = 0; k < 6; k++) {
      const a = -Math.PI / 2 + k * Math.PI / 3;
      g.moveTo(50 + 25 * Math.cos(a), 44 + 25 * Math.sin(a));
      g.lineTo(50 + 31 * Math.cos(a), 44 + 31 * Math.sin(a));
    }
    g.stroke();
    _A.lw(g, 2, u, st);
    _A.rrect(g, 25, 76, 50, 8, 2); _A.fs(g);                // service counter
    g.strokeStyle = _A.pal('rose'); g.lineCap = 'butt';
    _A.line(g, 28, 77, 72, 77);                             // rose neon line
  },

  lit(g, u, st) {
    const L = _A.lamp(st);
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    g.fillStyle = _A.alpha(L, .85);
    _A.strip(g, 29, 80, 42, 3, u, st);                      // counter strip lamp
    g.fillStyle = L;
    _A.dot(g, 12, 80, 2, u, st);                            // door glow
  },

  tell(g, u, t, st) {
    if (st.reduced) return;
    const tt = _A.powered(st) ? t : 0, L = _A.lamp(st);
    _A.begin(g);
    const X = [44, 50, 56], Y0 = [38, 36, 38], OFF = [0, .4, .8];
    for (let i = 0; i < 3; i++) {
      const p = ((tt / 1.2) + OFF[i]) % 1;
      g.fillStyle = _A.alpha(L, .7 * (1 - p));
      _A.sq(g, X[i], Y0[i] - 12 * p, 2, u, st);
    }
  },
};

/* ============================================================================
 * COMMS  (family ice, class A)
 *   silhouette: dish disc R 22u at (50,40) on a 6u mast rising from the bottom
 *               edge (47..53, 60..94); two concentric arcs R 28/34u, 90 deg span,
 *               facing up in front of the dish; receiver axis dot r 3u
 *   lit       : lamp dot at the mast top (50,62)
 *   tell      : the feed horn (lamp dot on a 2u spoke, R 16) sweeps round the
 *               dish centre 1 rev/8 s; an expanding 1px ice ring R 10 -> 40,
 *               alpha .4 -> 0, every 1.7 s
 *   The baked arcs stay facing up; rotation is carried by the live feed horn.
 * ========================================================================== */
ART.comms = {
  tellClass: 'A',

  silhouette(g, u, st) {
    const col = _A.color(st, 'comms');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    _A.rrect(g, 47, 60, 6, 34, 2); _A.fs(g);                // mast
    _A.circle(g, 50, 40, 22); _A.fs(g);                     // dish
    g.beginPath(); g.arc(50, 40, 28, -Math.PI * .75, -Math.PI * .25); g.stroke();   // arc R 28
    g.beginPath(); g.arc(50, 40, 34, -Math.PI * .75, -Math.PI * .25); g.stroke();   // arc R 34
    g.fillStyle = col; _A.circle(g, 50, 40, 3); g.fill();   // receiver axis
  },

  lit(g, u, st) {
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    g.fillStyle = _A.lamp(st);
    _A.dot(g, 50, 62, 2.5, u, st);                          // mast-top lamp
  },

  tell(g, u, t, st) {
    if (st.reduced) return;
    const tt = _A.powered(st) ? t : 0, col = _A.color(st, 'comms');
    _A.begin(g);
    // feed horn sweep: spoke + lamp dot, 1 rev / 8 s about the dish centre
    const a = _A.TAU * tt / 8 - Math.PI / 2, hx = 50 + 16 * Math.cos(a), hy = 40 + 16 * Math.sin(a);
    g.strokeStyle = col; _A.lw(g, 2, u, st);
    _A.line(g, 50, 40, hx, hy);
    g.fillStyle = _A.lamp(st);
    _A.dot(g, hx, hy, 2.5, u, st);
    // expanding ring every 1.7 s
    const p = (tt / 1.7) % 1;
    g.strokeStyle = _A.alpha(_A.pal('ice'), .4 * (1 - p)); g.lineWidth = _A.cssPx(1, u, st);
    _A.circle(g, 50, 40, 10 + 30 * p); g.stroke();
  },
};

/* ============================================================================
 * MARKET  (family amber, class A)
 *   silhouette: balance beam 60x4u (20..80, 34..38) on a 20u post (47..53,
 *               38..58) with a 24x4u foot; two pans (half-discs R 10u) hanging
 *               from the beam ends; ticker strip 60x6u along the bottom (80..86)
 *   lit       : lamp dot at the beam pivot
 *   tell      : 4 tick marks scroll left at 6u/s inside the strip, each colored
 *               good / bad / ink-3 from the sign in st.trends[i]
 * ========================================================================== */
ART.market = {
  tellClass: 'A',

  silhouette(g, u, st) {
    const col = _A.color(st, 'market');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    _A.rrect(g, 47, 38, 6, 20, 1); _A.fs(g);                // post
    _A.rrect(g, 38, 58, 24, 4, 1); _A.fs(g);                // foot
    _A.rrect(g, 20, 34, 60, 4, 1); _A.fs(g);                // beam
    g.beginPath(); g.moveTo(22, 38); g.lineTo(24, 48); g.moveTo(78, 38); g.lineTo(76, 48); g.stroke();   // hangers
    g.beginPath(); g.arc(24, 48, 10, 0, Math.PI); g.closePath(); _A.fs(g);   // left pan
    g.beginPath(); g.arc(76, 48, 10, 0, Math.PI); g.closePath(); _A.fs(g);   // right pan
    g.fillStyle = _A.alpha(_A.pal('void'), .6);
    _A.rrect(g, 20, 80, 60, 6, 1); _A.fs(g);                // ticker strip
  },

  lit(g, u, st) {
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    g.fillStyle = _A.lamp(st);
    _A.dot(g, 50, 36, 2.5, u, st);                          // pivot lamp
  },

  tell(g, u, t, st) {
    // the four ticker marks are part of the strip's geometry: under reduced motion (or when
    // Render passes a frozen clock) they stay put at phase 0 instead of vanishing (11.2: tickers snap)
    const tt = (_A.powered(st) && !st.reduced) ? t : 0;
    const trends = Array.isArray(st.trends) ? st.trends : [];
    _A.begin(g);
    g.beginPath(); g.rect(21, 81, 58, 4); g.clip();
    const w = Math.max(2, _A.minU(2, u, st)), scroll = (6 * tt) % 60;
    for (let i = 0; i < 4; i++) {
      const s = trends[i] || 0;
      g.fillStyle = s > 0 ? _A.pal('good') : s < 0 ? _A.pal('bad') : _A.pal('ink-3');
      const x = 20 + ((i * 15 + 60 - scroll) % 60);
      g.fillRect(x, 81, w, 4);
    }
  },
};

/* ============================================================================
 * REC  (family rose, class B)
 *   silhouette: ring court R 26u with a centre dot r 3u; four 6u lamp posts at
 *               the corners (16/78); a 2u scoreboard slit on the top rim
 *   lit       : 4 corner lamps (4u squares) at 60%
 *   tell      : lamps brighten in sequence every 2 s; a 3u ball dot drifts on
 *               an ellipse inside the court
 * ========================================================================== */
const _REC_POSTS = [[19, 19], [81, 19], [19, 81], [81, 81]];

ART.rec = {
  tellClass: 'B',

  silhouette(g, u, st) {
    const col = _A.color(st, 'rec');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    _A.circle(g, 50, 50, 26); _A.fs(g);                     // court
    g.fillStyle = col;
    _A.circle(g, 50, 50, 3); g.fill();                      // centre dot
    for (const [x, y] of _REC_POSTS) g.fillRect(x - 3, y - 3, 6, 6);   // lamp posts
    g.fillStyle = _A.alpha(_A.pal('void'), .7);
    g.fillRect(42, 23, 16, 2);                              // scoreboard slit on the top rim
  },

  lit(g, u, st) {
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    g.fillStyle = _A.alpha(_A.lamp(st), .6);
    const s = Math.max(4, _A.minU(2, u, st));
    g.beginPath();
    for (const [x, y] of _REC_POSTS) g.rect(x - s / 2, y - s / 2, s, s);
    g.fill();
  },

  tell(g, u, t, st) {
    if (st.reduced) return;
    const tt = _A.powered(st) ? t : 0, L = _A.lamp(st);
    _A.begin(g);
    const i = Math.floor(tt / 2) % 4, p = _REC_POSTS[i];
    g.fillStyle = L;
    _A.sq(g, p[0], p[1], 4, u, st);                         // the bright lamp in the sequence
    _A.dot(g, 50 + 14 * Math.cos(tt * .9), 50 + 9 * Math.sin(tt * .9), 1.5, u, st);   // ball
  },
};

/* ============================================================================
 * HYDRO  (family sage, class B)
 *   silhouette: half-ellipse glass dome 70x44u (centre 50,62; rx 35, ry 44) on a
 *               70x6u planter; four crop rows 4u tall fitted inside the dome;
 *               a 2u dome highlight arc; a 3u leaf tick at the left end of each row
 *   lit       : rows in grow light #D9B8D0 at 60% (unpowered: 30%, the one
 *               exception to the generic 50%)
 *   tell      : rows breathe: overlay alpha 0 -> .4 over 4 s (total .6 -> 1)
 * ========================================================================== */
const _HY_ROWS = [[28, 30, 44], [24, 38, 52], [21, 46, 58], [19, 54, 62]];   // x, y, width
const _HY_GROW = '#D9B8D0';

ART.hydro = {
  tellClass: 'B',

  silhouette(g, u, st) {
    const col = _A.color(st, 'hydro');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    g.beginPath(); g.ellipse(50, 62, 35, 44, 0, Math.PI, _A.TAU); g.closePath(); _A.fs(g);   // dome
    _A.rrect(g, 15, 62, 70, 6, 1); _A.fs(g);                // planter
    for (const [x, y, w] of _HY_ROWS) { _A.rrect(g, x, y, w, 4, 1); _A.fs(g); }   // crop rows
    g.strokeStyle = _A.alpha(_A.pal('ivory'), .5);
    g.beginPath(); g.ellipse(50, 62, 30, 39, 0, Math.PI * 1.12, Math.PI * 1.42); g.stroke();   // dome highlight
    g.fillStyle = col;
    for (const [x, y] of _HY_ROWS) g.fillRect(x + 3, y - 3, 3, 3);   // leaf ticks
  },

  lit(g, u, st) {
    _A.begin(g);
    g.globalAlpha = 1;
    g.fillStyle = _A.alpha(_HY_GROW, _A.powered(st) ? .6 : .3);
    g.beginPath();
    for (const [x, y, w] of _HY_ROWS) g.rect(x, y, w, 4);
    g.fill();
  },

  tell(g, u, t, st) {
    if (st.reduced) return;
    const tt = _A.powered(st) ? t : 0;
    const a = .2 * (1 - Math.cos(_A.TAU * tt / 4));          // 0 at phase 0, peaks at .4
    if (a <= .01) return;
    _A.begin(g);
    g.fillStyle = _A.alpha(_HY_GROW, a);
    g.beginPath();
    for (const [x, y, w] of _HY_ROWS) g.rect(x, y, w, 4);
    g.fill();
  },
};

/* ============================================================================
 * CLINIC  (family sage, class A)
 *   silhouette: rounded bay 64x56u (18..82, 18..74) r 8 with a 28x28u cross
 *               cut-out (arms 10u) centred at (50,44), cross outlined ivory 2u;
 *               ECG slit 40x6u along the bottom (30..70, 80..86); two bed ticks
 *   lit       : lamp door dot at the bay's bottom centre; status: cross outline
 *               turns good while flags.alert (outbreak / raid alert window)
 *   tell      : ECG trace (6-point polyline, 1px) sweeps the slit once per second;
 *               the beat pulses the cross outline by 1u
 * ========================================================================== */
const _CL_CROSS = [45, 30, 55, 30, 55, 39, 64, 39, 64, 49, 55, 49, 55, 58, 45, 58, 45, 49, 36, 49, 36, 39, 45, 39];
const _CL_BEAT = [0, 0, 6, 0, 9, -2.5, 12, 2.5, 15, 0, 24, 0];   // relative polyline, 6 points

ART.clinic = {
  tellClass: 'A',

  silhouette(g, u, st) {
    const col = _A.color(st, 'clinic');
    _A.begin(g);
    _A.silStyle(g, u, st, col);
    _A.rrect(g, 18, 18, 64, 56, 8); g.stroke();             // bay outline
    _A.polyAdd(g, _CL_CROSS); g.fill('evenodd');            // bay fill with the cross cut out
    g.strokeStyle = _A.pal('ivory');
    _A.poly(g, _CL_CROSS); g.stroke();                      // ivory cross outline
    g.fillStyle = _A.alpha(_A.pal('void'), .7); g.strokeStyle = col;
    _A.rrect(g, 30, 80, 40, 6, 1); _A.fs(g);                // ECG slit
    g.fillStyle = col;
    g.fillRect(24, 64, 8, 4); g.fillRect(68, 64, 8, 4);     // bed ticks
  },

  lit(g, u, st) {
    const F = st.flags || {};
    _A.begin(g);
    g.globalAlpha = _A.powered(st) ? 1 : .5;
    g.fillStyle = _A.lamp(st);
    _A.dot(g, 50, 74, 2.5, u, st);                          // door lamp
    if (F.alert) {                                          // status: cross turns good during the alert window
      g.globalAlpha = 1;
      g.strokeStyle = _A.pal('good'); _A.lw(g, 2, u, st);
      _A.poly(g, _CL_CROSS); g.stroke();
    }
  },

  tell(g, u, t, st) {
    if (st.reduced) return;
    const tt = _A.powered(st) ? t : 0, p = tt % 1;
    _A.begin(g);
    // beat pulse on the cross outline (first quarter of each second)
    if (p < .25) {
      g.strokeStyle = _A.alpha(_A.pal('ivory'), 1 - p / .25); _A.lw(g, 3, u, st);
      _A.poly(g, _CL_CROSS); g.stroke();
    }
    // ECG trace sweeping the slit
    g.beginPath(); g.rect(31, 81, 38, 4); g.clip();
    const x0 = 70 - p * 62, y0 = 83;
    g.strokeStyle = _A.lamp(st); g.lineWidth = _A.cssPx(1, u, st); g.lineJoin = 'miter';
    g.beginPath();
    g.moveTo(x0 + _CL_BEAT[0], y0 + _CL_BEAT[1]);
    for (let i = 2; i < _CL_BEAT.length; i += 2) g.lineTo(x0 + _CL_BEAT[i], y0 + _CL_BEAT[i + 1]);
    g.stroke();
  },
};

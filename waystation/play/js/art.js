// ============================================================
// WAYSTATION — art.js (Engineer A1)
// Shared visual foundation for the canvas renderer and the DOM HUD:
//   PAL            resolved color tokens (section 2) + PAL.load()/PAL.family()
//   FAMILY, FAMILY_COLOR, KIND_COLOR, COMPANY_COLOR
//   desat(), withAlpha(), mix(), luminance(), luma(), contrast()
//   registryOf(), registryNumber()      FNV-1a station registry
//   ICONS, Icons.svg(), Icons.path()    24x24 path library
//   ART = {}                            module art registry (filled by art-mod-a/b)
//   ArtKit                              drawing helpers in the 100x100 unit space
// Classic script: everything here is a top-level const/function global.
// Load order: data, sim, art, art-mod-a, art-mod-b, fx, ships, render, ui, main.
// ============================================================
'use strict';

// ------------------------------------------------------------
// 1. Palette tokens (DESIGN.md section 2). Name = CSS custom
//    property without its leading dashes. Values are the exact
//    fallbacks used when the stylesheet has not supplied them.
// ------------------------------------------------------------
const PAL_FALLBACK = {
  // black is the material
  'void': '#04050A',
  'bg': '#090B12',
  'surface-1': '#0F1119',
  'surface-2': '#161A25',
  'surface-3': '#1E2432',
  'hairline': '#262C3A',
  'hairline-2': '#343B4C',
  // canvas structure
  'hull': '#1B2030',
  'hull-edge': '#2A3142',
  'hull-rim': 'rgba(243,233,214,.25)',
  'truss': '#232838',
  // identity hues: solid / hi / dim(55%) / ghost(14%)
  'amber': '#E9A23B', 'amber-hi': '#FFC46A', 'amber-dim': 'rgba(233,162,59,.55)', 'amber-ghost': 'rgba(233,162,59,.14)',
  'ice': '#8FD3E8', 'ice-hi': '#BFE8F4', 'ice-dim': 'rgba(143,211,232,.55)', 'ice-ghost': 'rgba(143,211,232,.14)',
  'sage': '#A8C8A0', 'sage-hi': '#CBE2C4', 'sage-dim': 'rgba(168,200,160,.55)', 'sage-ghost': 'rgba(168,200,160,.14)',
  'rose': '#E58BB8', 'rose-hi': '#F2B6D3', 'rose-dim': 'rgba(229,139,184,.55)', 'rose-ghost': 'rgba(229,139,184,.14)',
  'gold': '#FFE28A',
  'ivory': '#F3E9D6', 'ivory-dim': 'rgba(243,233,214,.6)', 'ivory-ghost': 'rgba(243,233,214,.14)',
  'lamp': '#FFE9B8',
  // status
  'good': '#6FD3A3', 'warn': '#FF8F3D', 'bad': '#FF4F5E',
  'good-ghost': 'rgba(111,211,163,.14)', 'warn-ghost': 'rgba(255,143,61,.14)', 'bad-ghost': 'rgba(255,79,94,.14)',
  // text
  'ink': '#E6E8EC', 'ink-2': '#A3A7B0', 'ink-3': '#6B707C',
  'on-accent': '#140C00',
  // glow (box-shadow strings; carried for completeness, not colors)
  'glow-amber': '0 0 8px rgba(233,162,59,.35)',
  'glow-ice': '0 0 8px rgba(143,211,232,.35)',
  // hazard hatch (gradient string)
  'hazard': 'repeating-linear-gradient(135deg,#FF8F3D 0 5px,#140C00 5px 10px)',
};

const PAL = {
  ready: false,
  tokens: Object.keys(PAL_FALLBACK),
  FALLBACK: PAL_FALLBACK,
  _listeners: [],

  // Read every token from :root; fall back to the exact section-2 value when
  // the computed value is empty. Safe before the DOM is ready (fallbacks only)
  // and safe to call repeatedly (level changes, fonts.ready).
  load() {
    let cs = null;
    try {
      if (typeof document !== 'undefined' && document.documentElement && typeof getComputedStyle === 'function') {
        cs = getComputedStyle(document.documentElement);
      }
    } catch (e) { cs = null; }
    let changed = false;
    for (const name of this.tokens) {
      let v = '';
      if (cs) { try { v = cs.getPropertyValue('--' + name).trim(); } catch (e) { v = ''; } }
      if (!v) v = PAL_FALLBACK[name];
      if (this[name] !== v) { this[name] = v; changed = true; }
    }
    this.ready = true;
    if (changed) {
      _colorCache.clear(); _alphaCache.clear();
      for (const fn of this._listeners) { try { fn(this); } catch (e) { /* listener error must not break load */ } }
    }
    return this;
  },

  // Register for palette changes (level change re-load, fonts.ready). Returns an unsubscribe fn.
  onChange(fn) {
    this._listeners.push(fn);
    return () => { const i = this._listeners.indexOf(fn); if (i >= 0) this._listeners.splice(i, 1); };
  },

  // '--ice' | 'ice' -> resolved color; any other string is returned unchanged.
  resolve(nameOrColor) {
    if (typeof nameOrColor !== 'string') return nameOrColor;
    const key = nameOrColor.startsWith('--') ? nameOrColor.slice(2) : nameOrColor;
    if (Object.prototype.hasOwnProperty.call(PAL_FALLBACK, key)) return this[key] || PAL_FALLBACK[key];
    return nameOrColor;
  },

  // Resolved family color for a module id (ivory for unknown ids).
  family(moduleId) {
    const fam = FAMILY[moduleId] || 'hub';
    return this.resolve(FAMILY_COLOR[fam] || '--ivory');
  },

  // Resolved color for a goods kind ('mineral' | 'crop' | 'animal' | 'made').
  kind(kind) {
    return this.resolve(KIND_COLOR[kind] || '--ink-2');
  },
};
// Pre-seed with fallbacks so PAL.ice etc. are never undefined even before load().
for (const name of PAL.tokens) PAL[name] = PAL_FALLBACK[name];

// ------------------------------------------------------------
// 2. Module families, goods kinds (section 2.2)
// ------------------------------------------------------------
const FAMILY = {
  hub: 'hub',
  dock: 'ops', comms: 'ops', customs: 'ops', security: 'ops', shipyard: 'ops',
  solar: 'power', reactor: 'power',
  warehouse: 'trade', fuel: 'trade', market: 'trade', bank: 'trade', refinery: 'trade',
  quarters: 'life', cantina: 'life', hydro: 'life', clinic: 'life', habitat: 'life', school: 'life',
  rec: 'culture', plaza: 'culture', menagerie: 'culture', observatory: 'culture', gate: 'culture',
};

const FAMILY_COLOR = {
  ops: '--ice', power: '--gold', trade: '--amber', life: '--sage', culture: '--rose', hub: '--ivory',
};

const KIND_COLOR = {
  mineral: '#8C949F', crop: '--sage', animal: '--rose', made: '--amber',
};

// Registry-tag prefixes (section 8.0): first two letters uppercased, with the
// three collisions resolved exactly as the spec writes them.
const TAG_PREFIX = {
  hub: 'HB', dock: 'DK', warehouse: 'WH', solar: 'SO', fuel: 'FU', quarters: 'QU', cantina: 'CA',
  comms: 'CO', market: 'MA', rec: 'RE', hydro: 'HY', clinic: 'CL', habitat: 'HA', reactor: 'RX',
  customs: 'CU', security: 'SE', school: 'SC', bank: 'BA', plaza: 'PL', menagerie: 'ME',
  refinery: 'RF', shipyard: 'SH', observatory: 'OB', gate: 'GA',
};

// ------------------------------------------------------------
// 3. Color helpers (canvas-side; all cached)
// ------------------------------------------------------------
const _colorCache = new Map();   // color string -> [r,g,b,a] | null
const _alphaCache = new Map();   // `${color}|${a}` -> 'rgba(...)'

// Parse '#rgb', '#rgba', '#rrggbb', '#rrggbbaa', 'rgb(r,g,b)', 'rgba(r,g,b,a)'
// (commas or spaces, optional '/' alpha, percent alpha) and '--token' names.
// Returns [r, g, b, a] with channels 0..255 and alpha 0..1, or null.
function parseColor(color) {
  if (Array.isArray(color)) return color;
  if (typeof color !== 'string') return null;
  if (_colorCache.has(color)) return _colorCache.get(color);
  let s = color.trim(), out = null;
  if (s.startsWith('--')) s = PAL.resolve(s);
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      out = [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16),
        h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1];
    } else if (h.length === 6 || h.length === 8) {
      out = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    if (out && out.some(n => Number.isNaN(n))) out = null;
  } else {
    const m = /^rgba?\(\s*([\d.]+)%?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?(?:[\s,/]+([\d.]+)(%?))?\s*\)$/i.exec(s);
    if (m) {
      let a = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (m[5] === '%') a /= 100;
      out = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), Math.max(0, Math.min(1, a))];
    }
  }
  _colorCache.set(color, out);
  return out;
}

function _hex2(n) { const v = Math.max(0, Math.min(255, Math.round(n))); return (v < 16 ? '0' : '') + v.toString(16).toUpperCase(); }
function toHex(r, g, b) { return '#' + _hex2(r) + _hex2(g) + _hex2(b); }
function _rgbaStr(r, g, b, a) {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.round(a * 1000) / 1000})`;
}

// withAlpha('#8FD3E8', .3) -> 'rgba(143,211,232,0.3)'. The alpha REPLACES the
// color's own alpha. Unparsable input is returned unchanged.
function withAlpha(color, a) {
  const key = color + '|' + a;
  const hit = _alphaCache.get(key);
  if (hit !== undefined) return hit;
  const c = parseColor(color);
  const out = c ? _rgbaStr(c[0], c[1], c[2], Math.max(0, Math.min(1, a))) : color;
  _alphaCache.set(key, out);
  return out;
}

// Linear per-channel mix: k = 0 -> colorA, k = 1 -> colorB. Returns hex when both
// inputs are opaque, otherwise an rgba() string.
function mix(colorA, colorB, k) {
  const a = parseColor(colorA), b = parseColor(colorB);
  if (!a) return colorB; if (!b) return colorA;
  k = Math.max(0, Math.min(1, k));
  const r = a[0] + (b[0] - a[0]) * k, g = a[1] + (b[1] - a[1]) * k, bl = a[2] + (b[2] - a[2]) * k;
  const al = a[3] + (b[3] - a[3]) * k;
  return al >= 0.999 ? toHex(r, g, bl) : _rgbaStr(r, g, bl, al);
}

// Gamma-space weighted luma 0..255 (.2126R + .7152G + .0722B on raw channels).
// This is the grey desat() mixes toward (section 2.2).
function luma(color) {
  const c = parseColor(color);
  return c ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : 0;
}

// WCAG relative luminance 0..1 (sRGB linearised). Matches the family figures in
// section 13 (gold .78, ivory .84, ice .58, sage .52, amber .44, rose .38).
function luminance(color) {
  const c = parseColor(color);
  if (!c) return 0;
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

// WCAG contrast ratio between two colors (alpha ignored).
function contrast(colorA, colorB) {
  const la = luminance(colorA), lb = luminance(colorB);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// desat(hex, k): mix each channel toward the color's own luma grey by k.
// Company colors use k = .15. Always returns '#RRGGBB'.
function desat(hex, k) {
  const c = parseColor(hex);
  if (!c) return hex;
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return toHex(c[0] + (L - c[0]) * k, c[1] + (L - c[1]) * k, c[2] + (L - c[2]) * k);
}

// Company livery colors, computed once from COMPANIES (data.js).
const COMPANY_COLOR = {};
if (typeof COMPANIES !== 'undefined' && Array.isArray(COMPANIES)) {
  for (const co of COMPANIES) COMPANY_COLOR[co.id] = desat(co.color, 0.15);
}

// ------------------------------------------------------------
// 4. Station registry (section 6.2): 32-bit FNV-1a of the station name
//    over its UTF-16 code units, exact string (no trim, no case fold).
// ------------------------------------------------------------
function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function registryNumber(name) { return 1000 + (fnv1a32(name) % 9000); }
function registryOf(name) { return 'WS-' + registryNumber(name); }

// ------------------------------------------------------------
// 5. Icon library (section 6.0). 24x24 viewBox, 1.5-unit strokes, round
//    joins/caps, 2 units of padding (content within 2..22). Each module
//    icon rhymes with that module's canvas silhouette in section 8.1.
//    Multiple subpaths live in one d string. `fill: true` marks solid icons.
// ------------------------------------------------------------
const ICONS = {
  // ---- modules (24) ----
  // hexagon plate, inner ring, lamp core
  hub:         { d: 'M12 2.5 20.23 7.25v9.5L12 21.5l-8.23-4.75v-9.5Z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M12 11.75v.5' },
  // U collar open east, clamp pads at the arm tips, one LED
  dock:        { d: 'M16.5 4.5H8a3.5 3.5 0 0 0-3.5 3.5v8A3.5 3.5 0 0 0 8 19.5h8.5 M17 2.5v4 M17 17.5v4 M11.5 11.75v.5' },
  // 3x3 crate grid
  warehouse:   { d: 'M4 4h16v16H4Z M9.33 4v16 M14.67 4v16 M4 9.33h16 M4 14.67h16' },
  // two panel wings on a spine, junction box
  solar:       { d: 'M12 2.5v19 M3 6.5h7v11H3Z M14 6.5h7v11h-7Z M3 12h7 M14 12h7 M10.5 10.5h3v3h-3Z' },
  // twin cylinders with a band
  fuel:        { d: 'M4.5 20V7.5a3 3 0 0 1 6 0V20Z M13.5 20V7.5a3 3 0 0 1 6 0V20Z M4.5 15h6 M13.5 15h6' },
  // rounded bay, two rows of bunk slits
  quarters:    { d: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z M5.5 10h3 M10.5 10h3 M15.5 10h3 M5.5 14h3 M10.5 14h3 M15.5 14h3' },
  // round table with seat ticks, service counter along the bottom
  cantina:     { d: 'M17 10a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z M4.5 10h2 M17.5 10h2 M12 2.5v2.5 M4 20h16' },
  // dish disc on a mast, two arcs in front (also the UI 'comms' id)
  comms:       { d: 'M14 11a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M10 15v6 M7 21h6 M14 5.27A7 7 0 0 1 16.97 10.39 M15.45 3.22A9.5 9.5 0 0 1 19.46 10.17' },
  // balance beam on a post with two pans
  market:      { d: 'M4 7h16 M12 7v12 M8 19h8 M6 7v3.5 M18 7v3.5 M3 10.5a3 3 0 0 0 6 0Z M15 10.5a3 3 0 0 0 6 0Z' },
  // ring court, centre dot, four corner lamp posts
  rec:         { d: 'M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M12 11.75v.5 M4 3.75v.5 M20 3.75v.5 M4 19.75v.5 M20 19.75v.5' },
  // half-ellipse dome over crop rows
  hydro:       { d: 'M3 14a9 9 0 0 1 18 0Z M5 17.5h14 M7 20.5h10' },
  // rounded bay with a cross
  clinic:      { d: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M12 8v8 M8 12h8' },
  // ring of homes around a courtyard, antenna on top
  habitat:     { d: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z M9 10h6v6H9Z M12 5V2.5' },
  // torus with core and two orbit arcs
  reactor:     { d: 'M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z M14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z M7.24 9.25A5.5 5.5 0 0 1 16.76 9.25 M16.76 14.75A5.5 5.5 0 0 1 7.24 14.75' },
  // checkpoint box, gate bar across the lane, lane line
  customs:     { d: 'M3 9h7v7H3Z M10 12.5h11 M3 20h18' },
  // shield chevron with turret stubs at the shoulders
  security:    { d: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6Z M19 6.5h2.5 M2.5 6.5H5' },
  // lecture bowl open to the top, one tier, lectern dot
  school:      { d: 'M3 9.5a9 9 0 0 0 18 0Z M6.5 9.5a5.5 5.5 0 0 0 11 0 M12 9.25v.5' },
  // four columns under a lintel, vault circle below
  bank:        { d: 'M3 6h18 M5 6v7 M9.67 6v7 M14.33 6v7 M19 6v7 M3 13h18 M15 17.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z' },
  // cross-shaped concourse with four corner stalls
  plaza:       { d: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z M5.5 5.25v.5 M18.5 5.25v.5 M5.5 18.25v.5 M18.5 18.25v.5' },
  // dome grid over a band, two-hump creature below
  menagerie:   { d: 'M3 13a9 9 0 0 1 18 0Z M9 4.5V13 M15 4.5V13 M6 20.5c1.5-4 3.5-4 5 0c1.5-4 3.5-4 5 0' },
  // three stacks over a hopper
  refinery:    { d: 'M3 14h18v2.5L18 20H6l-3-3.5Z M5 14V4.5h3V14 M10.5 14V7h3v7 M16 14V4.5h3V14' },
  // gantry frame around a hull outline, crane hook on the beam
  shipyard:    { d: 'M3 5h18 M4.5 5v15.5 M19.5 5v15.5 M12 5v3 M7 10.5h7l3.5 2.5L14 15.5H7Z' },
  // half-dome with telescope through the slit, on a base
  observatory: { d: 'M3.5 13a8.5 8.5 0 0 1 17 0Z M12 13l7.5-7.5 M6.5 13v7.5 M17.5 13v7.5 M4 20.5h16' },
  // two rings, chevron at the top, lens core
  gate:        { d: 'M19.5 14a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z M16.25 14a4.25 4.25 0 1 1-8.5 0 4.25 4.25 0 0 1 8.5 0Z M9.5 5 12 2.5l2.5 2.5 M12 13.75v.5' },

  // ---- goods (12) ----
  ore:         { d: 'M4.5 14.5 8 7l6-2 5.5 5-1.5 7.5-6.5 2.5-4.5-3.5Z M8 7l4.5 6.5-1 6.5' },
  alloy:       { d: 'M3 17.5 6.5 9h11l3.5 8.5Z M8.5 12.5h7' },
  crystals:    { d: 'M12 2.5 15.5 8.5V21h-7V8.5Z M12 2.5V21 M4.5 21v-6.5L7 11l1.5 2.5' },
  water:       { d: 'M12 2.5c3.5 5 6.5 9 6.5 12.5a6.5 6.5 0 0 1-13 0C5.5 11.5 8.5 7.5 12 2.5Z M9 15a3 3 0 0 0 3 3' },
  grain:       { d: 'M12 21V9 M12 9C9 9 7 7 7 4c3 0 5 2 5 5Z M12 9c3 0 5-2 5-5-3 0-5 2-5 5Z M12 14.5C9 14.5 7 12.5 7 9.5c3 0 5 2 5 5Z M12 14.5c3 0 5-2 5-5-3 0-5 2-5 5Z' },
  fruit:       { d: 'M18.5 14a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z M12 7.5c0-2.5 2-4.5 5-4.5 0 2.5-2 4.5-5 4.5Z' },
  spice:       { d: 'M5 20C4.5 13.5 9 8 16 6.5c1.5 6-3.5 12-11 13.5Z M16 6.5c1-1.5 2.5-2.5 4-3' },
  livestock:   { d: 'M8 7h8a3 3 0 0 1 3 3v6a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-6a3 3 0 0 1 3-3Z M7.5 7.5C5.5 7 4 5.5 3.5 3.5 M16.5 7.5c2-.5 3.5-2 4-4 M9.25 17h.5 M14.25 17h.5' },
  xenofauna:   { d: 'M4.5 14.5a7.5 7.5 0 0 1 15 0V18h-15Z M7.5 18v3 M12 18v3 M16.5 18v3 M9.5 11.75v.5 M14.5 11.75v.5' },
  textiles:    { d: 'M5.5 4.5h13v2.5h-13Z M5.5 17h13v2.5h-13Z M7.5 7v10 M16.5 7v10 M7.5 10.5h9 M7.5 13.5h9' },
  tech:        { d: 'M6.5 6.5h11v11h-11Z M10 10h4v4h-4Z M9.5 6.5V3 M14.5 6.5V3 M9.5 21v-3.5 M14.5 21v-3.5 M6.5 9.5H3 M6.5 14.5H3 M21 9.5h-3.5 M21 14.5h-3.5' },
  medicine:    { d: 'M5 14 14 5a3.5 3.5 0 0 1 5 5l-9 9a3.5 3.5 0 0 1-5-5Z M9.5 9.5l5 5' },

  // ---- UI ----
  save:        { d: 'M4.5 4.5h12l3 3v12h-15Z M8 4.5v5h7v-5 M8 19.5v-5h8v5' },
  'new':       { d: 'M12 4v16 M4 12h16' },
  pause:       { d: 'M8 5v14 M16 5v14' },
  lock:        { d: 'M5.5 10.5h13v10h-13Z M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5 M12 14.5v2.5' },
  // 'comms' is shared with the module icon above (same id in one library)
  dish:        { d: 'M3.5 8.5A8.5 8.5 0 0 0 15.5 20.5Z M9.5 14.5 14.5 9.5 M11.67 6.67A4 4 0 0 1 17.33 6.67 M9.55 4.55A7 7 0 0 1 19.45 4.55' },
  ship:        { d: 'M3 12 20.5 4.5l-4 7.5 4 7.5Z M3 12h13.5' },
  berth:       { d: 'M8.5 4.5h-4v15h4 M15.5 4.5h4v15h-4 M9.5 12 14.5 9.5l-1.2 2.5 1.2 2.5Z' },
  power:       { d: 'M13 2.5 5.5 13.5H12l-1 8 7.5-11H13Z' },
  credits:     { d: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z M15 9.5a3.5 3.5 0 1 0 0 5' },
  people:      { d: 'M12.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z M3 20.5v-1a5.5 5.5 0 0 1 5.5-5.5h1a5.5 5.5 0 0 1 5.5 5.5v1 M15 4.25a3.5 3.5 0 0 1 0 6.5 M17.5 14.25a5.5 5.5 0 0 1 3.5 5.25v1' },
  rep:         { d: 'M12 3 14.47 9.1 21.03 9.56 15.99 13.8 17.58 20.19 12 16.7 6.42 20.19 8.01 13.8 2.97 9.56 9.53 9.1Z' },
  'trend-up':   { d: 'M12 6 19 17H5Z', fill: true },
  'trend-down': { d: 'M12 18 5 7h14Z', fill: true },
  'trend-flat': { d: 'M5 10.5h14v3H5Z', fill: true },
  check:       { d: 'M4.5 12.5 9.5 17.5 19.5 7' },
  warn:        { d: 'M12 3.5 21 19.5H3Z M12 9.5v4.5 M12 16.25v.5' },
  bad:         { d: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z M9 9l6 6 M15 9l-6 6' },
  info:        { d: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z M12 11v5 M12 7.75v.5' },
  close:       { d: 'M6 6l12 12 M18 6 6 18' },
  reroll:      { d: 'M4 12a8 8 0 0 1 14-5.3L20 8.5 M20 3.5v5h-5 M20 12a8 8 0 0 1-14 5.3L4 15.5 M4 20.5v-5h5' },
  lend:        { d: 'M12.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z M15 12h6.5 M18.5 9l3 3-3 3' },
  scrap:       { d: 'M4.5 6.5h15 M8.5 6.5V4h7v2.5 M6.5 6.5l1 14h9l1-14 M10 10.5v6.5 M14 10.5v6.5' },
  dump:        { d: 'M3 6h11v13H3Z M3 10.5h11 M14 13h7.5 M18.5 10l3 3-3 3' },
  buy:         { d: 'M4 11h16v9.5H4Z M12 2.5V11 M8.5 7.5 12 11l3.5-3.5' },
  sell:        { d: 'M4 11h16v9.5H4Z M12 11V2.5 M8.5 6 12 2.5 15.5 6' },
};

// Id groups, for previews and for anyone iterating the library in order.
const ICON_GROUPS = {
  modules: ['hub', 'dock', 'warehouse', 'solar', 'fuel', 'quarters', 'cantina', 'comms', 'market', 'rec', 'hydro', 'clinic',
    'habitat', 'reactor', 'customs', 'security', 'school', 'bank', 'plaza', 'menagerie', 'refinery', 'shipyard', 'observatory', 'gate'],
  goods: ['ore', 'alloy', 'crystals', 'water', 'grain', 'fruit', 'spice', 'livestock', 'xenofauna', 'textiles', 'tech', 'medicine'],
  ui: ['save', 'new', 'pause', 'lock', 'comms', 'dish', 'ship', 'berth', 'power', 'credits', 'people', 'rep', 'trend-up', 'trend-down',
    'trend-flat', 'check', 'warn', 'bad', 'info', 'close', 'reroll', 'lend', 'scrap', 'dump', 'buy', 'sell'],
};

const ICON_MISSING = { d: 'M4 4h16v16H4Z' };   // hollow square: nothing ever renders empty

const Icons = {
  _paths: new Map(),

  get(id) { return ICONS[id] || ICON_MISSING; },
  has(id) { return Object.prototype.hasOwnProperty.call(ICONS, id); },

  // Inline SVG string. Stroke icons: currentColor stroke 1.5, round caps/joins.
  // Filled icons: currentColor fill, no stroke. Unknown ids draw a hollow square.
  svg(id, size = 16, className = '') {
    const ic = this.get(id);
    const cls = className ? 'ic ' + className : 'ic';
    const s = Number(size) || 16;
    const paint = ic.fill
      ? 'fill="currentColor" stroke="none"'
      : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" class="${cls}" aria-hidden="true"><path d="${ic.d}" ${paint}/></svg>`;
  },

  // Cached Path2D in the 24x24 space. Draw with:
  //   ctx.save(); ctx.translate(x, y); ctx.scale(size/24, size/24); ctx.lineWidth = 1.5; ctx.stroke(Icons.path(id)); ctx.restore();
  path(id) {
    const key = this.has(id) ? id : '__missing';
    let p = this._paths.get(key);
    if (!p) {
      if (typeof Path2D === 'undefined') return null;
      p = new Path2D(this.get(id).d);
      this._paths.set(key, p);
    }
    return p;
  },

  // True when the icon should be filled rather than stroked.
  filled(id) { return !!this.get(id).fill; },

  // Convenience for canvas: draws the icon at (x, y) top-left, `size` CSS px, in `color`.
  draw(ctx, id, x, y, size, color) {
    const p = this.path(id);
    if (!p) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    if (this.filled(id)) { ctx.fillStyle = color; ctx.fill(p); }
    else { ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(p); }
    ctx.restore();
  },
};

// ------------------------------------------------------------
// 6. Module art registry (section 8.0). art-mod-a.js / art-mod-b.js fill
//    ART[id] = { tellClass: 'A'|'B', silhouette(g,u,st), lit(g,u,st), tell(g,u,t,st) }.
// ------------------------------------------------------------
const ART = {};

// ------------------------------------------------------------
// 7. ArtKit: shared drawing helpers for the 100x100 unit space.
//    Path builders (rrect, poly, circle, ring, line, hatch, arc, sq, dot)
//    begin a new path and leave it current; fill()/stroke() paint it.
// ------------------------------------------------------------
const ArtKit = {
  TAU: Math.PI * 2,

  lerp(a, b, k) { return a + (b - a) * k; },
  clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; },

  // Rounded rectangle path (radius clamped to half the shorter side).
  rrect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    g.beginPath();
    if (r === 0) { g.rect(x, y, w, h); return; }
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r);
    g.closePath();
  },

  // Closed polygon. Accepts [[x,y],[x,y],...] or a flat [x0,y0,x1,y1,...].
  poly(g, points) {
    g.beginPath();
    if (!points || !points.length) return;
    if (Array.isArray(points[0])) {
      g.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) g.lineTo(points[i][0], points[i][1]);
    } else {
      g.moveTo(points[0], points[1]);
      for (let i = 2; i + 1 < points.length; i += 2) g.lineTo(points[i], points[i + 1]);
    }
    g.closePath();
  },

  circle(g, x, y, r) {
    g.beginPath();
    g.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  },

  // Annulus path centred on radius r with the given width; fill() paints a ring.
  // (Outer circle clockwise, inner anticlockwise, so nonzero fill leaves the hole.)
  ring(g, x, y, r, width) {
    const ro = r + width / 2, ri = Math.max(0, r - width / 2);
    g.beginPath();
    g.arc(x, y, ro, 0, Math.PI * 2, false);
    if (ri > 0) g.arc(x, y, ri, 0, Math.PI * 2, true);
    g.closePath();
  },

  // Open arc path from angle a0 to a1 (radians, clockwise on screen).
  arc(g, x, y, r, a0, a1, anticlockwise) {
    g.beginPath();
    g.arc(x, y, Math.max(0, r), a0, a1, !!anticlockwise);
  },

  line(g, x1, y1, x2, y2) {
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
  },

  // Square of side s centred at (x, y) (lamp windows are 4u squares).
  sq(g, x, y, s) {
    g.beginPath();
    g.rect(x - s / 2, y - s / 2, s, s);
  },

  // Dot of radius r (lamp dots are r = 2u).
  dot(g, x, y, r) {
    g.beginPath();
    g.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  },

  // Hatch lines clipped to the rect (x, y, w, h), `pitch` apart, at angleDeg
  // (45 = rising diagonal). Builds a path of segments; stroke() paints it.
  // Pure geometry: no ctx.clip(), so it is safe inside baked sprites.
  hatch(g, x, y, w, h, pitch, angleDeg) {
    const a = ((angleDeg === undefined ? 45 : angleDeg) * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const nx = -dy, ny = dx;
    pitch = Math.max(0.5, pitch || 3);
    const cs = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
    let dmin = Infinity, dmax = -Infinity;
    for (const [cx, cy] of cs) { const d = cx * nx + cy * ny; if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
    g.beginPath();
    const x1 = x + w, y1 = y + h, eps = 1e-9;
    for (let d = Math.ceil(dmin / pitch) * pitch; d <= dmax; d += pitch) {
      const px = nx * d, py = ny * d;
      let t0 = -Infinity, t1 = Infinity;
      if (Math.abs(dx) > eps) {
        let ta = (x - px) / dx, tb = (x1 - px) / dx;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      } else if (px < x || px > x1) continue;
      if (Math.abs(dy) > eps) {
        let ta = (y - py) / dy, tb = (y1 - py) / dy;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      } else if (py < y || py > y1) continue;
      if (t0 < t1 && Number.isFinite(t0) && Number.isFinite(t1)) {
        g.moveTo(px + dx * t0, py + dy * t0);
        g.lineTo(px + dx * t1, py + dy * t1);
      }
    }
  },

  // Paint the current path.
  stroke(g, color, width) {
    if (color !== undefined) g.strokeStyle = color;
    if (width !== undefined) g.lineWidth = width;
    g.stroke();
  },
  fill(g, color) {
    if (color !== undefined) g.fillStyle = color;
    g.fill();
  },

  // Deterministic 0..1 from up to three integers (non-integers are floored).
  hash01(a, b, c) {
    let h = (Math.floor(a || 0) * 73856093) ^ (Math.floor(b || 0) * 19349663) ^ (Math.floor(c || 0) * 83492791);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  },

  // Return `units` grown so that units * u * dpr >= minDevicePx
  // (u = CSS px per unit = cell/100). Keeps lamps/LEDs >= 2 device px.
  clampPx(units, u, minDevicePx) {
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    if (!u || u <= 0) return units;
    const minUnits = (minDevicePx / dpr) / u;
    return units < minUnits ? minUnits : units;
  },

  // Eases (t in 0..1)
  easeOutCubic(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return 1 - Math.pow(1 - t, 3); },
  easeInOutSine(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return -(Math.cos(Math.PI * t) - 1) / 2; },
  easeOutBack(t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeInCubic(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * t; },

  // 0..1 sawtooth and 0..1 sine of a period, for tells: phase(t, 2.5) etc.
  phase(t, period) { const p = (t / period) % 1; return p < 0 ? p + 1 : p; },
  wave(t, period) { return 0.5 + 0.5 * Math.sin((t / period) * Math.PI * 2); },
};

// ------------------------------------------------------------
// 8. Install: load the palette now (fallbacks or live tokens), re-load on
//    document.fonts.ready and whenever body[data-level] changes. Guarded so
//    art.js also loads in a page without a body yet, and under Node.
// ------------------------------------------------------------
(function installPalette() {
  if (typeof document === 'undefined') return;
  PAL.load();
  const observe = () => {
    if (!document.body || typeof MutationObserver === 'undefined') return false;
    try {
      const mo = new MutationObserver(() => PAL.load());
      mo.observe(document.body, { attributes: true, attributeFilter: ['data-level'] });
    } catch (e) { /* observer unavailable: live tokens are still read on fonts.ready */ }
    return true;
  };
  if (!observe()) {
    document.addEventListener('DOMContentLoaded', () => { PAL.load(); observe(); }, { once: true });
  }
  try {
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(() => PAL.load()).catch(() => {});
    }
  } catch (e) { /* no FontFaceSet */ }
})();

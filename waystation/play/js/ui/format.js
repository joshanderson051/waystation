// ============================================================
// WAYSTATION v2 — ui/format.js
// Engineer H. Source of truth: DESIGN2.md 2.3 (type roles), 2.6 (counters),
// DESIGN.md 6.0 (icon library), 6.2 (tickers).
//
// Shared helpers for every ui/* file: DOM shortcuts, escaping, typographic
// glyphs, number and time formatting, the v2 UI icon additions (registered
// into the art.js ICONS library at load so Icons.svg stays the only icon
// renderer), and Counter: tweened numeric readouts in one shared rAF loop.
//
// Exports (globals): $, $$, esc, GLYPH, UI_ICONS, icon, Fmt, Counter, Motion
// ============================================================
'use strict';

// ------------------------------------------------------------
// 1. DOM shortcuts and escaping
// ------------------------------------------------------------
const $ = sel => document.querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = str => String(str == null ? '' : str).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// Plain glyphs the three faces carry (never emoji)
const GLYPH = { mid: '·', up: '▲', down: '▼', sq: '■', minus: '−', times: '×', arrow: '→', half: '½' };

// ------------------------------------------------------------
// 2. Icons: v2 additions in the art.js grammar (24x24, 1.5 stroke, round
//    joins, content within 2..22). Registered into ICONS when the library
//    is present so Icons.svg / Icons.path render them; `icon()` falls back
//    to an equivalent inline renderer when art.js is absent (harness).
// ------------------------------------------------------------
const UI_ICONS = {
  // premium currency: two crossed orbits around a core
  am:          { d: 'M4.21 16.5A9 3.5 -30 1 0 19.79 7.5A9 3.5 -30 1 0 4.21 16.5Z M4.21 7.5A9 3.5 30 1 0 19.79 16.5A9 3.5 30 1 0 4.21 7.5Z M13.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z' },
  // command rail
  build:       { d: 'M4 4h16v16H4Z M12 8.5v7 M8.5 12h7' },
  station:     { d: 'M12 2.5 20.23 7.25v9.5L12 21.5l-8.23-4.75v-9.5Z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M12 11.75v.5' },
  fleet:       { d: 'M3 12 20.5 4.5l-4 7.5 4 7.5Z M3 12h13.5' },
  expeditions: { d: 'M12 2.5c3 2.5 4.5 6.5 4.5 10.5v3H7.5V13C7.5 9 9 5 12 2.5Z M7.5 13 4.5 16v3.5L8 17.5 M16.5 13l3 3v3.5L16 17.5 M10 19.5h4 M12 9.75v.5' },
  map:         { d: 'M7 17.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z M13.5 6.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z M20.5 14a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z M6.3 16.1l4.9-8.3 M13.4 7.4l4.5 5.4 M7 17.1l10.6-3.3' },
  missions:    { d: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z M8.5 12.5 11 15l4.5-5.5' },
  registry:    { d: 'M5 4.5h13a1.5 1.5 0 0 1 1.5 1.5v13.5H6.5A1.5 1.5 0 0 1 5 18Z M5 18a1.5 1.5 0 0 1 1.5-1.5h13 M9 8.5h6 M9 12h4' },
  store:       { d: 'M6 8.5h12l1 12H5Z M9 8.5V7a3 3 0 0 1 6 0v1.5' },
  settings:    { d: 'M4 7h16 M4 12h16 M4 17h16 M9 5v4 M15 10v4 M8 15v4' },
  // status bar and context bar
  bell:        { d: 'M6 17h12l-1.5-2.5V10a4.5 4.5 0 0 0-9 0v4.5Z M10 19.5a2 2 0 0 0 4 0 M12 3.5v2' },
  calendar:    { d: 'M4 6.5h16v14H4Z M4 10.5h16 M8 3.5v4 M16 3.5v4 M12 14.25v.5' },
  focus:       { d: 'M12 4v3 M12 17v3 M4 12h3 M17 12h3 M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z' },
  collect:     { d: 'M12 3.5v11 M8 10.5l4 4 4-4 M4 15v4.5h16V15' },
  upgrade:     { d: 'M6 13l6-6 6 6 M6 19l6-6 6 6' },
  skip:        { d: 'M4 6l8 6-8 6Z M13 6l8 6-8 6Z' },
  clock:       { d: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z M12 7.5V12l3 2' },
  chart:       { d: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z M12 6.5l2 3.5 3.5 2-3.5 2-2 3.5-2-3.5L6.5 12l3.5-2Z' },
  keys:        { d: 'M3 7h18v10H3Z M6 10.25v.5 M9.5 10.25v.5 M13 10.25v.5 M16.5 10.25v.5 M7 14h10' },
  export:      { d: 'M12 15V3.5 M8 7.5l4-4 4 4 M4 14v6.5h16V14' },
  import:      { d: 'M12 3.5V15 M8 11l4 4 4-4 M4 14v6.5h16V14' },
  planet:      { d: 'M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z M4.5 9.8C2.3 11.5 2.6 13.4 5.5 14.3 M19.5 9.8c2.2 1.7 1.9 3.6-1 4.5' },
  travel:      { d: 'M4 8h13l-3-3 M20 16H7l3 3' },
  species:     { d: 'M12 3.5c4.5 0 7.5 3.5 7.5 7.5 0 4.5-4 9.5-7.5 9.5S4.5 15.5 4.5 11c0-4 3-7.5 7.5-7.5Z M8.5 10.5c1.5-.5 2.5.5 2.5 1.5 M15.5 10.5c-1.5-.5-2.5.5-2.5 1.5' },
  artifact:    { d: 'M12 3.5 20.5 10 12 20.5 3.5 10Z M3.5 10h17 M8 10l4 10.5L16 10 M8 10l4-6.5 4 6.5' },
  'chevron-right': { d: 'M9 6l6 6-6 6' },
  xp:          { d: 'M12 20V6 M6 12l6-6 6 6' },
};
if (typeof ICONS !== 'undefined' && ICONS) {
  for (const k of Object.keys(UI_ICONS)) if (!Object.prototype.hasOwnProperty.call(ICONS, k)) ICONS[k] = UI_ICONS[k];
}

// Inline SVG icon through the library; the fallback mirrors Icons.svg exactly.
function icon(id, size = 16, cls = '') {
  if (typeof Icons !== 'undefined' && Icons && typeof Icons.svg === 'function') return Icons.svg(id, size, cls);
  const ic = UI_ICONS[id] || { d: 'M4 4h16v16H4Z' };
  const paint = ic.fill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><path d="${ic.d}" ${paint}/></svg>`;
}

// ------------------------------------------------------------
// 3. Fmt: numbers and time. Real time is wall-clock ms; game time is days.
// ------------------------------------------------------------
const Fmt = {
  n(v) { return Math.round(Number(v) || 0).toLocaleString('en-US'); },
  signed(v) { v = Number(v) || 0; return (v >= 0 ? '+' : GLYPH.minus) + Fmt.n(Math.abs(v)); },
  pct(v) { return Math.round((Number(v) || 0) * 100) + '%'; },
  pad2(n) { return String(n).padStart(2, '0'); },
  pad3(n) { return String(n).padStart(3, '0'); },
  day(n) { return 'Day ' + Fmt.pad3(n); },
  grid(r, c) { return `${r + 1}:${Fmt.pad2(c + 1)}`; },
  // countdown: 4:12 under an hour, 1h 05m under a day, 2d 3h beyond
  ms(ms) {
    ms = Math.max(0, Number(ms) || 0);
    const s = Math.round(ms / 1000);
    if (s < 3600) return `${Math.floor(s / 60)}:${Fmt.pad2(s % 60)}`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h < 24) return `${h}h ${Fmt.pad2(m)}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  },
  // "4 min", "1 h 10 min", "2 days": durations in copy
  dur(ms) {
    if (ms < 59500) return `${Math.round(ms / 1000)} s`;
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
    const d = Math.floor(h / 24); return `${d} day${d === 1 ? '' : 's'}`;
  },
  ago(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'moments'; if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.floor(m / 60); if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
    return `${Math.floor(h / 24)} days`;
  },
  // ms until the next local midnight (daily reward boundary, 4.8)
  toMidnight(now = Date.now()) { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime() - now; },
  cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; },
  aOrAn(name) { return (/^[aeiou]/i.test(name) ? 'an ' : 'a ') + name; },
  plural(n, w, ws) { return `${Fmt.n(n)} ${n === 1 ? w : (ws || w + 's')}`; },
};

// ------------------------------------------------------------
// 4. Motion: reduced-motion resolution (2.6, 8). Settings override > media.
// ------------------------------------------------------------
const Motion = {
  _mq: null, override: 'auto',   // 'auto' | 'reduced' | 'full'
  init() {
    try { this._mq = matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { this._mq = null; }
    const sync = () => this.apply();
    if (this._mq) { if (this._mq.addEventListener) this._mq.addEventListener('change', sync); else if (this._mq.addListener) this._mq.addListener(sync); }
    this.apply();
  },
  reduced() {
    if (this.override === 'reduced') return true;
    if (this.override === 'full') return false;
    return !!(this._mq && this._mq.matches);
  },
  setOverride(v) { this.override = v || 'auto'; this.apply(); },
  apply() {
    const b = document.body; if (!b) return;
    if (this.reduced()) b.setAttribute('data-motion', 'reduced'); else b.removeAttribute('data-motion');
  },
  // tween budget: 400ms normally, 120ms under reduced motion (2.6)
  dur(ms) { return this.reduced() ? Math.min(120, ms) : ms; },
};

// ------------------------------------------------------------
// 5. Counter: tweened readouts (2.6). One shared rAF loop, easeOutCubic,
//    400ms (120ms reduced). On change the element gets .lit for 600ms plus
//    .up / .down so CSS can flash amber or red (violet for AM via .am).
// ------------------------------------------------------------
const Counter = {
  _items: new Map(),   // el -> { cur, from, to, t0, dur, fmt, active }
  _raf: 0,
  boot: false,         // first value ticks up from 0 over 500ms while body[data-boot]

  set(el, value, fmtFn, o = {}) {
    if (!el) return;
    value = Number(value) || 0;
    const f = typeof fmtFn === 'function' ? fmtFn : Fmt.n;
    let it = this._items.get(el);
    if (!it) {
      it = { cur: value, from: value, to: value, t0: 0, dur: 0, fmt: f, active: false };
      this._items.set(el, it);
      if (this.boot && !Motion.reduced() && Math.abs(value) >= 1) {
        it.cur = it.from = 0; it.to = value; it.dur = 500; it.t0 = performance.now(); it.active = true;
        el.textContent = f(0); this._kick(); return;
      }
      el.textContent = f(value); return;
    }
    it.fmt = f;
    if (it.to === value) { if (!it.active) { const s = f(value); if (el.textContent !== s) el.textContent = s; } return; }
    const dir = value > it.to ? 'up' : 'down';
    it.from = it.cur; it.to = value;
    it.dur = o.ms != null ? o.ms : Motion.dur(400);
    if (!o.quiet) this.lit(el, dir);
    if (it.dur <= 0 || Math.abs(it.to - it.from) < 1) { it.cur = value; it.active = false; el.textContent = f(value); return; }
    it.t0 = performance.now(); it.active = true;
    this._kick();
  },

  // 600ms glow in the readout's hue; re-adding restarts the keyframes
  lit(el, dir) {
    if (!el) return;
    el.classList.remove('lit', 'up', 'down');
    void el.offsetWidth;
    el.classList.add('lit', dir === 'down' ? 'down' : 'up');
    clearTimeout(el._litT);
    el._litT = setTimeout(() => el.classList.remove('lit', 'up', 'down'), 600);
  },

  _kick() { if (!this._raf) this._raf = requestAnimationFrame(t => this._step(t)); },
  _step(now) {
    this._raf = 0;
    let live = 0;
    for (const [el, it] of this._items) {
      if (!it.active) continue;
      if (!el.isConnected) { it.active = false; continue; }
      const p = Math.min(1, (now - it.t0) / it.dur);
      const e = 1 - Math.pow(1 - p, 3);
      it.cur = it.from + (it.to - it.from) * e;
      if (p >= 1) { it.cur = it.to; it.active = false; } else live++;
      el.textContent = it.fmt(it.cur);
    }
    if (live) this._kick();
  },
};

// ============================================================
// WAYSTATION — DOM HUD: top rail, tabs, panels, tooltip, modal, toasts
// Engineer H2. Source of truth: DESIGN.md (sections 6, 11, 12, 14.2).
// Ids and class names follow the mini style guide at the top of
// css/style.css (Engineer H1). Classic script: globals, no modules.
//
// Exports (globals): $, $$, esc, Ticker, UI, LOG_CAT, TOAST_CHIP, NOTE_TEXT
// ============================================================
'use strict';

// ------------------------------------------------------------
// 1. Small helpers
// ------------------------------------------------------------
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const esc = str => String(str).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// Typographic constants (never emoji; these are plain glyphs the mono face carries)
const MID = '·';      // middle dot separator
const TRI_UP = '▲';   // good
const TRI_DN = '▼';   // bad
const SQ = '■';       // warn / neutral
const MINUS = '−';    // true minus for the tooltip PWR tag
const TIMES = '×';    // built count, boom multiplier
const ARROW = '→';    // "-> D44"
const HALF = '½';     // glut multiplier

const pad2 = n => String(n).padStart(2, '0');
const pad3 = n => String(n).padStart(3, '0');
const signed = n => (n >= 0 ? '+' : '') + fmt(n);                 // fmt(negative) already carries '-'
const gridTag = (r, c) => `${r + 1}:${pad2(c + 1)}`;              // same 1-based row:col as Render's PLOT readout
const aOrAn = name => (/^[aeiou]/i.test(name) ? 'an ' : 'a ') + name;
const capFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

// FNV-1a fallback so the registry line never reads WS-NaN if art.js is missing
function _fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const regOf = name => (typeof registryOf === 'function') ? registryOf(name) : 'WS-' + (1000 + (_fnv1a32(String(name || '')) % 9000));

// Inline SVG icon (6.0). Empty string when art.js is unavailable, never an emoji.
const icon = (id, size = 16, cls = '') =>
  (typeof Icons !== 'undefined' && Icons && typeof Icons.svg === 'function') ? Icons.svg(id, size, cls) : '';

// Module family (2.2) and the CSS hue each family / goods kind / company carries
const FAM_FALLBACK = {
  hub: 'hub', dock: 'ops', comms: 'ops', customs: 'ops', security: 'ops', shipyard: 'ops',
  solar: 'power', reactor: 'power', warehouse: 'trade', fuel: 'trade', market: 'trade', bank: 'trade', refinery: 'trade',
  quarters: 'life', cantina: 'life', hydro: 'life', clinic: 'life', habitat: 'life', school: 'life',
  rec: 'culture', plaza: 'culture', menagerie: 'culture', observatory: 'culture', gate: 'culture',
};
const FAM_HUE = { hub: 'var(--ivory)', ops: 'var(--ice)', power: 'var(--gold)', trade: 'var(--amber)', life: 'var(--sage)', culture: 'var(--rose)' };
const KIND_FALLBACK = { mineral: '#8C949F', crop: '--sage', animal: '--rose', made: '--amber' };

const famOf = id => (typeof FAMILY !== 'undefined' && FAMILY && FAMILY[id]) || FAM_FALLBACK[id] || 'hub';
const famHue = id => FAM_HUE[famOf(id)] || 'var(--amber)';
function kindHue(kind) {
  const k = (typeof KIND_COLOR !== 'undefined' && KIND_COLOR && KIND_COLOR[kind]) || KIND_FALLBACK[kind] || '--ink-2';
  return k.startsWith('--') ? `var(${k})` : k;
}
function coHue(id) {
  if (typeof COMPANY_COLOR !== 'undefined' && COMPANY_COLOR && COMPANY_COLOR[id]) return COMPANY_COLOR[id];
  const c = COMPANIES.find(x => x.id === id);
  return c ? c.color : 'var(--amber)';
}
const coDef = id => COMPANIES.find(x => x.id === id);

// localStorage (keys 14.2: ws.orders, ws.notes.v1, ws.evt; never the save key)
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
const lsDel = k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } };
const lsJSON = (k, dflt) => { try { const v = lsGet(k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } };

// DOM write guards: never touch the DOM when the value is unchanged
const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };
const setClass = (el, cls) => { if (el && el.className !== cls) el.className = cls; };
const _htmlCache = new WeakMap();
function setHTML(el, html) {
  if (!el) return false;
  if (_htmlCache.get(el) === html) return false;
  _htmlCache.set(el, html); el.innerHTML = html; return true;
}

// ------------------------------------------------------------
// 2. Ticker: every mono value animates old -> new over --dur-number with
//    easeOutCubic in ONE shared rAF loop (6.2 / 11). Snaps when the change is
//    under 1, under reduced motion, or when the duration token is 0.
//    Also owns the 600ms .flash-good / .flash-bad helper (14.2).
// ------------------------------------------------------------
const Ticker = {
  _items: new Map(),   // el -> { cur, from, to, t0, dur, fmt, active }
  _raf: 0,
  _dur: -1,
  boot: false,         // while true, an element's FIRST value ticks up from 0 over 500ms (11.1)
  reduced: false,      // set by main.js from matchMedia / body[data-motion]

  duration() {
    if (this._dur < 0) {
      let d = 400;
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-number').trim();
        if (v) d = v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000;
      } catch (e) { d = 400; }
      this._dur = Number.isFinite(d) && d >= 0 ? d : 400;
    }
    return this._dur;
  },
  invalidate() { this._dur = -1; },

  set(el, value, fmtFn, dur) {
    if (!el) return;
    value = Number(value) || 0;
    const f = typeof fmtFn === 'function' ? fmtFn : fmt;
    let it = this._items.get(el);
    if (!it) {
      it = { cur: value, from: value, to: value, t0: 0, dur: 0, fmt: f, active: false };
      this._items.set(el, it);
      if (this.boot && !this.reduced && Math.abs(value) >= 1) {
        it.cur = it.from = 0; it.to = value; it.dur = dur == null ? 500 : dur; it.t0 = performance.now(); it.active = true;
        el.textContent = f(0); this._kick(); return;
      }
      el.textContent = f(value); return;
    }
    it.fmt = f;
    if (it.to === value) { if (!it.active) setText(el, f(value)); return; }
    it.from = it.cur; it.to = value;
    it.dur = dur == null ? this.duration() : dur;
    const snap = this.reduced || it.dur <= 0 || Math.abs(it.to - it.from) < 1 || document.body.getAttribute('data-motion') === 'reduced';
    if (snap) { it.cur = value; it.active = false; setText(el, f(value)); return; }
    it.t0 = performance.now(); it.active = true;
    this._kick();
  },

  _kick() { if (!this._raf) this._raf = requestAnimationFrame(t => this._step(t)); },

  _step(now) {
    this._raf = 0;
    let live = 0;
    for (const [el, it] of this._items) {
      if (!it.active) continue;
      const p = Math.min(1, (now - it.t0) / it.dur);
      const e = 1 - Math.pow(1 - p, 3);                     // easeOutCubic
      it.cur = it.from + (it.to - it.from) * e;
      if (p >= 1) { it.cur = it.to; it.active = false; }
      else live++;
      el.textContent = it.fmt(it.cur);
    }
    if (live) this._kick();
  },

  // 600ms colour flash; re-adding the class restarts the keyframes
  flash(el, kind) {
    if (!el) return;
    const cls = kind === 'bad' ? 'flash-bad' : 'flash-good';
    el.classList.remove('flash-good', 'flash-bad');
    void el.offsetWidth;
    el.classList.add(cls);
    clearTimeout(el._flashT);
    el._flashT = setTimeout(() => el.classList.remove(cls), 600);
  },
};

// ------------------------------------------------------------
// 3. Derived labels: log category codes (6.6), toast chips (6.10),
//    first-open notes (12.3)
// ------------------------------------------------------------
// Category from the message's keywords and its cls. First match wins.
const LOG_CAT = [
  ['SEC', /pirate|raid|smuggl|security/i],
  ['BLD', /^built |^scrapped |reaches level|galactic hub|comes online|^build a|unlocked/i],
  ['PWR', /power|flare|solar|reactor|efficiency/i],
  ['RES', /resident|refugee|fever|move in|settle|festival|pleasant place/i],
  ['EVT', /contract|boom|glut|explorer|convoy|transmission|press/i],
  ['TRD', /ship|berth|dock|sold|bought|broker|office|cargo|divert|waiting|fuel|lent|loan|repay|default|debt|credits|trade/i],
];
function logCat(msg, cls) {
  for (const [code, re] of LOG_CAT) if (re.test(msg)) return code;
  return cls === 'bad' ? 'EVT' : 'TRD';
}

// Toast chip label from class and message
const TOAST_CHIP = [
  ['SAVE', /saved/i],
  ['BUILD', /level \d|unlock|more credits for|cannot be removed|cut modules off|using this berth|occupied|touch the station|not enough credits|nothing there/i],
  ['ALERT', /pirate|raid|fever|debt|default|gave up/i],
  ['TRADE', /office|paid|loan|lend|lent|credits|sold|broker|bank|contract|minimum loan/i],
];
function toastChip(msg, cls) {
  for (const [label, re] of TOAST_CHIP) if (re.test(msg)) return label;
  if (cls === 'bad') return 'ALERT';
  if (cls === 'gold') return 'EVENT';
  return 'EVENT';
}
const TOAST_HUE = { good: 'good', bad: 'bad', warn: 'warn', gold: 'amber', '': 'amber' };

// First-open panel notes (12.3); dismissal set lives in ws.notes.v1
const NOTE_TEXT = {
  build: 'Tiers unlock with module count and reputation. Costs are in credits; pips are power.',
  station: 'Quality of life above 55% brings residents when homes are free.',
  market: 'Turn Sell off for Raw Ore if you run a Refinery, and for Xenofauna if you run a Menagerie.',
  companies: 'Serve ships fast and trust grows. At 75 trust a company opens an office here.',
};
const PANEL_IDS = ['build', 'station', 'market', 'companies', 'log'];
const TIER_WORD = { good: 'OK', warn: 'Low', bad: 'Bad' };
const TIER_SHAPE = { good: 'up', warn: 'sq', bad: 'down' };
const thr = v => v > 0.75 ? 'good' : v > 0.4 ? 'warn' : 'bad';
const trustCls = t => t > 70 ? 'good' : t > 40 ? 'warn' : 'bad';

// ------------------------------------------------------------
// 4. UI
// ------------------------------------------------------------
const UI = {
  tab: 'build',
  started: false,
  notes: new Set(),                 // dismissed / seen panel notes
  sig: {},                          // per-panel signature strings
  fadeTier: 0, fadeAt: 0,           // newly unlocked tier whose cards fade in (12.4)
  alert: { kind: null, until: 0 },  // HUD-owned 6s alert after pirates / outbreak (0.6)
  cond: null,                       // current body[data-condition]
  logSeen: new WeakSet(), logPrimed: false,
  tt: { key: '', t0: 0, html: '', timer: 0 },
  ordersTimer: 0, ordersClosing: false,
  _modal: null,
  _perfVisible: false,
  _lastSpeed: 1,

  // ---------------------------------------------------------- init
  init() {
    this.notes = new Set(lsJSON('ws.notes.v1', []));
    this.fillIcons(document);
    this._perfVisible = /[?&]perf\b/.test(location.search) || lsGet('ws.perf') === '1';
    const perf = $('#perf-tag'); if (perf) perf.hidden = !this._perfVisible;

    // tabs: click + arrow keys (13), one delegated listener each
    const tabs = $('#tabs');
    tabs.addEventListener('click', e => { const b = e.target.closest('.tab[data-tab]'); if (b) this.setTab(b.dataset.tab); });
    tabs.addEventListener('keydown', e => this.tabKeys(e));
    try { new ResizeObserver(() => this.placeIndicator()).observe(tabs); } catch (e) { /* resize listener below covers it */ }

    // speed + save (#btn-new is wired by main.js: it owns the title-screen confirm flow, 12.1)
    $('#speed').addEventListener('click', e => { const b = e.target.closest('button[data-speed]'); if (b) this.setSpeed(+b.dataset.speed); });
    $('#btn-save').addEventListener('click', () => { if (!Sim.state) return; Sim.save(); this.toast('Game saved', 'good'); });

    // panel delegation, attached once per panel (14.2)
    $('#panel-build').addEventListener('click', e => this.onBuildClick(e));
    $('#panel-station').addEventListener('click', e => this.onStationClick(e));
    $('#panel-market').addEventListener('click', e => this.onMarketClick(e));
    $('#panel-companies').addEventListener('click', e => this.onCompaniesClick(e));
    $('#sidebar').addEventListener('click', e => { const b = e.target.closest('.note-close'); if (b) this.dismissNote(b.dataset.note); });

    // modal
    const modal = $('#modal');
    modal.addEventListener('click', e => { const b = e.target.closest('#modal-actions button'); if (b) this.modalAction(+b.dataset.i); });
    modal.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); this.modalAction(0); } });
    $('#level-banner').addEventListener('animationend', e => e.currentTarget.classList.remove('show'));
    window.addEventListener('resize', () => { this.placeIndicator(); if (this._modal) this.placeModal(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { Ticker.invalidate(); this.placeIndicator(); });

    // Sim events
    Sim.on('change', () => this.refresh());
    Sim.on('log', () => { if (this.tab === 'log' && this.started) this.renderLog(); });
    Sim.on('toast', d => this.toast(d.msg, d.cls));
    Sim.on('event', () => { if (this.started) this.showEvent(); });
    Sim.on('levelup', lvl => this.onLevelUp(lvl));

    this.placeIndicator();
  },

  // Called by main.js once the title screen hands over (commission or resume)
  start() {
    this.started = true;
    this.sig = {};
    this.logPrimed = false;
    this.alert = { kind: null, until: 0 };
    this.refresh();
    this.placeIndicator();
  },

  // New station: objectives and the first-transmission note come back (ws.orders, ws.evt). Notes stay dismissed.
  resetProgress() {
    lsDel('ws.orders'); lsDel('ws.evt');
    clearTimeout(this.ordersTimer); this.ordersTimer = 0; this.ordersClosing = false;
    const o = $('#orders'); if (o) o.classList.remove('out');
    this.logSeen = new WeakSet(); this.logPrimed = false;
    this.sig = {};
  },

  // Fill every <span class="ic-slot" data-icon="..."> with its SVG (top rail SAVE/NEW, modal dish, title ship/reroll)
  fillIcons(root) {
    root.querySelectorAll('.ic-slot[data-icon]').forEach(el => { if (!el.firstChild) el.innerHTML = icon(el.dataset.icon, 14); });
  },

  // ---------------------------------------------------------- tabs
  setTab(t) {
    if (!PANEL_IDS.includes(t)) return;
    const prev = this.tab;
    if (prev !== t) {
      // first-open notes persist until the player dismisses them (12.3: only dismissal is stored)
      this.tab = t;
      $$('#tabs .tab').forEach(b => {
        const on = b.dataset.tab === t;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      $$('.panel').forEach(p => p.classList.remove('active'));
      const panel = $(`#panel-${t}`);
      if (panel) { void panel.offsetWidth; panel.classList.add('active'); }   // re-adding .active replays the clip-path wipe
      this.placeIndicator();
    }
    this.refresh();
  },

  tabKeys(e) {
    const cur = e.target.closest('.tab[data-tab]'); if (!cur) return;
    const list = $$('#tabs .tab'); let i = list.indexOf(cur);
    if (e.key === 'ArrowRight') i = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = list.length - 1;
    else return;
    e.preventDefault();
    list[i].focus();
    this.setTab(list[i].dataset.tab);
  },

  // #tab-indicator is positioned ONLY through its CSS vars (--x px, --w unitless)
  placeIndicator() {
    const ind = $('#tab-indicator'), b = $('#tabs .tab.active');
    if (!ind || !b) return;
    ind.style.setProperty('--x', b.offsetLeft + 'px');
    ind.style.setProperty('--w', String(b.offsetWidth));
  },

  setSpeed(sp) {
    if (!Sim.state) return;
    Sim.state.speed = sp;
    if (sp > 0) this._lastSpeed = sp;
    $$('#speed button').forEach(b => {
      const on = +b.dataset.speed === sp;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  },
  togglePause() { if (Sim.state) this.setSpeed(Sim.state.speed ? 0 : (this._lastSpeed || 1)); },

  // ---------------------------------------------------------- refresh entry points
  // Full refresh: top rail + the open panel (on Sim 'change')
  refresh() {
    if (!Sim.state) return;
    this.refreshTop();
    this.renderPanel(this.tab);
  },
  // Cheap periodic refresh (~250ms from main.js): top rail, and the Station panel's live values
  tick() {
    if (!Sim.state) return;
    this.refreshTop();
    if (this.tab === 'station') this.renderPanel('station');
    if (this.tab === 'log' && !this.logPrimed) this.renderLog();
  },
  renderPanel(t) {
    const panel = $(`#panel-${t}`); if (!panel) return;
    const scroll = panel.scrollTop;
    let changed = false;
    if (t === 'build') changed = this.renderBuild();
    else if (t === 'station') changed = this.renderStation();
    else if (t === 'market') changed = this.renderMarket();
    else if (t === 'companies') changed = this.renderCompanies();
    else if (t === 'log') changed = this.renderLog();
    if (changed) panel.scrollTop = scroll;   // re-rendering must not yank the list back to the top
  },

  // ---------------------------------------------------------- top rail (6.2), status bar (6.11), overlays
  refreshTop() {
    const s = Sim.state; if (!s) return null;
    const T = Sim.totals();
    const reg = regOf(s.name);

    setText($('#station-name'), s.name);
    setText($('#registry'), reg);
    setText($('#s-day'), pad3(s.day));

    // CREDITS: hero number, --bad with a leading triangle when negative
    const cr = $('#s-credits');
    cr.classList.toggle('bad', s.credits < 0);
    Ticker.set(cr, s.credits, v => v < 0 ? `${TRI_DN} ${fmt(Math.abs(v))}` : fmt(v));

    // INCOME: 6px triangle + explicit sign
    const y = s.income.yesterday;
    setClass($('#s-income-delta'), 'tri ' + (y >= 0 ? 'up c-good' : 'down c-bad'));
    Ticker.set($('#s-income'), y, signed);

    // POWER: used / produced in ice; warn + square during a flare; bad + triangle when overdrawn
    const over = T.used > T.produced;
    const pw = $('#s-power');
    setClass(pw, 'num ' + (over ? 'c-bad' : T.flare ? 'c-warn' : 'c-ice'));
    const prefix = over ? `${TRI_DN} ` : T.flare ? `${SQ} ` : '';
    const produced = T.produced;
    Ticker.set(pw, T.used, v => `${prefix}${fmt(v)} / ${fmt(produced)}`);
    const chip = $('#power-chip'); if (chip && chip.hidden === !!T.flare) chip.hidden = !T.flare;
    setHTML($('#power-pips'), this.powerPips(T.used, T.produced));

    // VISITORS / RESIDENTS in sage
    const beds = T.beds, homes = T.homes;
    Ticker.set($('#s-visitors'), T.visitors, v => `${fmt(v)} / ${fmt(beds)}`);
    Ticker.set($('#s-residents'), s.residents, v => `${fmt(v)} / ${fmt(homes)}`);

    // REPUTATION: five pips, fractional pip filled from the bottom
    const stars = $('#stars');
    if (stars) {
      const pips = stars.children;
      for (let i = 0; i < pips.length; i++) {
        const frac = Math.max(0, Math.min(1, s.rep - i));
        pips[i].classList.toggle('full', frac >= 0.999);
        const inner = pips[i].firstElementChild;
        if (inner) { const h = Math.round(frac * 100) + '%'; if (inner.style.height !== h) inner.style.height = h; }
      }
      const title = `Reputation ${s.rep.toFixed(2)} / 5`;
      if (stars.title !== title) { stars.title = title; const blk = stars.closest('.stat'); if (blk) blk.title = title; }
    }

    // LEVEL chip
    const tierName = TIER_NAMES[s.level] || 'Galactic Hub';
    setText($('#s-level'), `L${s.level} ${MID} ${tierName}`);

    // sidebar footer: WS-1910 · DAY 041 · {name}
    setText($('#sidebar-foot'), `${reg} ${MID} Day ${pad3(s.day)} ${MID} ${s.name}`);

    // status bar
    const docked = s.ships.filter(sh => sh.state === 'docked').length, hold = s.ships.filter(sh => sh.state === 'queue').length;
    let q = `<span>Ships ${docked} docked ${MID} ${hold} hold ${MID} berths ${T.docks}</span>`;
    if (s.recentAway > 1.5) q += `<span class="chip warn" data-shape="sq">Diverting ${MID} build docks</span>`;
    setHTML($('#queue-info'), q);
    setText($('#hint'), this.hintFor(s, T));
    if (this._perfVisible && typeof Render.perf === 'function') {
      const p = Render.perf();
      setText($('#perf-tag'), `${p.ms.toFixed(1)} ms ${MID} T${p.tier} ${MID} ${Math.round(Render.cell)}px`);
    }

    // overlays
    this.refreshOrders(s, T);
    this.refreshCondition(s, T);
    return T;
  },

  // count = min(8, ceil(total/4)); used pips filled, spare hollow, overdraw hatched (6.2)
  powerPips(used, produced) {
    const total = Math.max(produced, used);
    if (total <= 0) return '';
    const count = Math.min(8, Math.ceil(total / 4)), unit = total / count;
    const prodPips = Math.round(produced / unit), usedPips = Math.round(used / unit);
    let h = '';
    for (let i = 0; i < count; i++) {
      const cls = i < Math.min(usedPips, prodPips) ? 'on' : i < usedPips ? 'over' : 'spare';
      h += `<i class="pip ${cls}"></i>`;
    }
    return h;
  },

  // Berth numbering (8.0): the hub's own collar is 01, docks number from 02 by built day, then r, then c
  berthNo(r, c) {
    const s = Sim.state;
    if (s.grid[r][c] && s.grid[r][c].id === 'hub') return '01';
    const docks = Sim.cells().filter(x => x.m.id === 'dock')
      .sort((a, b) => ((a.m.built || 0) - (b.m.built || 0)) || (a.r - b.r) || (a.c - b.c));
    const i = docks.findIndex(x => x.r === r && x.c === c);
    return pad2(i < 0 ? docks.length + 2 : i + 2);
  },

  // Sentence-case mapping of Sim.canPlace().why (12.2 / 10)
  reasonSentence(why, id) {
    const d = MODULES[id], s = Sim.state;
    if (why === 'Occupied') return 'Occupied: that cell already holds a module.';
    const m = /^Needs station level (\d+)/.exec(why || '');
    if (m) return `Locked: ${d.name} needs station level ${m[1]}.`;
    if (why === 'Not enough credits') return `Need ${fmt(d.cost - s.credits)} more credits for ${aOrAn(d.name)}.`;
    if (why === 'Must touch the station') return 'Not adjacent: modules must touch the station.';
    return why || '';
  },

  // 12.2 hint table, first match wins
  hintFor(s, T) {
    if (s.pending) return 'Incoming transmission. Read it to continue.';
    const pl = Render.placing;
    if (pl && MODULES[pl]) {
      const h = Render.hover;
      if (h) { const chk = Sim.canPlace(pl, h.r, h.c); if (!chk.ok) return this.reasonSentence(chk.why, pl); }
      return `Placing ${MODULES[pl].name}: click a bracketed cell. Right-click or Esc to stop.`;
    }
    if (T.efficiency < 1) return 'Power shortage: modules run slower. Build a Solar Array or a Fusion Reactor.';
    // blocked berths: Docking Bays only (the hub's collar is routinely built around; the Station panel still reports it)
    for (const { r, c, m } of Sim.cells()) {
      if (m.id === 'dock' && !Sim.dockUsable(r, c)) return `Berth ${this.berthNo(r, c)} is blocked: it has no empty side. Ships cannot pull up to it.`;
    }
    if (s.recentAway > 1.5) return 'Ships are diverting. Build another Docking Bay.';
    if (T.flare) return 'Solar flare: solar arrays are dark. Reactors are immune.';
    if (s.stats.shipsServed === 0) {
      const sh = s.ships.find(x => x.state === 'approach' && x.dock);
      if (sh) {
        const co = coDef(sh.company), pl2 = co ? PLANETS[co.home] : null;
        return `${SHIP_CLASSES[sh.cls].name} from ${pl2 ? pl2.name : 'afar'} on approach to Berth ${this.berthNo(sh.dock.r, sh.dock.c)}. It will dock, trade and refuel.`;
      }
    }
    if (s.stats.shipsServed < 5 && s.ships.some(x => x.state === 'queue')) return 'A ship is holding in orbit. Build another Docking Bay.';
    if (Render.selected) return 'Scrap returns half the build cost. The Core Hub cannot be removed.';
    return 'Pick a module in 01 BUILD, then click a bracketed cell. Click a module to inspect it.';
  },

  // 12.3 objective strip: derived from real state; hides 2s after the third fills; never again for that save
  refreshOrders(s, T) {
    const el = $('#orders'); if (!el) return;
    if (lsGet('ws.orders') === 'done') { if (!el.hidden) el.hidden = true; return; }
    const done = { dock: (T.counts.dock || 0) >= 1, solar: (T.counts.solar || 0) >= 1, serve: s.stats.shipsServed >= 3 };
    for (const item of el.querySelectorAll('.order[data-order]')) item.classList.toggle('done', !!done[item.dataset.order]);
    if (el.hidden && !this.ordersClosing) el.hidden = false;
    const all = done.dock && done.solar && done.serve;
    if (all && !this.ordersTimer) {
      this.ordersTimer = setTimeout(() => {
        this.ordersClosing = true; el.classList.add('out');
        setTimeout(() => { el.hidden = true; el.classList.remove('out'); lsSet('ws.orders', 'done'); this.ordersClosing = false; this.ordersTimer = 0; }, 300);
      }, 2000);
    } else if (!all && this.ordersTimer && !this.ordersClosing) { clearTimeout(this.ordersTimer); this.ordersTimer = 0; }
  },

  // 0.6 / 5.10 condition: alert (6s HUD timer) > flare > festival. Sets body[data-condition] and the banner text.
  conditionFor(s, T) {
    if (this.alert.kind && performance.now() < this.alert.until) {
      return { kind: 'alert', text: `Condition ${MID} ${this.alert.kind === 'pirates' ? 'Pirate raid' : 'Hold fever'}` };
    }
    if (T.flare) {
      const n = Math.max(1, Math.ceil(s.fx.flareUntil - s.day));
      return { kind: 'flare', text: `Condition ${MID} Solar flare ${MID} Solar arrays dark ${n} day${n === 1 ? '' : 's'}` };
    }
    if (s.day < s.fx.festivalUntil) {
      const n = Math.max(1, s.fx.festivalUntil - s.day);
      return { kind: 'festival', text: `Festival ${MID} Visitor spending ${TIMES}2 ${MID} ${n} day${n === 1 ? '' : 's'}` };
    }
    return null;
  },
  refreshCondition(s, T) {
    const c = this.conditionFor(s, T), kind = c ? c.kind : null;
    if (c) setText($('#condition'), c.text);              // text stays during the 240ms fade-out
    if (kind !== this.cond) {
      this.cond = kind;
      if (kind) document.body.setAttribute('data-condition', kind); else document.body.removeAttribute('data-condition');
    }
  },
  // called from showEvent once a pirates / outbreak transmission is resolved
  raiseAlert(kind) { this.alert = { kind, until: performance.now() + 6000 }; this.refreshTop(); },

  flash(sel, kind) { Ticker.flash(typeof sel === 'string' ? $(sel) : sel, kind); },

  // ---------------------------------------------------------- shared fragments
  // Shelf header (5.4): label rides the rule, mono micro-tag right. `tag` is HTML, `label` is escaped here.
  shelf(label, tag, o = {}) {
    const cls = ['shelf', o.first ? 'first' : '', o.cls || ''].filter(Boolean).join(' ');
    const tagHtml = tag == null ? '' : `<span class="shelf-tag${o.tagCls ? ' ' + o.tagCls : ''}">${tag}</span>`;
    return `<h3 class="${cls}" style="--i:${o.i || 0}"><span class="shelf-label">${esc(label)}</span>${tagHtml}</h3>`;
  },

  // First-open note under a panel's first header (12.3)
  noteHtml(panel) {
    if (!NOTE_TEXT[panel] || this.notes.has(panel)) return '';
    return `<div class="note"><p class="note-text">${esc(NOTE_TEXT[panel])}</p>` +
      `<button type="button" class="btn icon ghost note-close" data-note="${panel}" title="Dismiss">${icon('close', 14)}</button></div>`;
  },
  dismissNote(panel) {
    if (!panel) return;
    this.notes.add(panel); this.saveNotes();
    this.sig[panel] = '';
    this.renderPanel(this.tab);
  },
  saveNotes() { lsSet('ws.notes.v1', JSON.stringify([...this.notes])); },

  // Build card (6.1). Also used static in the Station panel (6.9).
  // o = { count, unlocked, poor, selected, fade (index or -1), static }
  cardHtml(id, o) {
    const d = MODULES[id], s = Sim.state, fam = famOf(id);
    const cls = ['card',
      o.static ? 'static' : '',
      o.selected ? 'selected' : '',
      o.unlocked === false ? 'locked' : '',
      (o.unlocked !== false && o.poor) ? 'poor' : '',
      o.fade >= 0 ? 'fade-in' : ''].filter(Boolean).join(' ');
    let style = '';
    if (o.fade >= 0) {
      // negative delay keeps a stagger continuous across re-renders inside the fade window
      const delay = Math.round(o.fade * 120 - (performance.now() - this.fadeAt));
      style = ` style="--i:${o.fade};animation-delay:${delay}ms"`;
    }
    const desc = o.selected ? 'Click a bracketed cell. Right-click or Esc to stop.' : d.desc;
    const tag = o.selected ? ` <span class="chip ivory">Placing</span>` : o.count ? ` <span class="tag">${TIMES}${o.count}</span>` : '';
    // power pips: |power| capped at 6 pips, the signed number appears when |power| > 6
    const ap = Math.abs(d.power), n = Math.min(6, ap);
    let pips = '';
    if (ap > 6) pips += `<span class="pnum">${d.power > 0 ? '+' : '-'}${ap}</span>`;
    pips += (d.power > 0 ? '<i class="pip"></i>' : '<i class="pip off"></i>').repeat(n);
    const need = (o.unlocked !== false && o.poor && !o.static) ? `<div class="need">Need ${fmt(d.cost - s.credits)}</div>` : '';
    return `<div class="${cls}" data-mod="${id}" data-fam="${fam}" title="${esc(d.desc)}"${style}>` +
      `<div class="plate">${icon(id, 20)}</div>` +
      `<div class="card-main"><div class="name">${esc(d.name)}${tag}</div><div class="desc">${esc(desc)}</div></div>` +
      `<div class="card-side"><div class="cost">${fmt(d.cost)}</div><div class="pips">${pips}</div>${need}</div>` +
      `</div>`;
  },

  // ---------------------------------------------------------- 01 BUILD
  renderBuild() {
    const s = Sim.state, T = Sim.totals(), placing = Render.placing;
    const fading = this.fadeTier && performance.now() - this.fadeAt < 1800 ? this.fadeTier : 0;
    if (!fading && this.fadeTier) this.fadeTier = 0;
    let html = '', i = 0, fadeIdx = 0;
    for (const tier of [1, 2, 3, 4]) {
      const ids = MODULE_ORDER.filter(id => MODULES[id].tier === tier);
      const unlocked = Sim.tierUnlocked(tier), th = LEVEL_THRESHOLDS.find(t => t.level === tier);
      const builtKinds = ids.filter(id => T.counts[id]).length;
      const tag = unlocked
        ? `${builtKinds}/${ids.length} built`
        : `Locked ${MID} ${th.modules} modules ${MID} ${th.rep.toFixed(1)} rep`;
      const placingTier = placing && MODULES[placing] && MODULES[placing].tier === tier;
      html += this.shelf(`Tier ${tier} ${MID} ${TIER_NAMES[tier]}`, esc(tag), {
        first: tier === 1, i: i++,
        cls: 'tier-head' + (unlocked ? '' : ' locked') + (placingTier ? ' placing' : ''),
        tagCls: unlocked ? '' : 'warn',
      });
      if (tier === 1) html += this.noteHtml('build');
      for (const id of ids) {
        html += this.cardHtml(id, {
          count: T.counts[id] || 0, unlocked, poor: s.credits < MODULES[id].cost,
          selected: placing === id, fade: fading === tier ? fadeIdx++ : -1,
        });
      }
    }
    if (html === this.sig.build) return false;
    this.sig.build = html;
    $('#panel-build').innerHTML = html;
    return true;
  },

  onBuildClick(e) {
    if (e.target.closest('.note')) return;
    const card = e.target.closest('.card[data-mod]'); if (!card) return;
    const id = card.dataset.mod, d = MODULES[id]; if (!d) return;
    if (!Sim.tierUnlocked(d.tier)) { this.toast(`Reach station level ${d.tier} to unlock ${d.name}`, 'warn'); return; }
    if (Render.placing === id) Render.placing = null;
    else {
      Render.placing = id; Render.selected = null;
      // unaffordable cards still enter placing mode; the ghost carries the reason plate (6.1)
      if (Sim.state.credits < d.cost) this.toast(`Need ${fmt(d.cost - Sim.state.credits)} more credits for ${aOrAn(d.name)}`, 'warn');
    }
    this.refresh();
  },

  // ---------------------------------------------------------- 02 STATION
  renderStation() {
    const s = Sim.state, T = Sim.totals(), A = Sim.amenity(T);
    const pct = v => Math.round(v * 100);
    let i = 0;
    let h = this.shelf(s.name, esc(`L${s.level} ${MID} Day ${pad3(s.day)}`), { first: true, i: i++ });
    h += this.noteHtml('station');

    // QoL ring + word tag
    const q = pct(A.score), qc = thr(A.score);
    h += `<div class="qol"><div class="qol-ring" style="--p:${q};--c:var(--${qc})"><span class="qol-pct">${q}%</span></div>` +
      `<div class="qol-meta"><span class="label">Quality of life</span><span class="chip ${qc}" data-shape="${TIER_SHAPE[qc]}">${TIER_WORD[qc]}</span></div></div>`;
    // four QoL bars: 20 segments, threshold colour, percentage, word tag
    for (const [label, v] of [['Food', A.food], ['Beds for crews', A.beds], ['Entertainment', A.fun], ['Health care', A.health]]) {
      const c = thr(v);
      h += `<div class="qol-row ${c}"><span class="qol-lbl">${label}</span><span class="qol-bar" style="--n:${Math.round(v * 20)}"></span>` +
        `<span class="qol-val num">${pct(v)}%</span><span class="chip ${c}" data-shape="${TIER_SHAPE[c]}">${TIER_WORD[c]}</span></div>`;
    }
    h += `<div class="divider"></div>`;

    // kv telemetry in ice; lifetime earnings in amber
    const flareChip = T.flare ? `<span class="chip warn" data-shape="sq">Flare</span>` : '';
    h += `<div class="kv">` +
      `<span>Modules</span><span class="num">${T.modules}</span>` +
      `<span>Berths</span><span class="num">${T.docks}</span>` +
      `<span>Cargo storage</span><span class="num">${fmt(T.stockTotal)} / ${fmt(T.storage)}</span>` +
      `<span>Food served / day</span><span class="num">${T.food}</span>` +
      `<span>Visitor beds</span><span class="num">${T.beds}</span>` +
      `<span>Homes</span><span class="num">${s.residents} / ${T.homes}</span>` +
      `<span>Power</span><span class="num">${T.used} / ${T.produced}${flareChip}</span>` +
      `<span>Ships served</span><span class="num">${fmt(s.stats.shipsServed)}</span>` +
      `<span>Cargo traded</span><span class="num">${fmt(s.stats.cargoTraded)} units</span>` +
      `<span>Lifetime earnings</span><span class="num amber">${fmt(s.stats.earned)}</span>` +
      `</div>`;

    // yesterday's ledger: signed total on the shelf tag; today's running breakdown as kv
    const y = s.income.yesterday;
    h += this.shelf("Yesterday's ledger", esc(signed(y)), { i: i++, tagCls: 'ledger-total ' + (y >= 0 ? 'good' : 'bad') });
    const cats = Object.entries(s.income.breakdown).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    h += `<div class="kv"><span>Today so far</span><span class="num ink">${signed(s.income.today)}</span>`;
    for (const [cat, v] of cats) h += `<span>${esc(capFirst(cat))}</span><span class="num ${v >= 0 ? 'good' : 'bad'}">${signed(v)}</span>`;
    h += `</div>`;

    // selected module (6.9)
    const sel = Render.selected;
    const m = sel && s.grid[sel.r] && s.grid[sel.r][sel.c];
    if (m) {
      const d = MODULES[m.id], dem = Sim.canDemolish(sel.r, sel.c);
      h += this.shelf('Selected module', esc(`Grid ${gridTag(sel.r, sel.c)}`), { i: i++ });
      h += this.cardHtml(m.id, { static: true, count: 0 });
      // berth status for Docking Bays only: the hub's collar is routinely built around (see hintFor)
      if (d.docks && m.id !== 'hub') {
        h += Sim.dockUsable(sel.r, sel.c)
          ? `<p class="sel-status good">${TRI_UP} Berth ${this.berthNo(sel.r, sel.c)} clear</p>`
          : `<p class="sel-status bad">${TRI_DN} Berth ${this.berthNo(sel.r, sel.c)} blocked: no empty side for ships to pull up to</p>`;
        const ship = s.ships.find(sh => sh.dock && sh.dock.r === sel.r && sh.dock.c === sel.c && sh.state === 'docked');
        if (ship) {
          const co = coDef(ship.company);
          h += `<p class="sel-status">Docked: ${esc(ship.captain)}, ${esc(co ? co.name : ship.company)} ${MID} leaves in ${Math.max(0, ship.dockedUntil - Sim.now()).toFixed(1)} d</p>`;
        }
      }
      if (m.id === 'hub') h += `<p class="sel-status">The Core Hub cannot be removed.</p>`;
      else {
        h += `<div class="sel-actions"><button type="button" class="btn danger" data-act="scrap"${dem.ok ? '' : ` disabled title="${esc(dem.why)}"`}>Scrap for ${fmt(d.cost * 0.5)}</button>` +
          (dem.ok ? '' : `<span class="why">${esc(dem.why)}</span>`) + `</div>`;
      }
    } else {
      h += this.shelf('Selected module', null, { i: i++ });
      h += `<p class="idle">Click a module on the station to inspect or scrap it.</p>`;
    }

    if (h === this.sig.station) return false;
    this.sig.station = h;
    $('#panel-station').innerHTML = h;
    return true;
  },

  onStationClick(e) {
    const b = e.target.closest('[data-act="scrap"]'); if (!b || b.disabled) return;
    const sel = Render.selected; if (!sel) return;
    if (Sim.demolish(sel.r, sel.c)) { Render.selected = null; this.refresh(); }
  },

  // ---------------------------------------------------------- 03 MARKET
  renderMarket() {
    const s = Sim.state, T = Sim.totals();
    const buyPct = Math.round((0.65 - T.margin) * 100), sellPct = Math.round((1.05 + T.margin) * 100);
    let h = this.shelf('Trade exchange', esc(`Storage ${fmt(T.stockTotal)} / ${fmt(T.storage)}`), { first: true, i: 0 });
    h += this.noteHtml('market');
    h += `<p class="lead">Ships sell cargo into your warehouses at <span class="mono">${buyPct}%</span> of market price and buy what their home world needs at <span class="mono">${sellPct}%</span>. Hover a row to see which worlds want it.</p>`;
    const boom = s.fx.boom && s.day < s.fx.boom.until ? s.fx.boom : null;
    const glut = s.fx.glut && s.day < s.fx.glut.until ? s.fx.glut : null;
    if (boom || glut) {
      h += `<div class="chips">`;
      if (boom) h += `<span class="chip good" data-shape="up">Boom ${MID} ${esc(GOODS[boom.good].name)} ${TIMES}3 ${ARROW} D${boom.until}</span>`;
      if (glut) h += `<span class="chip warn" data-shape="sq">Glut ${MID} ${esc(GOODS[glut.good].name)} ${TIMES}${HALF} ${ARROW} D${glut.until}</span>`;
      h += `</div>`;
    }
    if (!T.hasMarket) h += `<div class="shelf-note warn"><i class="sq"></i>Needs exchange ${MID} policies locked</div>`;

    h += `<table class="market"><thead><tr><th class="kind"></th><th class="icon"></th><th>Good</th><th class="r stock">Stock</th><th class="r price">Price</th><th class="pol">Policy</th><th class="act"></th></tr></thead><tbody>`;
    for (const g of GOOD_IDS) {
      const G = GOODS[g], p = Sim.effPrice(g), pol = s.policy[g], stock = s.stock[g];
      const tr = p > G.base * 1.05 ? 'up c-good' : p < G.base * 0.95 ? 'down c-bad' : 'flat';
      const rowCls = boom && boom.good === g ? ' class="boom"' : glut && glut.good === g ? ' class="glut"' : '';
      const mult = boom && boom.good === g ? `<span class="mult">${TIMES}3</span>` : glut && glut.good === g ? `<span class="mult">${TIMES}${HALF}</span>` : '';
      const from = Object.values(PLANETS).filter(pl => pl.exports.includes(g)).map(pl => pl.name).join(', ');
      const to = Object.values(PLANETS).filter(pl => pl.imports.includes(g)).map(pl => pl.name).join(', ');
      const dis = T.hasMarket ? '' : ' disabled';
      h += `<tr${rowCls} title="From: ${esc(from)}&#10;Wanted by: ${esc(to || 'nobody nearby')}" style="--hue:${kindHue(G.kind)}">` +
        `<td class="kind"><i></i></td><td class="icon">${icon(g, 16)}</td><td class="gname">${esc(G.name)}</td>` +
        `<td class="stock num">${stock}</td>` +
        `<td class="price num"><span class="stk-s">${stock}</span><i class="tri ${tr}"></i><span class="prc">${p.toFixed(1)}</span>${mult}</td>` +
        `<td class="pol"><div class="seg small">` +
        `<button type="button" data-g="${g}" data-k="buy" class="${pol.buy ? 'on' : ''}"${dis} title="Buy ${esc(G.name)} from ships">Buy</button>` +
        `<button type="button" data-g="${g}" data-k="sell" class="${pol.sell ? 'on' : ''}"${dis} title="Sell ${esc(G.name)} to ships">Sell</button>` +
        `</div></td>` +
        `<td class="act"><button type="button" class="btn icon small danger dump" data-dump="${g}" title="Sell all to a passing broker at half price"${stock ? '' : ' disabled'}>${icon('dump', 14)}</button></td>` +
        `</tr>`;
    }
    h += `</tbody></table>`;

    if (h === this.sig.market) return false;
    this.sig.market = h;
    $('#panel-market').innerHTML = h;
    return true;
  },

  onMarketClick(e) {
    const pol = e.target.closest('button[data-g][data-k]');
    if (pol) { if (pol.disabled) return; const g = pol.dataset.g, k = pol.dataset.k; Sim.setPolicy(g, k, !Sim.state.policy[g][k]); return; }
    const dump = e.target.closest('button[data-dump]');
    if (dump && !dump.disabled) Sim.dumpStock(dump.dataset.dump);
  },

  // ---------------------------------------------------------- 04 COMPANIES
  renderCompanies() {
    const s = Sim.state, T = Sim.totals();
    const avg = Math.round(COMPANIES.reduce((a, c) => a + s.companies[c.id].trust, 0) / COMPANIES.length);
    let h = this.shelf('Shipping companies', esc(`Trust avg ${avg}`), { first: true, i: 0 });
    h += this.noteHtml('companies');
    const goodsRow = (label, ids) => `<div class="goods-row"><span class="lbl">${label}</span>` +
      ids.map(g => `<span style="color:${kindHue(GOODS[g].kind)}" title="${esc(GOODS[g].name)}">${icon(g, 14)}</span>`).join('') + `</div>`;
    for (const c of COMPANIES) {
      const co = s.companies[c.id], pl = PLANETS[c.home], locked = !!c.galactic && !T.galactic;
      let chips = '';
      if (co.office) chips += `<span class="chip good" data-shape="up">Office</span>`;
      if (s.day < co.contractUntil) chips += `<span class="chip ice" data-shape="sq">Contract ${ARROW} D${co.contractUntil}</span>`;
      if (locked) chips += `<span class="chip ink" data-shape="sq">Needs Jump Gate</span>`;
      if (co.loan) chips += `<span class="chip amber" data-shape="sq">Loan ${fmt(co.loan.remaining)} left ${MID} ${fmt(co.loan.perDay)}/day</span>`;
      const tc = trustCls(co.trust), filled = Math.min(10, Math.floor(co.trust / 10));
      let lend = '';
      if (!locked && !co.loan) {
        lend = `<button type="button" class="btn${T.hasBank ? ' primary' : ''}" data-lend="${c.id}"${T.hasBank ? '' : ' disabled title="Build a Mercantile Bank first"'}>${icon('lend', 14)}Lend</button>`;
      }
      h += `<div class="co${locked ? ' locked' : ''}" style="--hue:${coHue(c.id)}" title="${esc(c.blurb)}">` +
        `<div class="co-head"><span class="name">${esc(c.name)}</span></div>` +
        `<div class="co-chips">${chips}</div>` +
        `<p class="blurb">${esc(c.blurb)}</p>` +
        `<div class="home label">${esc(pl.name)} ${MID} ${esc(pl.type)}</div>` +
        goodsRow('Brings', pl.exports) + goodsRow('Buys', pl.imports) +
        `<div class="trust" title="Trust ${co.trust} / 100"><div class="trust-bar">${'<i class="on"></i>'.repeat(filled)}${'<i></i>'.repeat(10 - filled)}</div>` +
        `<span class="trust-val num">${co.trust} / 100</span><span class="chip ${tc}" data-shape="${TIER_SHAPE[tc]}">${TIER_WORD[tc]}</span></div>` +
        `<div class="co-foot"><span class="tag">Ships served ${co.served}</span>${lend}</div>` +
        `</div>`;
    }
    if (h === this.sig.companies) return false;
    this.sig.companies = h;
    $('#panel-companies').innerHTML = h;
    return true;
  },

  onCompaniesClick(e) {
    const b = e.target.closest('button[data-lend]');
    if (b && !b.disabled) this.lendDialog(b.dataset.lend);
  },

  lendDialog(companyId) {
    const co = Sim.state.companies[companyId], c = coDef(companyId); if (!co || !c) return;
    const rate = Math.round((0.25 - co.trust / 100 * 0.1) * 100);
    const max = Math.max(0, Math.floor(Sim.state.credits));
    this.modal({
      kind: 'lend',
      tag: `Loan desk ${MID} Day ${pad3(Sim.state.day)} ${MID} ${c.name}`,
      title: `Lend to ${c.name}`,
      html: `Trust <span class="num">${co.trust}/100</span> sets the rate at <b>${rate}%</b>, repaid over 10 days. Lower trust means a higher rate but a real chance of default. You have <span class="num">${fmt(max)}</span> credits.`,
      extra: `<input type="number" id="lend-amt" min="500" step="100" max="${max}" value="${Math.min(max, 2000)}" aria-label="Loan amount">`,
      actions: [
        { label: 'Lend', primary: true, fn: () => { const inp = $('#lend-amt'); Sim.lend(companyId, inp ? +inp.value : 0); } },
        { label: 'Cancel' },
      ],
    });
  },

  // ---------------------------------------------------------- 05 LOG
  renderLog() {
    const s = Sim.state, log = s.log, list = $('#log-list'); if (!list) return false;
    setText($('#log-tag'), log.length ? `${log.length} entr${log.length === 1 ? 'y' : 'ies'}` : '');
    const sig = `${log.length}|${log.length ? log[0].day + ':' + log[0].msg : ''}|${log.length ? log[log.length - 1].msg : ''}`;
    if (sig === this.sig.log) return false;
    this.sig.log = sig;
    let h = '';
    for (let i = 0; i < log.length; i++) {
      const l = log[i];
      const newday = i > 0 && log[i - 1].day !== l.day;
      const fresh = this.logPrimed && !this.logSeen.has(l);
      this.logSeen.add(l);
      const cls = ['line', l.cls || '', newday ? 'newday' : '', fresh ? 'new' : ''].filter(Boolean).join(' ');
      h += `<div class="${cls}"><span class="day">D${pad3(l.day)}</span><span class="cat">${logCat(l.msg, l.cls)}</span><span class="msg">${esc(l.msg)}</span></div>`;
    }
    this.logPrimed = true;
    list.innerHTML = h || `<p class="empty">Nothing yet.</p>`;
    return true;
  },

  // ---------------------------------------------------------- tooltip (6.7)
  // main.js passes the hover cell (null while placing) and the hovered ship.
  tooltip(mx, my, cell, ship) {
    const el = $('#tooltip'); if (!el) return;
    let key = '', html = '', hue = 'var(--ivory)';
    if (ship) { key = 'ship:' + ship.id; hue = coHue(ship.company); html = this.shipTip(ship); }
    else if (cell && Sim.state && Sim.state.grid[cell.r][cell.c]) {
      const m = Sim.state.grid[cell.r][cell.c];
      key = `cell:${cell.r},${cell.c}`; hue = famHue(m.id); html = this.cellTip(cell, m);
    }
    if (!key) { this.hideTooltip(); return; }
    if (key !== this.tt.key) {
      this.tt.key = key; this.tt.t0 = performance.now();
      el.classList.remove('more');
      clearTimeout(this.tt.timer);
      // the delayed trades block fades in after 600ms even when the cursor rests
      if (ship && ship.trades.length) this.tt.timer = setTimeout(() => { if (this.tt.key === key) el.classList.add('more'); }, 600);
    }
    if (html !== this.tt.html) { this.tt.html = html; el.innerHTML = html; el.style.setProperty('--hue', hue); }
    if (ship && ship.trades.length && performance.now() - this.tt.t0 > 600) el.classList.add('more');
    el.classList.add('show');
    const wrap = $('#canvas-wrap');
    const x = Math.max(8, Math.min(mx + 14, wrap.clientWidth - el.offsetWidth - 8));
    const yy = Math.max(8, Math.min(my + 14, wrap.clientHeight - el.offsetHeight - 8));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(yy)}px)`;
  },
  hideTooltip() {
    const el = $('#tooltip'); if (!el) return;
    if (this.tt.key) { el.classList.remove('show', 'more'); this.tt.key = ''; this.tt.html = ''; clearTimeout(this.tt.timer); }
  },

  shipTip(ship) {
    const co = coDef(ship.company), cls = SHIP_CLASSES[ship.cls];
    const held = Object.values(ship.cargo).reduce((a, q) => a + Math.max(0, q), 0);
    let state;
    if (ship.state === 'docked') state = `<p class="tt-body">Docked ${MID} leaves in ${Math.max(0, ship.dockedUntil - Sim.now()).toFixed(1)} d</p>`;
    else if (ship.state === 'queue') state = `<p class="tt-body warn">${SQ} Holding ${Math.max(0, Sim.now() - ship.waitStart).toFixed(1)} d for a berth</p>`;
    else if (ship.state === 'approach') state = `<p class="tt-body">On approach</p>`;
    else state = `<p class="tt-body">Departing</p>`;
    const hold = Object.entries(ship.cargo).filter(([, q]) => q > 0);
    const goodIc = g => `<span style="color:${kindHue(GOODS[g].kind)}" title="${esc(GOODS[g].name)}">${icon(g, 14)}</span>`;
    let h = `<div class="tt-title">${esc(co ? co.name : ship.company)}</div>` +
      `<p class="tt-body">${cls.name} ${MID} ${esc(ship.captain)} ${MID} crew ${ship.crew}</p>` + state;
    if (hold.length) h += `<div class="tt-row"><span class="lbl">Hold</span>${hold.map(([g, q]) => goodIc(g) + `<span class="num">${q}</span>`).join('')}</div>`;
    h += `<div class="tt-row"><span class="lbl">Wants</span>${ship.wants.map(goodIc).join('')}</div>`;
    const short = co ? co.name.split(' ')[0] : ship.company;
    h += `<div class="tt-foot">${esc(short)} ${MID} ${cls.name} ${MID} Hold ${held}/${cls.cargo}</div>`;
    if (ship.trades.length) h += `<div class="tt-more">${ship.trades.map(t => esc(t)).join('<br>')}</div>`;
    return h;
  },

  cellTip(cell, m) {
    const d = MODULES[m.id];
    let foot = `Grid ${gridTag(cell.r, cell.c)} ${MID} PWR ${d.power > 0 ? '+' : MINUS}${Math.abs(d.power)}`;
    if (d.docks && m.id !== 'hub') {       // the hub's collar (berth 01) is routinely built around; never alarm
      foot += Sim.dockUsable(cell.r, cell.c)
        ? ` ${MID} Berth ${this.berthNo(cell.r, cell.c)} clear`
        : ` ${MID} <span class="bad">${TRI_DN} Berth ${this.berthNo(cell.r, cell.c)} blocked</span>`;
    }
    return `<div class="tt-title">${esc(d.name)}</div><p class="tt-body">${esc(d.desc)}</p><div class="tt-foot">${foot}</div>`;
  },

  // ---------------------------------------------------------- modal (6.8)
  // o = { kind: 'event'|'alert'|'confirm'|'lend', tag, title, html, extra, actions: [{label, primary, fn}] }
  modal(o) {
    const m = $('#modal'), box = m.querySelector('.box');
    box.dataset.kind = o.kind || 'confirm';
    setText($('#modal-tag'), o.tag || '');
    setText($('#modal-title'), o.title || '');
    $('#modal-text').innerHTML = o.html || '';
    $('#modal-extra').innerHTML = o.extra || '';
    $('#modal-actions').innerHTML = (o.actions || []).map((a, i) =>
      `<button type="button" class="btn${a.primary ? ' primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('');
    this._modal = o;
    this.placeModal();
    m.classList.remove('open'); void m.offsetWidth; m.classList.add('open');
    const focus = $('#modal-extra input') || $('#modal-actions .btn.primary') || $('#modal-actions .btn');
    if (focus) { focus.focus(); if (focus.select) focus.select(); }
  },
  // centre the box over #canvas-wrap, not the viewport (the sidebar stays visible behind the backdrop)
  placeModal() {
    const wrap = $('#canvas-wrap'), m = $('#modal'); if (!wrap || !m) return;
    const r = wrap.getBoundingClientRect();
    m.style.setProperty('--mx', Math.round(r.left + r.width / 2) + 'px');
    m.style.setProperty('--my', Math.round(r.top + r.height / 2) + 'px');
  },
  modalAction(i) {
    const o = this._modal; if (!o) return;
    const a = (o.actions || [])[i];
    this.closeModal();
    if (a && typeof a.fn === 'function') a.fn();
  },
  closeModal() { $('#modal').classList.remove('open'); this._modal = null; },
  modalOpen() { return !!this._modal; },
  // Esc closes confirmations and the lend dialog; a transmission must be answered
  escModal() { if (this._modal && this._modal.kind !== 'event' && this._modal.kind !== 'alert') this.closeModal(); },
  confirm(title, text, fn) {
    this.modal({ kind: 'confirm', tag: `Confirm ${MID} Day ${pad3(Sim.state ? Sim.state.day : 0)}`, title, html: text,
      actions: [{ label: 'Yes', primary: true, fn }, { label: 'Cancel' }] });
  },

  // Transmission index: ws.evt = {"n":count,"key":"id|day"}; the same pending event reopened after a reload is not recounted
  evtRecord(ev) {
    const s = Sim.state, key = `${ev.id}|${s.day}`;
    let rec = lsJSON('ws.evt', null);
    const first = !rec;
    if (!rec || rec.key !== key) { rec = { n: (rec && rec.n ? rec.n : 0) + 1, key }; lsSet('ws.evt', JSON.stringify(rec)); }
    return { n: rec.n, first };
  },

  showEvent() {
    const s = Sim.state, ev = s && s.pending; if (!ev) return;
    const alert = ev.id === 'pirates' || ev.id === 'outbreak';
    const rec = this.evtRecord(ev);
    const srcCo = ev.id === 'contract' && ev.data && ev.data.company ? coDef(ev.data.company) : null;
    const tag = `Transmission ${pad2(rec.n)} ${MID} Day ${pad3(s.day)} ${MID} SRC ${srcCo ? srcCo.name : 'Sector comms'}`;
    let html = esc(ev.text);
    if (rec.first) html += `<br><br>Transmissions like this arrive every few days. Most need no reply.`;
    const after = () => { if (alert) this.raiseAlert(ev.id); else this.refreshTop(); };
    const actions = ev.choice
      ? [{ label: ev.yes, primary: true, fn: () => { Sim.resolveEvent(true); after(); } },
         { label: ev.no, fn: () => { Sim.resolveEvent(false); after(); } }]
      : [{ label: 'Continue', primary: true, fn: () => { Sim.resolveEvent(true); after(); } }];
    this.modal({ kind: alert ? 'alert' : 'event', tag, title: ev.title, html, actions });
  },

  // ---------------------------------------------------------- toasts (6.10)
  toast(msg, cls = '') {
    const box = $('#toasts'); if (!box) return;
    while (box.children.length >= 4) box.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'toast' + (cls ? ' ' + cls : '');
    el.innerHTML = `<span class="chip ${TOAST_HUE[cls] || 'amber'}">${toastChip(msg, cls)}</span><span class="toast-msg">${esc(msg)}</span>`;
    el.title = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  },

  // ---------------------------------------------------------- level-up banner (12.4)
  onLevelUp(lvl) {
    document.body.setAttribute('data-level', String(lvl));
    const el = $('#level-banner');
    if (el) {
      setText(el, `Threshold ${MID} now a ${TIER_NAMES[lvl] || 'Galactic Hub'}`);
      el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    }
    // newly unlocked cards fade in with a 120ms stagger the next time the Build panel renders
    this.fadeTier = lvl; this.fadeAt = performance.now(); this.sig.build = '';
    if (this.started && this.tab === 'build') this.renderPanel('build');
  },
};

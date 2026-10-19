// ============================================================
// WAYSTATION v2 — ui/hud.js
// Engineer H. Source of truth: DESIGN2.md 0.4 (the UI facade, verbatim),
// 0.6 (bus events), 0.7 (body attributes), 2.4 (layout), 2.6 (motion),
// 5.1 (keys), 5.4 (title ids), 8 (accessibility); DESIGN.md 12.2 (hint table).
//
// Builds the status bar, command rail, panel host, notices and context bar
// into the shells index.html provides; binds Sim / Meta / Engine / Store;
// exposes `UI`. Every call into Meta, Engine and Store goes through the
// three adapters in section 0 so the integrator can alias names in one place.
//
// Exports (globals): UI, MetaAdapter, EngineAdapter, StoreAdapter
// ============================================================
'use strict';

// ------------------------------------------------------------
// 0. Adapters. Each call is guarded: a missing global or method returns a
//    harmless fallback and never throws into the HUD.
// ------------------------------------------------------------
const has = (obj, fn) => typeof obj !== 'undefined' && obj && typeof obj[fn] === 'function';
const call = (obj, fn, args, dflt) => { try { return has(obj, fn) ? obj[fn].apply(obj, args) : dflt; } catch (e) { console.warn(`[hud] ${fn} failed`, e); return dflt; } };
const S = () => (typeof Sim !== 'undefined' && Sim.state) ? Sim.state : null;

// Meta (0.5, section 4). The only place that spells Meta method names.
const MetaAdapter = {
  _settings: {},
  present() { return typeof Meta !== 'undefined' && !!Meta; },
  profile() { return (typeof Meta !== 'undefined' && Meta && Meta.profile) || null; },
  settings() { const p = this.profile(); if (p) { p.settings = p.settings || {}; return p.settings; } return this._settings; },
  saveSettings() { call(Meta, 'save', [], undefined); },
  // read model
  hopper(r, c) { return call(Meta, 'hopper', [r, c], null); },
  build(r, c) { return call(Meta, 'build', [r, c], null); },
  upgrade(r, c) { return call(Meta, 'upgrade', [r, c], null); },
  am() { if (typeof Meta !== 'undefined' && Meta && Meta.am != null) return Number(typeof Meta.am === 'function' ? Meta.am() : Meta.am) || 0; const p = this.profile(); return p ? Number(p.am) || 0 : 0; },
  rank() { const r = (typeof Meta !== 'undefined' && Meta && Meta.rank) ? (typeof Meta.rank === 'function' ? Meta.rank() : Meta.rank) : null; return r || { level: 1, title: 'Ensign', xp: 0, next: 300, pct: 0 }; },
  sectors() { return call(Meta, 'sectors', [], []) || []; },
  expeditions() { return call(Meta, 'expeditions', [], []) || []; },
  missions() { return call(Meta, 'missions', [], []) || []; },
  daily() { return call(Meta, 'daily', [], null); },
  collection() { return call(Meta, 'collection', [], { ships: [], species: [], artifacts: [] }) || { ships: [], species: [], artifacts: [] }; },
  charts(sectorId) { if (has(Meta, 'charts')) return Number(Meta.charts(sectorId)) || 0; const p = this.profile(); return p && p.charts ? Number(p.charts[sectorId]) || 0 : 0; },
  slots() {
    if (has(Meta, 'expeditionSlots')) {
      const v = Meta.expeditionSlots();
      if (v && typeof v === 'object') return v;                       // already {used, max}
      return { used: this.expeditions().filter(x => x.status === 'out').length, max: Number(v) || 0 };   // Meta returns the slot count
    }
    const s = S(); const T = s && typeof Sim !== 'undefined' ? Sim.totals() : null; const max = T ? Math.min(3, 1 + (T.counts.comms ? 1 : 0) + (T.counts.shipyard ? 1 : 0)) : 1; return { used: this.expeditions().filter(x => x.status === 'out').length, max }; },
  activeSector() { const s = S(); return (s && s.sector) || (this.profile() && this.profile().activeSector) || 'home'; },
  sectorDef(id) { if (typeof SECTORS === 'undefined' || !SECTORS) return { id, name: id }; return Array.isArray(SECTORS) ? SECTORS.find(x => x.id === id) : Object.assign({ id }, SECTORS[id] || { name: id }); },
  readyCells() { const s = S(); if (!s || !has(Sim, 'cells')) return []; const out = []; for (const { r, c } of Sim.cells()) { const h = this.hopper(r, c); if (h && h.ready) out.push({ r, c, bank: h.bank }); } return out; },
  bankedTotal() { const s = S(); if (!s || !has(Sim, 'cells')) return 0; let t = 0; for (const { r, c } of Sim.cells()) { const h = this.hopper(r, c); if (h) t += Math.floor(h.bank || 0); } return t; },
  buildingCells() { const s = S(); if (!s || !has(Sim, 'cells')) return []; const out = []; for (const { r, c, m } of Sim.cells()) { const b = this.build(r, c); if (b && b.building) out.push({ r, c, id: m.id, remainingMs: b.remainingMs, totalMs: b.totalMs, skipAM: b.skipAM }); } return out; },
  canCollectAll() { if (typeof Meta !== 'undefined' && Meta && Meta.canCollectAll != null) return typeof Meta.canCollectAll === 'function' ? !!Meta.canCollectAll() : !!Meta.canCollectAll; return this.rank().level >= 3; },
  // mutators
  collect(r, c) { return call(Meta, 'collect', [r, c], 0); },
  collectAll() { return call(Meta, 'collectAll', [], 0); },
  skipBuild(r, c) { return call(Meta, 'skipBuild', [r, c], false); },
  upgradeModule(r, c) { return call(Meta, 'upgradeModule', [r, c], false); },
  launchExpedition(id) { return call(Meta, 'launchExpedition', [id], false); },
  // expedition ids are numbers in Meta but arrive as strings from data attributes
  expId(id) { const n = Number(id); return id !== '' && id != null && Number.isFinite(n) ? n : id; },
  claimExpedition(id) { return call(Meta, 'claimExpedition', [this.expId(id)], null); },
  skipExpedition(id) { return call(Meta, 'skipExpedition', [this.expId(id)], false); },
  claimMission(id) { return call(Meta, 'claimMission', [id], null); },
  claimDaily() { return call(Meta, 'claimDaily', [], null); },
  repairStreak() { return call(Meta, 'repairStreak', [], false); },
  unlockSector(id, withAM) { return call(Meta, 'unlockSector', [id, { withAM: !!withAM }], false); },
  switchSector(id) { return call(Meta, 'switchSector', [id], null); },
  spendAM(n, reason) { return call(Meta, 'spendAM', [n, reason], false); },
  exportSave() { return call(Meta, 'export', [], ''); },
  importSave(json) { return call(Meta, 'import', [json], false); },
  scrapStation() { if (has(Meta, 'newStationHere')) { Meta.newStationHere(); return true; } if (has(Sim, 'reset')) { Sim.reset(); return true; } return false; },
  resetProfile() { if (has(Meta, 'resetProfile')) return Meta.resetProfile(); try { localStorage.removeItem('waystation.profile.v2'); localStorage.removeItem('waystation-save-v1'); } catch (e) { /* ignore */ } location.reload(); return true; },
};

// Engine (0.3)
const EngineAdapter = {
  present() { return typeof Engine !== 'undefined' && !!Engine; },
  placing() { return this.present() ? Engine.placing || null : null; },
  setPlacing(id) { if (this.present()) Engine.placing = id || null; },
  selected() { return this.present() ? Engine.selected || null : null; },
  setSelected(cell) { if (this.present()) Engine.selected = cell || null; },
  hover() { return this.present() ? Engine.hover || null : null; },
  on(evt, fn) { call(Engine, 'on', [evt, fn], undefined); },
  cellToScreen(r, c) { return call(Engine, 'cellToScreen', [r, c], null); },
  setPaused(b) { call(Engine, 'setPaused', [!!b], undefined); },
  setSector(def, state) { call(Engine, 'setSector', [def, state], undefined); },
  // body[data-perf] is the override the engine reads (0.7, stage.js readBody); removing it returns to automatic tiers
  setPerf(tier) { if (tier === 'auto' || tier == null) document.body.removeAttribute('data-perf'); else document.body.setAttribute('data-perf', String(Math.max(0, Math.min(2, Number(tier) | 0)))); },
  perf() { if (!this.present() || !Engine.perf) return null; const p = typeof Engine.perf === 'function' ? Engine.perf() : Engine.perf; return p && p.fps != null ? p : null; },
  camera() { return this.present() && Engine.camera ? Engine.camera : null; },
  focusCell(r, c, o) { const cam = this.camera(); if (cam && typeof cam.focusCell === 'function') cam.focusCell(r, c, o || { zoom: 1.6, ms: 600 }); },
  avoid(rect) { const cam = this.camera(); if (cam && typeof cam.avoid === 'function') cam.avoid(rect); },
  fx(name, ...args) { if (!this.present() || !Engine.fx || typeof Engine.fx[name] !== 'function') return null; try { return Engine.fx[name](...args); } catch (e) { return null; } },
};

// Store (7.2)
const StoreAdapter = {
  present() { return typeof Store !== 'undefined' && !!Store; },
  mode() { return this.present() && Store.mode ? Store.mode : 'sandbox'; },
  catalog() { const c = call(Store, 'catalog', [], null); if (Array.isArray(c)) return c; if (typeof STORE_CATALOG !== 'undefined' && Array.isArray(STORE_CATALOG)) return STORE_CATALOG; return []; },
  purchase(sku) { const p = call(Store, 'purchase', [sku], null); return p && typeof p.then === 'function' ? p : Promise.resolve(p || { ok: false, why: 'Store unavailable' }); },
  restore(email) { const p = call(Store, 'restore', [email], null); return p && typeof p.then === 'function' ? p : Promise.resolve(p || { ok: false, why: 'Store unavailable' }); },
  offer() { return this.catalog().some(i => i.offer || i.featured); },
};

// ------------------------------------------------------------
// 1. Constants
// ------------------------------------------------------------
const MID2 = GLYPH.mid;
const KEY_PANEL = { b: 'build', s: 'station', m: 'market', f: 'fleet', e: 'expeditions', g: 'map', j: 'missions', r: 'registry' };
const regOf = name => (typeof registryOf === 'function') ? registryOf(name) : 'WS-0000';

// ------------------------------------------------------------
// 2. UI
// ------------------------------------------------------------
const UI = {
  panel: null,            // open panel id | null (facade)
  _inst: null,            // { update, destroy } of the open panel
  started: false,
  _lastSpeed: 1,
  _focusShip: { id: null, until: 0 },
  _cond: null, _alert: { kind: null, until: 0 },
  _pendingOffline: null,
  _bootTimer: 0,
  _tipTimer: 0,
  sig: {},
  ctx: null,

  // ---------------------------------------------------------- init (0.4)
  init() {
    const body = document.body;
    Motion.init();
    const st = MetaAdapter.settings();
    if (st.motion) Motion.setOverride(st.motion);
    Sound.bind(st, () => MetaAdapter.saveSettings());
    Overlays.init({ sound: Sound });
    body.setAttribute('data-store', StoreAdapter.mode());
    if (st.perf != null && st.perf !== 'auto') EngineAdapter.setPerf(st.perf);
    // 7.2: the store asks the HUD to confirm a purchase; sandbox copy says so plainly
    if (StoreAdapter.present() && Store.ui) {
      Store.ui.confirm = req => Overlays.confirm(
        `Buy ${req.title}?`,
        `${esc(req.desc || '')}<div class="price-line"><span>Price</span><b class="num">${esc(req.priceLabel || '')}</b></div>` +
        (req.testMode || StoreAdapter.mode() !== 'stripe' ? `<p class="test-note">${GLYPH.sq} Test mode. Nothing is charged.</p>` : `<p class="fine">You will be taken to a secure checkout page.</p>`),
        null, { kind: 'store', yes: req.testMode || StoreAdapter.mode() !== 'stripe' ? `Buy ${MID2} test` : `Buy ${MID2} ${req.priceLabel || ''}`, am: true, tag: `Store ${MID2} ${StoreAdapter.mode() === 'stripe' ? 'Checkout' : 'Sandbox'}` });
    }

    this.buildStatusBar();
    this.buildRail();
    this.buildContextBar();
    this.buildNotices();
    // title screen and any static markup: <span class="ic-slot" data-icon="..."> gets its SVG
    for (const el of $$('.ic-slot[data-icon]')) if (!el.firstChild) el.innerHTML = icon(el.dataset.icon, 14);
    this.ctx = {
      ui: this, meta: MetaAdapter, engine: EngineAdapter, store: StoreAdapter, sound: Sound, state: S,
    };

    // first gesture starts audio (section 9)
    const gesture = () => { Sound.init(); window.removeEventListener('pointerdown', gesture); window.removeEventListener('keydown', gesture); };
    window.addEventListener('pointerdown', gesture); window.addEventListener('keydown', gesture);

    // interaction sounds and tooltips, delegated once
    document.addEventListener('mouseover', e => {
      const t = e.target.closest && e.target.closest('.btn, .rail-btn, .card, .ptab, .seg > button, .am-tile, .node, .ship-row, .sil-card');
      if (t && !t.disabled && !t._hov) { t._hov = true; Sound.hover(); t.addEventListener('mouseleave', () => { t._hov = false; }, { once: true }); }
      const tip = e.target.closest && e.target.closest('[data-tip]');
      clearTimeout(this._tipTimer);
      if (tip) { this._tipTimer = setTimeout(() => Overlays.tooltipFor(tip, `<div class="tt-body">${esc(tip.dataset.tip)}</div>`, tip.dataset.tipHue || 'var(--ivory)'), 350); tip.addEventListener('mouseleave', () => { clearTimeout(this._tipTimer); Overlays.hideTooltip(); }, { once: true }); }
    });
    document.addEventListener('click', e => {
      const t = e.target.closest && e.target.closest('.btn, .rail-btn, .ptab, .seg > button, .am-tile');
      if (t && !t.disabled && !t.closest('#modal') && !t.closest('#sheet')) Sound.click();
    });

    // rail, status bar, context bar handlers
    $('#rail').addEventListener('click', e => { const b = e.target.closest('.rail-btn[data-panel]'); if (b) this.openPanel(this.panel === b.dataset.panel ? null : b.dataset.panel); });
    $('#sb-sector').addEventListener('click', () => this.openPanel('map'));
    $('#btn-am-plus').addEventListener('click', e => { e.stopPropagation(); this.openPanel('store'); });
    $('#btn-daily').addEventListener('click', () => this.openDaily());
    $('#speed').addEventListener('click', e => { const b = e.target.closest('button[data-speed]'); if (b) this.setSpeed(+b.dataset.speed); });
    const bell = $('#btn-notices'); if (bell) bell.addEventListener('click', () => { body.toggleAttribute('data-notices'); });
    $('#btn-keys').addEventListener('click', () => Overlays.keys());
    $('#ctx-actions').addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (b && !b.disabled) this.ctxAction(b.dataset.act); });
    $('#nextup').addEventListener('click', e => { const r = e.target.closest('.nu-row[data-go]'); if (r) this.nextUpGo(r.dataset.go, r); });
    window.addEventListener('keydown', e => this.onKey(e));
    window.addEventListener('resize', () => { this.placeAvoid(); });

    // Sim bus (0.6)
    if (typeof Sim !== 'undefined' && has(Sim, 'on')) {
      Sim.on('change', () => this.refresh());
      Sim.on('toast', d => d && this.toast(d.msg, d.cls));
      Sim.on('event', () => { if (this.started) this.showEvent(); });
      Sim.on('levelup', d => this.onLevelUp(typeof d === 'object' && d ? d.level : d));
      Sim.on('collect', d => this.onCollect(d));
      Sim.on('hopper', () => this.refreshContext());
      Sim.on('build-start', d => { if (d && MODULES[d.id]) this.toast(`${MODULES[d.id].name} under construction ${MID2} ${Fmt.dur(d.totalMs || 0)}`, 'info', { icon: 'build', chip: 'Build' }); this.refresh(); });
      Sim.on('build-done', d => this.onBuildDone(d));
      Sim.on('upgrade', d => { if (d && S() && S().grid[d.r] && S().grid[d.r][d.c]) this.toast(`${MODULES[S().grid[d.r][d.c].id].name} is now level ${d.lvl}`, 'good', { icon: 'upgrade', chip: 'Upgrade' }); this.refresh(); });
      Sim.on('am', d => { const el = $('#v-am'); if (el && d && d.delta) Counter.lit(el, d.delta > 0 ? 'up' : 'down'); this.refreshTop(); });
      Sim.on('rank', d => this.celebrate('rank', d || {}));
      Sim.on('mission', d => this.onMission(d));
      Sim.on('daily', d => { if (d && d.claimed) this.celebrate('daily', d); this.refreshTop(); });
      Sim.on('expedition', d => this.onExpedition(d));
      Sim.on('sector', d => { if (d && d.state === 'unlocked') this.celebrate('unlock', d); if (d && d.state === 'switched') { body.setAttribute('data-sector', d.id); } this.refresh(); });
      Sim.on('discover', d => this.onDiscover(d));
      Sim.on('purchase', d => this.onPurchase(d));
      Sim.on('offline', d => { if (this.started) this.showAway(d); else this._pendingOffline = d; });
    }
    // Engine events (0.3)
    EngineAdapter.on('cell-click', d => this.onCellClick(d));
    EngineAdapter.on('bank-click', d => d && this.collect(d.r, d.c));
    EngineAdapter.on('scaffold-click', d => d && this.select(d.r, d.c));
    EngineAdapter.on('ship-click', d => d && d.ship && this.onShipClick(d.ship));
    EngineAdapter.on('empty-click', () => { if (!EngineAdapter.placing()) this.deselect(); });
    EngineAdapter.on('context', () => { if (EngineAdapter.placing()) this.place(null); else this.deselect(); });
    EngineAdapter.on('cell-hover', d => this.onCellHover(d));
    EngineAdapter.on('ship-hover', d => this.onShipHover(d));
    EngineAdapter.on('camera', () => { if (this._hoverTip) this.onCellHover(this._hoverTip); });

    this.refreshTop();
  },

  // ---------------------------------------------------------- DOM builders (2.4)
  buildStatusBar() {
    const el = $('#statusbar'); if (!el) return;
    el.innerHTML =
      `<div class="sb-left"><span class="wordmark" aria-label="Waystation">Waystation</span>` +
      `<button type="button" id="sb-sector" class="sb-sector" title="Open the galaxy map (G)"><span class="sb-sector-name" id="sb-sector-name">—</span><span class="sb-station micro" id="sb-station">—</span></button></div>` +
      `<div class="sb-center">` +
      `<div class="ro credits" id="ro-credits" data-tip="Credits · shared across every sector"><span class="ro-ic">${icon('credits', 20)}</span><div class="ro-main"><div class="ro-top"><span class="ro-lbl">Credits</span><span class="ro-sub" id="v-income-wrap"><i class="tri up" id="v-income-tri"></i><span class="num" id="v-income">+0</span><small>/day</small></span></div><span class="ro-val hero" id="v-credits">0</span></div></div>` +
      `<div class="ro am" id="ro-am" data-tip="Antimatter · the premium currency: skips, early returns, early unlocks" data-tip-hue="var(--am)"><span class="ro-ic">${icon('am', 20)}</span><div class="ro-main"><div class="ro-top"><span class="ro-lbl">Antimatter</span></div><span class="ro-val big" id="v-am">0</span></div><button type="button" class="plus" id="btn-am-plus" title="Get Antimatter" aria-label="Open the store">${icon('new', 14)}</button></div>` +
      `<div class="ro power" id="ro-power" data-tip="Power used / produced" data-tip-hue="var(--ice)"><span class="ro-ic">${icon('power', 20)}</span><div class="ro-main"><div class="ro-top"><span class="ro-lbl">Power</span><span class="ro-sub" id="power-pips"></span></div><span class="ro-val" id="v-power">0 / 0</span></div></div>` +
      `<div class="ro people" id="ro-people" data-tip="Residents / homes · visitors aboard" data-tip-hue="var(--sage)"><span class="ro-ic">${icon('people', 20)}</span><div class="ro-main"><div class="ro-top"><span class="ro-lbl">Residents</span><span class="ro-sub num" id="v-visitors">0 aboard</span></div><span class="ro-val" id="v-residents">0 / 0</span></div></div>` +
      `<div class="ro rep" id="ro-rep" data-tip="Reputation out of 5"><span class="ro-ic">${icon('rep', 20)}</span><div class="ro-main"><div class="ro-top"><span class="ro-lbl">Reputation</span><span class="ro-sub" id="rep-pips">${'<i class="pip"><b></b></i>'.repeat(5)}</span></div><span class="ro-val" id="v-rep">0.0</span></div></div>` +
      `</div>` +
      `<div class="sb-right">` +
      `<div class="rank" id="ro-rank" data-tip="Commander rank · XP from banks, ships, missions and expeditions"><span class="rank-ring">${'<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><circle class="ring-track" cx="20" cy="20" r="17"/><circle class="ring-arc" id="rank-arc" cx="20" cy="20" r="17" stroke-dasharray="106.81" stroke-dashoffset="106.81"/></svg>'}<span class="rank-level num" id="v-rank-level">1</span></span><div class="rank-main"><span class="ro-lbl" id="v-rank-lbl">Rank 1</span><span class="rank-title" id="v-rank-title">Ensign</span></div></div>` +
      `<button type="button" class="sb-btn" id="btn-daily" title="Daily reward" aria-label="Daily reward">${icon('calendar', 20)}<i class="dot" hidden></i></button>` +
      `<div id="speed" class="seg" role="group" aria-label="Game speed"><button type="button" data-speed="0" title="Pause (Space)" aria-label="Pause">${icon('pause', 14)}</button><button type="button" data-speed="1" class="on" title="Normal speed (1)">1${GLYPH.times}</button><button type="button" data-speed="2" title="Double speed (2)">2${GLYPH.times}</button><button type="button" data-speed="4" title="Quadruple speed (4)">4${GLYPH.times}</button></div>` +
      `<button type="button" class="sb-btn narrow-only" id="btn-notices" title="Notices" aria-label="Toggle notices">${icon('bell', 20)}<i class="dot" hidden></i></button>` +
      `</div>`;
  },
  buildRail() {
    const el = $('#rail'); if (!el) return;
    el.innerHTML = PANEL_DEFS.map(p =>
      `<button type="button" class="rail-btn${p.pinned ? ' pinned' : ''}" data-panel="${p.id}" data-tip="${esc(p.label)}${p.key ? ` ${MID2} ${p.key}` : ''}" aria-label="${esc(p.label)}" aria-pressed="false"><i class="spine"></i><span class="rail-ic">${icon(p.icon, 22)}</span><span class="rail-lbl">${esc(p.label)}</span><span class="rail-badge" hidden></span></button>`).join('');
  },
  buildContextBar() {
    const el = $('#contextbar'); if (!el) return;
    el.innerHTML = `<div class="hint" id="hint"></div><div class="ctx-actions" id="ctx-actions"></div><div class="ctx-right"><span class="micro" id="perf-tag" hidden></span><button type="button" class="btn icon ghost" id="btn-keys" title="Keys (?)" aria-label="Keyboard reference">${icon('keys', 16)}</button></div>`;
  },
  buildNotices() {
    const n = $('#notices'); if (!n) return;
    if (!$('#toasts')) n.insertAdjacentHTML('afterbegin', '<div id="toasts" aria-live="polite"></div>');
    if (!$('#nextup')) n.insertAdjacentHTML('beforeend', '<div id="nextup" class="glass"><i class="spine"></i><div class="nu-head"><span class="nu-title">Next up</span></div><div class="nu-rows"></div></div>');
  },

  // ---------------------------------------------------------- start / tick / refresh (0.4)
  start() {
    this.started = true;
    this.sig = {};
    document.body.removeAttribute('data-screen');
    // the profile exists now: persisted settings replace the pre-profile defaults bound in init
    const st = MetaAdapter.settings();
    Sound.bind(st, () => MetaAdapter.saveSettings());
    Motion.setOverride(st.motion || 'auto');
    EngineAdapter.setPerf(st.perf == null ? 'auto' : st.perf);
    const s = S();
    if (s) document.body.setAttribute('data-sector', s.sector || 'home');
    // 11.1 boot: once per session, 600ms, skipped under reduced motion
    if (!Motion.reduced()) {
      Counter.boot = true; document.body.setAttribute('data-boot', '');
      clearTimeout(this._bootTimer);
      this._bootTimer = setTimeout(() => { document.body.removeAttribute('data-boot'); Counter.boot = false; }, 700);
    }
    this.setSpeed(s && s.speed != null ? s.speed : 1);
    this.refresh();
    // tutorial pointer: the Build button pulses until the first dock is placed (4.7)
    const T = s && has(Sim, 'totals') ? Sim.totals() : null;
    const fresh = T && !T.counts.dock && s.stats && s.stats.shipsServed === 0;
    const rb = $('.rail-btn[data-panel="build"]'); if (rb) rb.classList.toggle('pulse', !!fresh);
    if (s && s.pending) this.showEvent();
    if (this._pendingOffline) { const d = this._pendingOffline; this._pendingOffline = null; setTimeout(() => this.showAway(d), 500); }
    else { const d = MetaAdapter.daily(); if (d && d.claimable) setTimeout(() => { if (!Overlays.anyOpen()) this.openDaily(); }, 900); }
  },
  tick() {
    if (!S()) return;
    this.refreshTop();
    this.refreshNextUp();
    this.refreshContext();
    this.refreshBadges();
    if (this._inst) this._inst.update();
    const tag = $('#perf-tag');
    if (tag && !tag.hidden) { const p = EngineAdapter.perf(); const s2 = p ? `${Math.round(p.fps)} fps ${MID2} T${p.tier != null ? p.tier : 2}` : 'perf —'; if (tag.textContent !== s2) tag.textContent = s2; }
  },
  refresh() {
    if (!S()) return;
    this.refreshTop();
    this.refreshContext();
    this.refreshBadges();
    this.refreshNextUp();
    if (this._inst) this._inst.update();
  },

  // ---------------------------------------------------------- status bar (2.4)
  refreshTop() {
    const s = S(); if (!s) return;
    const T = Sim.totals();
    const setText = (sel, v) => { const el = $(sel); if (el && el.textContent !== v) el.textContent = v; };
    setText('#sb-sector-name', MetaAdapter.sectorDef(s.sector || 'home').name || 'Home');
    setText('#sb-station', `${s.name} ${MID2} ${regOf(s.name)}`);
    const cr = $('#v-credits'); if (cr) { cr.classList.toggle('bad', s.credits < 0); Counter.set(cr, s.credits, v => v < 0 ? `${GLYPH.down} ${Fmt.n(Math.abs(v))}` : Fmt.n(v)); }
    const y = s.income ? s.income.yesterday : 0;
    const tri = $('#v-income-tri'); if (tri) tri.className = 'tri ' + (y >= 0 ? 'up c-good' : 'down c-bad');
    Counter.set($('#v-income'), y, Fmt.signed, { quiet: true });
    Counter.set($('#v-am'), MetaAdapter.am(), Fmt.n);
    const over = T.used > T.produced, pw = $('#v-power');
    if (pw) { pw.className = 'ro-val ' + (over ? 'c-bad' : T.flare ? 'c-warn' : 'c-ice'); const prod = T.produced, pre = over ? `${GLYPH.down} ` : T.flare ? `${GLYPH.sq} ` : ''; Counter.set(pw, T.used, v => `${pre}${Fmt.n(v)} / ${Fmt.n(prod)}`, { quiet: true }); }
    const pp = $('#power-pips'); if (pp) { const h = this.powerPips(T.used, T.produced); if (pp._h !== h) { pp._h = h; pp.innerHTML = h; } }
    const homes = T.homes; Counter.set($('#v-residents'), s.residents, v => `${Fmt.n(v)} / ${Fmt.n(homes)}`, { quiet: true });
    Counter.set($('#v-visitors'), T.visitors, v => `${Fmt.n(v)} aboard`, { quiet: true });
    Counter.set($('#v-rep'), s.rep, v => v.toFixed(1), { quiet: true });
    const rp = $('#rep-pips'); if (rp) { const pips = rp.children; for (let i = 0; i < pips.length; i++) { const f = Math.max(0, Math.min(1, s.rep - i)); const inner = pips[i].firstElementChild; const hh = Math.round(f * 100) + '%'; if (inner && inner.style.height !== hh) inner.style.height = hh; pips[i].classList.toggle('full', f >= .999); } }
    const rk = MetaAdapter.rank();
    setText('#v-rank-level', String(rk.level));
    setText('#v-rank-lbl', `Rank ${rk.level}`);
    setText('#v-rank-title', rk.title || '');
    const arc = $('#rank-arc'); if (arc) { const c = 106.81, off = (c * (1 - Math.max(0, Math.min(1, rk.pct || 0)))).toFixed(2); if (arc.getAttribute('stroke-dashoffset') !== off) arc.setAttribute('stroke-dashoffset', off); }
    const rankEl = $('#ro-rank'); if (rankEl) rankEl.dataset.tip = `Rank ${rk.level} ${MID2} ${rk.title || ''} ${MID2} ${Fmt.n(rk.xp || 0)}${rk.next ? ` / ${Fmt.n(rk.next)}` : ''} XP`;
    const daily = MetaAdapter.daily(); const dot = $('#btn-daily .dot'); if (dot) dot.hidden = !(daily && daily.claimable);
    const lvl = String(s.level); if (document.body.getAttribute('data-level') !== lvl) document.body.setAttribute('data-level', lvl);
    this.refreshCondition(s, T);
  },
  powerPips(used, produced) {
    const total = Math.max(produced, used); if (total <= 0) return '';
    const count = Math.min(8, Math.ceil(total / 4)), unit = total / count;
    const prodPips = Math.round(produced / unit), usedPips = Math.round(used / unit);
    let h = '';
    for (let i = 0; i < count; i++) h += `<i class="pip ${i < Math.min(usedPips, prodPips) ? 'on' : i < usedPips ? 'over' : 'spare'}"></i>`;
    return h;
  },
  // 5.10 → v2 condition strip under the status bar
  refreshCondition(s, T) {
    let kind = null, text = '';
    if (this._alert.kind && performance.now() < this._alert.until) { kind = 'alert'; text = `Condition ${MID2} ${this._alert.kind === 'pirates' ? 'Pirate raid' : 'Hold fever'}`; }
    else if (T.flare) { const n = Math.max(1, Math.ceil(s.fx.flareUntil - s.day)); kind = 'flare'; text = `Condition ${MID2} Solar flare ${MID2} Solar arrays dark ${n} day${n === 1 ? '' : 's'}`; }
    else if (s.fx && s.day < s.fx.festivalUntil) { const n = Math.max(1, s.fx.festivalUntil - s.day); kind = 'festival'; text = `Festival ${MID2} Visitor spending ${GLYPH.times}2 ${MID2} ${n} day${n === 1 ? '' : 's'}`; }
    const el = $('#condition'); if (el && text && el.textContent !== text) el.textContent = text;
    if (kind !== this._cond) { this._cond = kind; if (kind) document.body.setAttribute('data-condition', kind); else document.body.removeAttribute('data-condition'); }
  },
  raiseAlert(kind) { this._alert = { kind, until: performance.now() + 6000 }; this.refreshTop(); },

  // ---------------------------------------------------------- rail badges (2.4)
  refreshBadges() {
    const set = (id, n, cls) => { const b = $(`.rail-btn[data-panel="${id}"] .rail-badge`); if (!b) return; const txt = n === true ? '' : String(n); b.className = 'rail-badge' + (cls ? ' ' + cls : '') + (n === true ? ' dot' : ''); if (b.textContent !== txt) b.textContent = txt; b.hidden = !n; };
    set('missions', MetaAdapter.missions().filter(m => m.claimable).length, 'amber');
    set('expeditions', MetaAdapter.expeditions().filter(x => x.status === 'ready').length, 'ice');
    set('store', StoreAdapter.offer() ? true : 0, 'am');
    const ready = MetaAdapter.readyCells().length;
    set('station', ready > 0 && MetaAdapter.canCollectAll() ? ready : 0, 'amber');
  },

  // ---------------------------------------------------------- Next up (2.4)
  refreshNextUp() {
    const host = $('#nextup'); if (!host) return;
    const now = Date.now(), items = [];
    for (const b of MetaAdapter.buildingCells()) items.push({ at: now + b.remainingMs, icon: 'build', label: `${MODULES[b.id] ? MODULES[b.id].name : b.id} online`, go: `cell:${b.r},${b.c}`, hue: 'ice' });
    for (const x of MetaAdapter.expeditions()) {
      if (x.status === 'out') items.push({ at: x.endsAt, icon: 'expeditions', label: `Expedition ${MID2} ${MetaAdapter.sectorDef(x.sector).name || x.sector}`, go: 'panel:expeditions', hue: 'ice' });
      else if (x.status === 'ready') items.push({ at: now, icon: 'expeditions', label: `Debrief ${MID2} ${MetaAdapter.sectorDef(x.sector).name || x.sector}`, go: 'panel:expeditions', hue: 'good', ready: true });
    }
    const d = MetaAdapter.daily();
    if (d) items.push(d.claimable ? { at: now, icon: 'calendar', label: 'Daily reward ready', go: 'daily', hue: 'amber', ready: true } : { at: now + Fmt.toMidnight(now), icon: 'calendar', label: 'Daily reward', go: 'daily', hue: 'amber' });
    items.sort((a, b) => a.at - b.at);
    const top = items.slice(0, 3);
    const sig = top.map(i => i.go + i.label + (i.ready ? 'R' : '')).join('|');
    const rows = host.querySelector('.nu-rows');
    if (this.sig.nextup !== sig) {
      this.sig.nextup = sig;
      rows.innerHTML = top.map(i => `<button type="button" class="nu-row${i.ready ? ' ready' : ''}" data-go="${esc(i.go)}" style="--hue:var(--${i.hue})"><span class="nu-ic">${icon(i.icon, 16)}</span><span class="nu-lbl">${esc(i.label)}</span><span class="nu-time num" data-until="${Math.round(i.at)}">${i.ready ? 'now' : Fmt.ms(i.at - now)}</span></button>`).join('');
      host.hidden = !top.length;
    }
    for (const el of rows.querySelectorAll('.nu-time[data-until]')) { const left = +el.dataset.until - now; const s2 = left <= 500 ? 'now' : Fmt.ms(left); if (el.textContent !== s2) el.textContent = s2; }
  },
  nextUpGo(go) {
    if (go === 'daily') return this.openDaily();
    if (go.startsWith('panel:')) return this.openPanel(go.slice(6));
    const m = /^cell:(\d+),(\d+)$/.exec(go); if (m) { this.focusCell(+m[1], +m[2]); this.select(+m[1], +m[2]); }
  },

  // ---------------------------------------------------------- context bar: hint table (12.2 extended) + quick actions
  refreshContext() {
    const s = S(); if (!s) return;
    const T = Sim.totals(), hint = $('#hint'), acts = $('#ctx-actions');
    const text = this.hintFor(s, T);
    if (hint && hint.textContent !== text) hint.textContent = text;
    const sel = EngineAdapter.selected(), m = sel && s.grid[sel.r] && s.grid[sel.r][sel.c];
    let h = '';
    if (m && !EngineAdapter.placing()) {
      const hp = MetaAdapter.hopper(sel.r, sel.c), bd = MetaAdapter.build(sel.r, sel.c), up = MetaAdapter.upgrade(sel.r, sel.c);
      h += `<span class="ctx-name">${esc(MODULES[m.id].name)} <span class="micro">${Fmt.grid(sel.r, sel.c)}</span></span>`;
      if (hp && hp.bank >= 1) h += `<button type="button" class="btn primary" data-act="collect" title="Collect ${Fmt.n(hp.bank)} credits">${icon('collect', 14)}<span>Collect ${Fmt.n(Math.floor(hp.bank))}</span></button>`;
      if (bd && bd.building) h += `<button type="button" class="btn am" data-act="skip" title="Skip the build">${icon('skip', 14)}<span>Skip ${MID2} ${bd.skipAM} AM</span></button>`;
      else if (up && up.next && m.id !== 'hub') h += `<button type="button" class="btn" data-act="upgrade"${s.credits < up.next.cost ? ' disabled' : ''} title="Upgrade for ${Fmt.n(up.next.cost)}">${icon('upgrade', 14)}<span>Upgrade</span></button>`;
      h += `<button type="button" class="btn ghost" data-act="focus" title="Focus the camera">${icon('focus', 14)}<span>Focus</span></button>`;
      if (m.id !== 'hub') h += `<button type="button" class="btn ghost danger" data-act="scrap" title="Scrap">${icon('scrap', 14)}<span>Scrap</span></button>`;
    } else if (EngineAdapter.placing()) {
      h += `<button type="button" class="btn ghost" data-act="cancel">${icon('close', 14)}<span>Stop placing</span></button>`;
    }
    if (acts && acts._h !== h) { acts._h = h; acts.innerHTML = h; }
  },
  ctxAction(act) {
    const sel = EngineAdapter.selected();
    if (act === 'cancel') return this.place(null);
    if (!sel) return;
    if (act === 'collect') this.collect(sel.r, sel.c);
    else if (act === 'skip') this.skipBuild(sel.r, sel.c);
    else if (act === 'upgrade') this.upgrade(sel.r, sel.c);
    else if (act === 'focus') this.focusCell(sel.r, sel.c);
    else if (act === 'scrap') this.demolish(sel.r, sel.c);
  },
  reasonSentence(why, id) {
    const d = MODULES[id], s = S();
    if (why === 'Occupied') return 'Occupied: that cell already holds a module.';
    const m = /^Needs station level (\d+)/.exec(why || '');
    if (m) return `Locked: ${d.name} needs station level ${m[1]}.`;
    if (why === 'Not enough credits') return `Need ${Fmt.n(d.cost - s.credits)} more credits for ${Fmt.aOrAn(d.name)}.`;
    if (why === 'Must touch the station') return 'Not adjacent: modules must touch the station.';
    return why || '';
  },
  hintFor(s, T) {
    if (s.pending) return 'Incoming transmission. Read it to continue.';
    const pl = EngineAdapter.placing();
    if (pl && MODULES[pl]) {
      const hv = EngineAdapter.hover();
      if (hv && has(Sim, 'canPlace')) { const chk = Sim.canPlace(pl, hv.r, hv.c); if (!chk.ok) return this.reasonSentence(chk.why, pl); }
      return `Placing ${MODULES[pl].name}: click a bracketed cell. Right-click or Esc to stop.`;
    }
    const sel = EngineAdapter.selected(), m = sel && s.grid[sel.r] && s.grid[sel.r][sel.c];
    if (m) {
      const bd = MetaAdapter.build(sel.r, sel.c);
      if (bd && bd.building) return `${MODULES[m.id].name} is under construction: ${Fmt.ms(bd.remainingMs)} left. Skip it for ${bd.skipAM} AM.`;
      const hp = MetaAdapter.hopper(sel.r, sel.c);
      if (hp && hp.ready) return `${MODULES[m.id].name} has ${Fmt.n(Math.floor(hp.bank))} credits banked. Collect them here or tap the coin on the station.`;
      return m.id === 'hub' ? 'The Core Hub cannot be removed. Everything else grows from it.' : 'Collect, upgrade or scrap it from the actions here. Esc deselects.';
    }
    if (MetaAdapter.expeditions().some(x => x.status === 'ready')) return 'An expedition is back. Debrief it in Expeditions (E) to open the loot.';
    if (MetaAdapter.missions().some(x => x.claimable)) return 'A mission reward is waiting. Claim it in Missions (J).';
    if (T.efficiency < 1) return 'Power shortage: modules run slower. Build a Solar Array or a Fusion Reactor.';
    for (const { r, c, m: mm } of Sim.cells()) if (mm.id === 'dock' && !Sim.dockUsable(r, c)) return `Berth at ${Fmt.grid(r, c)} is blocked: it has no empty side. Ships cannot pull up to it.`;
    const ready = MetaAdapter.readyCells();
    if (ready.length) return `${ready.length} hopper${ready.length === 1 ? ' is' : 's are'} ready: tap the coin above a module to collect. Shift-click collects every bank nearby.`;
    if (s.recentAway > 1.5) return 'Ships are diverting. Build another Docking Bay.';
    if (T.flare) return 'Solar flare: solar arrays are dark. Reactors are immune.';
    if (s.stats && s.stats.shipsServed === 0) {
      const sh = s.ships.find(x => x.state === 'approach' && x.dock);
      if (sh) { const co = (COMPANIES || []).find(c => c.id === sh.company), pl2 = co ? PLANETS[co.home] : null; return `${SHIP_CLASSES[sh.cls].name} from ${pl2 ? pl2.name : 'afar'} on approach. It will dock, trade and refuel.`; }
    }
    if (s.stats && s.stats.shipsServed < 5 && s.ships.some(x => x.state === 'queue')) return 'A ship is holding in orbit. Build another Docking Bay.';
    const bld = MetaAdapter.buildingCells();
    if (bld.length) { const b = bld.sort((a, c) => a.remainingMs - c.remainingMs)[0]; return `${MODULES[b.id] ? MODULES[b.id].name : 'A module'} comes online in ${Fmt.ms(b.remainingMs)}. Hoppers keep filling while you wait.`; }
    return 'Pick a module in Build (B), then click a bracketed cell. Click a module to inspect it.';
  },

  // ---------------------------------------------------------- panels (0.4)
  openPanel(id) {
    if (id == null) return this.closePanel();
    if (!Panels[id]) return;
    const host = $('#panel'), wrap = $('#panel-host');
    if (!host) return;
    if (this.panel === id) { if (this._inst) this._inst.update(); return; }
    if (this._inst) { this._inst.destroy(); this._inst = null; }
    this.panel = id;
    host.dataset.panel = id;
    document.body.setAttribute('data-panel', id);
    for (const b of $$('.rail-btn')) { const on = b.dataset.panel === id; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); if (on) b.classList.remove('pulse'); }
    wrap.hidden = false;
    host.classList.remove('open', 'closing'); void host.offsetWidth; host.classList.add('open');
    this._inst = Panels[id](host, this.ctx);
    Sound.open();
    this.placeAvoid();
    const first = host.querySelector('.panel-body');
    if (first && !first.contains(document.activeElement) && document.activeElement && document.activeElement.closest && document.activeElement.closest('#rail')) first.focus({ preventScroll: true });
  },
  closePanel() {
    const host = $('#panel'), wrap = $('#panel-host');
    if (!this.panel) return;
    if (this._inst) { this._inst.destroy(); this._inst = null; }
    this.panel = null;
    document.body.removeAttribute('data-panel');
    for (const b of $$('.rail-btn')) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); }
    if (host) { host.classList.remove('open'); host.classList.add('closing'); setTimeout(() => { if (!this.panel) { host.classList.remove('closing'); wrap.hidden = true; host.innerHTML = ''; host.removeAttribute('data-panel'); } }, Motion.reduced() ? 0 : 180); }
    Sound.close();
    EngineAdapter.avoid(null);
  },
  // the camera keeps the station clear of the panel (2.4 / 3.2)
  placeAvoid() {
    const host = $('#panel');
    if (!this.panel || !host) { EngineAdapter.avoid(null); return; }
    const r = host.getBoundingClientRect();
    EngineAdapter.avoid({ x: r.left, y: r.top, w: r.width, h: r.height });
  },

  // ---------------------------------------------------------- selection and placing (0.4)
  select(r, c) {
    const s = S(); if (!s || !s.grid[r] || !s.grid[r][c]) return;
    EngineAdapter.setPlacing(null); document.body.removeAttribute('data-placing');
    EngineAdapter.setSelected({ r, c });
    EngineAdapter.fx('pulse', r, c, 'ivory');
    if (this.panel !== 'station') this.openPanel('station');
    this.refresh();
  },
  deselect() { if (EngineAdapter.selected()) { EngineAdapter.setSelected(null); this.refresh(); } },
  place(id) {
    if (id && !MODULES[id]) return;
    EngineAdapter.setPlacing(id || null);
    if (id) { EngineAdapter.setSelected(null); document.body.setAttribute('data-placing', id); const s = S(); if (s && s.credits < MODULES[id].cost) this.toast(`Need ${Fmt.n(MODULES[id].cost - s.credits)} more credits for ${Fmt.aOrAn(MODULES[id].name)}`, 'warn'); }
    else document.body.removeAttribute('data-placing');
    this.refresh();
  },
  onCellClick(d) {
    const s = S(); if (!s || !d) return;
    const pl = EngineAdapter.placing();
    if (pl) {
      const chk = has(Sim, 'canPlace') ? Sim.canPlace(pl, d.r, d.c) : { ok: true };
      if (!chk.ok) { this.toast(this.reasonSentence(chk.why, pl), 'warn'); Sound.error(); return; }
      if (Sim.place(pl, d.r, d.c)) { Sound.click(); if (s.credits < MODULES[pl].cost) this.place(null); else this.refresh(); }
      return;
    }
    if (d.occupied || (s.grid[d.r] && s.grid[d.r][d.c])) this.select(d.r, d.c); else this.deselect();
  },
  onShipClick(ship) { this._focusShip = { id: ship.id, until: performance.now() + 4000 }; if (this.panel !== 'fleet') this.openPanel('fleet'); else if (this._inst) this._inst.update(); },
  focusedShip() { return performance.now() < this._focusShip.until ? this._focusShip.id : null; },
  focusShip(id) {
    const s = S(); const sh = s && s.ships.find(x => x.id === id); if (!sh) return;
    this._focusShip = { id, until: performance.now() + 4000 };
    const r = Math.max(0, Math.round(sh.y - 0.5)), c = Math.max(0, Math.round(sh.x - 0.5));
    EngineAdapter.focusCell(r, c, { zoom: 1.4, ms: 600 });
    if (this._inst) this._inst.update();
  },
  focusCell(r, c) { EngineAdapter.focusCell(r, c, { zoom: 1.6, ms: 600 }); EngineAdapter.fx('pulse', r, c, 'ivory'); },

  // ---------------------------------------------------------- hover tooltips (6.7 → anchored with cellToScreen)
  _hoverTip: null,
  onCellHover(d) {
    const s = S();
    if (!d || !s || EngineAdapter.placing() || !s.grid[d.r] || !s.grid[d.r][d.c]) { this._hoverTip = null; Overlays.hideTooltip(); return; }
    this._hoverTip = d;
    const m = s.grid[d.r][d.c], def = MODULES[m.id], p = EngineAdapter.cellToScreen(d.r, d.c);
    const hp = MetaAdapter.hopper(d.r, d.c), bd = MetaAdapter.build(d.r, d.c);
    let foot = `Grid ${Fmt.grid(d.r, d.c)} ${MID2} PWR ${def.power > 0 ? '+' : GLYPH.minus}${Math.abs(def.power)}`;
    if (def.docks && m.id !== 'hub') foot += Sim.dockUsable(d.r, d.c) ? ` ${MID2} Berth clear` : ` ${MID2} <span class="bad">${GLYPH.down} Berth blocked</span>`;
    let body = `<div class="tt-title">${esc(def.name)}</div><p class="tt-body">${esc(def.desc)}</p>`;
    if (bd && bd.building) body += `<p class="tt-body ice">${GLYPH.sq} Under construction ${MID2} ${Fmt.ms(bd.remainingMs)}</p>`;
    else if (hp) body += `<p class="tt-body ${hp.ready ? 'good' : ''}">${hp.ready ? GLYPH.up : GLYPH.sq} Banked ${Fmt.n(Math.floor(hp.bank))} / ${Fmt.n(hp.cap)} ${MID2} +${Fmt.n(hp.rate)}/min</p>`;
    body += `<div class="tt-foot">${foot}</div>`;
    const host = $('#world'), hr = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
    const x = p ? hr.left + p.x : (d.x || 0), y = p ? hr.top + p.y : (d.y || 0);
    Overlays.tooltipAt(x + 10, y + 10, body, famHue(m.id), `cell:${d.r},${d.c}`);
  },
  onShipHover(d) {
    if (!d || !d.ship) { if (this._hoverTip && this._hoverTip.ship) { this._hoverTip = null; Overlays.hideTooltip(); } return; }
    const sh = d.ship, co = coDef(sh.company), cls = SHIP_CLASSES[sh.cls];
    const held = Object.values(sh.cargo || {}).reduce((a, q) => a + Math.max(0, q), 0);
    const state = sh.state === 'docked' ? `Docked ${MID2} leaves in ${Math.max(0, sh.dockedUntil - Sim.now()).toFixed(1)} d` : sh.state === 'queue' ? `${GLYPH.sq} Holding ${Math.max(0, Sim.now() - sh.waitStart).toFixed(1)} d for a berth` : sh.state === 'approach' ? 'On approach' : 'Departing';
    const goodIc = g => `<span style="color:${kindHue(GOODS[g].kind)}" title="${esc(GOODS[g].name)}">${icon(g, 14)}</span>`;
    const hold = Object.entries(sh.cargo || {}).filter(([, q]) => q > 0);
    let h = `<div class="tt-title">${esc(co ? co.name : sh.company)}</div><p class="tt-body">${cls.name} ${MID2} ${esc(sh.captain)} ${MID2} crew ${sh.crew}</p><p class="tt-body${sh.state === 'queue' ? ' warn' : ''}">${state}</p>`;
    if (hold.length) h += `<div class="tt-row"><span class="lbl">Hold</span>${hold.map(([g, q]) => goodIc(g) + `<span class="num">${q}</span>`).join('')}</div>`;
    if (sh.wants && sh.wants.length) h += `<div class="tt-row"><span class="lbl">Wants</span>${sh.wants.map(goodIc).join('')}</div>`;
    h += `<div class="tt-foot">${esc(cls.name)} ${MID2} Hold ${held}/${cls.cargo}</div>`;
    this._hoverTip = { ship: true };
    Overlays.tooltipAt(d.x || 0, d.y || 0, h, coHue(sh.company), 'ship:' + sh.id);
  },

  // ---------------------------------------------------------- speed (0.4)
  setSpeed(sp) {
    const s = S(); if (!s) return;
    s.speed = sp; if (sp > 0) this._lastSpeed = sp;
    for (const b of $$('#speed button')) { const on = +b.dataset.speed === sp; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    EngineAdapter.setPaused(sp === 0);
    document.body.toggleAttribute('data-paused', sp === 0);
  },
  togglePause() { const s = S(); if (s) this.setSpeed(s.speed ? 0 : (this._lastSpeed || 1)); },

  // ---------------------------------------------------------- keyboard (5.1)
  onKey(e) {
    if (document.body.getAttribute('data-screen') === 'title') return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) { if (e.key === 'Escape') e.target.blur(); return; }
    if (Overlays.anyOpen()) { if (e.key === 'Escape') Overlays.escModal(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || !S()) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { if (EngineAdapter.placing()) this.place(null); else if (EngineAdapter.selected()) this.deselect(); else if (this.panel) this.closePanel(); }
    else if (e.code === 'Space') { e.preventDefault(); this.togglePause(); }
    else if (e.key === '1') this.setSpeed(1); else if (e.key === '2') this.setSpeed(2); else if (e.key === '4') this.setSpeed(4);
    else if (e.key === '?') Overlays.keys();
    else if (KEY_PANEL[k]) this.openPanel(this.panel === KEY_PANEL[k] ? null : KEY_PANEL[k]);
  },

  // ---------------------------------------------------------- transmissions (6.8)
  showEvent() {
    const s = S(), ev = s && s.pending; if (!ev) return;
    const alert = ev.id === 'pirates' || ev.id === 'outbreak';
    const srcCo = ev.id === 'contract' && ev.data && ev.data.company ? coDef(ev.data.company) : null;
    const after = () => { if (alert) this.raiseAlert(ev.id); this.refresh(); };
    const actions = ev.choice
      ? [{ label: ev.yes, primary: true, fn: () => { Sim.resolveEvent(true); after(); } }, { label: ev.no, ghost: true, fn: () => { Sim.resolveEvent(false); after(); } }]
      : [{ label: 'Acknowledge', primary: true, fn: () => { Sim.resolveEvent(true); after(); } }];
    if (alert) Sound.alert();
    Overlays.modal({ kind: alert ? 'alert' : 'event', tag: `Transmission ${MID2} ${Fmt.day(s.day)} ${MID2} ${srcCo ? srcCo.name : 'Sector comms'}`, title: ev.title, html: esc(ev.text), actions, dismissible: false });
  },
  modalOpen() { return Overlays.anyOpen(); },
  escModal() { Overlays.escModal(); },
  confirm(title, html, fn, o) { return Overlays.confirm(title, html, fn, o); },
  toast(msg, kind, o) { return Overlays.toast(msg, kind, o); },
  anchor(name) { return $(name === 'credits' ? '#ro-credits .ro-val' : name === 'am' ? '#v-am' : name === 'rank' ? '#ro-rank' : '#ro-credits'); },
  // a glyph landed on an anchor: 1.0 → 1.08 → 1.0 over 260ms, later hits a short pulse (2.6)
  anchorHit(name) {
    const chip = $(name === 'am' ? '#ro-am' : name === 'rank' ? '#ro-rank' : '#ro-credits'); if (!chip) return;
    const first = !chip.classList.contains('hit');
    chip.classList.remove('hit', 'hit2'); void chip.offsetWidth; chip.classList.add(first ? 'hit' : 'hit2');
    clearTimeout(chip._hitT); chip._hitT = setTimeout(() => chip.classList.remove('hit', 'hit2'), first ? 260 : 120);
    if (name === 'am') Counter.lit($('#v-am'), 'up'); else if (name === 'credits') Counter.lit($('#v-credits'), 'up');
  },

  // ---------------------------------------------------------- celebrations (2.6)
  celebrate(kind, data = {}) {
    const d = Object.assign({}, data);
    const fxLevel = () => EngineAdapter.fx('levelUp');
    let spec;
    switch (kind) {
      case 'rank': spec = { kicker: 'Commander promoted', title: `Rank ${d.level || MetaAdapter.rank().level} ${MID2} ${d.title || MetaAdapter.rank().title}`, reward: d.reward || { am: 10 * (d.level || 1) }, hue: 'amber', fx: fxLevel }; break;
      case 'level': spec = { kicker: 'Station threshold', title: `Level ${d.level} ${MID2} ${TIER_NAMES[d.level] || 'Galactic Hub'}`, sub: 'New modules unlocked', hue: 'amber', fx: fxLevel }; break;
      case 'unlock': spec = { kicker: 'Route charted', title: `Sector unlocked ${MID2} ${MetaAdapter.sectorDef(d.id).name || d.id}`, hue: 'ice', fx: fxLevel }; break;
      case 'mission': spec = { kicker: 'Mission complete', title: d.title || 'Mission complete', reward: d.reward, hue: 'amber' }; break;
      case 'expedition': spec = { kicker: 'Expedition returned', title: MetaAdapter.sectorDef(d.sector).name || d.title || 'Debrief', reward: d.loot || d.reward, hue: 'ice' }; break;
      case 'purchase': spec = { kicker: 'Vault credited', title: d.title || (d.granted && d.granted.am ? `+${Fmt.n(d.granted.am)} Antimatter` : d.name || 'Purchase complete'), reward: d.granted || d.reward, hue: 'am' }; break;
      case 'daily': spec = { kicker: `Day ${(d.dayIndex != null ? d.dayIndex + 1 : d.streak) || 1} of your streak`, title: 'Daily reward', reward: d.reward, hue: 'amber' }; break;
      default: spec = { kicker: d.kicker || '', title: d.title || kind, reward: d.reward, hue: d.hue || 'amber' };
    }
    if (d.kicker) spec.kicker = d.kicker; if (d.titleOverride) spec.title = d.titleOverride; if (d.sub) spec.sub = d.sub;
    Overlays.celebrate(kind, spec);
  },

  // ---------------------------------------------------------- bus reactions (0.6)
  onCollect(d) {
    if (!d) return;
    const target = this.anchor('credits');
    const p = EngineAdapter.fx('collect', d.r, d.c, d.amount, target);
    Sound.collect(d.amount);
    const done = () => { this.anchorHit('credits'); this.refreshTop(); };
    if (p && typeof p.then === 'function') p.then(done, done);
    else {
      const pt = EngineAdapter.cellToScreen(d.r, d.c), host = $('#world'), hr = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
      Overlays.fly(pt ? { x: hr.left + pt.x, y: hr.top + pt.y } : $('#rail'), target, { n: Math.max(8, Math.min(14, Math.round((d.amount || 0) / 50))), icon: 'credits', onHit: () => this.anchorHit('credits') }).then(done);
    }
    this.refresh();
  },
  onBuildDone(d) {
    if (!d) return;
    Sound.built();
    const name = MODULES[d.id] ? MODULES[d.id].name : 'Module';
    this.toast(`${name} online`, 'good', { icon: 'build', chip: 'Build', action: { label: 'Focus', fn: () => { this.focusCell(d.r, d.c); this.select(d.r, d.c); } } });
    this.refresh();
  },
  onLevelUp(level) {
    document.body.setAttribute('data-level', String(level));
    this.celebrate('level', { level });
    this.refresh();
  },
  onMission(d) {
    if (!d) return;
    if (d.state === 'complete') { const m = MetaAdapter.missions().find(x => x.id === d.id); this.toast(`Mission complete: ${m ? m.title : d.id}`, 'gold', { icon: 'missions', chip: 'Mission', action: { label: 'Claim', fn: () => this.openPanel('missions') } }); }
    this.refreshBadges(); if (this.panel === 'missions' && this._inst) this._inst.update();
  },
  onExpedition(d) {
    if (!d) return;
    if (d.state === 'ready') this.toast(`Expedition back from ${MetaAdapter.sectorDef(d.sector || '').name || 'the lanes'}`, 'info', { icon: 'expeditions', chip: 'Expedition', action: { label: 'Debrief', fn: () => this.openPanel('expeditions') } });
    this.refreshBadges(); this.refreshNextUp(); if (this.panel === 'expeditions' && this._inst) this._inst.update();
  },
  onDiscover(d) {
    if (!d) return;
    const col = MetaAdapter.collection(), list = col[d.kind] || col[d.kind + 's'] || [];
    const it = list.find(x => x.id === d.id);
    this.toast(`New in the registry: ${it ? it.name : d.id}`, 'gold', { icon: 'registry', chip: 'Registry', action: { label: 'View', fn: () => this.openPanel('registry') } });
    this.refreshBadges();
  },
  // Store bus payload (7.2): { sku, granted, mode, grantId, pending, cancelled, error, message, restored }
  onPurchase(d) {
    if (!d) return;
    const item = StoreAdapter.catalog().find(i => i.sku === d.sku) || {};
    if (d.cancelled) { if (d.sku) this.toast('Purchase cancelled', 'info', { chip: 'Store' }); return; }
    if (d.error) { this.toast(d.message || `Purchase failed (${d.error})`, 'bad', { chip: 'Store' }); Sound.error(); return; }
    if (d.pending && !d.granted) { this.toast(`${item.title || 'Purchase'} recorded. It is applied when your profile loads.`, 'info', { chip: 'Store' }); return; }
    if (!d.granted) return;
    const grant = item.grant || {};
    const am = typeof d.granted === 'object' && d.granted.am ? d.granted.am : grant.am;
    const credits = typeof d.granted === 'object' && d.granted.credits ? d.granted.credits : (grant.credits && grant.credits.fixed) || 0;
    if (d.restored) { this.toast(`Restored: ${item.title || d.sku}`, 'good', { chip: 'Store' }); this.refresh(); return; }
    const reward = {}; if (am) reward.am = am; if (credits) reward.credits = credits; if (grant.unlockAll) reward.label = 'Every sector unlocked'; if (grant.payload && grant.payload.title) reward.title = grant.payload.title;
    this.celebrate('purchase', { sku: d.sku, title: am && !grant.entitlement ? `+${Fmt.n(am)} Antimatter` : item.title, reward });
    const from = $('#panel') || $('#rail');
    if (am) Overlays.fly(from, this.anchor('am'), { n: Math.min(14, Math.max(6, Math.round(am / 40))), icon: 'am', hue: 'am', onHit: () => this.anchorHit('am') });
    if (credits || (grant.credits && grant.credits.hours)) Overlays.fly(from, this.anchor('credits'), { n: 10, icon: 'credits', onHit: () => this.anchorHit('credits') });
    this.refresh();
  },
  showAway(d) {
    if (!d) return;
    const banked = d.banked != null ? d.banked : d.credits;
    Overlays.away(Object.assign({}, d, { banked }), { onCollect: banked && MetaAdapter.canCollectAll() ? () => this.collectAll() : null });
  },
  openDaily() {
    const d = MetaAdapter.daily();
    if (!d) { this.toast('Daily rewards need a profile', 'warn'); return; }
    Overlays.daily(d, {
      onClaim: () => { const rw = MetaAdapter.claimDaily(); if (rw) { this.celebrate('daily', Object.assign({ reward: rw }, MetaAdapter.daily() || {})); Overlays.fly($('#btn-daily'), this.anchor(rw.am ? 'am' : 'credits'), { n: 8, icon: rw.am ? 'am' : 'credits', hue: rw.am ? 'am' : 'amber', onHit: () => this.anchorHit(rw.am ? 'am' : 'credits') }); } this.refresh(); },
      onRepair: () => { if (MetaAdapter.repairStreak()) this.toast('Streak repaired', 'good'); else this.toast('Not enough Antimatter', 'bad'); this.refresh(); },
    });
  },

  // ---------------------------------------------------------- panel verbs (called by panels.js through ctx.ui)
  collect(r, c) {
    const hp = MetaAdapter.hopper(r, c);
    if (!hp || hp.bank < 1) { this.toast('Nothing banked here yet', 'warn'); return; }
    const got = MetaAdapter.collect(r, c);
    if (got === false || got == null) this.toast('Collecting needs the station link (Meta)', 'warn');
  },
  collectAll(btn) {
    const total = MetaAdapter.collectAll();
    if (total && total > 0) {
      Overlays.fly(btn || $('#panel') || $('#rail'), this.anchor('credits'), { n: 12, icon: 'credits', onHit: () => this.anchorHit('credits') });
      Sound.collect(total);
      this.toast(`Collected ${Fmt.n(total)} credits from every hopper`, 'good', { chip: 'Bank', icon: 'collect' });
    }
    this.refresh();
  },
  skipBuild(r, c) {
    const bd = MetaAdapter.build(r, c); if (!bd || !bd.building) return;
    const name = S() && S().grid[r][c] ? MODULES[S().grid[r][c].id].name : 'the build';
    this.confirm('Skip the wait?', `Finish <b>${esc(name)}</b> now for <b class="c-am">${bd.skipAM} AM</b>. You have ${Fmt.n(MetaAdapter.am())} AM.`, () => {
      if (!MetaAdapter.skipBuild(r, c)) { this.toast('Not enough Antimatter', 'bad'); Sound.error(); }
      this.refresh();
    }, { kind: 'store', yes: `Skip ${MID2} ${bd.skipAM} AM`, am: true, tag: 'Antimatter' });
  },
  upgrade(r, c) {
    const up = MetaAdapter.upgrade(r, c); if (!up || !up.next) return;
    const s = S(); if (s && s.credits < up.next.cost) { this.toast(`Need ${Fmt.n(up.next.cost - s.credits)} more credits`, 'warn'); return; }
    if (MetaAdapter.upgradeModule(r, c)) { this.toast(`Upgrade started ${MID2} level ${up.lvl + 1}`, 'good', { icon: 'upgrade', chip: 'Upgrade' }); Sound.click(); } else this.toast('Upgrade needs the station link (Meta)', 'warn');
    this.refresh();
  },
  demolish(r, c) {
    const s = S(); const m = s && s.grid[r] && s.grid[r][c]; if (!m) return;
    const hp = MetaAdapter.hopper(r, c), d = MODULES[m.id];
    this.confirm(`Scrap ${d.name}?`, `Scrapping returns <b>${Fmt.n(d.cost * 0.5)}</b> credits.${hp && hp.bank >= 1 ? ` The <b>${Fmt.n(Math.floor(hp.bank))}</b> credits banked in its hopper are lost.` : ''}`, () => {
      if (Sim.demolish(r, c)) { this.deselect(); Sound.close(); }
    }, { yes: 'Scrap it', danger: true, tag: 'Confirm' });
  },
  rename(name) {
    const s = S(); if (!s) return;
    const n = String(name || '').trim().slice(0, 28); if (!n || n === s.name) return;
    s.name = n; if (has(Sim, 'emit')) Sim.emit('change'); call(Sim, 'save', [], undefined);
    this.toast(`Registry updated: ${n} ${MID2} ${regOf(n)}`, 'good', { chip: 'Station' });
  },
  lendDialog(companyId) {
    const s = S(); const co = s && s.companies[companyId], c = coDef(companyId); if (!co || !c) return;
    const rate = Math.round((0.25 - co.trust / 100 * 0.1) * 100), max = Math.max(0, Math.floor(s.credits));
    Overlays.modal({
      kind: 'lend', tag: `Loan desk ${MID2} ${Fmt.day(s.day)} ${MID2} ${c.name}`, title: `Lend to ${c.name}`,
      html: `Trust <span class="num">${co.trust}/100</span> sets the rate at <b>${rate}%</b>, repaid over 10 days. Lower trust means a higher rate but a real chance of default. You have <span class="num">${Fmt.n(max)}</span> credits.`,
      extra: `<input type="number" id="lend-amt" class="input" min="500" step="100" max="${max}" value="${Math.min(max, 2000)}" aria-label="Loan amount">`,
      actions: [{ label: 'Lend', primary: true, fn: () => { const inp = $('#lend-amt'); Sim.lend(companyId, inp ? +inp.value : 0); } }, { label: 'Cancel', ghost: true }],
    });
  },
  travel(id) {
    const def = MetaAdapter.sectorDef(id);
    Sound.warp();
    const p = EngineAdapter.fx('warp');
    document.body.setAttribute('data-warp', '');
    const go = () => {
      // Meta refuses locked or unknown sectors; a success emits sector 'switched', which the engine
      // follows with its own setSector (no second rebuild here)
      const res = MetaAdapter.switchSector(id);
      const ok = res === true || (res && typeof res === 'object' && res.ok !== false && !res.why);
      document.body.removeAttribute('data-warp');
      if (!ok) { this.toast((res && res.why) || `${def.name || id} is not open yet`, 'warn'); Sound.error(); this.refresh(); return; }
      document.body.setAttribute('data-sector', id);
      this.toast(`Arrived at ${def.name || id}`, 'info', { icon: 'planet', chip: 'Sector' });
      this.refresh();
      if (this.panel === 'map' && this._inst && this._inst.pick) this._inst.pick(id);
    };
    if (p && typeof p.then === 'function') p.then(go, go); else setTimeout(go, Motion.reduced() ? 0 : 450);
  },
  unlock(id, withAM) {
    const def = MetaAdapter.sectorDef(id), amCost = def.unlock && (def.unlock.am || def.unlock.AM);
    const doIt = () => {
      const res = MetaAdapter.unlockSector(id, withAM);
      const ok = res === true || (res && res.ok !== false);
      if (!ok) { this.toast((res && res.why) || 'That route is not open yet', 'warn'); Sound.error(); }
      this.refresh();
    };
    if (withAM) this.confirm(`Unlock ${def.name}?`, `Open the route now for <b class="c-am">${amCost} AM</b>. You have ${Fmt.n(MetaAdapter.am())} AM.`, doIt, { kind: 'store', yes: `Unlock ${MID2} ${amCost} AM`, am: true, tag: 'Antimatter' });
    else this.confirm(`Unlock ${def.name}?`, `${esc(def.flavour || def.flavor || 'A new station, a new world, the same wallet.')}${def.unlock && def.unlock.credits ? `<br><br>Costs <b>${Fmt.n(def.unlock.credits)}</b> credits.` : ''}`, doIt, { yes: 'Unlock', tag: 'Galaxy' });
  },
  launch(sectorId) {
    const res = MetaAdapter.launchExpedition(sectorId);
    const ok = res === true || (res && res.ok !== false);
    if (ok) { Sound.open(); this.toast(`Expedition launched to ${MetaAdapter.sectorDef(sectorId).name || sectorId}`, 'info', { icon: 'expeditions', chip: 'Expedition' }); }
    else { this.toast((res && res.why) || 'The expedition could not launch', 'warn'); Sound.error(); }
    this.refresh();
  },
  debrief(id, btn) {
    const x = MetaAdapter.expeditions().find(e => String(e.id) === String(id));
    const loot = MetaAdapter.claimExpedition(id);
    if (!loot) { this.toast('Debrief needs the station link (Meta)', 'warn'); return; }
    this.celebrate('expedition', { sector: x ? x.sector : '', loot });
    if (loot.credits) Overlays.fly(btn || $('#panel'), this.anchor('credits'), { n: 8, icon: 'credits', onHit: () => this.anchorHit('credits') });
    if (loot.am) Overlays.fly(btn || $('#panel'), this.anchor('am'), { n: 6, icon: 'am', hue: 'am', onHit: () => this.anchorHit('am') });
    this.refresh();
  },
  instantReturn(id) {
    const x = MetaAdapter.expeditions().find(e => e.id === id); if (!x) return;
    const am = Math.max(1, Math.ceil(Math.max(0, x.endsAt - Date.now()) / 60000 / 8));
    this.confirm('Bring them home now?', `Instant return from <b>${esc(MetaAdapter.sectorDef(x.sector).name || x.sector)}</b> for <b class="c-am">${am} AM</b>. The loot is the same.`, () => {
      if (!MetaAdapter.skipExpedition(id)) { this.toast('Not enough Antimatter', 'bad'); Sound.error(); }
      this.refresh();
    }, { kind: 'store', yes: `Return ${MID2} ${am} AM`, am: true, tag: 'Antimatter' });
  },
  claimMission(id, btn) {
    const m = MetaAdapter.missions().find(x => x.id === id);
    const res = MetaAdapter.claimMission(id);
    if (res === false || res == null) { this.toast('Claiming needs the station link (Meta)', 'warn'); return; }
    const reward = (res && typeof res === 'object' && (res.credits || res.am || res.xp)) ? res : (m && m.reward) || {};
    const from = btn || $('#panel');
    if (reward.credits) Overlays.fly(from, this.anchor('credits'), { n: 8, icon: 'credits', onHit: () => this.anchorHit('credits') });
    if (reward.am) Overlays.fly(from, this.anchor('am'), { n: 6, icon: 'am', hue: 'am', onHit: () => this.anchorHit('am') });
    if (reward.xp) Overlays.fly(from, this.anchor('rank'), { n: 4, icon: 'xp', hue: 'ice', onHit: () => this.anchorHit('rank') });
    this.celebrate('mission', { title: m ? m.title : 'Mission complete', reward });
    this.refresh();
  },
  // Store.purchase never rejects: { ok, granted, pending, cancelled, redirect, error, message }.
  // Outcomes toast / celebrate through the bus `purchase` event (onPurchase); only the redirect is handled here.
  purchase(sku, btn) {
    const item = StoreAdapter.catalog().find(i => i.sku === sku);
    if (!item || item.owned) return;
    btn && btn.classList.add('busy');
    StoreAdapter.purchase(sku).then(res => {
      btn && btn.classList.remove('busy');
      if (res && res.redirect) this.toast('Redirecting to checkout…', 'info', { chip: 'Store', ms: 8000 });
      else if (res && !res.ok && !res.cancelled && res.error && !StoreAdapter.present()) this.toast(res.message || res.error, 'bad', { chip: 'Store' });
      this.refresh();
    }).catch(() => { btn && btn.classList.remove('busy'); this.toast('The store did not answer', 'bad'); });
  },
  // Store.restore(email?) -> { ok, mode, applied: [...], found, message, error }
  restore(email) {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { this.toast('That does not look like an email address', 'warn'); return; }
    StoreAdapter.restore(email || undefined).then(res => {
      if (!res) return;
      const n = Array.isArray(res.applied) ? res.applied.length : 0;
      if (!res.ok) this.toast(res.message || 'Restore failed', 'bad', { chip: 'Store' });
      else if (n) this.toast(`Restored ${Fmt.plural(n, 'purchase')}`, 'good', { chip: 'Store' });
      else this.toast(res.message || (res.found ? 'Everything is already applied' : 'Nothing to restore'), 'info', { chip: 'Store' });
      this.refresh();
    });
  },
  setSetting(key, value) {
    const st = MetaAdapter.settings();
    if (key === 'perf') value = value === 'auto' ? 'auto' : Number(value);
    st[key] = value;
    if (key === 'motion') Motion.setOverride(value);
    else if (key === 'perf') EngineAdapter.setPerf(value);
    else if (key === 'perfTag') { const t = $('#perf-tag'); if (t) t.hidden = !value; }
    MetaAdapter.saveSettings();
  },
  scrapStation() {
    this.confirm('Scrap this station?', 'A fresh Core Hub takes its place in this sector. Your rank, Antimatter, registry and other sectors stay.', () => {
      this.confirm('Really scrap it?', 'Every module here is gone for good.', () => {
        if (MetaAdapter.scrapStation()) { EngineAdapter.setSelected(null); EngineAdapter.setPlacing(null); const s = S(); EngineAdapter.setSector(MetaAdapter.sectorDef(MetaAdapter.activeSector()), s); this.resetProgress(); this.toast('New station commissioned', 'good'); this.refresh(); }
      }, { yes: 'Scrap everything', danger: true });
    }, { yes: 'Continue', danger: true });
  },
  resetProfile() {
    this.confirm('Reset the whole profile?', 'Every sector, your rank, Antimatter and the registry are erased from this browser.', () => {
      this.confirm('Last chance', 'This cannot be undone. Purchases can be restored from the Store later.', () => MetaAdapter.resetProfile(), { yes: 'Erase everything', danger: true });
    }, { yes: 'Continue', danger: true });
  },

  // ---------------------------------------------------------- new station (0.4)
  resetProgress() {
    this.sig = {};
    const rb = $('.rail-btn[data-panel="build"]'); if (rb) rb.classList.add('pulse');
    this._alert = { kind: null, until: 0 };
    if (this._inst) this._inst.update();
  },

  // ---------------------------------------------------------- title screen helpers (5.4; main.js owns the flow)
  // data = { name, day, level, credits, am, banked, rank: { level, title }, sector, thumb: HTMLCanvasElement|null }
  setTitleResume(data) {
    const meta = $('#resume-meta'), rank = $('#resume-rank'), name = $('#resume-name'), thumb = $('#title-thumb');
    if (rank) rank.textContent = data.rank ? `Commander ${MID2} Rank ${data.rank.level} ${data.rank.title}` : 'Commander';
    if (name) name.textContent = data.name || '';
    if (meta) meta.innerHTML = `<span>${esc(MetaAdapter.sectorDef(data.sector || 'home').name || 'Home')}</span><span>${Fmt.day(data.day || 1)}</span><span>L${data.level || 1} ${esc(TIER_NAMES[data.level || 1] || '')}</span><span class="c-amber-hi">${Fmt.n(data.credits || 0)} cr</span><span class="c-am">${Fmt.n(data.am || 0)} AM</span>${data.banked ? `<span class="c-good">${Fmt.n(data.banked)} cr waiting</span>` : ''}`;
    if (thumb && data.thumb) { thumb.width = data.thumb.width; thumb.height = data.thumb.height; thumb.getContext('2d').drawImage(data.thumb, 0, 0); }
  },
};

// ============================================================
// WAYSTATION v2 — Meta: profile, wallet and Antimatter, hoppers (banks),
// build timers and skips, upgrades, sectors, expeditions, missions, daily
// streak, commander rank, collection, convoy window, store grants.
// Engineer S. Source of truth: DESIGN2.md 0.5, 0.6, 4.x, 6, 7.1.
// Loads after sim.js (0.1). Timers are wall-clock (Date.now()).
// ============================================================
'use strict';

const PROFILE_KEY = 'waystation.profile.v2';
const DAY_MS = 86400e3;

const cellKey = (r, c) => `${r},${c}`;
const pad2 = n => String(n).padStart(2, '0');

const Meta = {
  profile: null,
  _offline: null,                 // the "while you were away" summary, read once through offlineSummary
  _acc: null,                     // per-session accumulators (mission throttle, autosave, inactive-sector accrual)
  _convoyWas: null,
  _bankCarry: 0,                  // fractional XP from collected credits

  now() { return Date.now(); },

  // ---------------------------------------------------------- 4.12 profile: create, load, migrate, save, export, import
  _newProfile(now) {
    return {
      v: 2, playerId: `p${now.toString(36)}${irnd(0, 2 ** 30).toString(36)}`, createdAt: now, lastSeenAt: now, savedAt: 0,
      credits: TIMERS.START_CREDITS, am: TIMERS.START_AM,
      rank: { xp: 0, level: 1 },
      activeSector: 'home', unlocked: ['home'], sectors: {},
      collection: { found: {}, sets: {} },
      missions: { completed: {}, claimed: {}, progress: {} },
      daily: { streak: 0, lastClaimAt: 0, lastClaimKey: null },
      expeditions: { list: [], nextId: 1, charts: {}, runs: {} },
      achievements: { completed: {}, claimed: {} },           // A1.3: id -> tiers reached / tiers claimed (0..3)
      entitlements: { owned: {}, history: [], liveries: [], titles: [], tokens: { livery: 0 }, sectorPass: false, redeemed: [] },   // redeemed: sector liveries bought with a livery token (A5)
      settings: { sound: true, music: true, sfxVolume: 0.8, musicVolume: 0.5, reducedMotion: null, perf: null, livery: 'default' },
      stats: { collects: 0, collectedCredits: 0, transmissions: 0, expeditionsLaunched: 0, expeditionsClaimed: 0, discoveries: 0,
        buildsPlaced: 0, buildsDone: 0, upgrades: 0, skips: 0, amEarned: 0, amSpent: 0, amBought: 0, convoyServed: 0, servedTotal: 0,
        instantBuilds: 0, sectorsUnlocked: 0, dailyClaims: 0, missionsClaimed: 0,
        residentsPeak: 0, aurelianServed: 0, plotRings: 0 },       // A1.3 lifetime stats (migration defaults through _fixup)
      migratedFrom: null,
    };
  },

  _freshAcc(now) { return { lastMission: 0, missionDirty: true, lastSave: now, lastInactive: now }; },

  _readJSON(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  },
  _validProfile(p) { return !!(p && p.v === 2 && p.sectors && p.activeSector && p.sectors[p.activeSector]); },

  // forward-compatible fix-ups; every saved station goes through Sim.sanitize
  _fixup(p, now) {
    const fresh = this._newProfile(now);
    for (const k in fresh) if (p[k] === undefined) p[k] = fresh[k];
    for (const k of ['rank', 'collection', 'missions', 'daily', 'expeditions', 'achievements', 'entitlements', 'settings', 'stats']) {
      p[k] ||= {};
      for (const f in fresh[k]) if (p[k][f] === undefined) p[k][f] = fresh[k][f];
    }
    p.collection.found ||= {}; p.collection.sets ||= {};
    p.expeditions.list ||= []; p.expeditions.charts ||= {}; p.expeditions.runs ||= {};
    p.entitlements.history ||= []; p.entitlements.owned ||= {}; p.entitlements.liveries ||= []; p.entitlements.titles ||= []; p.entitlements.tokens ||= { livery: 0 };
    p.entitlements.redeemed ||= [];
    if (typeof p.settings.livery !== 'string' || !p.settings.livery) p.settings.livery = 'default';
    for (const id in p.sectors) { const st = Sim.sanitize(p.sectors[id]); if (!st) delete p.sectors[id]; else st.sector = SECTORS[id] ? id : st.sector; }
    if (!p.sectors[p.activeSector]) p.activeSector = p.sectors.home ? 'home' : Object.keys(p.sectors)[0];
    if (!p.activeSector) { p.sectors.home = Sim.makeState('home'); p.activeSector = 'home'; }
    p.unlocked = Array.isArray(p.unlocked) ? p.unlocked.filter(id => SECTORS[id]) : [];
    for (const id in p.sectors) if (!p.unlocked.includes(id)) p.unlocked.push(id);
    p.unlocked.sort((a, b) => SECTORS[a].index - SECTORS[b].index);
    p.rank.xp = Math.max(0, Number(p.rank.xp) || 0);
    p.rank.level = Math.max(this._rankFor(p.rank.xp).level, p.rank.level || 1);
    if (typeof p.credits !== 'number' || !isFinite(p.credits)) p.credits = p.sectors[p.activeSector].credits || 0;
    if (typeof p.am !== 'number' || !isFinite(p.am)) p.am = 0;
    return p;
  },

  _bindActive() {
    const p = this.profile;
    Sim.state = p.sectors[p.activeSector];
    Sim.state.credits = p.credits;
    Sim.floaters = [];
  },

  // 4.12: the v1 save becomes sectors.home; its key is renamed to .bak
  _migrateV1(now) {
    let raw = null;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { raw = null; }
    if (!raw) return null;
    let s = null;
    try { s = Sim.sanitize(JSON.parse(raw)); } catch (e) { s = null; }
    try { localStorage.setItem(`${SAVE_KEY}.bak`, raw); localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    if (!s) return null;
    s.sector = 'home'; s.pending = s.pending || null;
    for (const k in s.cells) { s.cells[k] = { lvl: 1, bank: 0, readyAt: null, builtAt: now, at: now }; }
    const p = this._newProfile(now);
    p.sectors.home = s; p.credits = s.credits;
    p.rank.xp = (s.stats.shipsServed || 0) * ECON.xp.served;
    p.rank.level = this._rankFor(p.rank.xp).level;
    p.stats.instantBuilds = TIMERS.TUTORIAL_INSTANT_BUILDS;      // an established station is not a brand-new profile
    p.stats.servedTotal = s.stats.shipsServed || 0;
    p.migratedFrom = 'v1';
    return p;
  },

  // load or create, migrate, settle timers, compute the offline summary. Returns { resumed, migrated }.
  init() {
    const now = this.now();
    let p = this._readJSON(PROFILE_KEY), resumed = false, migrated = false;
    if (!this._validProfile(p)) p = null;
    if (p) resumed = true;
    else { p = this._migrateV1(now); if (p) { resumed = true; migrated = true; } }
    if (!p) { p = this._newProfile(now); p.sectors.home = Sim.makeState('home'); }
    this.profile = p;
    this._fixup(p, now);
    this._acc = this._freshAcc(now);
    this._offline = null;
    this._bindActive();
    if (resumed) this._offlineCatchUp(now);
    p.lastSeenAt = now;
    this._convoyWas = this.convoyActive();
    this.evalMissions(now, true);
    this.save(now);
    return { resumed, migrated };
  },

  save(now = this.now()) {
    const p = this.profile; if (!p) return false;
    this._syncWallet();
    p.lastSeenAt = now; p.savedAt = now;
    if (this._acc) this._acc.lastSave = now;
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); return true; } catch (e) { return false; }
  },

  // re-read the stored profile and bind it (no offline pass; init() does that)
  load() {
    const p = this._readJSON(PROFILE_KEY);
    if (!this._validProfile(p)) return false;
    const now = this.now();
    this.profile = p; this._fixup(p, now); this._acc = this._freshAcc(now); this._bindActive();
    this._convoyWas = this.convoyActive();
    return true;
  },

  export() { if (!this.profile) return ''; this._syncWallet(); return JSON.stringify(this.profile); },

  import(json) {
    let p = null;
    try { p = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return { ok: false, why: 'Not valid JSON' }; }
    if (!this._validProfile(p)) return { ok: false, why: 'Not a Waystation v2 profile' };
    const now = this.now();
    this.profile = p; this._fixup(p, now); this._acc = this._freshAcc(now); this._offline = null;
    this._bindActive();
    this._convoyWas = this.convoyActive();
    this.evalMissions(now, true);
    this.save(now);
    Sim.emit('sector', { id: p.activeSector, state: 'switched' });
    Sim.emit('change'); Sim.emit('log');
    return { ok: true };
  },

  resetProfile() {
    try { localStorage.removeItem(PROFILE_KEY); } catch (e) { /* ignore */ }
    const now = this.now(), p = this._newProfile(now);
    p.sectors.home = Sim.makeState('home');
    this.profile = p; this._acc = this._freshAcc(now); this._offline = null; this._bankCarry = 0;
    this._bindActive();
    this._convoyWas = this.convoyActive();
    this.evalMissions(now, true);
    this.save(now);
    Sim.emit('sector', { id: 'home', state: 'switched' });
    Sim.emit('change'); Sim.emit('log');
  },

  // Sim.newGame(sectorId) hands its fresh station here: it becomes the active sector's station (scrap and recommission)
  onNewGame(state) {
    const p = this.profile; if (!p) return;
    const id = state.sector;
    p.sectors[id] = state; p.activeSector = id;
    if (!p.unlocked.includes(id)) { p.unlocked.push(id); p.unlocked.sort((a, b) => SECTORS[a].index - SECTORS[b].index); }
    state.credits = p.credits;
    Sim.state = state;
    this._dirty();
    Sim.emit('sector', { id, state: 'switched' });
    this.save();
  },

  newStationHere() { if (!this.profile) return; Sim.newGame(this.profile.activeSector); },

  renameStation(name) {
    if (!Sim.state) return false;
    const n = String(name || '').trim().slice(0, 28);
    if (!n) return false;
    Sim.state.name = n; Sim.emit('change'); return true;
  },

  // ---------------------------------------------------------- 4.2 offline: banks for min(elapsed, 12 h), timers by elapsed, 2 h of fast catch-up
  _offlineCatchUp(now) {
    const p = this.profile, elapsed = Math.max(0, now - (p.lastSeenAt || now));
    const summary = { ms: elapsed, credits: 0, banked: 0, events: 0, builds: [], expeditions: 0, served: 0, days: 0, pending: false };
    for (const id in p.sectors) {
      const st = p.sectors[id];
      summary.banked += this._accrue(st, now, TIMERS.OFFLINE_BANK_CAP_MS, false).added;
      for (const b of this._settleBuilds(st, now)) summary.builds.push(b);
      if (this._settlePlot(st, now)) summary.plots = (summary.plots || 0) + 1;
    }
    summary.expeditions = this._settleExpeditions(now);
    if (elapsed >= TIMERS.OFFLINE_MIN_MS) {
      const cu = Sim.catchUp(Math.min(elapsed, TIMERS.OFFLINE_SIM_CAP_MS));
      summary.credits = cu.credits; summary.events = cu.events; summary.served = cu.served; summary.days = cu.days; summary.pending = cu.pending;
      summary.banked = Math.round(summary.banked);
      this._offline = summary;
      Sim.emit('offline', { ms: elapsed, credits: summary.credits, banked: summary.banked, events: summary.events, builds: summary.builds.length, expeditions: summary.expeditions, served: summary.served, summary });
    }
    this._syncWallet();
    return summary;
  },

  get offlineSummary() { const s = this._offline; this._offline = null; return s; },

  // ---------------------------------------------------------- wallet (4.5: shared; Sim.state.credits is the live mirror)
  get credits() { return Sim.state ? Sim.state.credits : (this.profile ? this.profile.credits : 0); },
  get wallet() { return this.credits; },
  _syncWallet() { if (this.profile && Sim.state) this.profile.credits = Sim.state.credits; },

  addCredits(n, reason = 'grant') {
    n = Math.round(Number(n) || 0);
    if (!this.profile || !Sim.state) return 0;
    if (n) { Sim.state.credits += n; Sim.earn(n, reason); this._syncWallet(); this._dirty(); Sim.emit('change'); }
    return Sim.state.credits;
  },

  // ---------------------------------------------------------- 4.4 Antimatter
  get am() { return this.profile ? this.profile.am : 0; },
  addAM(n, reason = 'grant') {
    n = Math.round(Number(n) || 0);
    const p = this.profile; if (!p) return 0;
    if (n) {
      p.am = Math.max(0, p.am + n);
      if (n > 0) { p.stats.amEarned += n; if (reason === 'purchase') p.stats.amBought += n; }
      Sim.emit('am', { delta: n, reason, total: p.am });
      this._dirty();
    }
    return p.am;
  },
  spendAM(n, reason = 'spend') {
    n = Math.ceil(Number(n) || 0);
    const p = this.profile; if (!p) return false;
    if (n <= 0) return true;
    if (p.am < n) return false;
    p.am -= n; p.stats.amSpent += n;
    Sim.emit('am', { delta: -n, reason, total: p.am });
    return true;
  },
  // 4.4 "Relief convoy": 10 AM for 30 minutes of total station rate
  reliefConvoy() {
    const R = TIMERS.RELIEF_CONVOY, credits = Math.round(this.totalRate() * R.minutes);
    if (!this.spendAM(R.am, 'relief convoy')) return { ok: false, cost: R.am, credits };
    this.addCredits(credits, 'relief convoy');
    return { ok: true, cost: R.am, credits };
  },

  // ---------------------------------------------------------- 4.2 hoppers (banks)
  _rateBonus() { return this.rank.level >= 5 ? 1 + ECON.rankRateBonus : 1; },
  _rate(def, lvl) { return (def.rate || 0) * TIMERS.RATE_MUL[clamp(lvl, 1, 3) - 1] * this._rateBonus(); },
  _cap(def, lvl) { return Math.round(this._rate(def, lvl) * TIMERS.CAP_MINUTES[clamp(lvl, 1, 3) - 1]); },
  totalRate() {                              // active station, credits per real minute
    if (!Sim.state) return 0;
    return Sim.totals().rate * this._rateBonus();
  },
  totalRateAll() {
    const p = this.profile; if (!p) return 0;
    let r = 0; for (const id in p.sectors) r += Sim.totalsOf(p.sectors[id]).rate;
    return r * this._rateBonus();
  },
  bankedTotal(state = Sim.state) {
    if (!state || !state.cells) return 0;
    let t = 0; for (const k in state.cells) t += Math.floor(state.cells[k].bank || 0);
    return t;
  },

  // accrue every active cell of a station up to `now`; dt per cell is capped at capMs (12 h offline rule)
  _accrue(state, now, capMs, detectCrossings) {
    const out = { added: 0, crossings: [] };
    const cells = state && state.cells; if (!cells) return out;
    for (const k in cells) {
      const cell = cells[k];
      if (cell.readyAt != null && !cell.up) { cell.at = now; continue; }         // under construction: nothing accrues
      const i = k.indexOf(','), r = +k.slice(0, i), c = +k.slice(i + 1);
      const m = state.grid[r] && state.grid[r][c];
      if (!m) continue;
      const def = MODULES[m.id];
      if (!def || !def.rate) { cell.at = now; continue; }
      const lvl = cell.lvl || 1, cap = this._cap(def, lvl), rate = this._rate(def, lvl);
      const dt = Math.min(Math.max(0, now - (cell.at || now)), capMs);
      const before = cell.bank || 0;
      if (dt > 0 && before < cap) { cell.bank = Math.min(cap, before + rate * dt / 60000); out.added += cell.bank - before; }
      cell.at = now;
      if (detectCrossings) {
        const q = cap * 0.25, bank = cell.bank;
        if ((bank >= q && before < q) || (bank >= cap && before < cap)) out.crossings.push({ r, c, full: bank >= cap });
      }
    }
    return out;
  },

  hopper(r, c) {
    const s = Sim.state, cell = Sim.cellMeta(r, c); if (!s || !cell) return null;
    const m = s.grid[r][c]; if (!m) return null;
    if (cell.readyAt != null && !cell.up) return null;                              // building: no bank yet
    const def = MODULES[m.id], lvl = cell.lvl || 1, cap = this._cap(def, lvl), rate = this._rate(def, lvl);
    const bank = Math.min(cap, cell.bank || 0);
    return { bank, cap, rate, ready: bank >= cap * 0.25, full: bank >= cap, lvl };
  },

  collect(r, c) {
    const s = Sim.state, p = this.profile, cell = Sim.cellMeta(r, c); if (!s || !p || !cell) return 0;
    this._accrue(s, this.now(), TIMERS.OFFLINE_BANK_CAP_MS, false);
    const amount = Math.floor(cell.bank || 0);
    if (amount <= 0) return 0;
    cell.bank -= amount;
    s.credits += amount; Sim.earn(amount, 'banks');
    p.stats.collects++; p.stats.collectedCredits += amount;
    this._bankCarry += amount / ECON.xp.creditsPerXP;
    const whole = Math.floor(this._bankCarry); this._bankCarry -= whole;
    if (whole) this._addXP(whole, 'bank');
    this._syncWallet(); this._dirty();
    Sim.emit('collect', { r, c, amount });
    Sim.emit('change');
    return amount;
  },

  // granted at rank 3 (4.9)
  collectAll() {
    const s = Sim.state; if (!s || !this.profile) return 0;
    if (this.rank.level < 3) return 0;
    let total = 0;
    for (const k of Object.keys(s.cells)) {
      const i = k.indexOf(','), r = +k.slice(0, i), c = +k.slice(i + 1);
      if ((s.cells[k].bank || 0) >= 1) total += this.collect(r, c);
    }
    return total;
  },
  canCollectAll() { return this.rank.level >= 3; },

  // ---------------------------------------------------------- 4.3 build timers, skips, upgrades
  buildMul(state = Sim.state) { const d = state && SECTORS[state.sector]; return d ? d.buildMul : 1; },
  skipCost(remainingMs) { return Math.max(1, Math.ceil(Math.max(0, remainingMs) / 60000 / TIMERS.SKIP_MINUTES_PER_AM)); },
  // A1.1: upgrading from `lvl` takes UPGRADE_TIME_MUL[lvl - 1] x the build time (2x to level 2, 5x to level 3 in `patient`)
  upgradeMs(def, lvl, state = Sim.state) { const M = TIMERS.UPGRADE_TIME_MUL, m = Array.isArray(M) ? M[clamp(lvl, 1, 2) - 1] : M; return Math.round((def.buildMs || 0) * m * this.buildMul(state)); },

  // called by Sim.place after the grid cell is set: creates the cell meta and emits build-start (or an instant build-done)
  onPlace(r, c, id) {
    const p = this.profile, s = Sim.state, now = this.now(), def = MODULES[id];
    let totalMs = Math.round((def.buildMs || 0) * this.buildMul(s));
    const instant = def.tier === 1 && !p.migratedFrom && p.stats.instantBuilds < TIMERS.TUTORIAL_INSTANT_BUILDS;
    if (instant) { p.stats.instantBuilds++; totalMs = 0; }
    s.cells[cellKey(r, c)] = { lvl: 1, bank: 0, readyAt: totalMs > 0 ? now + totalMs : null, builtAt: now, at: now, startedAt: now, totalMs };
    p.stats.buildsPlaced++;
    this._syncWallet(); this._dirty();
    if (totalMs > 0) Sim.emit('build-start', { r, c, id, totalMs, sector: s.sector, upgrade: false });
    else { p.stats.buildsDone++; Sim.emit('build-done', { r, c, id, sector: s.sector, instant: true }); }
    return { instant: totalMs === 0, totalMs };
  },

  onDemolish(r, c, id) {
    const s = Sim.state, cell = Sim.cellMeta(r, c);
    const lost = cell ? Math.floor(cell.bank || 0) : 0;
    if (lost > 0 && s) Sim.log(`${fmt(lost)} banked credits were lost with the ${MODULES[id].name}.`, 'warn');
    this._dirty();
    return lost;
  },

  _settleBuilds(state, now) {
    const done = [];
    const cells = state && state.cells; if (!cells) return done;
    for (const k in cells) {
      const cell = cells[k];
      if (cell.readyAt == null || cell.readyAt > now) continue;
      const i = k.indexOf(','), r = +k.slice(0, i), c = +k.slice(i + 1);
      if (!state.grid[r] || !state.grid[r][c]) { delete cells[k]; continue; }
      done.push(this._finishBuild(state, r, c, cell, 'timer'));
    }
    return done;
  },

  _finishBuild(state, r, c, cell, how) {
    const id = state.grid[r][c].id, wasUp = !!cell.up, now = this.now();
    cell.readyAt = null; cell.at = now; delete cell.totalMs; delete cell.startedAt;
    if (wasUp) { cell.lvl = cell.up; delete cell.up; this.profile.stats.upgrades++; }
    else this.profile.stats.buildsDone++;
    Sim.recomputeLevel(state);
    const ev = { r, c, id, sector: state.sector, how };
    if (wasUp) { ev.lvl = cell.lvl; Sim.emit('upgrade', ev); }
    else Sim.emit('build-done', ev);
    if (state === Sim.state) {
      Sim.log(wasUp ? `${MODULES[id].name} upgraded to level ${cell.lvl}.` : `${MODULES[id].name} online.`, 'good');
      Sim.emit('change');
    }
    this._dirty();
    return ev;
  },

  build(r, c) {
    const cell = Sim.cellMeta(r, c); if (!cell) return null;
    const building = cell.readyAt != null, now = this.now();
    const remainingMs = building ? Math.max(0, cell.readyAt - now) : 0;
    const totalMs = building ? (cell.totalMs || remainingMs) : 0;
    return { building, remainingMs, totalMs, skipAM: building ? this.skipCost(remainingMs) : 0, upgrade: !!cell.up, toLvl: cell.up || null, lvl: cell.lvl || 1 };
  },

  skipBuild(r, c) {
    const s = Sim.state, cell = Sim.cellMeta(r, c);
    if (!s || !cell || cell.readyAt == null) return { ok: false, cost: 0, why: 'Nothing to skip' };
    const cost = this.skipCost(cell.readyAt - this.now());
    if (!this.spendAM(cost, 'skip build')) return { ok: false, cost, why: 'Not enough Antimatter' };
    this.profile.stats.skips++;
    this._finishBuild(s, r, c, cell, 'skip');
    return { ok: true, cost };
  },

  upgrade(r, c) {
    const s = Sim.state, cell = Sim.cellMeta(r, c); if (!s || !cell) return null;
    const m = s.grid[r][c]; if (!m) return null;
    const def = MODULES[m.id], lvl = cell.lvl || 1;
    const out = { lvl, next: null, upgrading: !!cell.up, building: cell.readyAt != null && !cell.up };
    if (!def.upgrade || lvl >= 3) return out;
    const nl = lvl + 1;
    const effectKey = { dock: 'dockTime', capacity: 'capacity', power: 'power' }[def.upgrade.kind] || null;
    out.next = { lvl: nl, cost: def.cost * def.upgrade.costMul[lvl - 1], rate: this._rate(def, nl), cap: this._cap(def, nl),
      ms: this.upgradeMs(def, lvl, s), kind: def.upgrade.kind,
      effect: effectKey ? Sim.upgradeEffect(m.id, effectKey, nl) : null };   // dockTime multiplier, or capacity / power multiplier
    return out;
  },

  upgradeModule(r, c) {
    const s = Sim.state, cell = Sim.cellMeta(r, c);
    if (!s || !cell || !s.grid[r][c]) return { ok: false, cost: 0, totalMs: 0, why: 'Nothing there' };
    const id = s.grid[r][c].id, def = MODULES[id], lvl = cell.lvl || 1;
    if (!def.upgrade) return { ok: false, cost: 0, totalMs: 0, why: 'The Core Hub cannot be upgraded' };
    if (cell.readyAt != null) return { ok: false, cost: 0, totalMs: 0, why: cell.up ? 'Already upgrading' : 'Still under construction' };
    if (lvl >= 3) return { ok: false, cost: 0, totalMs: 0, why: 'Already at level 3' };
    const cost = def.cost * def.upgrade.costMul[lvl - 1];
    if (s.credits < cost) return { ok: false, cost, totalMs: 0, why: 'Not enough credits' };
    const now = this.now(), totalMs = this.upgradeMs(def, lvl, s);
    s.credits -= cost; this._syncWallet();
    cell.up = lvl + 1; cell.readyAt = now + totalMs; cell.startedAt = now; cell.totalMs = totalMs;
    Sim.log(`Upgrading ${def.name} to level ${lvl + 1}.`, '');
    Sim.emit('build-start', { r, c, id, totalMs, sector: s.sector, upgrade: true, toLvl: lvl + 1 });
    Sim.emit('change');
    if (totalMs <= 0) this._finishBuild(s, r, c, cell, 'instant');
    return { ok: true, cost, totalMs };
  },

  // ---------------------------------------------------------- A1.2 plot expansion ("territory")
  plot() {
    const s = Sim.state, p = this.profile; if (!s || !s.plot) return null;
    const rings = Sim.plotRingsOf(s), P = s.plot, now = this.now();
    const out = { ring: P.ring, rings: rings.length, r0: P.r0, c0: P.c0, r1: P.r1, c1: P.c1, cells: boxCells(P), next: null, clearing: null };
    if (P.clearing) {
      const C = P.clearing, remainingMs = Math.max(0, C.endsAt - now);
      out.clearing = { ring: C.ring, endsAt: C.endsAt, remainingMs, totalMs: C.totalMs, skipAM: this.skipCost(remainingMs) };
    } else if (P.ring < rings.length - 1) {
      const k = P.ring + 1, cost = plotCost(k);
      out.next = { ring: k, cost, ms: plotMs(k, this.buildMul(s)), cells: boxCells(rings[k]) - boxCells(P), affordable: !!p && s.credits >= cost, bounds: rings[k] };
    }
    return out;
  },

  expandPlot() {
    const s = Sim.state, p = this.profile; if (!s || !p || !s.plot) return { ok: false, cost: 0, endsAt: null, why: 'No station' };
    const info = this.plot();
    if (info.clearing) return { ok: false, cost: 0, endsAt: info.clearing.endsAt, why: `Already clearing ring ${info.clearing.ring}` };
    if (!info.next) return { ok: false, cost: 0, endsAt: null, why: 'The whole sector is already yours' };
    const { ring, cost, ms } = info.next;
    if (s.credits < cost) return { ok: false, cost, endsAt: null, why: `Needs ${fmt(cost)} credits` };
    const now = this.now();
    s.credits -= cost; Sim.earn(-cost, 'plot clearing'); this._syncWallet();
    s.plot.clearing = { ring, startedAt: now, endsAt: now + ms, totalMs: ms };
    Sim.log(`Clearing ring ${ring} of the plot: ${info.next.cells} cells in ${Math.round(ms / 60000)} minutes.`, '');
    Sim.emit('plot', { state: 'start', ring, bounds: info.next.bounds, endsAt: now + ms, totalMs: ms, sector: s.sector });
    Sim.emit('change');
    this._dirty();
    if (ms <= 0) this._finishPlot(s, 'instant');
    return { ok: true, cost, endsAt: now + ms, why: null };
  },

  skipPlot() {
    const s = Sim.state, C = s && s.plot && s.plot.clearing;
    if (!C) return { ok: false, cost: 0, why: 'Nothing is being cleared' };
    const cost = this.skipCost(C.endsAt - this.now());
    if (!this.spendAM(cost, 'skip plot')) return { ok: false, cost, why: 'Not enough Antimatter' };
    this.profile.stats.skips++;
    this._finishPlot(s, 'skip');
    return { ok: true, cost };
  },

  _finishPlot(state, how) {
    const ring = state.plot.clearing.ring;
    state.plot = Sim.plotAt(state, ring, null);
    this.profile.stats.plotRings++;
    const bounds = { r0: state.plot.r0, c0: state.plot.c0, r1: state.plot.r1, c1: state.plot.c1 };
    if (state === Sim.state) { Sim.log(`Ring ${ring} cleared. The plot is now ${bounds.c1 - bounds.c0 + 1}x${bounds.r1 - bounds.r0 + 1}.`, 'good'); }
    Sim.emit('plot', { state: how === 'skip' ? 'skip' : 'done', ring, bounds, sector: state.sector, how });
    if (state === Sim.state) Sim.emit('change');
    this._dirty();
    return { ring, bounds };
  },

  _settlePlot(state, now) {
    const C = state && state.plot && state.plot.clearing;
    if (!C || C.endsAt > now) return null;
    return this._finishPlot(state, 'timer');
  },

  // ---------------------------------------------------------- 4.9 commander rank
  _rankFor(xp) { let R = RANKS[0]; for (const r of RANKS) if (xp >= r.xp) R = r; return R; },
  get rank() {
    const p = this.profile, xp = p ? p.rank.xp : 0, R = this._rankFor(xp);
    const next = RANKS.find(r => r.level === R.level + 1) || null;
    const pct = next ? clamp((xp - R.xp) / Math.max(1, next.xp - R.xp), 0, 1) : 1;
    return { level: R.level, title: R.title, xp, next: next ? next.xp : null, nextTitle: next ? next.title : null, pct, grant: R.grant || null };
  },
  _addXP(n, reason) {
    const p = this.profile; n = Math.round(n); if (!p || n <= 0) return;
    p.rank.xp += n;
    const R = this._rankFor(p.rank.xp);
    while (p.rank.level < R.level) {
      p.rank.level++;
      const def = RANKS.find(r => r.level === p.rank.level);
      this.addAM(ECON.rankAMPerLevel * p.rank.level, 'rank');
      if (Sim.state) Sim.log(`Promoted to ${def.title} (rank ${def.level}).${def.grantText ? ` Granted: ${def.grantText}.` : ''}`, 'good');
      Sim.emit('rank', { level: def.level, title: def.title, grant: def.grant || null, reason });
    }
    this._dirty();
  },
  onLevelUp(state, lvl) { this._addXP(ECON.xp.levelUp, 'levelup'); },

  // ---------------------------------------------------------- 4.5 sectors
  bestLevel() { const p = this.profile; let L = 1; if (p) for (const id in p.sectors) L = Math.max(L, p.sectors[id].level || 1); return L; },
  charts(id) { const p = this.profile; return p ? (p.expeditions.charts[id] || 0) : 0; },

  _unlockCheck(def, withAM) {
    const p = this.profile, U = def.unlock;
    if (p.unlocked.includes(def.id)) return { ok: true, mode: 'owned' };
    if (p.entitlements.sectorPass || this.hasEntitlement('sector_pass')) return { ok: true, mode: 'pass' };
    if (withAM) {
      if (U.am == null) return { ok: false, why: 'No Antimatter shortcut for this sector', mode: 'am' };
      if (p.am < U.am) return { ok: false, why: `Needs ${U.am} Antimatter (you have ${p.am})`, mode: 'am' };
      return { ok: true, mode: 'am' };
    }
    const L = this.bestLevel();
    if (L < U.level) return { ok: false, why: `Reach station level ${U.level} in any sector`, mode: 'credits' };
    const have = this.charts(def.id);
    if (have < U.charts) return { ok: false, why: `Needs ${U.charts} chart${U.charts > 1 ? 's' : ''} of ${def.name} (${have}/${U.charts})`, mode: 'credits' };
    if (this.credits < U.credits) return { ok: false, why: `Needs ${fmt(U.credits)} credits (you have ${fmt(this.credits)})`, mode: 'credits' };
    return { ok: true, mode: 'credits' };
  },

  sectors() {
    const p = this.profile; if (!p) return [];
    return SECTOR_ORDER.map(id => {
      const def = SECTORS[id], st = p.sectors[id];
      let status, why = null;
      if (id === p.activeSector) status = 'active';
      else if (p.unlocked.includes(id)) status = 'owned';
      else {
        const chk = this._unlockCheck(def, false);
        status = chk.ok ? 'unlockable' : 'locked'; why = chk.ok ? null : chk.why;
      }
      const amOption = def.unlock.am != null && !p.unlocked.includes(id) ? { am: def.unlock.am, affordable: p.am >= def.unlock.am } : null;
      const summary = st ? { name: st.name, level: st.level, credits: p.credits, modules: Sim.cellsOf(st).length - 1, banked: this.bankedTotal(st), day: st.day }
        : { name: null, level: 0, credits: p.credits, modules: 0, banked: 0, day: 0 };
      return { def, id, status, why, amOption, charts: this.charts(id), summary };
    });
  },

  unlockSector(id, opts = {}) {
    const p = this.profile, def = SECTORS[id];
    if (!p || !def) return { ok: false, why: 'Unknown sector' };
    if (p.unlocked.includes(id)) return { ok: false, why: 'Already unlocked' };
    const chk = this._unlockCheck(def, !!opts.withAM);
    if (!chk.ok) return { ok: false, why: chk.why, mode: chk.mode };
    if (chk.mode === 'am') { if (!this.spendAM(def.unlock.am, `unlock ${id}`)) return { ok: false, why: 'Not enough Antimatter' }; }
    else if (chk.mode === 'credits' && def.unlock.credits) { Sim.state.credits -= def.unlock.credits; Sim.earn(-def.unlock.credits, 'sector unlock'); this._syncWallet(); }
    this._addSector(id);
    Sim.log(`${def.name} unlocked. A new station awaits commissioning there.`, 'good');
    Sim.emit('sector', { id, state: 'unlocked', mode: chk.mode });
    Sim.emit('change');
    this.save();
    return { ok: true, mode: chk.mode };
  },

  _addSector(id) {
    const p = this.profile;
    if (!p.sectors[id]) { p.sectors[id] = Sim.makeState(id); p.sectors[id].credits = p.credits; }
    if (!p.unlocked.includes(id)) { p.unlocked.push(id); p.unlocked.sort((a, b) => SECTORS[a].index - SECTORS[b].index); p.stats.sectorsUnlocked++; }
    this._dirty();
  },

  // store: the Sector Pass; returns the ids newly unlocked
  unlockAllSectors(reason = 'sector pass') {
    const p = this.profile; if (!p) return [];
    const added = [];
    p.entitlements.sectorPass = true;
    for (const id of SECTOR_ORDER) if (!p.unlocked.includes(id)) { this._addSector(id); added.push(id); Sim.emit('sector', { id, state: 'unlocked', mode: 'pass', reason }); }
    if (added.length) { Sim.emit('change'); this.save(); }
    return added;
  },

  switchSector(id) {
    const p = this.profile;
    if (!p || !p.sectors[id] || !p.unlocked.includes(id)) return { ok: false, why: 'Sector not unlocked' };
    if (id === p.activeSector) return { ok: true, same: true };
    const now = this.now();
    this._syncWallet();
    this._accrue(Sim.state, now, TIMERS.OFFLINE_BANK_CAP_MS, false);
    p.activeSector = id;
    this._bindActive();
    this._accrue(Sim.state, now, TIMERS.OFFLINE_BANK_CAP_MS, false);
    this._settleBuilds(Sim.state, now);
    this._settlePlot(Sim.state, now);
    this._dirty();
    Sim.emit('sector', { id, state: 'switched' });
    Sim.emit('change'); Sim.emit('log');
    this.save(now);
    return { ok: true };
  },

  // ---------------------------------------------------------- 4.6 expeditions
  expeditionCost(def) { return Math.round(EXPEDITIONS.costBase * (1 + EXPEDITIONS.costPerIndex * def.index)); },
  expeditionSlots(T = Sim.state ? Sim.totals() : null) {
    if (!T || !T.counts[EXPEDITIONS.requires]) return 0;
    return Math.min(EXPEDITIONS.slots.max, EXPEDITIONS.slots.base + (T.counts.comms ? EXPEDITIONS.slots.comms : 0) + (T.counts.shipyard ? EXPEDITIONS.slots.shipyard : 0));
  },
  _openExpeditions() { return this.profile.expeditions.list.filter(e => e.status !== 'claimed'); },

  launchExpedition(sectorId) {
    const p = this.profile, s = Sim.state, def = SECTORS[sectorId];
    if (!p || !s || !def) return { ok: false, id: null, why: 'Unknown sector' };
    const T = Sim.totals();
    if (!T.counts[EXPEDITIONS.requires]) return { ok: false, id: null, why: 'Needs a Docking Bay' };
    const slots = this.expeditionSlots(T), open = this._openExpeditions();
    if (open.length >= slots) return { ok: false, id: null, why: slots === 1 ? 'The expedition slot is busy' : `All ${slots} expedition slots are busy` };
    const cost = this.expeditionCost(def);
    if (s.credits < cost) return { ok: false, id: null, why: `Needs ${fmt(cost)} credits`, cost };
    s.credits -= cost; Sim.earn(-cost, 'expeditions'); this._syncWallet();
    const now = this.now(), ms = def.expedition.minutes * 60000;
    const used = new Set(open.map(e => e.slot)); let slot = 0; while (used.has(slot)) slot++;
    const e = { id: p.expeditions.nextId++, sector: sectorId, from: s.sector, startedAt: now, endsAt: now + ms, status: 'out', slot, loot: null, claimedAt: null };
    p.expeditions.list.push(e);
    p.stats.expeditionsLaunched++;
    Sim.log(`Expedition ${e.id} departs for ${def.name}. Back in ${def.expedition.minutes} minutes.`, '');
    Sim.emit('expedition', { id: e.id, state: 'launched', sector: sectorId, endsAt: e.endsAt });
    Sim.emit('change');
    this._dirty();
    return { ok: true, id: e.id, endsAt: e.endsAt, cost };
  },

  _settleExpeditions(now) {
    const p = this.profile; let n = 0;
    for (const e of p.expeditions.list) {
      if (e.status !== 'out' || e.endsAt > now) continue;
      e.status = 'ready'; n++;
      Sim.emit('expedition', { id: e.id, state: 'ready', sector: e.sector });
    }
    if (n) this._dirty();
    return n;
  },

  skipExpedition(id) {
    const p = this.profile, e = p && p.expeditions.list.find(x => x.id === id);
    if (!e || e.status !== 'out') return { ok: false, cost: 0, why: 'Not out' };
    const now = this.now(), cost = this.skipCost(e.endsAt - now);
    if (!this.spendAM(cost, 'skip expedition')) return { ok: false, cost, why: 'Not enough Antimatter' };
    p.stats.skips++;
    e.endsAt = now;
    this._settleExpeditions(now);
    return { ok: true, cost };
  },

  _weightedPick(items, weightOf) {
    const w = items.map(weightOf), total = w.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  },

  _pickDiscovery(def) {
    const p = this.profile, W = EXPEDITIONS.loot.discovery.weights, pool = [];
    for (const kind of COLLECTION_KINDS) for (const it of COLLECTION[kind]) if (it.source.expedition && it.source.expedition.includes(def.id)) pool.push({ kind, it });
    if (!pool.length) return null;
    const unfound = pool.filter(x => !p.collection.found[x.it.id]);
    const from = unfound.length ? unfound : pool;
    const x = this._weightedPick(from, y => W[y.it.rarity] || 1);
    return x ? { kind: x.kind, id: x.it.id, name: x.it.name, rarity: x.it.rarity, dup: !!p.collection.found[x.it.id] } : null;
  },

  _rollLoot(def) {
    const p = this.profile, L = EXPEDITIONS.loot, run = (p.expeditions.runs[def.id] || 0) + 1;
    const loot = { sector: def.id, run, chart: false, goods: [], am: 0, discovery: null, credits: 0, brokered: 0 };
    loot.chart = (run % L.chart.guaranteeEvery === 0) || Math.random() < L.chart.p;
    const total = irnd(L.goods.min, L.goods.max), gs = def.lootGoods, n = gs.length;
    let left = total;
    gs.forEach((g, i) => { const q = i === n - 1 ? left : Math.round(total / n); if (q > 0) loot.goods.push({ good: g, qty: q }); left -= q; });
    if (Math.random() < L.am.p) loot.am = clamp(L.am.min + Math.floor(Math.pow(Math.random(), 2) * (L.am.max - L.am.min + 1)), L.am.min, L.am.max);
    if (Math.random() < L.discovery.p) loot.discovery = this._pickDiscovery(def);
    if (Math.random() < L.credits.p) loot.credits = Math.round(this.totalRate() * rnd(L.credits.minMinutes, L.credits.maxMinutes));
    return loot;
  },

  // goods into the active station's stock; whatever does not fit is brokered at half price (like dumpStock)
  _stow(goods) {
    const s = Sim.state, T = Sim.totals(); let room = Math.max(0, T.storage - T.stockTotal), brokered = 0;
    for (const g of goods) {
      const q = Math.min(g.qty, room); room -= q; s.stock[g.good] += q; g.stowed = q;
      const rest = g.qty - q;
      if (rest > 0) brokered += Math.round(rest * Sim.effPrice(g.good) * 0.5);
    }
    if (brokered > 0) { s.credits += brokered; Sim.earn(brokered, 'brokered loot'); }
    return brokered;
  },

  claimExpedition(id) {
    const p = this.profile, s = Sim.state, now = this.now();
    if (!p || !s) return null;
    this._settleExpeditions(now);
    const e = p.expeditions.list.find(x => x.id === id);
    if (!e || e.status !== 'ready') return null;
    const def = SECTORS[e.sector], loot = this._rollLoot(def);
    p.expeditions.runs[def.id] = (p.expeditions.runs[def.id] || 0) + 1;
    if (loot.chart) p.expeditions.charts[def.id] = (p.expeditions.charts[def.id] || 0) + 1;
    loot.brokered = this._stow(loot.goods);
    if (loot.am) this.addAM(loot.am, 'expedition');
    if (loot.credits) { s.credits += loot.credits; Sim.earn(loot.credits, 'expeditions'); }
    if (loot.discovery) this._discover(loot.discovery.kind, loot.discovery.id, 'expedition');
    e.status = 'claimed'; e.claimedAt = now; e.loot = loot;
    p.stats.expeditionsClaimed++;
    this._addXP(EXPEDITIONS.xp, 'expedition');
    this._syncWallet();
    const parts = [];
    if (loot.chart) parts.push('a chart');
    parts.push(loot.goods.map(g => `${g.qty} ${GOODS[g.good].name}`).join(', '));
    if (loot.am) parts.push(`${loot.am} Antimatter`);
    if (loot.credits) parts.push(`${fmt(loot.credits)} credits`);
    if (loot.discovery) parts.push(`a discovery: ${loot.discovery.name}`);
    Sim.log(`Expedition ${e.id} returns from ${def.name} with ${parts.join(', ')}.`, 'good');
    // keep the last five debriefs for the panel
    const claimed = p.expeditions.list.filter(x => x.status === 'claimed');
    while (claimed.length > 5) { const old = claimed.shift(); p.expeditions.list.splice(p.expeditions.list.indexOf(old), 1); }
    Sim.emit('expedition', { id: e.id, state: 'claimed', sector: e.sector, loot });
    Sim.emit('change');
    this._dirty();
    return loot;
  },

  expeditions() {
    const p = this.profile; if (!p) return [];
    const now = this.now();
    return p.expeditions.list.map(e => ({ id: e.id, sector: e.sector, def: SECTORS[e.sector], from: e.from, startedAt: e.startedAt, endsAt: e.endsAt,
      remainingMs: e.status === 'out' ? Math.max(0, e.endsAt - now) : 0, status: e.status, slot: e.slot, loot: e.loot,
      skipAM: e.status === 'out' ? this.skipCost(e.endsAt - now) : 0 }));
  },

  // ---------------------------------------------------------- 4.10 collection
  _discover(kind, id, via) {
    const p = this.profile, F = p.collection.found, now = this.now();
    const first = !F[id];
    if (first) F[id] = { count: 1, firstAt: now, via };
    else F[id].count++;
    if (first) {
      p.stats.discoveries++;
      this._addXP(ECON.xp.discovery, 'discovery');
      const it = COLLECTION[kind].find(x => x.id === id);
      if (Sim.state && it) Sim.log(`Registry: ${it.name} logged (${kind}).`, 'good');
      Sim.emit('discover', { kind, id, via, first: true });
      this._checkSets();
    } else Sim.emit('discover', { kind, id, via, first: false });
    this._dirty();
    return first;
  },

  _checkSets() {
    const p = this.profile;
    for (const set of COLLECTION.sets) {
      if (p.collection.sets[set.id]) continue;
      if (!set.items.every(id => p.collection.found[id])) continue;
      p.collection.sets[set.id] = this.now();
      if (set.reward.am) this.addAM(set.reward.am, `set ${set.id}`);
      if (set.reward.title && !p.entitlements.titles.includes(set.reward.title)) p.entitlements.titles.push(set.reward.title);
      if (Sim.state) Sim.log(`Registry set complete: ${set.name}. Title granted: ${set.reward.title}.`, 'good');
      Sim.emit('discover', { kind: 'set', id: set.id, reward: set.reward, first: true });
    }
  },

  // ships served reveal company liveries, notable hulls and visitor species (4.10)
  _onDock(ship) {
    const p = this.profile, s = Sim.state; if (!p || !s) return;
    p.stats.servedTotal++;
    if (ship.company === 'aurelian') p.stats.aurelianServed++;
    if (this.convoyActive()) p.stats.convoyServed++;
    this._addXP(ECON.xp.served, 'served');
    const co = s.companies[ship.company], served = co ? co.served : 0;
    for (const kind of ['ships', 'species']) {
      for (const it of COLLECTION[kind]) {
        const src = it.source.serve;
        if (!src || src.company !== ship.company || p.collection.found[it.id]) continue;
        if (src.cls && src.cls !== ship.cls) continue;
        if (served >= (src.count || 1)) this._discover(kind, it.id, 'served');
      }
    }
    this._dirty();
  },

  collection() {
    const p = this.profile, F = p ? p.collection.found : {};
    const out = {};
    for (const kind of COLLECTION_KINDS) out[kind] = COLLECTION[kind].map(it => Object.assign({}, it, { found: !!F[it.id], count: F[it.id] ? F[it.id].count : 0, foundAt: F[it.id] ? F[it.id].firstAt : null }));
    out.sets = COLLECTION.sets.map(st => Object.assign({}, st, { have: st.items.filter(id => F[id]).length, total: st.items.length, done: !!(p && p.collection.sets[st.id]) }));
    return out;
  },

  // ---------------------------------------------------------- 4.7 missions
  _dirty() { if (this._acc) this._acc.missionDirty = true; },
  missionSlots() { return this.rank.level >= 4 ? MISSION_SLOTS.commodore : MISSION_SLOTS.base; },

  // the next unclaimed mission of each open chapter, in chapter order, up to the slot count
  _activeMissions() {
    const p = this.profile, out = [];
    for (const ch of MISSION_CHAPTERS) {
      const m = MISSIONS.find(x => x.chapter === ch && !p.missions.claimed[x.id]);
      if (!m || !m.requires.every(id => p.missions.completed[id])) continue;
      out.push(m);
    }
    return out.slice(0, this.missionSlots());
  },

  evalMissions(now = this.now(), force = false) {
    const p = this.profile; if (!p || !Sim.state || !this._acc) return;
    if (!force && (!this._acc.missionDirty || now - this._acc.lastMission < TIMERS.MISSION_EVAL_MS)) return;
    this._acc.missionDirty = false; this._acc.lastMission = now;
    for (let pass = 0; pass < 4; pass++) {
      let completed = false;
      for (const m of this._activeMissions()) {
        if (p.missions.completed[m.id]) continue;
        let prog = 0;
        try { prog = Number(m.track(Sim.state, p)) || 0; } catch (e) { prog = 0; }
        if (p.missions.progress[m.id] !== prog) {
          p.missions.progress[m.id] = prog;
          if (prog < m.goal) Sim.emit('mission', { id: m.id, state: 'progress', progress: prog, goal: m.goal });
        }
        if (prog >= m.goal) {
          p.missions.completed[m.id] = now; completed = true;
          if (Sim.state) Sim.log(`Mission complete: ${m.title}. Claim the reward in Missions.`, 'good');
          Sim.emit('mission', { id: m.id, state: 'complete' });
        }
      }
      if (!completed) break;              // a completion can open the next chapter: look again
    }
    this._evalAchievements(now);          // A1.3: same triggers and throttle as missions
  },

  missions() {
    const p = this.profile; if (!p) return [];
    const active = new Set(this._activeMissions().map(m => m.id));
    return MISSIONS.map(m => {
      const done = !!p.missions.completed[m.id], claimed = !!p.missions.claimed[m.id];
      const progress = done ? m.goal : Math.min(m.goal, p.missions.progress[m.id] || 0);
      return { id: m.id, chapter: m.chapter, title: m.title, desc: m.desc, type: m.type, progress, goal: m.goal, reward: m.reward,
        done, claimable: done && !claimed, claimed, active: active.has(m.id), pointer: m.pointer || null };
    });
  },

  claimMission(id) {
    const p = this.profile, m = MISSIONS.find(x => x.id === id);
    if (!p || !m || !p.missions.completed[id] || p.missions.claimed[id]) return null;
    p.missions.claimed[id] = this.now();
    p.stats.missionsClaimed++;
    const reward = Object.assign({ credits: 0, am: 0, xp: 0 }, m.reward);
    if (reward.credits) this.addCredits(reward.credits, 'missions');
    if (reward.am) this.addAM(reward.am, `mission ${id}`);
    if (reward.xp) this._addXP(reward.xp, 'mission');
    Sim.emit('mission', { id, state: 'claimed', reward });
    this._dirty();
    this.evalMissions(this.now(), true);
    this.save();
    return reward;
  },

  // ---------------------------------------------------------- A1.3 achievements (lifetime, profile-wide, three tiers each)
  // lifetime counters from profile.stats plus derived values; keys are what ACHIEVEMENTS[*].stat names
  lifetimeStats() {
    const p = this.profile, S = p ? p.stats : {}, out = Object.assign({}, S);
    if (!p) return out;
    out.chartsTotal = 0; for (const id in p.expeditions.charts) out.chartsTotal += p.expeditions.charts[id];
    out.registryFound = Object.keys(p.collection.found).length;
    out.sectorsOwned = p.unlocked.length;                     // home included (Pioneer 2 / 5 / 8)
    out.rankLevel = this.rank.level;
    out.bestLevel = this.bestLevel();
    out.sectorsAtL2 = 0; out.sectorsAtL3 = 0; out.sectorsAtL4 = 0; out.sectorsAtL5 = 0;
    out.cargoTraded = 0; out.earnedLifetime = 0; out.residentsNow = 0;
    for (const id in p.sectors) {
      const st = p.sectors[id], L = st.level || 1;
      if (L >= 2) out.sectorsAtL2++; if (L >= 3) out.sectorsAtL3++; if (L >= 4) out.sectorsAtL4++; if (L >= 5) out.sectorsAtL5++;
      out.cargoTraded += st.stats.cargoTraded || 0; out.earnedLifetime += st.stats.earned || 0;
      out.residentsNow = Math.max(out.residentsNow, st.residents || 0);
    }
    out.residentsPeak = Math.max(S.residentsPeak || 0, out.residentsNow);
    out.bankedLifetime = S.collectedCredits || 0;
    return out;
  },

  _tierOf(def, value) { let t = 0; for (const tier of def.tiers) if (value >= tier.goal) t++; return t; },

  _evalAchievements(now) {
    const p = this.profile; if (!p) return;
    const S = this.lifetimeStats(), A = p.achievements;
    for (const def of ACHIEVEMENTS) {
      const reached = this._tierOf(def, Number(S[def.stat]) || 0), had = A.completed[def.id] || 0;
      if (reached > had) {
        A.completed[def.id] = reached;
        for (let t = had + 1; t <= reached; t++) {
          if (Sim.state) Sim.log(`Achievement: ${def.title} ${['', 'bronze', 'silver', 'gold'][t]}. Claim it in Missions.`, 'good');
          Sim.emit('achievement', { id: def.id, tier: t, state: 'complete' });
        }
      }
    }
  },

  achievements() {
    const p = this.profile, S = this.lifetimeStats();
    return ACHIEVEMENTS.map(def => {
      const value = Number(S[def.stat]) || 0, done = p ? (p.achievements.completed[def.id] || 0) : 0, claimed = p ? (p.achievements.claimed[def.id] || 0) : 0;
      const next = def.tiers[Math.min(claimed, def.tiers.length - 1)];
      return { id: def.id, title: def.title, desc: def.desc, icon: def.icon, fam: def.fam, tier: claimed, reached: done, progress: Math.min(value, next.goal), value,
        goal: next.goal, nextAM: claimed >= def.tiers.length ? 0 : next.am, tiers: def.tiers, claimable: done > claimed, done: claimed >= def.tiers.length };
    });
  },

  // claims the next unclaimed tier (one tier per call) and pays its Antimatter
  claimAchievement(id) {
    const p = this.profile, def = ACHIEVEMENTS.find(a => a.id === id); if (!p || !def) return null;
    const done = p.achievements.completed[id] || 0, claimed = p.achievements.claimed[id] || 0;
    if (done <= claimed) return null;
    const tier = claimed + 1, am = def.tiers[tier - 1].am;
    p.achievements.claimed[id] = tier;
    this.addAM(am, `achievement ${id}`);
    Sim.emit('achievement', { id, tier, state: 'claimed', am });
    this._dirty();
    this.save();
    return { am, tier };
  },

  achievementBadge() {
    const p = this.profile; if (!p) return 0;
    let n = 0; for (const def of ACHIEVEMENTS) if ((p.achievements.completed[def.id] || 0) > (p.achievements.claimed[def.id] || 0)) n++;
    return n;
  },

  // ---------------------------------------------------------- 4.8 daily reward and streak (local calendar days)
  _dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); },
  _dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; },
  _daysBetween(a, b) { return Math.round((this._dayStart(b) - this._dayStart(a)) / DAY_MS); },

  daily() {
    const p = this.profile, now = this.now();
    const d = p ? p.daily : { streak: 0, lastClaimAt: 0 };
    const since = d.lastClaimAt ? this._daysBetween(d.lastClaimAt, now) : null;     // 0 today, 1 yesterday, >= 2 a miss
    const claimable = since !== 0;
    const broken = since != null && since >= 2 && d.streak > 0;
    const breakAt = d.lastClaimAt ? this._dayStart(d.lastClaimAt) + 2 * DAY_MS : 0;
    const repairable = broken && now - breakAt <= TIMERS.STREAK_REPAIR_MS;
    const streakIfClaim = since == null ? 1 : since === 0 ? d.streak : since === 1 ? d.streak + 1 : 1;
    const dayIndex = (Math.max(1, claimable ? streakIfClaim : d.streak) - 1) % 7;
    return { streak: d.streak, dayIndex, claimable, broken, repairable, repairAM: TIMERS.STREAK_REPAIR_AM, streakIfClaim,
      nextAt: claimable ? now : this._dayStart(now) + DAY_MS, rewards: DAILY_REWARDS, today: DAILY_REWARDS[dayIndex] };
  },

  _crate(units) {
    const def = SECTORS[Sim.state.sector] || SECTORS.home, gs = def.lootGoods, goods = [];
    let left = units;
    gs.forEach((g, i) => { const q = i === gs.length - 1 ? left : Math.round(units / gs.length); goods.push({ good: g, qty: q }); left -= q; });
    const brokered = this._stow(goods);
    return { goods, brokered };
  },

  claimDaily() {
    const p = this.profile; if (!p || !Sim.state) return null;
    const info = this.daily(); if (!info.claimable) return null;
    const now = this.now(), d = p.daily;
    d.streak = info.streakIfClaim; d.lastClaimAt = now; d.lastClaimKey = this._dayKey(now);
    const idx = (d.streak - 1) % 7, R = DAILY_REWARDS[idx];
    const reward = { day: idx + 1, kind: R.kind, label: R.label, credits: 0, am: 0, goods: null, token: null, streak: d.streak };
    if (R.kind === 'credits') { reward.credits = Math.max(R.min, Math.round(this.totalRate() * R.rateMinutes)); this.addCredits(reward.credits, 'daily reward'); }
    else if (R.kind === 'am') {
      reward.am = R.amount; this.addAM(R.amount, 'daily');
      if (R.token) { p.entitlements.tokens[R.token] = (p.entitlements.tokens[R.token] || 0) + 1; reward.token = R.token; }
    } else if (R.kind === 'goods') { reward.goods = this._crate(R.units); this._syncWallet(); }
    p.stats.dailyClaims++;
    Sim.log(`Daily reward claimed: ${R.label}. Streak: ${d.streak} day${d.streak === 1 ? '' : 's'}.`, 'good');
    Sim.emit('daily', { claimed: true, streak: d.streak, reward });
    Sim.emit('change');
    this._dirty();
    this.save(now);
    return reward;
  },

  repairStreak() {
    const p = this.profile; if (!p) return { ok: false, cost: 0, why: 'No profile' };
    const info = this.daily(), cost = TIMERS.STREAK_REPAIR_AM;
    if (!info.broken) return { ok: false, cost, why: 'The streak is not broken' };
    if (!info.repairable) return { ok: false, cost, why: 'The repair window has closed' };
    if (!this.spendAM(cost, 'streak repair')) return { ok: false, cost, why: 'Not enough Antimatter' };
    const now = this.now();
    p.daily.lastClaimAt = this._dayStart(now) - DAY_MS / 2;          // as if claimed yesterday: the next claim continues the streak
    p.daily.lastClaimKey = this._dayKey(p.daily.lastClaimAt);
    Sim.emit('daily', { repaired: true, streak: p.daily.streak });
    this.save(now);
    return { ok: true, cost };
  },

  // ---------------------------------------------------------- 4.11 weekly convoy window (48 h every 7 days from profile creation)
  convoy() {
    const p = this.profile; if (!p) return { active: false, startsAt: null, endsAt: null };
    const now = this.now(), period = TIMERS.CONVOY_PERIOD_MS, win = TIMERS.CONVOY_WINDOW_MS;
    const age = now - p.createdAt, k = Math.floor(age / period);
    const start = p.createdAt + period * k, active = k >= 1 && now - start < win;
    return { active, startsAt: active ? start : p.createdAt + period * (k + 1), endsAt: active ? start + win : null, mul: active ? TIMERS.CONVOY_TRAFFIC : 1 };
  },
  convoyActive() { return this.convoy().active; },
  rift() { return { enabled: TIMERS.RIFT.enabled, active: false }; },

  // ---------------------------------------------------------- store grants (7.1 / 7.2)
  hasEntitlement(sku) { const p = this.profile; return !!(p && p.entitlements.owned[sku]); },

  // payload: { grantId, mode, at, sku, kind, granted, ...extra } from the store; pushed verbatim into entitlements.history
  grantEntitlement(sku, payload) {
    const p = this.profile; if (!p) return false;
    const E = p.entitlements, rec = Object.assign({ sku, at: this.now() }, payload || {});
    E.history.push(rec);
    E.owned[sku] = true;
    if (Array.isArray(rec.liveries)) for (const l of rec.liveries) if (!E.liveries.includes(l)) E.liveries.push(l);
    if (rec.livery && !E.liveries.includes(rec.livery)) E.liveries.push(rec.livery);
    if (rec.title && !E.titles.includes(rec.title)) E.titles.push(rec.title);
    if (sku === 'sector_pass') E.sectorPass = true;
    this._dirty();
    this.save();
    return true;
  },

  // what a catalog sku grants right now (credit packs scale with the active station's rate)
  grantValue(sku) {
    const item = STORE_CATALOG.find(x => x.sku === sku); if (!item) return null;
    const v = { sku, kind: item.kind, am: 0, credits: 0, unlockAll: false, cosmetic: null };
    if (item.kind === 'am') v.am = item.amount;
    else if (item.kind === 'credits') v.credits = Math.max(item.min, Math.round(this.totalRate() * item.rateMinutes));
    else if (item.kind === 'pass') v.unlockAll = true;
    else if (item.kind === 'cosmetic') { v.cosmetic = item.grant; if (item.grant && item.grant.am) v.am = item.grant.am; }
    return v;
  },

  // convenience for the store: apply a sku and record the entitlement in one call
  grantSku(sku, payload) {
    const v = this.grantValue(sku); if (!v || !this.profile) return null;
    if (v.am) this.addAM(v.am, 'purchase');
    if (v.credits) this.addCredits(v.credits, 'purchase');
    if (v.unlockAll) this.unlockAllSectors('sector pass');
    this.grantEntitlement(sku, Object.assign({ kind: v.kind, granted: v }, v.cosmetic || {}, payload || {}));
    return v;
  },

  // ---------------------------------------------------------- A5 station liveries: ownership, the active choice, token redemption
  _liveryDefs() { return (typeof LIVERIES !== 'undefined' && Array.isArray(LIVERIES) && LIVERIES.length) ? LIVERIES : [{ id: 'default', name: 'Standard', strip: 'family', seam: '#8FD3E8', rim: '#F3E9D6', hubCore: '#F3E9D6' }]; },
  liveryDef(id) { return this._liveryDefs().find(l => l.id === id) || null; },
  // 'default' is everyone's; sector liveries come with the 'liveries' sku or a redeemed token; founder with the 'founder' sku
  ownsLivery(id) {
    if (id === 'default') return true;
    const p = this.profile, d = this.liveryDef(id); if (!p || !d) return false;
    const E = p.entitlements;
    if (E.liveries.includes(id)) return true;
    if (id === 'founder') return this.hasEntitlement('founder');
    if (d.sector) return this.hasEntitlement('liveries');
    return false;
  },
  liveryTokens() { const p = this.profile; return p ? Math.max(0, (p.entitlements.tokens && p.entitlements.tokens.livery) | 0) : 0; },
  // the active livery definition; an unowned choice (an imported profile, a refunded sku) falls back to 'default'
  livery() {
    const p = this.profile, id = p && p.settings ? p.settings.livery : 'default';
    return (id && this.ownsLivery(id) && this.liveryDef(id)) || this.liveryDef('default') || this._liveryDefs()[0];
  },
  // -> [{ id, name, desc, sector, strip, seam, rim, hubCore, owned, active, source: 'default'|'sector'|'store'|'token' }]
  // source says how the livery is (or would be) obtained: a sector livery owned through the sku is 'store', through a token 'token', unowned 'sector'
  liveries() {
    const p = this.profile, active = this.livery().id, E = p ? p.entitlements : null;
    return this._liveryDefs().map(d => {
      const owned = this.ownsLivery(d.id);
      let source = 'default';
      if (d.id === 'founder') source = 'store';
      else if (d.sector) source = E && E.redeemed.includes(d.id) ? 'token' : owned ? 'store' : 'sector';
      return { id: d.id, name: d.name, desc: d.desc || '', sector: d.sector || null, strip: d.strip, seam: d.seam, rim: d.rim, hubCore: d.hubCore, owned, active: d.id === active, source };
    });
  },
  // validates ownership, saves the setting, emits `livery {id, name, was}` (the engine rebakes on it)
  setLivery(id) {
    const p = this.profile; if (!p) return { ok: false, why: 'No profile' };
    const d = this.liveryDef(id); if (!d) return { ok: false, why: 'Unknown livery' };
    if (!this.ownsLivery(id)) return { ok: false, why: d.sector ? 'Needs the Sector Liveries or a livery token' : "Needs the Founder's Charter" };
    const was = p.settings.livery || 'default';
    p.settings.livery = id;
    this.save();
    Sim.emit('livery', { id, name: d.name, was });
    return { ok: true, id, changed: was !== id };
  },
  // spends one livery token (day 7 of the daily streak) on a sector livery the player does not own yet
  redeemLiveryToken(id) {
    const p = this.profile; if (!p) return { ok: false, why: 'No profile' };
    const d = this.liveryDef(id);
    if (!d || !d.sector) return { ok: false, why: 'A livery token buys one of the six sector liveries' };
    if (this.ownsLivery(id)) return { ok: false, why: `${d.name} is already yours` };
    const E = p.entitlements, have = this.liveryTokens();
    if (have < 1) return { ok: false, why: 'No livery token. Day 7 of the daily streak grants one.' };
    E.tokens.livery = have - 1;
    E.liveries.push(id); E.redeemed.push(id);
    E.history.push({ sku: 'livery_token', kind: 'token', livery: id, at: this.now() });
    this._dirty();
    Sim.emit('change');
    this.save();
    return { ok: true, id, name: d.name, left: E.tokens.livery };
  },

  // ---------------------------------------------------------- read model helpers
  nextUp() {
    const p = this.profile, s = Sim.state; if (!p || !s) return [];
    const now = this.now(), out = [];
    for (const k in s.cells) {
      const cell = s.cells[k]; if (cell.readyAt == null) continue;
      const i = k.indexOf(','), r = +k.slice(0, i), c = +k.slice(i + 1), m = s.grid[r] && s.grid[r][c];
      if (!m) continue;
      out.push({ kind: 'build', label: `${MODULES[m.id].name}${cell.up ? ` · level ${cell.up}` : ''}`, endsAt: cell.readyAt, r, c, id: m.id });
    }
    for (const e of p.expeditions.list) if (e.status === 'out') out.push({ kind: 'expedition', label: `Expedition · ${SECTORS[e.sector].name}`, endsAt: e.endsAt, r: null, c: null, id: e.id });
    if (s.plot && s.plot.clearing) out.push({ kind: 'plot', label: `Clearing ring ${s.plot.clearing.ring}`, endsAt: s.plot.clearing.endsAt, r: null, c: null, id: s.plot.clearing.ring });
    const d = this.daily();
    out.push({ kind: 'daily', label: 'Daily reward', endsAt: d.nextAt, r: null, c: null, id: 'daily' });
    out.sort((a, b) => a.endsAt - b.endsAt);
    return out.slice(0, 3);
  },

  // ---------------------------------------------------------- hooks from Sim
  onResolve(ev, accepted) {
    const p = this.profile; if (!p) return;
    p.stats.transmissions++;
    this._dirty();
  },

  // ---------------------------------------------------------- per-frame tick (cheap; called every frame or every 250 ms)
  tick(now = this.now()) {
    const p = this.profile, s = Sim.state; if (!p || !s || !this._acc) return;
    const a = this._acc;
    const r = this._accrue(s, now, TIMERS.OFFLINE_BANK_CAP_MS, true);
    for (const x of r.crossings) Sim.emit('hopper', x);
    if (now - a.lastInactive >= 5000) {
      a.lastInactive = now;
      for (const id in p.sectors) if (id !== p.activeSector) { this._accrue(p.sectors[id], now, TIMERS.OFFLINE_BANK_CAP_MS, false); this._settleBuilds(p.sectors[id], now); this._settlePlot(p.sectors[id], now); }
    }
    this._settleBuilds(s, now);
    this._settlePlot(s, now);
    this._settleExpeditions(now);
    if (s.residents > (p.stats.residentsPeak || 0)) { p.stats.residentsPeak = s.residents; this._dirty(); }
    const ca = this.convoyActive();
    if (ca !== this._convoyWas) { this._convoyWas = ca; Sim.emit('convoy', { active: ca, endsAt: this.convoy().endsAt }); }
    this.evalMissions(now);
    this._syncWallet();
    if (now - a.lastSave >= TIMERS.AUTOSAVE_MS) this.save(now);
  },
};

// mission re-evaluation triggers (4.7) and served-ship hooks
Sim.on('change', () => Meta._dirty());
Sim.on('collect', () => Meta._dirty());
Sim.on('depart', () => Meta._dirty());
Sim.on('expedition', () => Meta._dirty());
Sim.on('discover', () => Meta._dirty());
Sim.on('sector', () => Meta._dirty());
Sim.on('dock', ship => Meta._onDock(ship));

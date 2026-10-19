// ============================================================
// WAYSTATION — simulation: state, economy, ships, residents
// v2 (DESIGN2.md section 6): sector-sized grids, cell meta for banks and
// build timers, upgrade multipliers, sector bias, offline catch-up, and
// save/load as thin wrappers over Meta. Every v1 method and event stays.
// ============================================================
'use strict';

// Real seconds per game day at 1x. v1 used 6; v2 reads TIMERS.DAY_MS (data2.js tuning record 1).
const DAY_SECONDS = (typeof TIMERS !== 'undefined' && TIMERS.DAY_MS) ? TIMERS.DAY_MS / 1000 : 6;
const SHIP_SPEED = (typeof ECON !== 'undefined' && ECON.shipSpeed) ? ECON.shipSpeed : 22;   // cells per game day
const LIVE = (typeof ECON !== 'undefined' && ECON.live != null) ? ECON.live : 1;             // live-economy multiplier (6 / tuning record 1)
const MAX_WAIT_DAYS = 3;
const SAVE_KEY = 'waystation-save-v1';          // v1 save; v2 reads it only to migrate (4.12)

const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.floor(rnd(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = n => Math.round(n).toLocaleString('en-US');

const NO_BIAS = { goods: {}, events: {}, companies: {}, residents: 1, rent: 1, refinery: 1, fuel: 1, gate: 1, traffic: 1 };

const Sim = {
  state: null,
  floaters: [],          // transient: {x,y,text,color,ttl}
  listeners: {},

  _muted: false,         // catchUp() runs hundreds of game days: only 'dock' (Meta's XP and discoveries) passes while muted
  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); },
  off(evt, fn) { const l = this.listeners[evt]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
  emit(evt, data) { if (this._muted && evt !== 'dock') return; (this.listeners[evt] || []).forEach(fn => fn(data)); },

  // Meta is loaded after sim.js (0.1); every call into it is guarded so the sim also runs alone.
  meta() { return (typeof Meta !== 'undefined' && Meta && Meta.profile) ? Meta : null; },
  sectorDef(id) { return (typeof SECTORS !== 'undefined' && SECTORS[id]) || null; },
  bias(state = this.state) { const d = state && this.sectorDef(state.sector); return d && d.bias ? d.bias : NO_BIAS; },

  // ---------------------------------------------------------- setup (6: newGame sizes the grid from the sector def)
  makeState(sectorId = 'home') {
    const def = this.sectorDef(sectorId);
    const cols = def ? def.grid.cols : GRID_COLS, rows = def ? def.grid.rows : GRID_ROWS;
    const grid = [];
    for (let r = 0; r < rows; r++) grid.push(new Array(cols).fill(null));
    const cr = Math.floor(rows / 2), cc = Math.floor(cols / 2);
    grid[cr][cc] = { id: 'hub' };

    const stock = {}, prices = {}, policy = {};
    for (const g of GOOD_IDS) { stock[g] = 0; prices[g] = GOODS[g].base; policy[g] = { buy: true, sell: true }; }

    const companies = {};
    for (const c of COMPANIES) companies[c.id] = { trust: 40, served: 0, contractUntil: 0, loan: null, office: false };

    const now = Date.now();
    const name = pick(def && def.names && def.names.length ? def.names : STATION_NAMES);
    const credits = (typeof TIMERS !== 'undefined' && TIMERS.START_CREDITS != null) ? TIMERS.START_CREDITS : 6000;
    const state = {
      name, day: 1, t: 0, credits, speed: 1,
      grid, hub: { r: cr, c: cc }, stock, prices, policy, companies,
      ships: [], nextShipId: 1, shipTimer: 0.4,
      residents: 0, rep: 0.3, level: 1,
      fx: { flareUntil: 0, boom: null, glut: null, festivalUntil: 0 },
      pending: null, nextEventDay: irnd(4, 7),
      income: { today: 0, yesterday: 0, breakdown: {} }, recentAway: 0,
      log: [], stats: { shipsServed: 0, cargoTraded: 0, earned: 0, turnedAway: 0, diverted: 0 },
      sector: def ? def.id : 'home',
      cells: { [`${cr},${cc}`]: { lvl: 1, bank: 0, readyAt: null, builtAt: now, at: now } },
      plot: null,
    };
    state.plot = this.plotAt(state, 0);                     // A1.2: every station starts with the 7x5 plot around its hub
    state.log.push({ day: 1, msg: 'Build a Docking Bay, a Warehouse and a Solar Array to start taking traffic.', cls: '' });
    state.log.push({ day: 1, msg: `Station ${name} comes online. One docking collar, a hold full of hope.`, cls: 'good' });
    return state;
  },

  // ---------------------------------------------------------- A1.2 plot ("territory")
  plotRingsOf(s = this.state) {
    if (typeof plotRings !== 'function') return [{ r0: 0, c0: 0, r1: this.rows(s) - 1, c1: this.cols(s) - 1 }];   // sim.js alone: the whole grid
    return plotRings(this.rows(s), this.cols(s), s.hub);
  },
  plotAt(s, ring, clearing = null) {
    const rings = this.plotRingsOf(s), k = clamp(ring, 0, rings.length - 1), b = rings[k];
    return { ring: k, r0: b.r0, c0: b.c0, r1: b.r1, c1: b.c1, clearing };
  },
  // the smallest ring that contains every occupied cell (migration of stations that predate plots)
  ringContaining(s) {
    const rings = this.plotRingsOf(s), cells = this.cellsOf(s);
    for (let k = 0; k < rings.length; k++) {
      const b = rings[k];
      if (cells.every(({ r, c }) => r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1)) return k;
    }
    return rings.length - 1;
  },
  inPlot(r, c, s = this.state) {
    const p = s && s.plot; if (!p) return this.inBounds(r, c);
    return r >= p.r0 && r <= p.r1 && c >= p.c0 && c <= p.c1;
  },
  newGame(sectorId) {
    const M = (typeof Meta !== 'undefined' && Meta) ? Meta : null;
    if (M && !M.profile) M.init();                         // v1 main.js never calls Meta.init: create or load the profile here
    sectorId = sectorId || (M && M.profile ? M.profile.activeSector : 'home');
    this.state = this.makeState(sectorId);
    this.floaters = [];
    if (M && M.profile) M.onNewGame(this.state);           // registers the station as the active sector and applies the wallet
    this.emit('log');
    this.emit('change');
  },

  // 6: thin wrappers over Meta (the v1 key is only read for migration)
  save() {
    const M = this.meta();
    if (!M) return false;
    M.save();
    return true;
  },
  load() {
    if (typeof Meta === 'undefined' || !Meta) return false;
    if (!Meta.profile) Meta.init();
    return !!this.state;
  },
  reset() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    const M = this.meta();
    if (M) M.newStationHere(); else this.newGame();
  },

  // v1 load fix-ups plus the v2 fields (sector, cells); safe to run on any saved station
  sanitize(s) {
    if (!s || !s.grid || !s.companies) return null;
    for (const c of COMPANIES) s.companies[c.id] ||= { trust: 40, served: 0, contractUntil: 0, loan: null, office: false };
    s.stock ||= {}; s.prices ||= {}; s.policy ||= {};
    for (const g of GOOD_IDS) { s.stock[g] ??= 0; s.prices[g] ??= GOODS[g].base; s.policy[g] ||= { buy: true, sell: true }; }
    s.recentAway ??= 0; s.stats ||= { shipsServed: 0, cargoTraded: 0, earned: 0, turnedAway: 0, diverted: 0 }; s.stats.diverted ??= 0;
    s.ships ||= []; s.log ||= []; s.fx ||= { flareUntil: 0, boom: null, glut: null, festivalUntil: 0 };
    s.income ||= { today: 0, yesterday: 0, breakdown: {} };
    s.speed ??= 1; s.level ??= 1; s.residents ??= 0; s.rep ??= 0.3; s.t ??= 0; s.day ??= 1;
    s.sector = this.sectorDef(s.sector) ? s.sector : 'home';
    s.cells ||= {};
    const now = Date.now();
    for (let r = 0; r < s.grid.length; r++) for (let c = 0; c < s.grid[r].length; c++) {
      const k = `${r},${c}`;
      if (s.grid[r][c]) { s.cells[k] ||= { lvl: 1, bank: 0, readyAt: null, builtAt: now, at: now }; s.cells[k].at ??= now; s.cells[k].lvl ??= 1; s.cells[k].bank ??= 0; }
      else if (s.cells[k]) delete s.cells[k];
    }
    if (!s.hub) { for (let r = 0; r < s.grid.length; r++) for (let c = 0; c < s.grid[r].length; c++) if (s.grid[r][c] && s.grid[r][c].id === 'hub') s.hub = { r, c }; }
    // A1.2: stations saved before plots get the smallest ring that holds every module; stale bounds are recomputed from the ring
    if (!s.plot || typeof s.plot.ring !== 'number') s.plot = this.plotAt(s, this.ringContaining(s));
    else s.plot = this.plotAt(s, s.plot.ring, s.plot.clearing || null);
    return s;
  },

  log(msg, cls = '') { this.logTo(this.state, msg, cls); },
  logTo(s, msg, cls = '') {
    if (!s) return;
    s.log.unshift({ day: s.day, msg, cls });
    if (s.log.length > 120) s.log.length = 120;
    if (s === this.state) this.emit('log');
  },
  toast(msg, cls = '') { this.emit('toast', { msg, cls }); },
  floater(x, y, text, color = '#7ee787') { this.floaters.push({ x, y, text, color, ttl: 1.6 }); },

  now() { return this.state.day + this.state.t; },

  // ---------------------------------------------------------- grid helpers (grids are sized per sector, 4.5)
  rows(s = this.state) { return s.grid.length; },
  cols(s = this.state) { return s.grid[0].length; },
  queueRadius(s = this.state) { return this.cols(s) / 2 + 1.6; },
  cells() { return this.cellsOf(this.state); },
  cellsOf(s) {
    const out = [], g = s.grid;
    for (let r = 0; r < g.length; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c]) out.push({ r, c, m: g[r][c] });
    return out;
  },
  inBounds(r, c) { return r >= 0 && r < this.rows() && c >= 0 && c < this.cols(); },
  occupied(r, c) { return this.inBounds(r, c) && !!this.state.grid[r][c]; },
  neighbors(r, c) { return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]; },

  // 4.3 cell meta: { lvl, bank, readyAt, builtAt, at, up? }. A cell is "building" while readyAt is set and it is
  // not an upgrade (upgrading modules keep running at their current level, see data2.js note 3).
  cellMeta(r, c, s = this.state) { return s && s.cells ? s.cells[`${r},${c}`] || null : null; },
  isBuilding(r, c, s = this.state) { const m = this.cellMeta(r, c, s); return !!(m && m.readyAt != null && !m.up); },
  active(r, c, s = this.state) { return !!(s.grid[r] && s.grid[r][c]) && !this.isBuilding(r, c, s); },
  levelOf(r, c, s = this.state) { const m = this.cellMeta(r, c, s); return m && m.lvl ? m.lvl : 1; },
  upgradeEffect(id, kind, lvl) {
    const d = MODULES[id];
    if (typeof UPGRADE_EFFECTS === 'undefined' || !d.upgrade || !d.upgrade.kind) return 1;
    const E = UPGRADE_EFFECTS[d.upgrade.kind];
    return E && E[kind] ? E[kind][clamp(lvl, 1, 3) - 1] : 1;
  },
  dockTimeMul(dock, s = this.state) { return dock ? this.upgradeEffect('dock', 'dockTime', this.levelOf(dock.r, dock.c, s)) : 1; },
  bankRate(id, lvl) { const d = MODULES[id]; const mul = (typeof TIMERS !== 'undefined' ? TIMERS.RATE_MUL : [1, 1.6, 2.4])[clamp(lvl, 1, 3) - 1]; return (d.rate || 0) * mul; },

  tierUnlocked(tier) { return tier <= this.state.level; },

  canPlace(id, r, c) {
    const s = this.state, def = MODULES[id];
    if (!def || !this.inBounds(r, c) || s.grid[r][c]) return { ok: false, why: 'Occupied' };
    if (!this.inPlot(r, c, s)) return { ok: false, why: 'plot' };                 // A1.2: unclaimed space
    if (!this.tierUnlocked(def.tier)) return { ok: false, why: `Needs station level ${def.tier}` };
    if (s.credits < def.cost) return { ok: false, why: 'Not enough credits' };
    const adj = this.neighbors(r, c).some(([nr, nc]) => this.occupied(nr, nc));
    if (!adj) return { ok: false, why: 'Must touch the station' };
    return { ok: true };
  },

  // 6: place deducts credits, creates the cell meta through Meta.onPlace (which emits build-start), emits built
  place(id, r, c) {
    const chk = this.canPlace(id, r, c);
    if (!chk.ok) { this.toast(chk.why, 'bad'); return false; }
    const def = MODULES[id];
    this.state.credits -= def.cost;
    this.state.grid[r][c] = { id, built: this.state.day };
    this.floater(c + 0.5, r + 0.5, `-${fmt(def.cost)}`, '#ff9d5a');
    const M = this.meta();
    const started = M ? M.onPlace(r, c, id) : null;
    if (started && !started.instant) this.log(`Construction of ${def.name} begins.`, '');
    else this.log(`Built ${def.name}.`, '');
    this.recomputeLevel();
    this.emit('built', { r, c, id });
    this.emit('change');
    return true;
  },

  canDemolish(r, c) {
    const s = this.state;
    if (!this.occupied(r, c)) return { ok: false, why: 'Nothing there' };
    if (s.grid[r][c].id === 'hub') return { ok: false, why: 'The Core Hub cannot be removed' };
    if (s.ships.some(sh => sh.dock && sh.dock.r === r && sh.dock.c === c)) return { ok: false, why: 'A ship is using this berth' };
    // connectivity: everything must still reach the hub
    const seen = new Set([`${s.hub.r},${s.hub.c}`]), q = [[s.hub.r, s.hub.c]];
    while (q.length) {
      const [qr, qc] = q.pop();
      for (const [nr, nc] of this.neighbors(qr, qc)) {
        if ((nr === r && nc === c) || !this.occupied(nr, nc) || seen.has(`${nr},${nc}`)) continue;
        seen.add(`${nr},${nc}`); q.push([nr, nc]);
      }
    }
    if (seen.size !== this.cells().length - 1) return { ok: false, why: 'Would cut modules off from the hub' };
    return { ok: true };
  },

  // 6: demolish clears the cell meta (the bank is lost; the UI says so in its confirm)
  demolish(r, c) {
    const chk = this.canDemolish(r, c);
    if (!chk.ok) { this.toast(chk.why, 'bad'); return false; }
    const id = this.state.grid[r][c].id, def = MODULES[id];
    const refund = Math.round(def.cost * 0.5);
    const M = this.meta();
    if (M) M.onDemolish(r, c, id);
    this.state.credits += refund;
    this.state.grid[r][c] = null;
    if (this.state.cells) delete this.state.cells[`${r},${c}`];
    this.floater(c + 0.5, r + 0.5, `+${fmt(refund)}`);
    this.log(`Scrapped ${def.name} for ${fmt(refund)} credits.`, 'warn');
    this.recomputeLevel();
    this.emit('demolished', { r, c, id });
    this.emit('change');
    return true;
  },

  // ---------------------------------------------------------- derived totals
  // 6: cells under construction count for power draw only; upgrade multipliers and the sector bias apply.
  totals() { return this.totalsOf(this.state); },
  totalsOf(s) {
    const B = this.bias(s);
    const T = { produced: 0, used: 0, docks: 0, storage: 0, beds: 0, food: 0, homes: 0, fun: 0,
      counts: {}, modules: 0, building: 0, security: 0, tariff: 0, margin: 0, traffic: 0, business: 0,
      repairIncome: 0, fuelIncome: 0, repBonus: 0, galactic: false, hasBank: false, hasClinic: false,
      hasSchool: false, hasMarket: false, produces: {}, converts: [], flare: s.day < s.fx.flareUntil,
      rate: 0, bias: B };
    const W = (typeof ECON !== 'undefined' && ECON.upgradeModuleWeight != null) ? ECON.upgradeModuleWeight : 0.5;
    for (const { r, c, m } of this.cellsOf(s)) {
      const d = MODULES[m.id];
      if (d.power < 0) T.used += -d.power;                       // draw counts even under construction
      if (this.isBuilding(r, c, s)) { T.building++; continue; }
      const lvl = this.levelOf(r, c, s);
      const capMul = this.upgradeEffect(m.id, 'capacity', lvl), powMul = this.upgradeEffect(m.id, 'power', lvl);
      T.counts[m.id] = (T.counts[m.id] || 0) + 1;
      if (m.id !== 'hub') T.modules += 1 + (lvl - 1) * W;
      if (d.power > 0 && !(m.id === 'solar' && T.flare)) T.produced += d.power * powMul;
      T.docks += d.docks || 0; T.storage += d.storage || 0; T.beds += (d.beds || 0) * capMul;
      T.food += d.food || 0; T.homes += (d.homes || 0) * capMul; T.fun += d.fun || 0;
      T.security += d.security || 0; T.tariff += d.tariff || 0; T.margin += d.margin || 0;
      T.traffic += d.traffic || 0; T.business += d.business || 0;
      T.repairIncome += d.repairIncome || 0; T.fuelIncome += (d.fuelIncome || 0) * B.fuel; T.repBonus += d.rep || 0;
      T.rate += this.bankRate(m.id, lvl);
      if (d.galactic) T.galactic = true;
      if (d.bank) T.hasBank = true;
      if (m.id === 'clinic') T.hasClinic = true;
      if (m.id === 'school') T.hasSchool = true;
      if (m.id === 'market') T.hasMarket = true;
      if (d.produces) for (const g in d.produces) T.produces[g] = (T.produces[g] || 0) + d.produces[g];
      if (d.converts) T.converts.push(B.refinery === 1 ? d.converts : Object.assign({}, d.converts, { outAmt: Math.round(d.converts.outAmt * B.refinery) }));
    }
    T.beds = Math.round(T.beds); T.homes = Math.round(T.homes); T.produced = Math.round(T.produced);
    T.efficiency = T.used > T.produced ? clamp(T.produced / Math.max(1, T.used), 0.3, 1) : 1;
    T.stockTotal = GOOD_IDS.reduce((a, g) => a + s.stock[g], 0);
    T.visitors = s.ships.filter(sh => sh.state === 'docked').reduce((a, sh) => a + sh.crew, 0);
    T.funCount = (T.counts.rec || 0) + (T.counts.plaza || 0) + (T.counts.menagerie || 0);
    return T;
  },

  // amenity coverage 0..1 across food, beds, fun, health
  amenity(T, s = this.state) {
    const people = T.visitors + s.residents;
    const food = people ? clamp(T.food / people, 0, 1) : 1;
    const beds = T.visitors ? clamp(T.beds / T.visitors, 0, 1) : 1;
    const fun = people ? clamp((T.funCount * 40) / people, 0, 1) : (T.funCount ? 1 : 0.5);
    const health = T.hasClinic ? 1 : (people > 20 ? 0.4 : 0.7);
    const score = (food * 0.35 + beds * 0.2 + fun * 0.25 + health * 0.2) * T.efficiency;
    return { food, beds, fun, health, score };
  },

  recomputeLevel(s = this.state) {
    const T = this.totalsOf(s);
    let lvl = 1;
    for (const th of LEVEL_THRESHOLDS) if (T.modules >= th.modules && s.rep >= th.rep) lvl = th.level;
    if (lvl > s.level) {
      s.level = lvl;
      if (lvl === 5) this.logTo(s, `${s.name} is now a true galactic hub: a city between the stars, built from one docking collar. Keep growing.`, 'good');
      else this.logTo(s, `Station reaches level ${lvl}: ${TIER_NAMES[lvl]}. New modules unlocked.`, 'good');
      if (s === this.state) { this.toast(`Level ${lvl} — ${TIER_NAMES[lvl]}`, 'gold'); this.emit('levelup', lvl); }
      const M = this.meta(); if (M) M.onLevelUp(s, lvl);
    }
    s.level = Math.max(s.level, lvl);
  },

  // ---------------------------------------------------------- prices (6: sector bias on goods)
  effPrice(g) {
    const s = this.state; let p = s.prices[g] * (this.bias(s).goods[g] || 1);
    if (s.fx.boom && s.fx.boom.good === g && s.day < s.fx.boom.until) p *= 3;
    if (s.fx.glut && s.fx.glut.good === g && s.day < s.fx.glut.until) p *= 0.5;
    return p;
  },
  buyPrice(g, T) { return this.effPrice(g) * (0.65 - (T || this.totals()).margin); },   // what we pay ships
  sellPrice(g, T) { return this.effPrice(g) * (1.05 + (T || this.totals()).margin); },  // what ships pay us

  setPolicy(g, key, val) { this.state.policy[g][key] = val; this.emit('change'); },

  dumpStock(g) {
    const s = this.state, qty = s.stock[g];
    if (!qty) return;
    const got = Math.round(qty * this.effPrice(g) * 0.5);
    s.stock[g] = 0; s.credits += got; this.earn(got, 'dumped stock');
    this.log(`Sold ${qty} ${GOODS[g].name} to a passing broker for ${fmt(got)}.`, 'warn');
    this.emit('change');
  },

  earn(amt, cat) {   // bookkeeping only; the caller moves the credits
    const s = this.state;
    s.income.today += amt;
    s.income.breakdown[cat] = (s.income.breakdown[cat] || 0) + amt;
    if (amt > 0) s.stats.earned += amt;
  },

  // ---------------------------------------------------------- ships
  holdOf(cls) { return Math.max(1, Math.round(cls.cargo * LIVE)); },   // units a ship actually carries (tuning record 1)

  spawnShip(forceCompany) {
    const s = this.state, T = this.totals(), B = this.bias(s);
    let pool = COMPANIES.filter(c => !c.galactic || T.galactic);
    let co = forceCompany ? COMPANIES.find(c => c.id === forceCompany) : null;
    if (!co) {
      // weight by trust: trusted companies send more ships; the sector bias favours its home lines
      const w = pool.map(c => (1 + s.companies[c.id].trust / 50) * (B.companies[c.id] || 1));
      let r = Math.random() * w.reduce((a, b) => a + b, 0);
      co = pool[0];
      for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) { co = pool[i]; break; } }
    }
    const clsId = pick(co.ships), cls = SHIP_CLASSES[clsId], planet = PLANETS[co.home];
    const cargo = {}, hold = this.holdOf(cls);
    const goods = [...planet.exports].sort(() => Math.random() - 0.5).slice(0, irnd(1, 2));
    let left = hold;
    goods.forEach((g, i) => { const q = i === goods.length - 1 ? left : Math.round(left * rnd(0.4, 0.7)); cargo[g] = q; left -= q; });
    const cols = this.cols(), rows = this.rows(), side = irnd(0, 3);
    const x = side === 0 ? -3 : side === 1 ? cols + 3 : rnd(-1, cols + 1);
    const y = side === 2 ? -3 : side === 3 ? rows + 3 : rnd(-1, rows + 1);
    const ship = {
      id: s.nextShipId++, company: co.id, cls: clsId, captain: `Capt. ${pick(CAPTAIN_NAMES)}`,
      cargo, hold, wants: [...planet.imports], crew: cls.crew + (cls.passengers || 0),
      state: 'approach', x, y, angle: Math.random() * Math.PI * 2, dock: null, target: null,
      dockedUntil: 0, waitStart: this.now(), arrived: this.now(), trades: [], earned: 0,
    };
    s.ships.push(ship);
    this.routeShip(ship);
    this.emit('spawn', ship);
    return ship;
  },

  // find dock cell with a free berth point; returns {dock:{r,c}, berth:{x,y}} or null (docks under construction do not count)
  findBerth() {
    const s = this.state, taken = new Set(s.ships.filter(sh => sh.dock).map(sh => `${sh.dock.r},${sh.dock.c}`));
    const best = [];
    for (const { r, c, m } of this.cells()) {
      if (!(MODULES[m.id].docks > 0) || taken.has(`${r},${c}`) || !this.active(r, c)) continue;
      const bp = this.berthPoint(r, c);
      if (bp) best.push({ dock: { r, c }, berth: bp });
    }
    return best.length ? pick(best) : null;
  },
  berthPoint(r, c) {
    const s = this.state, cr = s.hub.r + 0.5, cc = s.hub.c + 0.5;
    let best = null, bd = -1;
    for (const [nr, nc] of this.neighbors(r, c)) {
      if (this.occupied(nr, nc)) continue;
      const d = Math.hypot(nc + 0.5 - cc, nr + 0.5 - cr);
      if (d > bd) { bd = d; best = { x: nc + 0.5, y: nr + 0.5 }; }
    }
    return best;
  },
  dockUsable(r, c) { return !!this.berthPoint(r, c); },

  routeShip(ship) {
    const b = this.findBerth();
    if (b) { ship.dock = b.dock; ship.target = b.berth; ship.state = 'approach'; }
    else { ship.dock = null; ship.target = null; ship.state = 'queue'; }
  },

  onDock(ship, T) {
    const s = this.state, co = s.companies[ship.company], coDef = COMPANIES.find(c => c.id === ship.company);
    const cls = SHIP_CLASSES[ship.cls];
    const discount = s.day < co.contractUntil ? 0.85 : 1;
    const size = cls.cargo / 80;                                  // class size ratio for fuel and repairs
    let earned = 0;
    // fees (live-scaled)
    const fee = Math.max(1, Math.round(cls.dockFee * discount * T.efficiency * LIVE));
    earned += fee; ship.trades.push(`Docking fee +${fmt(fee)}`);
    if (T.fuelIncome) { const f = Math.max(1, Math.round(T.fuelIncome * size * (T.counts.fuel > 1 ? 1.3 : 1) * LIVE)); earned += f; ship.trades.push(`Fuel +${fmt(f)}`); }
    if (T.repairIncome && Math.random() < 0.6) { const rp = Math.max(1, Math.round(T.repairIncome * size * LIVE)); earned += rp; ship.trades.push(`Repairs +${fmt(rp)}`); }
    s.credits += earned; this.earn(earned, 'docking & services');

    // ship sells cargo to station
    let traded = 0;
    for (const g in ship.cargo) {
      const want = ship.cargo[g];
      if (!s.policy[g].buy) continue;
      const room = Math.max(0, T.storage - this.totals().stockTotal);
      const price = this.buyPrice(g, T);
      const canAfford = Math.floor(Math.max(0, s.credits) / Math.max(0.01, price));
      const q = Math.min(want, room, canAfford);
      if (q <= 0) continue;
      const cost = Math.round(q * price);
      s.credits -= cost; s.stock[g] += q; ship.cargo[g] -= q; traded += q;
      this.earn(-cost, 'cargo bought');
      ship.trades.push(`Bought ${q} ${GOODS[g].name} -${fmt(cost)}`);
    }
    // ship buys what its home world wants, at full price
    let capacity = ship.hold || this.holdOf(cls);
    const wantList = ship.wants.filter(g => s.policy[g].sell && s.stock[g] > 0);
    const perGood = Math.max(1, Math.floor(capacity / Math.max(1, wantList.length)));
    for (const g of wantList) {
      const q = Math.min(s.stock[g], perGood, capacity);
      if (q <= 0) continue;
      const got = Math.round(q * this.sellPrice(g, T));
      s.stock[g] -= q; s.credits += got; traded += q; earned += got; capacity -= q;
      this.earn(got, 'cargo sold');
      ship.trades.push(`Sold ${q} ${GOODS[g].name} +${fmt(got)}`);
    }
    // then fills spare hold space speculatively with anything else, at a discount
    const home = PLANETS[coDef.home];
    const spec = GOOD_IDS.filter(g => s.policy[g].sell && s.stock[g] > 0 && !ship.wants.includes(g) && !home.exports.includes(g))
      .sort((a, b) => this.effPrice(b) - this.effPrice(a));
    for (const g of spec) {
      if (capacity <= 0) break;
      const q = Math.min(s.stock[g], Math.ceil(capacity * 0.5));
      const got = Math.round(q * this.effPrice(g) * (0.85 + T.margin));
      s.stock[g] -= q; s.credits += got; traded += q; earned += got; capacity -= q;
      this.earn(got, 'cargo sold');
      ship.trades.push(`Took ${q} ${GOODS[g].name} on spec +${fmt(got)}`);
    }
    if (T.tariff && traded) { const t = Math.round(T.tariff * traded); if (t > 0) { s.credits += t; earned += t; this.earn(t, 'tariffs'); ship.trades.push(`Tariff +${fmt(t)}`); } }
    s.stats.cargoTraded += traded;
    ship.earned = earned;
    ship.dockedUntil = this.now() + cls.dockDays * this.dockTimeMul(ship.dock);   // 4.3 dock upgrades shorten service
    if (earned > 0) this.floater(ship.x, ship.y - 0.3, `+${fmt(earned)}`, coDef.color);
    // trust: penalise long waits
    const waited = this.now() - ship.waitStart;
    const dTrust = (T.counts.shipyard ? 3 : 2) - (waited > 1 ? Math.floor(waited) * 2 : 0);
    co.trust = clamp(co.trust + dTrust, 0, 100);
    co.served++; s.stats.shipsServed++;
    if (!co.office && co.trust >= 75) { co.office = true; this.log(`${coDef.name} opens a permanent office on the station. Expect regular traffic and rent.`, 'good'); this.toast(`${coDef.name} opened an office`, 'gold'); }
    this.emit('dock', ship);
    this.emit('change');
  },

  onDepart(ship) {
    const s = this.state, cr = s.hub.r + 0.5, cc = s.hub.c + 0.5;
    const dx = ship.x - cc, dy = ship.y - cr, L = Math.hypot(dx, dy) || 1;
    ship.target = { x: cc + dx / L * (this.cols() + 6), y: cr + dy / L * (this.rows() + 6) };
    ship.dock = null; ship.state = 'depart';
    this.emit('depart', ship);
  },

  tickShips(dtDays, T) {
    const s = this.state, now = this.now(), B = T.bias || this.bias(s);
    // spawn
    s.shipTimer -= dtDays;
    if (s.shipTimer <= 0) {
      const offices = Object.values(s.companies).filter(c => c.office).length;
      const contracts = Object.values(s.companies).filter(c => s.day < c.contractUntil).length;
      const M = this.meta();
      const convoy = (M && M.convoyActive()) ? ((typeof TIMERS !== 'undefined' && TIMERS.CONVOY_TRAFFIC) || 1.5) : 1;   // 4.11
      const rate = (0.9 + s.rep * 0.6 + T.traffic * 4 + offices * 0.4 + contracts * 0.5) * (T.galactic ? 1.25 * B.gate : 1) * B.traffic * convoy;
      s.shipTimer = rnd(0.6, 1.4) / rate;
      const queued = s.ships.filter(sh => sh.state === 'queue').length;
      if (queued >= 2) { s.stats.diverted++; s.recentAway += 0.5; }   // captains see the queue and divert elsewhere
      else if (s.ships.length < 16) this.spawnShip();
    }
    const QR = this.queueRadius(s);
    for (const ship of [...s.ships]) {
      if (ship.state === 'approach' || ship.state === 'depart') {
        const dx = ship.target.x - ship.x, dy = ship.target.y - ship.y, d = Math.hypot(dx, dy);
        const step = SHIP_SPEED * dtDays;
        ship.angle = Math.atan2(dy, dx);
        if (d <= step) {
          ship.x = ship.target.x; ship.y = ship.target.y;
          if (ship.state === 'approach') { ship.state = 'docked'; this.onDock(ship, T); }
          else s.ships.splice(s.ships.indexOf(ship), 1);
        } else { ship.x += dx / d * step; ship.y += dy / d * step; }
      } else if (ship.state === 'queue') {
        ship.orbit = (ship.orbit ?? Math.atan2(ship.y - s.hub.r - 0.5, ship.x - s.hub.c - 0.5)) + 0.7 * dtDays;
        const tx = s.hub.c + 0.5 + Math.cos(ship.orbit) * QR, ty = s.hub.r + 0.5 + Math.sin(ship.orbit) * QR * 0.75;
        ship.angle = Math.atan2(ty - ship.y, tx - ship.x);
        ship.x += (tx - ship.x) * Math.min(1, dtDays * 6); ship.y += (ty - ship.y) * Math.min(1, dtDays * 6);
        if (now - ship.waitStart > MAX_WAIT_DAYS) {
          const co = s.companies[ship.company], coDef = COMPANIES.find(c => c.id === ship.company);
          co.trust = clamp(co.trust - 6, 0, 100); s.stats.turnedAway++; s.recentAway += 1;
          this.log(`${coDef.name} ${SHIP_CLASSES[ship.cls].name} gave up waiting for a berth and left.`, 'bad');
          this.onDepart(ship);
        } else {
          const b = this.findBerth();
          if (b) { ship.dock = b.dock; ship.target = b.berth; ship.state = 'approach'; }
        }
      } else if (ship.state === 'docked') {
        if (now >= ship.dockedUntil) this.onDepart(ship);
      }
    }
  },

  // ---------------------------------------------------------- daily tick (live flows scaled by LIVE; residents and rent by the sector bias)
  dailyTick() {
    const s = this.state, T = this.totals(), A = this.amenity(T), B = T.bias || this.bias(s);
    let delta = 0;
    // production
    for (const g in T.produces) { const room = T.storage - T.stockTotal; const q = Math.min(T.produces[g], Math.max(0, room)); s.stock[g] += q; }
    for (const cv of T.converts) {
      const n = Math.min(cv.inAmt, s.stock[cv.from]);
      if (n >= cv.inAmt) { s.stock[cv.from] -= cv.inAmt; s.stock[cv.to] += cv.outAmt; }
    }
    // residents: rent, business, growth
    if (s.residents > 0) {
      const rent = Math.round(s.residents * 6 * T.efficiency * B.rent * LIVE); delta += rent; this.earn(rent, 'resident rent');
      if (T.business) { const b = Math.round(s.residents * T.business * (s.day < s.fx.festivalUntil ? 2 : 1) * LIVE); delta += b; this.earn(b, 'promenade business'); }
      const eat = Math.round(s.residents * 0.15);
      if (s.stock.grain >= eat) s.stock.grain -= eat;
      else if (s.stock.fruit >= eat) s.stock.fruit -= eat;
    }
    const freeHomes = T.homes - s.residents;
    if (B.residents > 0 && freeHomes > 0 && A.score > 0.55) {
      const growth = Math.max(1, Math.round(T.visitors * 0.08 * (T.hasSchool ? 2 : 1) * A.score * B.residents));
      const add = Math.min(freeHomes, growth);
      if (add > 0 && Math.random() < 0.7) { s.residents += add; if (s.residents === add) this.log('The first permanent residents move in.', 'good'); }
    } else if (A.score < 0.35 && s.residents > 0) {
      const leave = Math.max(1, Math.round(s.residents * 0.05)); s.residents -= leave;
      this.log(`${leave} residents leave: the station is not a pleasant place to live right now.`, 'bad');
    }
    // visitors spending
    if (T.visitors) {
      const perHead = 6 * (0.5 + A.food * 0.6 + A.beds * 0.4 + A.fun * 0.9) * (s.day < s.fx.festivalUntil ? 2 : 1) * T.efficiency * LIVE;
      const spend = Math.round(T.visitors * perHead); delta += spend; this.earn(spend, 'crew spending');
    }
    // menagerie exhibits
    if (T.counts.menagerie && s.stock.xenofauna > 0) {
      const ex = Math.round(Math.min(s.stock.xenofauna, 30 * T.counts.menagerie) * 4 * (1 + s.residents / 50) * LIVE); delta += ex; this.earn(ex, 'menagerie tickets');
    }
    // offices pay rent
    const offices = Object.values(s.companies).filter(c => c.office).length;
    if (offices) { const r = Math.round(offices * 80 * LIVE); delta += r; this.earn(r, 'office leases'); }
    // bank: loan repayments (player money, never scaled)
    for (const c of COMPANIES) {
      const co = s.companies[c.id];
      if (!co.loan) continue;
      const L = co.loan;
      const risk = (100 - co.trust) / 100 * 0.025;
      if (Math.random() < risk) { this.log(`${c.name} defaults on its loan. ${fmt(L.remaining)} credits written off.`, 'bad'); co.loan = null; co.trust = clamp(co.trust - 15, 0, 100); continue; }
      const pay = Math.min(L.remaining, L.perDay); L.remaining -= pay; delta += pay; this.earn(pay, 'loan repayments');
      if (L.remaining <= 0) { co.loan = null; co.trust = clamp(co.trust + 8, 0, 100); this.log(`${c.name} repays its loan in full.`, 'good'); }
    }
    // upkeep
    let upkeep = 0;
    for (const { m } of this.cells()) upkeep += MODULES[m.id].cost * 0.004;
    upkeep = Math.round((upkeep + s.residents * 1) * LIVE); delta -= upkeep; this.earn(-upkeep, 'upkeep');
    s.credits += delta;

    // prices drift & mean-revert
    for (const g of GOOD_IDS) {
      const b = GOODS[g].base;
      s.prices[g] = clamp(s.prices[g] + (b - s.prices[g]) * 0.08 + b * rnd(-0.06, 0.06), b * 0.5, b * 1.8);
    }
    // reputation drifts toward a target
    const variety = Object.keys(T.counts).length / 14;
    s.recentAway *= 0.75;                                   // memories of bad service fade
    const waitPenalty = Math.min(1.2, s.recentAway * 0.25);
    if (s.recentAway > 2 && s.day % 3 === 0) this.log('Ships are diverting to other stations: not enough free berths.', 'warn');
    let target = A.score * 2.4 + Math.min(1, variety) * 1.0 + (s.residents > 0 ? 0.4 : 0) + Math.min(1, T.repBonus)
      + (T.galactic ? 0.3 : 0) - waitPenalty - (s.credits < 0 ? 0.8 : 0) - (T.efficiency < 1 ? 0.6 : 0);
    target = clamp(target, 0, 5);
    s.rep += (target - s.rep) * 0.12;
    s.rep = clamp(s.rep, 0, 5);
    if (T.efficiency < 1 && s.day % 3 === 0) this.log('Power shortage: modules are running at reduced efficiency. Build a Solar Array or Reactor.', 'warn');
    if (s.credits < 0 && s.day % 2 === 0) this.log('The station is in debt. Income is suffering until credits are positive.', 'bad');

    this.recomputeLevel();
    // random events
    if (s.day >= s.nextEventDay && !s.pending) { this.rollEvent(); s.nextEventDay = s.day + irnd(4, 8); }
    s.income.yesterday = s.income.today; s.income.today = 0; s.income.breakdown = {};
    this.emit('day', s.day);
    this.emit('change');
  },

  // ---------------------------------------------------------- events (6: sector bias on event weights)
  rollEvent() {
    const s = this.state, B = this.bias(s);
    const pool = EVENTS.filter(e => !e.minLevel || s.level >= e.minLevel);
    const weights = pool.map(e => e.weight * (B.events[e.id] || 1));
    const total = weights.reduce((a, w) => a + w, 0);
    let r = Math.random() * total, ev = pool[0];
    for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) { ev = pool[i]; break; } }
    const data = {};
    if (ev.id === 'boom' || ev.id === 'glut') data.good = pick(GOOD_IDS);
    if (ev.id === 'contract') data.company = pick(COMPANIES.filter(c => !c.galactic || this.totals().galactic)).id;
    let text = ev.text;
    if (data.good) text = text.replace('{good}', GOODS[data.good].name);
    if (data.company) text = text.replace('{company}', COMPANIES.find(c => c.id === data.company).name);
    s.pending = { id: ev.id, title: ev.title, text, data, choice: !!ev.choice, yes: ev.yes, no: ev.no };
    this.emit('event');
  },

  resolveEvent(accepted) {
    const s = this.state, ev = s.pending; if (!ev) return;
    const T = this.totals(); s.pending = null;
    const d = ev.data;
    switch (ev.id) {
      case 'flare': s.fx.flareUntil = s.day + 3; this.log('Solar flare: solar arrays offline for 3 days.', 'warn'); break;
      case 'pirates': {
        if (T.security >= 2) { this.log('Pirates attempted a raid but security drove them off with no losses.', 'good'); break; }
        const frac = 0.35 / (1 + T.security); let lost = 0;
        for (const g of GOOD_IDS) { const q = Math.round(s.stock[g] * frac); s.stock[g] -= q; lost += q * this.effPrice(g); }
        const cash = Math.round(Math.min(Math.max(0, s.credits) * 0.08, 1500) / (1 + T.security)); s.credits -= cash;
        this.log(`Pirate raid! Lost cargo worth ~${fmt(lost)} and ${fmt(cash)} credits.`, 'bad'); break;
      }
      case 'boom': s.fx.boom = { good: d.good, until: s.day + 4 }; this.log(`Trade boom: ${GOODS[d.good].name} prices tripled for 4 days.`, 'good'); break;
      case 'glut': s.fx.glut = { good: d.good, until: s.day + 4 }; this.log(`Market glut: ${GOODS[d.good].name} prices halved for 4 days.`, 'warn'); break;
      case 'outbreak':
        if (T.hasClinic) this.log('Hold fever contained by the Med Bay. No one got sick.', 'good');
        else { const l = Math.round(s.residents * 0.25); s.residents -= l; s.rep = Math.max(0, s.rep - 0.5); this.log(`Hold fever spreads. ${l} residents leave and reputation suffers. Build a Med Bay.`, 'bad'); }
        break;
      case 'refugees':
        if (!accepted) { s.rep = Math.max(0, s.rep - 0.15); this.log('The refugee convoy moved on. Word gets around.', 'warn'); break; }
        { const free = T.homes - s.residents; if (free <= 0) { s.rep = Math.max(0, s.rep - 0.1); this.log('You offered shelter but had no homes. The convoy left disappointed.', 'warn'); }
          else { const n = Math.min(free, 20); s.residents += n; s.rep = Math.min(5, s.rep + 0.5); this.log(`${n} refugees settle on the station. Your reputation grows.`, 'good'); } }
        break;
      case 'explorer': { const r = T.counts.observatory ? 1 : 0.5; s.rep = Math.min(5, s.rep + r); s.credits += 600; this.earn(600, 'publicity'); this.log(`A famous explorer visits. Reputation +${r}, and 600 credits in press junkets.`, 'good'); break; }
      case 'contract': {
        const co = s.companies[d.company], name = COMPANIES.find(c => c.id === d.company).name;
        if (accepted) { co.contractUntil = s.day + 10; co.trust = clamp(co.trust + 10, 0, 100); this.log(`Signed a 10-day contract with ${name}.`, 'good'); for (let i = 0; i < 2; i++) this.spawnShip(d.company); }
        else this.log(`Declined the ${name} contract.`, '');
        break;
      }
      case 'smugglers':
        if (!T.counts.customs && !T.security) { this.log('Smugglers slipped through. A Customs Office or Security Post would have caught them.', 'warn'); break; }
        { let room = T.storage - T.stockTotal, got = []; for (const g of ['spice', 'tech', 'crystals', 'medicine']) { const q = Math.min(room, irnd(5, 15)); if (q > 0) { s.stock[g] += q; room -= q; got.push(`${q} ${GOODS[g].name}`); } }
          this.log(`Smugglers caught. Seized: ${got.join(', ') || 'nothing (no storage room)'}.`, 'good'); }
        break;
      case 'festival': s.fx.festivalUntil = s.day + 3; this.log('Station festival! Visitor spending doubled for 3 days.', 'good'); break;
    }
    const M = this.meta(); if (M) M.onResolve(ev, accepted);
    this.emit('change');
  },

  // ---------------------------------------------------------- bank
  lend(companyId, amount) {
    const s = this.state, co = s.companies[companyId], name = COMPANIES.find(c => c.id === companyId).name;
    if (!this.totals().hasBank) return this.toast('Build a Mercantile Bank first', 'bad');
    if (co.loan) return this.toast(`${name} already has a loan`, 'bad');
    amount = Math.round(amount);
    if (!(amount >= 500)) return this.toast('Minimum loan is 500', 'bad');
    if (amount > s.credits) return this.toast('Not enough credits', 'bad');
    const rate = 0.25 - co.trust / 100 * 0.1;
    const total = Math.round(amount * (1 + rate));
    co.loan = { principal: amount, remaining: total, perDay: Math.ceil(total / 10), rate };
    s.credits -= amount; this.earn(-amount, 'loans issued');
    this.log(`Lent ${fmt(amount)} to ${name} at ${Math.round(rate * 100)}%. Repaid over 10 days.`, '');
    this.emit('change');
  },

  // ---------------------------------------------------------- main tick
  // advance the world by dtDays of game time (shared by the frame tick and the offline catch-up)
  advance(dtDays) {
    const s = this.state; if (!s || s.pending || !(dtDays > 0)) return;
    const T = this.totals();
    this.tickShips(dtDays, T);
    s.t += dtDays;
    while (s.t >= 1) { s.t -= 1; s.day++; this.dailyTick(); }
  },

  tick(dtReal) {
    const s = this.state; if (!s || s.pending) return;
    // A1.1: speed is Pause or 1x (presets may allow more through TIMERS.SPEEDS)
    const allowed = (typeof TIMERS !== 'undefined' && TIMERS.SPEEDS) || [0, 1];
    if (!allowed.includes(s.speed)) s.speed = s.speed > 0 ? Math.max(...allowed.filter(v => v > 0)) : 0;
    const dtDays = (dtReal * s.speed) / DAY_SECONDS;
    if (dtDays <= 0) return;
    this.advance(dtDays);
    for (const f of this.floaters) { f.ttl -= dtReal; f.y -= 0.6 * dtReal; }
    this.floaters = this.floaters.filter(f => f.ttl > 0);
  },

  // 4.2 / 6: fast-forward the active sector by `ms` of real time at speed 1 (capped at TIMERS.OFFLINE_SIM_CAP_MS).
  // Transmissions without a choice resolve themselves; one that needs a decision stays pending and ends the loop.
  catchUp(ms) {
    const s = this.state, out = { ms: 0, days: 0, credits: 0, served: 0, events: 0, pending: false };
    if (!s || !(ms > 0)) return out;
    const cap = (typeof TIMERS !== 'undefined' && TIMERS.OFFLINE_SIM_CAP_MS) || 2 * 3600e3;
    ms = Math.min(ms, cap);
    const credits0 = s.credits, served0 = s.stats.shipsServed, STEP = 0.25;
    let left = ms / (DAY_SECONDS * 1000), guard = Math.ceil(left / STEP) + 10;
    this._muted = true;
    try {
      while (left > 1e-9 && guard-- > 0) {
        if (s.pending) { if (s.pending.choice) break; this.resolveEvent(true); out.events++; }
        const d = Math.min(STEP, left);
        this.advance(d); left -= d; out.days += d;
      }
    } finally { this._muted = false; }
    if (s.pending) { out.pending = true; out.events++; }
    this.floaters = [];
    out.ms = ms; out.days = Math.round(out.days * 100) / 100;
    out.credits = Math.round(s.credits - credits0); out.served = s.stats.shipsServed - served0;
    this.emit('log'); this.emit('change');
    if (s.pending) this.emit('event');
    return out;
  },
};

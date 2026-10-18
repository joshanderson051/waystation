// ============================================================
// WAYSTATION — simulation: state, economy, ships, residents
// ============================================================
'use strict';

const DAY_SECONDS = 6;          // real seconds per game day at 1x
const SHIP_SPEED = 22;          // cells per game day
const QUEUE_RADIUS = GRID_COLS / 2 + 1.6;
const MAX_WAIT_DAYS = 3;
const SAVE_KEY = 'waystation-save-v1';

const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.floor(rnd(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = n => Math.round(n).toLocaleString('en-US');

const Sim = {
  state: null,
  floaters: [],          // transient: {x,y,text,color,ttl}
  listeners: {},

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); },
  emit(evt, data) { (this.listeners[evt] || []).forEach(fn => fn(data)); },

  // ---------------------------------------------------------- setup
  newGame() {
    const grid = [];
    for (let r = 0; r < GRID_ROWS; r++) grid.push(new Array(GRID_COLS).fill(null));
    const cr = Math.floor(GRID_ROWS / 2), cc = Math.floor(GRID_COLS / 2);
    grid[cr][cc] = { id: 'hub' };

    const stock = {}, prices = {}, policy = {};
    for (const g of GOOD_IDS) { stock[g] = 0; prices[g] = GOODS[g].base; policy[g] = { buy: true, sell: true }; }

    const companies = {};
    for (const c of COMPANIES) companies[c.id] = { trust: 40, served: 0, contractUntil: 0, loan: null, office: false };

    this.state = {
      name: pick(STATION_NAMES), day: 1, t: 0, credits: 6000, speed: 1,
      grid, hub: { r: cr, c: cc }, stock, prices, policy, companies,
      ships: [], nextShipId: 1, shipTimer: 0.4,
      residents: 0, rep: 0.3, level: 1,
      fx: { flareUntil: 0, boom: null, glut: null, festivalUntil: 0 },
      pending: null, nextEventDay: irnd(4, 7),
      income: { today: 0, yesterday: 0, breakdown: {} }, recentAway: 0,
      log: [], stats: { shipsServed: 0, cargoTraded: 0, earned: 0, turnedAway: 0, diverted: 0 },
    };
    this.floaters = [];
    this.log(`Station ${this.state.name} comes online. One docking collar, a hold full of hope.`, 'good');
    this.log('Build a Docking Bay, a Warehouse and a Solar Array to start taking traffic.', '');
    this.emit('change');
  },

  save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
  },
  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const s = JSON.parse(raw);
      if (!s || !s.grid || !s.companies) return false;
      for (const c of COMPANIES) s.companies[c.id] ||= { trust: 40, served: 0, contractUntil: 0, loan: null, office: false };
      for (const g of GOOD_IDS) { s.stock[g] ??= 0; s.prices[g] ??= GOODS[g].base; s.policy[g] ||= { buy: true, sell: true }; }
      s.recentAway ??= 0; s.stats.diverted ??= 0;
      this.state = s; this.floaters = [];
      return true;
    } catch (e) { return false; }
  },
  reset() { localStorage.removeItem(SAVE_KEY); this.newGame(); },

  log(msg, cls = '') {
    const s = this.state;
    s.log.unshift({ day: s.day, msg, cls });
    if (s.log.length > 120) s.log.length = 120;
    this.emit('log');
  },
  toast(msg, cls = '') { this.emit('toast', { msg, cls }); },
  floater(x, y, text, color = '#7ee787') { this.floaters.push({ x, y, text, color, ttl: 1.6 }); },

  now() { return this.state.day + this.state.t; },

  // ---------------------------------------------------------- grid helpers
  cells() {
    const out = [];
    const g = this.state.grid;
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) if (g[r][c]) out.push({ r, c, m: g[r][c] });
    return out;
  },
  inBounds(r, c) { return r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS; },
  occupied(r, c) { return this.inBounds(r, c) && !!this.state.grid[r][c]; },
  neighbors(r, c) { return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]; },

  tierUnlocked(tier) { return tier <= this.state.level; },

  canPlace(id, r, c) {
    const s = this.state, def = MODULES[id];
    if (!def || !this.inBounds(r, c) || s.grid[r][c]) return { ok: false, why: 'Occupied' };
    if (!this.tierUnlocked(def.tier)) return { ok: false, why: `Needs station level ${def.tier}` };
    if (s.credits < def.cost) return { ok: false, why: 'Not enough credits' };
    const adj = this.neighbors(r, c).some(([nr, nc]) => this.occupied(nr, nc));
    if (!adj) return { ok: false, why: 'Must touch the station' };
    return { ok: true };
  },

  place(id, r, c) {
    const chk = this.canPlace(id, r, c);
    if (!chk.ok) { this.toast(chk.why, 'bad'); return false; }
    const def = MODULES[id];
    this.state.credits -= def.cost;
    this.state.grid[r][c] = { id, built: this.state.day };
    this.floater(c + 0.5, r + 0.5, `-${fmt(def.cost)}`, '#ff9d5a');
    this.log(`Built ${def.name}.`, '');
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

  demolish(r, c) {
    const chk = this.canDemolish(r, c);
    if (!chk.ok) { this.toast(chk.why, 'bad'); return false; }
    const id = this.state.grid[r][c].id, def = MODULES[id];
    const refund = Math.round(def.cost * 0.5);
    this.state.credits += refund;
    this.state.grid[r][c] = null;
    this.floater(c + 0.5, r + 0.5, `+${fmt(refund)}`);
    this.log(`Scrapped ${def.name} for ${fmt(refund)} credits.`, 'warn');
    this.recomputeLevel();
    this.emit('demolished', { r, c, id });
    this.emit('change');
    return true;
  },

  // ---------------------------------------------------------- derived totals
  totals() {
    const s = this.state;
    const T = { produced: 0, used: 0, docks: 0, storage: 0, beds: 0, food: 0, homes: 0, fun: 0,
      counts: {}, modules: 0, security: 0, tariff: 0, margin: 0, traffic: 0, business: 0,
      repairIncome: 0, fuelIncome: 0, repBonus: 0, galactic: false, hasBank: false, hasClinic: false,
      hasSchool: false, hasMarket: false, produces: {}, converts: [], flare: s.day < s.fx.flareUntil };
    for (const { m } of this.cells()) {
      const d = MODULES[m.id];
      T.counts[m.id] = (T.counts[m.id] || 0) + 1;
      if (m.id !== 'hub') T.modules++;
      if (d.power > 0) { if (!(m.id === 'solar' && T.flare)) T.produced += d.power; }
      else T.used += -d.power;
      T.docks += d.docks || 0; T.storage += d.storage || 0; T.beds += d.beds || 0;
      T.food += d.food || 0; T.homes += d.homes || 0; T.fun += d.fun || 0;
      T.security += d.security || 0; T.tariff += d.tariff || 0; T.margin += d.margin || 0;
      T.traffic += d.traffic || 0; T.business += d.business || 0;
      T.repairIncome += d.repairIncome || 0; T.fuelIncome += d.fuelIncome || 0; T.repBonus += d.rep || 0;
      if (d.galactic) T.galactic = true;
      if (d.bank) T.hasBank = true;
      if (m.id === 'clinic') T.hasClinic = true;
      if (m.id === 'school') T.hasSchool = true;
      if (m.id === 'market') T.hasMarket = true;
      if (d.produces) for (const g in d.produces) T.produces[g] = (T.produces[g] || 0) + d.produces[g];
      if (d.converts) T.converts.push(d.converts);
    }
    T.efficiency = T.used > T.produced ? clamp(T.produced / Math.max(1, T.used), 0.3, 1) : 1;
    T.stockTotal = GOOD_IDS.reduce((a, g) => a + s.stock[g], 0);
    T.visitors = s.ships.filter(sh => sh.state === 'docked').reduce((a, sh) => a + sh.crew, 0);
    T.funCount = (T.counts.rec || 0) + (T.counts.plaza || 0) + (T.counts.menagerie || 0);
    return T;
  },

  // amenity coverage 0..1 across food, beds, fun, health
  amenity(T) {
    const s = this.state;
    const people = T.visitors + s.residents;
    const food = people ? clamp(T.food / people, 0, 1) : 1;
    const beds = T.visitors ? clamp(T.beds / T.visitors, 0, 1) : 1;
    const fun = people ? clamp((T.funCount * 40) / people, 0, 1) : (T.funCount ? 1 : 0.5);
    const health = T.hasClinic ? 1 : (people > 20 ? 0.4 : 0.7);
    const score = (food * 0.35 + beds * 0.2 + fun * 0.25 + health * 0.2) * T.efficiency;
    return { food, beds, fun, health, score };
  },

  recomputeLevel() {
    const s = this.state, T = this.totals();
    let lvl = 1;
    for (const th of LEVEL_THRESHOLDS) if (T.modules >= th.modules && s.rep >= th.rep) lvl = th.level;
    if (lvl > s.level) {
      s.level = lvl;
      if (lvl === 5) this.log(`${s.name} is now a true galactic hub: a city between the stars, built from one docking collar. Keep growing.`, 'good');
      else this.log(`Station reaches level ${lvl}: ${TIER_NAMES[lvl]}. New modules unlocked.`, 'good');
      this.toast(`Level ${lvl} — ${TIER_NAMES[lvl]}`, 'gold');
      this.emit('levelup', lvl);
    }
    s.level = Math.max(s.level, lvl);
  },

  // ---------------------------------------------------------- prices
  effPrice(g) {
    const s = this.state; let p = s.prices[g];
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
  spawnShip(forceCompany) {
    const s = this.state, T = this.totals();
    let pool = COMPANIES.filter(c => !c.galactic || T.galactic);
    let co = forceCompany ? COMPANIES.find(c => c.id === forceCompany) : null;
    if (!co) {
      // weight by trust: trusted companies send more ships
      const w = pool.map(c => 1 + s.companies[c.id].trust / 50);
      let r = Math.random() * w.reduce((a, b) => a + b, 0);
      co = pool[0];
      for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) { co = pool[i]; break; } }
    }
    const clsId = pick(co.ships), cls = SHIP_CLASSES[clsId], planet = PLANETS[co.home];
    const cargo = {};
    const goods = [...planet.exports].sort(() => Math.random() - 0.5).slice(0, irnd(1, 2));
    let left = cls.cargo;
    goods.forEach((g, i) => { const q = i === goods.length - 1 ? left : Math.round(left * rnd(0.4, 0.7)); cargo[g] = q; left -= q; });
    const side = irnd(0, 3);
    const x = side === 0 ? -3 : side === 1 ? GRID_COLS + 3 : rnd(-1, GRID_COLS + 1);
    const y = side === 2 ? -3 : side === 3 ? GRID_ROWS + 3 : rnd(-1, GRID_ROWS + 1);
    const ship = {
      id: s.nextShipId++, company: co.id, cls: clsId, captain: `Capt. ${pick(CAPTAIN_NAMES)}`,
      cargo, wants: [...planet.imports], crew: cls.crew + (cls.passengers || 0),
      state: 'approach', x, y, angle: Math.random() * Math.PI * 2, dock: null, target: null,
      dockedUntil: 0, waitStart: this.now(), arrived: this.now(), trades: [], earned: 0,
    };
    s.ships.push(ship);
    this.routeShip(ship);
    this.emit('spawn', ship);
    return ship;
  },

  // find dock cell with a free berth point; returns {dock:{r,c}, berth:{x,y}} or null
  findBerth() {
    const s = this.state, taken = new Set(s.ships.filter(sh => sh.dock).map(sh => `${sh.dock.r},${sh.dock.c}`));
    const best = [];
    for (const { r, c, m } of this.cells()) {
      if (!(MODULES[m.id].docks > 0) || taken.has(`${r},${c}`)) continue;
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
    let earned = 0;
    // fees
    const fee = Math.round(cls.dockFee * discount * T.efficiency);
    earned += fee; ship.trades.push(`Docking fee +${fmt(fee)}`);
    if (T.fuelIncome) { const f = Math.round(T.fuelIncome * (cls.cargo / 80) * (T.counts.fuel > 1 ? 1.3 : 1)); earned += f; ship.trades.push(`Fuel +${fmt(f)}`); }
    if (T.repairIncome && Math.random() < 0.6) { const rp = Math.round(T.repairIncome * (cls.cargo / 80)); earned += rp; ship.trades.push(`Repairs +${fmt(rp)}`); }
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
    let capacity = cls.cargo;
    const wantList = ship.wants.filter(g => s.policy[g].sell && s.stock[g] > 0);
    const perGood = Math.floor(capacity / Math.max(1, wantList.length));
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
    if (T.tariff && traded) { const t = Math.round(T.tariff * traded); s.credits += t; earned += t; this.earn(t, 'tariffs'); ship.trades.push(`Tariff +${fmt(t)}`); }
    s.stats.cargoTraded += traded;
    ship.earned = earned;
    ship.dockedUntil = this.now() + cls.dockDays;
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
    ship.target = { x: cc + dx / L * (GRID_COLS + 6), y: cr + dy / L * (GRID_ROWS + 6) };
    ship.dock = null; ship.state = 'depart';
    this.emit('depart', ship);
  },

  tickShips(dtDays, T) {
    const s = this.state, now = this.now();
    // spawn
    s.shipTimer -= dtDays;
    if (s.shipTimer <= 0) {
      const offices = Object.values(s.companies).filter(c => c.office).length;
      const contracts = Object.values(s.companies).filter(c => s.day < c.contractUntil).length;
      const rate = (0.9 + s.rep * 0.6 + T.traffic * 4 + offices * 0.4 + contracts * 0.5) * (T.galactic ? 1.25 : 1);
      s.shipTimer = rnd(0.6, 1.4) / rate;
      const queued = s.ships.filter(sh => sh.state === 'queue').length;
      if (queued >= 2) { s.stats.diverted++; s.recentAway += 0.5; }   // captains see the queue and divert elsewhere
      else if (s.ships.length < 16) this.spawnShip();
    }
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
        const tx = s.hub.c + 0.5 + Math.cos(ship.orbit) * QUEUE_RADIUS, ty = s.hub.r + 0.5 + Math.sin(ship.orbit) * QUEUE_RADIUS * 0.75;
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

  // ---------------------------------------------------------- daily tick
  dailyTick() {
    const s = this.state, T = this.totals(), A = this.amenity(T);
    let delta = 0;
    // production
    for (const g in T.produces) { const room = T.storage - T.stockTotal; const q = Math.min(T.produces[g], Math.max(0, room)); s.stock[g] += q; }
    for (const cv of T.converts) {
      const n = Math.min(cv.inAmt, s.stock[cv.from]);
      if (n >= cv.inAmt) { s.stock[cv.from] -= cv.inAmt; s.stock[cv.to] += cv.outAmt; }
    }
    // residents: rent, business, growth
    if (s.residents > 0) {
      const rent = Math.round(s.residents * 6 * T.efficiency); delta += rent; this.earn(rent, 'resident rent');
      if (T.business) { const b = Math.round(s.residents * T.business * (s.day < s.fx.festivalUntil ? 2 : 1)); delta += b; this.earn(b, 'promenade business'); }
      const eat = Math.round(s.residents * 0.15);
      if (s.stock.grain >= eat) s.stock.grain -= eat;
      else if (s.stock.fruit >= eat) s.stock.fruit -= eat;
    }
    const freeHomes = T.homes - s.residents;
    if (freeHomes > 0 && A.score > 0.55) {
      const growth = Math.max(1, Math.round(T.visitors * 0.08 * (T.hasSchool ? 2 : 1) * A.score));
      const add = Math.min(freeHomes, growth);
      if (add > 0 && Math.random() < 0.7) { s.residents += add; if (s.residents === add) this.log('The first permanent residents move in.', 'good'); }
    } else if (A.score < 0.35 && s.residents > 0) {
      const leave = Math.max(1, Math.round(s.residents * 0.05)); s.residents -= leave;
      this.log(`${leave} residents leave: the station is not a pleasant place to live right now.`, 'bad');
    }
    // visitors spending
    if (T.visitors) {
      const perHead = 6 * (0.5 + A.food * 0.6 + A.beds * 0.4 + A.fun * 0.9) * (s.day < s.fx.festivalUntil ? 2 : 1) * T.efficiency;
      const spend = Math.round(T.visitors * perHead); delta += spend; this.earn(spend, 'crew spending');
    }
    // menagerie exhibits
    if (T.counts.menagerie && s.stock.xenofauna > 0) {
      const ex = Math.round(Math.min(s.stock.xenofauna, 30 * T.counts.menagerie) * 4 * (1 + s.residents / 50)); delta += ex; this.earn(ex, 'menagerie tickets');
    }
    // offices pay rent
    const offices = Object.values(s.companies).filter(c => c.office).length;
    if (offices) { const r = offices * 80; delta += r; this.earn(r, 'office leases'); }
    // bank: loan repayments
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
    upkeep = Math.round(upkeep + s.residents * 1); delta -= upkeep; this.earn(-upkeep, 'upkeep');
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

  // ---------------------------------------------------------- events
  rollEvent() {
    const s = this.state;
    const pool = EVENTS.filter(e => !e.minLevel || s.level >= e.minLevel);
    const total = pool.reduce((a, e) => a + e.weight, 0);
    let r = Math.random() * total, ev = pool[0];
    for (const e of pool) { r -= e.weight; if (r <= 0) { ev = e; break; } }
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
  tick(dtReal) {
    const s = this.state; if (!s || s.pending) return;
    const dtDays = (dtReal * s.speed) / DAY_SECONDS;
    if (dtDays <= 0) return;
    const T = this.totals();
    this.tickShips(dtDays, T);
    s.t += dtDays;
    while (s.t >= 1) { s.t -= 1; s.day++; this.dailyTick(); }
    for (const f of this.floaters) { f.ttl -= dtDays * DAY_SECONDS / s.speed; f.y -= 0.6 * dtDays * DAY_SECONDS / s.speed; }
    this.floaters = this.floaters.filter(f => f.ttl > 0);
  },
};

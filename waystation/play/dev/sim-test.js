#!/usr/bin/env node
// ============================================================
// WAYSTATION v2 — simulation and meta-game harness (DESIGN2.md 4.13)
//   node play/dev/sim-test.js            run every check, print the economy and pacing tables, exit 0 on success
//   node play/dev/sim-test.js --quick    skip the 25-day pacing bot
//   node play/dev/sim-test.js --days 10  pacing bot horizon (default 25); --no-compare prints only the shipped-preset table
//   node play/dev/sim-test.js --tuning '{"rateDivisor":120,"sectorCosts":{"aurelia":2000000}}'   pacing bot under a WAYSTATION_TUNING override
// Loads data.js, data2.js, sim.js, meta.js inside a vm context with a localStorage shim and a
// controllable clock (Date.now is replaced; Math.random can be seeded), then walks the journey:
// new profile -> tutorial builds instant -> timers -> offline accrual at +3 h -> expedition round trip ->
// mission completion and claim -> sector unlock and switch -> migration from a v1 save -> export/import,
// plus hopper caps, skip costs, upgrades, loot odds, daily streak, ranks, store grants and every v1 Sim method.
// The numeric sections run under WAYSTATION_TUNING = { preset: 'spec' } (the DESIGN2 formulas, asserted with their
// own numbers); one section asserts that the file default is the shipped 'slow' preset; the pacing bots run under
// the file default and, for comparison, under 'spec'.
// ============================================================
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..', 'js');
const FILES = ['data.js', 'data2.js', 'sim.js', 'meta.js'];
const SOURCES = FILES.map(f => ({ f, code: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
const ARGS = process.argv.slice(2);
const QUICK = ARGS.includes('--quick');
const DAYS = (() => { const i = ARGS.indexOf('--days'); return i >= 0 ? Math.max(1, +ARGS[i + 1] || 25) : 25; })();
const TUNING_ARG = (() => { const i = ARGS.indexOf('--tuning'); return i >= 0 ? JSON.parse(ARGS[i + 1]) : null; })();   // e.g. --tuning '{"rateDivisor":120}'
// tuning selectors: the numeric sections assert the DESIGN2 formulas under SPEC; the shipped curve is the data2.js file default
const SPEC = { preset: 'spec' };            // the DESIGN2 numbers; makeWorld() applies it unless told otherwise
const FILE_DEFAULT = 'default';             // makeWorld({ tuning: FILE_DEFAULT }) loads data2.js with no override

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const START = new Date(2026, 9, 19, 12, 0, 0).getTime();     // a local noon, so calendar-day tests are unambiguous

// ------------------------------------------------------------ tiny test framework
const results = { pass: 0, fail: 0, failures: [] };
let section = '';
function sec(name) { section = name; console.log(`\n== ${name}`); }
function check(name, cond, detail) {
  if (cond) { results.pass++; console.log(`  ok   ${name}`); }
  else { results.fail++; results.failures.push(`${section}: ${name}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`); console.log(`  FAIL ${name}${detail !== undefined ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// ------------------------------------------------------------ world factory: a fresh vm context over a shared storage + clock
function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null, get length() { return m.size; }, _map: m };
}
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function makeWorld(opts = {}) {
  const storage = opts.storage || makeStorage();
  const clock = opts.clock || { now: opts.start || START };
  const tuning = opts.tuning === FILE_DEFAULT ? undefined : (opts.tuning || SPEC);
  const ctx = vm.createContext({ console, localStorage: storage, WAYSTATION_TUNING: tuning });
  vm.runInContext('Date', ctx).now = () => clock.now;
  if (opts.seed != null) vm.runInContext('Math', ctx).random = mulberry32(opts.seed);
  for (const { f, code } of SOURCES) vm.runInContext(code, ctx, { filename: f });
  const G = name => vm.runInContext(name, ctx);
  const W = { ctx, G, storage, clock, Sim: G('Sim'), Meta: G('Meta'), MODULES: G('MODULES'), SECTORS: G('SECTORS'), TIMERS: G('TIMERS'), ECON: G('ECON'),
    MISSIONS: G('MISSIONS'), COLLECTION: G('COLLECTION'), RANKS: G('RANKS'), STORE_CATALOG: G('STORE_CATALOG'), EXPEDITIONS: G('EXPEDITIONS'), DAILY_REWARDS: G('DAILY_REWARDS'),
    MODULE_ORDER: G('MODULE_ORDER'), GOOD_IDS: G('GOOD_IDS'), PACING_PRESET: G('PACING_PRESET'), PACING_PRESETS: G('PACING_PRESETS'), TUNING: G('TUNING'), events: [] };
  W.record = (...names) => { for (const n of names) W.Sim.on(n, d => W.events.push({ evt: n, data: d })); };
  W.count = evt => W.events.filter(e => e.evt === evt).length;
  W.last = evt => { const l = W.events.filter(e => e.evt === evt); return l.length ? l[l.length - 1].data : null; };
  // wall-clock passes without the game running (offline); Meta.tick settles timers
  W.advance = ms => { clock.now += ms; W.Meta.tick(clock.now); };
  // the game runs live for `seconds` of real time at the station's speed; transmissions are read as they arrive
  W.run = (seconds, step = 0.1) => {
    for (let t = 0; t < seconds; t += step) {
      W.Sim.tick(step);
      if (W.Sim.state.pending) W.Sim.resolveEvent(true);
      clock.now += step * 1000;
      W.Meta.tick(clock.now);
    }
  };
  // place a module on the free cell nearest the hub that accepts it
  W.placeNear = id => {
    const s = W.Sim.state, hub = s.hub, spots = [];
    for (let r = 0; r < s.grid.length; r++) for (let c = 0; c < s.grid[0].length; c++) spots.push({ r, c, d: Math.abs(r - hub.r) + Math.abs(c - hub.c) + (c - hub.c) * 0.01 });
    spots.sort((a, b) => a.d - b.d);
    for (const sp of spots) { if (s.grid[sp.r][sp.c]) continue; if (W.Sim.canPlace(id, sp.r, sp.c).ok) { if (W.Sim.place(id, sp.r, sp.c)) return sp; } }
    return null;
  };
  W.cellOf = id => { const s = W.Sim.state; for (let r = 0; r < s.grid.length; r++) for (let c = 0; c < s.grid[0].length; c++) if (s.grid[r][c] && s.grid[r][c].id === id) return { r, c }; return null; };
  W.modules = (s = W.Sim.state) => W.Sim.cellsOf(s).length - 1;
  return W;
}

// ============================================================ tests
function testNewProfileAndTutorial() {
  sec('1. New profile, tutorial instant builds, timers, skip');
  const W = makeWorld({ seed: 1 });
  W.record('build-start', 'build-done', 'upgrade', 'hopper', 'collect', 'am', 'change');
  const r = W.Meta.init();
  const S = W.Sim, M = W.Meta, p = M.profile;
  check('fresh profile created (not resumed)', r.resumed === false && !!p && p.v === 2);
  check('starts with 20 AM and 6,000 credits', M.am === W.TIMERS.START_AM && S.state.credits === 6000 && p.credits === 6000, { am: M.am, cr: S.state.credits });
  check('active sector is home with a 15x9 grid', S.state.sector === 'home' && S.state.grid.length === 9 && S.state.grid[0].length === 15);
  check('hub has cell meta and a 10/min hopper', !!S.cellMeta(S.state.hub.r, S.state.hub.c) && M.hopper(S.state.hub.r, S.state.hub.c).rate === 10);
  check('profile.sectors.home is Sim.state (shared reference)', p.sectors.home === S.state);

  const dock = W.placeNear('dock'), wh = W.placeNear('warehouse'), sol = W.placeNear('solar');
  check('first three tier-1 builds placed', !!dock && !!wh && !!sol);
  check('they are instant (no timer)', !M.build(dock.r, dock.c).building && !M.build(wh.r, wh.c).building && !M.build(sol.r, sol.c).building);
  check('three build-done events, no build-start', W.count('build-done') === 3 && W.count('build-start') === 0, { done: W.count('build-done'), start: W.count('build-start') });
  check('instant builds count toward totals', S.totals().docks === 2 && S.totals().storage === 250);

  const fuel = W.placeNear('fuel');
  const b = M.build(fuel.r, fuel.c);
  check('fourth tier-1 build has a 45 s timer', b.building && b.totalMs === 45000 && near(b.remainingMs, 45000, 1), b);
  check('build-start emitted with totalMs', W.last('build-start') && W.last('build-start').totalMs === 45000);
  check('skipAM for 45 s is 1', b.skipAM === 1);
  const T = S.totals();
  check('cell under construction: power draw counts, income does not', T.used === 2 + 1 + 1 && T.fuelIncome === 0 && !T.counts.fuel && T.building === 1, { used: T.used, fuel: T.fuelIncome, building: T.building });
  check('hopper is null while building', M.hopper(fuel.r, fuel.c) === null);
  check('nextUp lists the build (daily, claimable now, sorts first) and is sorted', M.nextUp().some(x => x.kind === 'build' && x.id === 'fuel') && M.nextUp()[0].kind === 'daily' && M.nextUp().every((x, i, a) => i === 0 || a[i - 1].endsAt <= x.endsAt), M.nextUp());
  W.advance(44 * 1000);
  check('still building at 44 s', M.build(fuel.r, fuel.c).building);
  W.advance(1000);
  check('build-done after 45 s', !M.build(fuel.r, fuel.c).building && W.count('build-done') === 4);
  check('module active after completion', S.totals().counts.fuel === 1 && S.totals().fuelIncome > 0);

  // skip cost formula 4.3
  check('skip cost: 4 min -> 1, 60 min -> 8, 100 min -> 13, 0 -> 1', M.skipCost(4 * MIN) === 1 && M.skipCost(60 * MIN) === 8 && M.skipCost(100 * MIN) === 13 && M.skipCost(0) === 1);

  // upgrades 4.3
  const u0 = M.upgrade(dock.r, dock.c);
  check('dock upgrade to level 2 costs 2x (1,600) and takes 90 s', u0.lvl === 1 && u0.next.cost === 1600 && u0.next.ms === 90000 && u0.next.rate === 32 && u0.next.cap === 2880, u0);
  const credits0 = S.state.credits;
  const up = M.upgradeModule(dock.r, dock.c);
  check('upgrade starts and deducts credits', up.ok && up.cost === 1600 && up.totalMs === 90000 && S.state.credits === credits0 - 1600, up);
  check('dock keeps its berth while upgrading', S.totals().docks === 2 && S.active(dock.r, dock.c));
  const sk = M.skipBuild(dock.r, dock.c);
  check('skipping the upgrade costs 1 AM (90 s)', sk.ok && sk.cost === 1 && M.am === 19, sk);
  check('upgrade event and level 2', W.count('upgrade') === 1 && M.upgrade(dock.r, dock.c).lvl === 2);
  check('level 2 hopper: rate 32, cap 2,880', M.hopper(dock.r, dock.c).rate === 32 && M.hopper(dock.r, dock.c).cap === 2880);
  const u3 = M.upgradeModule(dock.r, dock.c);
  check('level 3 refused without 4,000 credits', !u3.ok && u3.cost === 4000, u3);
  M.addCredits(10000, 'test');
  check('upgrades count as half a module each for level thresholds', near(S.totals().modules, 4.5, 1e-9), S.totals().modules);
  const u3b = M.upgradeModule(dock.r, dock.c);
  check('level 3 upgrade starts (5x cost)', u3b.ok && u3b.cost === 4000);
  W.advance(90 * 1000);
  check('level 3 after 90 s: rate 48, cap 5,760, dock time x0.70', M.hopper(dock.r, dock.c).rate === 48 && M.hopper(dock.r, dock.c).cap === 5760 && near(S.dockTimeMul(dock), 0.7, 1e-9));
  check('upgrade read model: no next at level 3', M.upgrade(dock.r, dock.c).next === null);
  check('solar upgrade raises power 25%', (() => { const c = M.upgradeModule(sol.r, sol.c); if (!c.ok) return false; M.skipBuild(sol.r, sol.c); return S.totals().produced === 10 + Math.round(6 * 1.25); })(), S.totals().produced);
  return W;
}

function testHoppers() {
  sec('2. Hoppers: accrual, caps, thresholds, collect, collectAll gate');
  const W = makeWorld({ seed: 2 });
  W.record('hopper', 'collect');
  const M = W.Meta, S = W.Sim; M.init();
  const dock = W.placeNear('dock');
  const h0 = M.hopper(dock.r, dock.c);
  check('dock hopper starts empty: rate 20, cap 1,200', h0.bank === 0 && h0.rate === 20 && h0.cap === 1200 && !h0.ready && !h0.full, h0);
  W.advance(30 * MIN);
  const h1 = M.hopper(dock.r, dock.c);
  check('30 min later the bank holds 600', near(h1.bank, 600, 0.01) && h1.ready && !h1.full, h1.bank);
  check('hopper event fired when the bank crossed 25%', W.count('hopper') >= 1 && W.events.some(e => e.evt === 'hopper' && e.data.r === dock.r && e.data.c === dock.c));
  W.advance(3 * HOUR);
  const h2 = M.hopper(dock.r, dock.c);
  check('bank caps at 60 minutes of rate', h2.bank === 1200 && h2.full, h2.bank);
  check('full crossing emitted', W.events.some(e => e.evt === 'hopper' && e.data.full));
  const hub = S.state.hub;
  check('hub bank capped at 600', M.hopper(hub.r, hub.c).bank === 600);
  const before = S.state.credits, xp0 = M.rank.xp;
  const got = M.collect(dock.r, dock.c);
  check('collect moves the bank to credits (floor)', got === 1200 && S.state.credits === before + 1200 && M.hopper(dock.r, dock.c).bank === 0, got);
  check('collect event and 12 XP (1 per 100 cr)', W.count('collect') === 1 && M.rank.xp === xp0 + 12);
  check('wallet mirrors Sim.state.credits', M.profile.credits === S.state.credits);
  check('collectAll is gated to rank 3', M.collectAll() === 0 && M.hopper(hub.r, hub.c).bank === 600);
  M._addXP(900, 'test');
  check('rank 3 reached (Harbourmaster)', M.rank.level === 3 && M.rank.title === 'Harbourmaster');
  const all = M.collectAll();
  check('collectAll gathers every bank', all === 600 && M.hopper(hub.r, hub.c).bank === 0, all);
  check('Meta.totalRate is the active station rate per real minute', M.totalRate() === 30, M.totalRate());
  M.profile.rank.xp = 4500; M.profile.rank.level = 5;
  check('Admiral of the Reach adds 5% to rates', near(M.hopper(dock.r, dock.c).rate, 21, 1e-9) && M.totalRate() === 31.5, M.hopper(dock.r, dock.c).rate);
  // demolish loses the bank
  W.advance(10 * MIN);
  const wh = W.placeNear('warehouse'); W.advance(20 * MIN);
  const lost = M.hopper(wh.r, wh.c).bank;
  check('warehouse banked 300 in 20 min (with the 5% bonus: 315)', near(lost, 315, 0.01), lost);
  check('demolish clears the cell meta', S.demolish(wh.r, wh.c) && !S.cellMeta(wh.r, wh.c));
}

function testOffline() {
  sec('3. Offline: save, +3 h, reload -> banks, builds, catch-up, offline event');
  const storage = makeStorage(), clock = { now: START };
  const W = makeWorld({ storage, clock, seed: 3 });
  W.Meta.init();
  const dock = W.placeNear('dock'); W.placeNear('warehouse'); W.placeNear('solar');
  const fuel = W.placeNear('fuel');
  check('fuel depot is building at save time', W.Meta.build(fuel.r, fuel.c).building);
  const exp = W.Meta.launchExpedition('home');
  check('expedition launched before leaving', exp.ok);
  W.Meta.save();
  const day0 = W.Sim.state.day;
  clock.now += 3 * HOUR;
  const W2 = makeWorld({ storage, clock, seed: 4 });
  W2.record('offline', 'build-done', 'expedition');
  const r = W2.Meta.init();
  const M = W2.Meta, S = W2.Sim;
  check('profile resumed', r.resumed === true && !r.migrated);
  const off = W2.last('offline');
  check('offline event emitted once with ms ~ 3 h', W2.count('offline') === 1 && off && near(off.ms, 3 * HOUR, 1000), off && off.ms);
  check('banks accrued while away (dock full at 1,200)', M.hopper(dock.r, dock.c).bank === 1200 && off.banked >= 1200 + 600);
  check('the build finished while away', !M.build(fuel.r, fuel.c).building && W2.count('build-done') >= 1);
  check('the expedition came back ready', M.expeditions().some(e => e.status === 'ready') && W2.events.some(e => e.evt === 'expedition' && e.data.state === 'ready'));
  const capDays = W2.TIMERS.OFFLINE_SIM_CAP_MS / W2.TIMERS.DAY_MS;
  check(`catch-up simulated ${capDays} game days (2 h cap)`, near(S.state.day - day0, capDays, 1) && near(off.summary.days, capDays, 0.5), { days: S.state.day - day0, sum: off.summary.days });
  check('catch-up served ships and earned live credits', off.summary.served > 0 && off.credits !== 0, { served: off.summary.served, credits: off.credits });
  const sum = M.offlineSummary;
  check('offlineSummary reads once then nulls', !!sum && sum.ms === off.ms && M.offlineSummary === null);
  check('wallet consistent after reload', M.profile.credits === S.state.credits);
  // a 20-minute reload still settles timers but is not an "away"
  M.save(); clock.now += 20 * 1000;
  const W3 = makeWorld({ storage, clock, seed: 5 }); W3.record('offline'); W3.Meta.init();
  check('short gaps (< 60 s) emit no offline event', W3.count('offline') === 0 && W3.Meta.offlineSummary === null);
  check('Sim.catchUp is bounded by the 2 h cap', W3.Sim.catchUp(10 * HOUR).ms === W3.TIMERS.OFFLINE_SIM_CAP_MS);
}

function testExpeditions() {
  sec('4. Expeditions: launch, slots, ready, claim, skip, loot odds over 1,000 runs');
  const W = makeWorld({ seed: 6 });
  W.record('expedition', 'discover', 'am');
  const M = W.Meta, S = W.Sim; M.init();
  check('needs a Docking Bay', !M.launchExpedition('home').ok);
  W.placeNear('dock'); W.placeNear('warehouse'); W.placeNear('solar');
  const c0 = S.state.credits;
  const e1 = M.launchExpedition('home');
  check('launch to home costs 400 and takes 10 min', e1.ok && e1.cost === 400 && S.state.credits === c0 - 400 && near(e1.endsAt - W.clock.now, 10 * MIN, 1), e1);
  check('one slot without a Comms Relay', M.expeditionSlots() === 1 && !M.launchExpedition('sable').ok);
  check('expeditions() shows it out with remainingMs', M.expeditions()[0].status === 'out' && near(M.expeditions()[0].remainingMs, 10 * MIN, 1));
  check('costs scale with distance: sable 600, aurelia 1,800', M.expeditionCost(W.SECTORS.sable) === 600 && M.expeditionCost(W.SECTORS.aurelia) === 1800);
  W.advance(10 * MIN);
  check('ready after 10 minutes (event)', M.expeditions()[0].status === 'ready' && W.events.some(e => e.evt === 'expedition' && e.data.state === 'ready'));
  const xp0 = M.rank.xp, stock0 = W.GOOD_IDS.reduce((a, g) => a + S.state.stock[g], 0);
  const loot = M.claimExpedition(e1.id);
  check('claim returns loot with goods', !!loot && loot.goods.length >= 1 && loot.goods.every(g => g.qty > 0), loot);
  const stock1 = W.GOOD_IDS.reduce((a, g) => a + S.state.stock[g], 0);
  check('goods went into stock (or were brokered)', stock1 > stock0 || loot.brokered > 0);
  check('claim pays 20 XP and emits claimed', M.rank.xp >= xp0 + 20 && W.events.some(e => e.evt === 'expedition' && e.data.state === 'claimed'));
  check('runs counted and claimed stays in the list', M.profile.expeditions.runs.home === 1 && M.expeditions().some(e => e.status === 'claimed'));
  // skip
  const e2 = M.launchExpedition('sable');
  const am0 = M.am;
  const sk = M.skipExpedition(e2.id);
  check('instant return costs ceil(20/8) = 3 AM', sk.ok && sk.cost === 3 && M.am === am0 - 3, sk);
  check('skipped expedition is ready', M.expeditions().find(e => e.id === e2.id).status === 'ready');
  M.claimExpedition(e2.id);
  // guarantee: runs 3, 6, 9 always carry a chart
  let guaranteed = true;
  for (let i = 0; i < 100; i++) { M.profile.expeditions.runs.kessler = 2; if (!M._rollLoot(W.SECTORS.kessler).chart) guaranteed = false; }
  check('chart guaranteed on the third run (100 trials)', guaranteed);
  // distribution over 1,000 non-guaranteed rolls
  const N = 1000, tally = { chart: 0, am: 0, discovery: 0, credits: 0, goodsOk: 0 };
  for (let i = 0; i < N; i++) {
    M.profile.expeditions.runs.sable = 0;
    const l = M._rollLoot(W.SECTORS.sable);
    if (l.chart) tally.chart++; if (l.am) tally.am++; if (l.discovery) tally.discovery++; if (l.credits) tally.credits++;
    const total = l.goods.reduce((a, g) => a + g.qty, 0); if (total >= 20 && total <= 80) tally.goodsOk++;
  }
  console.log(`     loot over ${N} runs: chart ${(tally.chart / N * 100).toFixed(1)}%  AM ${(tally.am / N * 100).toFixed(1)}%  discovery ${(tally.discovery / N * 100).toFixed(1)}%  credits ${(tally.credits / N * 100).toFixed(1)}%`);
  check('chart ~60%', near(tally.chart / N, 0.6, 0.05), tally.chart / N);
  check('AM ~35%', near(tally.am / N, 0.35, 0.05), tally.am / N);
  check('discovery ~45%', near(tally.discovery / N, 0.45, 0.05), tally.discovery / N);
  check('credits ~20%', near(tally.credits / N, 0.2, 0.05), tally.credits / N);
  check('goods always 20..80 units', tally.goodsOk === N, tally.goodsOk);
  // 1,000 full claims through the public path: discoveries land in the registry and sets pay out
  M.addCredits(5e6, 'test');
  let claimed = 0, charts0 = M.charts('oros');
  for (let i = 0; i < 1000; i++) {
    const e = M.launchExpedition('oros'); if (!e.ok) break;
    W.clock.now = e.endsAt; M.tick(W.clock.now);
    if (M.claimExpedition(e.id)) claimed++;
  }
  check('1,000 claims through the public path', claimed === 1000, claimed);
  check('charts accumulate', M.charts('oros') - charts0 > 500, M.charts('oros'));
  const col = M.collection();
  check('oros discoveries found: Ring Ice Lens, Halo Chime, Ring Drifters', col.artifacts.find(a => a.id === 'ring_lens').found && col.artifacts.find(a => a.id === 'halo_chime').found && col.species.find(s => s.id === 'ring_drifter').found);
  check('Relics of Oros Halo set completed and paid AM', col.sets.find(s => s.id === 'set_art_oros').done && W.events.some(e => e.evt === 'discover' && e.data.kind === 'set' && e.data.id === 'set_art_oros'));
  check('three slots with Comms Relay and Shipyard', (() => { S.state.level = 3; W.placeNear('comms'); W.placeNear('shipyard'); for (const id of ['comms', 'shipyard']) { const c = W.cellOf(id); M.skipBuild(c.r, c.c); } return M.expeditionSlots() === 3; })(), M.expeditionSlots());
}

function testMissions() {
  sec('5. Missions: the tutorial chain from a fresh profile by doing the things');
  const W = makeWorld({ seed: 7 });
  W.record('mission');
  const M = W.Meta, S = W.Sim; M.init();
  const active = () => M.missions().filter(m => m.active).map(m => m.id);
  check('three mission slots at rank 1', M.missionSlots() === 3);
  check('first active mission is First Berth (build a dock)', active()[0] === 'c_dock' && !M.missions()[0].done);
  check('Crew and Trade chapters wait for the tutorial', !active().includes('k_quarters') && !active().includes('t_fuel'));
  const claim = id => { const m = M.missions().find(x => x.id === id); if (!m || !m.claimable) return null; return M.claimMission(id); };
  W.placeNear('dock'); W.advance(300);
  check('placing the dock completes First Berth', M.missions().find(m => m.id === 'c_dock').claimable);
  let rw = claim('c_dock');
  check('claim pays 300 cr + 5 AM', rw && rw.credits === 300 && rw.am === 5 && M.am === 25, rw);
  check('Room to Breathe is now active', active().includes('c_warehouse'));
  W.placeNear('warehouse'); W.advance(300); rw = claim('c_warehouse');
  check('warehouse mission claimed', !!rw);
  W.placeNear('solar'); W.advance(300); rw = claim('c_solar');
  check('solar mission claimed; Crew chapter opens', !!rw && active().includes('k_quarters'));
  check('Tap the Bank active and waiting', active().includes('c_collect') && !M.missions().find(m => m.id === 'c_collect').done);
  W.advance(2 * MIN);
  const hub = S.state.hub; M.collect(hub.r, hub.c); W.advance(300);
  rw = claim('c_collect');
  check('collecting a bank completes Tap the Bank', !!rw);
  let guard = 0;
  while (S.state.stats.shipsServed < 3 && guard++ < 600) W.run(1);
  W.advance(300);
  rw = claim('c_serve3');
  check('serving three ships completes Open for Business', !!rw, { served: S.state.stats.shipsServed });
  guard = 0;
  while (M.profile.stats.transmissions < 1 && guard++ < 1200) W.run(1);
  W.advance(300);
  rw = claim('c_transmission');
  check('reading a transmission completes Incoming Transmission', !!rw, { tx: M.profile.stats.transmissions });
  check('tutorial paid 30 AM in total (20 + 30 = 50 on hand)', M.am === 50, M.am);
  const ms = M.missions();
  check('all six Commissioning missions claimed', ms.filter(m => m.chapter === 'Commissioning').every(m => m.claimed));
  check('mission events: progress, complete and claimed all fired', W.events.some(e => e.evt === 'mission' && e.data.state === 'complete') && W.events.some(e => e.evt === 'mission' && e.data.state === 'claimed'));
  check('Trade and Reach chapters are open now', active().includes('t_fuel') && active().includes('k_quarters'));
  check('48 missions in 7 chapters', W.MISSIONS.length === 48 && new Set(W.MISSIONS.map(m => m.chapter)).size === 7);
  check('every mission has a working tracker', W.MISSIONS.every(m => typeof m.track(S.state, M.profile) === 'number'));
  check('every requires id exists', W.MISSIONS.every(m => m.requires.every(id => W.MISSIONS.some(x => x.id === id))));
  // throttle: evaluation at most once per 250 ms
  const t0 = M._acc.lastMission; M._dirty(); M.tick(W.clock.now + 100);
  check('mission evaluation throttled to 250 ms', M._acc.lastMission === t0);
  M.tick(W.clock.now + 300);
  check('...and runs once the window passes', M._acc.lastMission !== t0);
}

function testDaily() {
  sec('6. Daily reward: streak, reset, repair');
  const W = makeWorld({ seed: 8 });
  W.record('daily');
  const M = W.Meta, S = W.Sim; M.init();
  let d = M.daily();
  check('claimable on first run, day index 0', d.claimable && d.dayIndex === 0 && d.streak === 0);
  const c0 = S.state.credits;
  let r = M.claimDaily();
  check('day 1 pays at least 1,500 credits', r && r.credits >= 1500 && S.state.credits === c0 + r.credits && r.streak === 1, r);
  check('not claimable again today', !M.daily().claimable && M.claimDaily() === null);
  W.advance(DAY);
  r = M.claimDaily();
  check('next day: streak 2, 3,000+ credits', r && r.streak === 2 && r.credits >= 3000, r);
  W.advance(DAY);
  const am0 = M.am; r = M.claimDaily();
  check('day 3 pays 5 AM', r && r.streak === 3 && r.am === 5 && M.am === am0 + 5, r);
  W.advance(2 * DAY);
  d = M.daily();
  check('a missed day breaks the streak (repairable within 48 h)', d.broken && d.repairable && d.streakIfClaim === 1, d);
  r = M.claimDaily();
  check('claiming after a miss resets to day 1', r && r.streak === 1, r);
  // repair path
  W.advance(DAY); M.claimDaily();
  W.advance(2 * DAY);
  d = M.daily();
  check('broken again', d.broken && d.repairable && M.daily().streak === 2);
  const am1 = M.am;
  const rep = M.repairStreak();
  check('repair costs 5 AM', rep.ok && rep.cost === 5 && M.am === am1 - 5, rep);
  check('after repair the streak is intact', !M.daily().broken && M.daily().streakIfClaim === 3);
  r = M.claimDaily();
  check('claim continues the streak at 3', r && r.streak === 3, r);
  check('repair refused when not broken', !M.repairStreak().ok);
  W.advance(5 * DAY);
  d = M.daily();
  check('repair window closes after 48 h', d.broken && !d.repairable && !M.repairStreak().ok);
  // rewards loop 1..7 and day 7 grants a livery token
  M.profile.daily = { streak: 6, lastClaimAt: W.clock.now - DAY, lastClaimKey: null };
  r = M.claimDaily();
  check('day 7: 25 AM and a livery token', r && r.streak === 7 && r.am === 25 && r.token === 'livery' && M.profile.entitlements.tokens.livery === 1, r);
  W.advance(DAY); r = M.claimDaily();
  check('day 8 loops back to the day-1 reward', r && r.day === 1 && r.credits >= 1500);
  check('daily events fired', W.count('daily') >= 8);
  check('nextUp includes the daily timer at local midnight', M.nextUp().some(x => x.kind === 'daily' && x.endsAt > W.clock.now));
}

function testRanks() {
  sec('7. Ranks: thresholds, AM grants, slots');
  const W = makeWorld({ seed: 9 });
  W.record('rank', 'am');
  const M = W.Meta; M.init();
  check('rank 1 Ensign at 0 XP', M.rank.level === 1 && M.rank.title === 'Ensign' && M.rank.next === 300);
  const am0 = M.am;
  M._addXP(299, 'test'); check('299 XP still Ensign', M.rank.level === 1);
  M._addXP(1, 'test'); check('300 XP -> Lieutenant, +20 AM', M.rank.level === 2 && M.am === am0 + 20);
  M._addXP(600, 'test'); check('900 XP -> Harbourmaster, +30 AM, Collect All', M.rank.level === 3 && M.am === am0 + 50 && M.canCollectAll());
  check('three mission slots below Commodore', M.missionSlots() === 3);
  M._addXP(1100, 'test'); check('2,000 XP -> Commodore, fourth mission slot', M.rank.level === 4 && M.missionSlots() === 4);
  M._addXP(2500, 'test'); check('4,500 XP -> Admiral of the Reach', M.rank.level === 5 && M.rank.title === 'Admiral of the Reach');
  M._addXP(3000, 'test'); check('7,500 XP -> rank 6 (+3,000 per rank)', M.rank.level === 6);
  check('rank events fired for each promotion', W.count('rank') === 5);
  check('rank.pct within 0..1', M.rank.pct >= 0 && M.rank.pct <= 1);
  check('level-ups pay 100 XP', (() => { const x = M.rank.xp; M.onLevelUp(W.Sim.state, 2); return M.rank.xp === x + 100; })());
}

function testSectors() {
  sec('8. Sectors: lock reasons, unlock, AM shortcut, pass, switch preserving both stations');
  const W = makeWorld({ seed: 10 });
  W.record('sector');
  const M = W.Meta, S = W.Sim; M.init();
  let list = M.sectors();
  check('eight sectors, home active', list.length === 8 && list[0].id === 'home' && list[0].status === 'active');
  const sable = list.find(x => x.id === 'sable');
  check('sable locked: needs level 2', sable.status === 'locked' && /level 2/.test(sable.why), sable.why);
  check('sable AM option listed (60 AM, not affordable with 20)', sable.amOption && sable.amOption.am === 60 && !sable.amOption.affordable);
  check('unlock refused while locked', !M.unlockSector('sable').ok);
  S.state.level = 2;
  check('with level 2 the reason becomes credits', /credits/.test(M.sectors().find(x => x.id === 'sable').why));
  M.addCredits(20000, 'test');
  check('sable unlockable now', M.sectors().find(x => x.id === 'sable').status === 'unlockable');
  const w0 = S.state.credits;
  const u = M.unlockSector('sable');
  check('unlock deducts 18,000 and creates the station', u.ok && u.mode === 'credits' && S.state.credits === w0 - 18000 && !!M.profile.sectors.sable && M.profile.unlocked.includes('sable'), u);
  check('sector unlocked event', W.events.some(e => e.evt === 'sector' && e.data.state === 'unlocked' && e.data.id === 'sable'));
  check('kessler needs a chart', /chart/.test(M.sectors().find(x => x.id === 'kessler').why));
  M.profile.expeditions.charts.kessler = 1; M.addCredits(30000, 'test');
  check('kessler unlockable with 1 chart + 30,000', M.sectors().find(x => x.id === 'kessler').status === 'unlockable');
  check('thessaly has no AM shortcut', !M.unlockSector('thessaly', { withAM: true }).ok);
  // switch preserving both
  W.placeNear('dock'); W.placeNear('warehouse'); W.placeNear('solar'); W.placeNear('fuel');
  const homeGrid = JSON.stringify(S.state.grid), homeState = S.state, wallet = S.state.credits;
  const sw = M.switchSector('sable');
  check('switch to sable', sw.ok && S.state.sector === 'sable' && S.state !== homeState);
  check('wallet travels: credits equal in both', S.state.credits === wallet && M.profile.credits === wallet);
  check('sable starts with just the hub and its own name', W.modules() === 0 && W.SECTORS.sable.names.includes(S.state.name));
  check('sable grid 15x9', S.state.grid.length === 9 && S.state.grid[0].length === 15);
  const sd = W.placeNear('dock');
  check('dock in sable has a timer (instant builds spent in home)', M.build(sd.r, sd.c).building);
  const back = M.switchSector('home');
  check('switch back to home', back.ok && S.state === homeState && S.state.sector === 'home');
  check('home grid intact', JSON.stringify(S.state.grid) === homeGrid && W.modules() === 4);
  check('sable kept its dock', M.profile.sectors.sable.grid[sd.r][sd.c].id === 'dock');
  check('summary of sable shows 1 module', M.sectors().find(x => x.id === 'sable').summary.modules === 1);
  check('wallet after round trip', S.state.credits === wallet - 800 && M.profile.credits === S.state.credits);
  check('inactive sector banks keep filling', (() => { W.advance(6000); W.advance(30 * MIN); return M.bankedTotal(M.profile.sectors.sable) >= 300; })(), M.bankedTotal(M.profile.sectors.sable));
  // AM shortcut on a fresh profile
  const W2 = makeWorld({ seed: 11 }); W2.Meta.init(); W2.Meta.addAM(40, 'test');
  const a = W2.Meta.unlockSector('sable', { withAM: true });
  check('AM shortcut: 60 AM unlocks sable at level 1', a.ok && a.mode === 'am' && W2.Meta.am === 0 && W2.Meta.profile.unlocked.includes('sable'), a);
  // sector pass
  const W3 = makeWorld({ seed: 12 }); W3.Meta.init();
  W3.Meta.grantEntitlement('sector_pass', { grantId: 'g1', mode: 'sandbox', at: 1, sku: 'sector_pass', kind: 'pass', granted: true });
  check('with the pass every sector reads unlockable', W3.Meta.sectors().filter(x => x.status === 'unlockable').length === 7);
  const added = W3.Meta.unlockAllSectors('test');
  check('unlockAllSectors opens the other seven', added.length === 7 && W3.Meta.profile.unlocked.length === 8);
  check('aurelia grid 19x11 and buildMul 1.5', W3.Meta.profile.sectors.aurelia.grid.length === 11 && W3.Meta.profile.sectors.aurelia.grid[0].length === 19 && W3.SECTORS.aurelia.buildMul === 1.5);
  W3.Meta.switchSector('marrow'); W3.Sim.state.level = 2; W3.Meta.profile.stats.instantBuilds = 3;
  const md = W3.placeNear('comms');
  check('far sectors build 1.5x slower (comms 6 min)', W3.Meta.build(md.r, md.c).totalMs === 360000, W3.Meta.build(md.r, md.c).totalMs);
  check('sector bias reaches prices (sable ore x1.4)', (() => { W3.Meta.switchSector('sable'); const s = W3.Sim.state; s.prices.ore = 10; return near(W3.Sim.effPrice('ore'), 14, 1e-9); })());
  check('kessler has no residents', (() => { W3.Meta.switchSector('kessler'); return W3.Sim.bias().residents === 0; })());
}

function testExportImportAndReset() {
  sec('9. Export / import round trip, reset, rename, new station here');
  const W = makeWorld({ seed: 13 });
  const M = W.Meta, S = W.Sim; M.init();
  W.placeNear('dock'); W.placeNear('warehouse'); M.addAM(7, 'test');
  const id = M.profile.playerId, grid = JSON.stringify(S.state.grid), json = M.export();
  check('export is JSON of the profile', typeof json === 'string' && JSON.parse(json).playerId === id);
  M.resetProfile();
  check('reset gives a fresh profile', M.profile.playerId !== id && W.modules() === 0 && M.am === 20);
  const imp = M.import(json);
  check('import restores the profile', imp.ok && M.profile.playerId === id && JSON.stringify(S.state.grid) === grid && M.am === 27, imp);
  check('import rejects garbage', !M.import('{"v":1}').ok && !M.import('nope').ok);
  check('rename station', M.renameStation('  Lantern Reach  ') && S.state.name === 'Lantern Reach');
  const wallet = S.state.credits;
  M.newStationHere();
  check('new station here keeps the wallet and the sector', S.state.sector === 'home' && W.modules() === 0 && S.state.credits === wallet && M.profile.sectors.home === S.state);
}

function testMigration() {
  sec('10. v1 migration preserves the grid; the v1 key becomes .bak');
  const storage = makeStorage();
  // build a v1-shaped save with the current code, then strip the v2 fields
  const W0 = makeWorld({ seed: 14 });
  const v1 = W0.Sim.makeState('home');
  delete v1.sector; delete v1.cells;
  const place = (id, r, c) => { v1.grid[r][c] = { id, built: 3 }; };
  place('dock', 4, 8); place('warehouse', 4, 6); place('solar', 3, 7); place('fuel', 5, 7); place('quarters', 4, 9); place('cantina', 4, 5);
  v1.credits = 4321; v1.day = 41; v1.level = 2; v1.rep = 1.4; v1.stats.shipsServed = 12; v1.name = 'Old Faithful';
  storage.setItem('waystation-save-v1', JSON.stringify(v1));
  const W = makeWorld({ storage, seed: 15 });
  const r = W.Meta.init();
  const M = W.Meta, S = W.Sim;
  check('migrated on first v2 load', r.resumed && r.migrated && M.profile.migratedFrom === 'v1');
  check('station is sectors.home with the same grid', S.state.sector === 'home' && JSON.stringify(S.state.grid) === JSON.stringify(v1.grid) && S.state.name === 'Old Faithful');
  check('credits became the wallet', M.profile.credits === 4321 && S.state.credits === 4321);
  check('rank xp = served x 5', M.profile.rank.xp === 60);
  check('every occupied cell has meta', W.Sim.cellsOf(S.state).every(({ r, c }) => { const m = S.cellMeta(r, c); return m && m.lvl === 1 && m.bank === 0 && m.readyAt === null; }));
  check('v1 key renamed to .bak', storage.getItem('waystation-save-v1') === null && !!storage.getItem('waystation-save-v1.bak'));
  check('v2 profile written', !!storage.getItem('waystation.profile.v2'));
  check('no instant builds for a migrated station', (() => { const d = W.placeNear('dock'); return d && M.build(d.r, d.c).building; })());
  check('tutorial missions complete from the existing station', M.missions().find(m => m.id === 'c_dock').claimable);
  // a second load does not migrate again
  const W2 = makeWorld({ storage, seed: 16 }); const r2 = W2.Meta.init();
  check('second load resumes the v2 profile', r2.resumed && !r2.migrated && W2.Sim.state.name === 'Old Faithful');
}

function testV1Sim() {
  sec('11. Every v1 Sim method still works; 200 game days without exceptions; events resolve');
  const W = makeWorld({ seed: 17 });
  W.record('built', 'demolished', 'dock', 'depart', 'spawn', 'levelup', 'day', 'change', 'log', 'toast', 'event');
  const M = W.Meta, S = W.Sim; M.init();
  check('newGame(sectorId) sizes the grid from the sector', (() => { M.unlockAllSectors('test'); S.newGame('oros'); return S.state.sector === 'oros' && S.state.grid.length === 11 && S.state.grid[0].length === 17 && M.profile.sectors.oros === S.state; })());
  S.newGame('home');
  check('newGame(home) resets the home station and keeps the profile', S.state.sector === 'home' && M.profile.sectors.home === S.state);
  check('canPlace reasons', S.canPlace('dock', 0, 0).why === 'Must touch the station' && S.canPlace('gate', S.state.hub.r, S.state.hub.c + 1).why === 'Needs station level 4' && S.canPlace('dock', S.state.hub.r, S.state.hub.c).why === 'Occupied' && (() => { const c = S.state.credits; S.state.credits = 0; const w = S.canPlace('dock', S.state.hub.r, S.state.hub.c + 1).why; S.state.credits = c; return w === 'Not enough credits'; })());
  for (const id of ['dock', 'warehouse', 'solar', 'fuel', 'quarters', 'cantina']) W.placeNear(id);
  check('six modules placed, built events', W.modules() === 6 && W.count('built') === 6);
  const q = W.cellOf('quarters');
  check('canDemolish / demolish refund', S.canDemolish(q.r, q.c).ok && S.demolish(q.r, q.c) && W.count('demolished') === 1);
  check('hub cannot be demolished', !S.canDemolish(S.state.hub.r, S.state.hub.c).ok);
  W.placeNear('quarters');
  M.profile.stats.instantBuilds = 3;
  for (const k in S.state.cells) { const c = S.state.cells[k]; if (c.readyAt != null) c.readyAt = W.clock.now; }
  M.tick(W.clock.now);
  check('totals', (() => { const T = S.totals(); return T.docks === 2 && T.beds === 26 && T.food === 40 && T.produced === 16 && T.used === 8 && T.efficiency === 1 && T.rate === ['hub', 'dock', 'warehouse', 'solar', 'fuel', 'quarters', 'cantina'].reduce((a, id) => a + W.MODULES[id].rate, 0); })(), S.totals());
  check('amenity score in 0..1', (() => { const a = S.amenity(S.totals()); return a.score >= 0 && a.score <= 1; })());
  check('setPolicy', (() => { S.setPolicy('ore', 'buy', false); return S.state.policy.ore.buy === false; })());
  S.setPolicy('ore', 'buy', true);
  check('effPrice / buyPrice / sellPrice', S.buyPrice('ore') < S.effPrice('ore') && S.sellPrice('ore') > S.effPrice('ore'));
  check('spawnShip / findBerth / routeShip', (() => { const sh = S.spawnShip(); return sh && sh.state === 'approach' && sh.dock && sh.hold >= 1; })());
  check('ship holds are live-scaled (freighter 80 -> 5)', S.holdOf(W.G('SHIP_CLASSES').freighter) === Math.max(1, Math.round(80 * W.ECON.live)));
  check('dumpStock', (() => { S.state.stock.ore = 10; const c = S.state.credits; S.dumpStock('ore'); return S.state.stock.ore === 0 && S.state.credits > c; })());
  check('lend needs a bank', (() => { S.lend('halvorsen', 1000); return !S.state.companies.halvorsen.loan; })());
  // 200 game days live
  let events = 0, ex = null;
  const days0 = S.state.day;
  const onEvent = () => events++;
  S.on('event', onEvent);
  try { W.run(200 * (W.TIMERS.DAY_MS / 1000), 0.1); } catch (e) { ex = e; }
  S.off('event', onEvent);
  check('200 game days ticked without exceptions', !ex && S.state.day - days0 >= 199, ex ? String(ex && ex.stack) : S.state.day - days0);
  check('ships were served and left', S.state.stats.shipsServed > 20 && W.count('dock') > 20 && W.count('depart') > 10, S.state.stats.shipsServed);
  check('transmissions arrived and resolved', events >= 5 && M.profile.stats.transmissions >= 5 && !S.state.pending, events);
  check('day events and level 2 reached', W.count('day') >= 199 && S.state.level >= 2 && W.count('levelup') >= 1, { level: S.state.level, rep: S.state.rep });
  check('credits finite', Number.isFinite(S.state.credits));
  check('Sim.now', near(S.now(), S.state.day + S.state.t, 1e-9));
  check('save/load wrappers', S.save() === true && S.load() === true);
  check('Sim.reset recommissions the active sector', (() => { S.reset(); return S.state.sector === 'home' && W.modules() === 0; })());
  // every exported event name is reachable on the bus
  check('v1 event bus: on/off/emit', (() => { let n = 0; const f = () => n++; S.on('x', f); S.emit('x'); S.off('x', f); S.emit('x'); return n === 1; })());
  check('tick ignores a pending transmission', (() => { S.state.pending = { id: 'flare', choice: false }; const d = S.state.day, t = S.state.t; S.tick(5); const same = S.state.day === d && S.state.t === t; S.resolveEvent(true); return same; })());
  // resolve every event type at least once through the public path
  const EV = W.G('EVENTS');
  let resolved = 0;
  for (const e of EV) { S.state.level = 3; S.state.pending = null; S.state.nextEventDay = 0; S.rollEvent(); S.state.pending = Object.assign(S.state.pending, { id: e.id }); if (e.id === 'boom' || e.id === 'glut') S.state.pending.data.good = 'ore'; if (e.id === 'contract') S.state.pending.data.company = 'kestrel'; S.resolveEvent(true); resolved++; }
  check('every event id resolves', resolved === EV.length && !S.state.pending);
}

function testStore() {
  sec('12. Store grants and catalog');
  const W = makeWorld({ seed: 18 });
  W.record('am', 'change', 'sector');
  const M = W.Meta, S = W.Sim; M.init();
  check('catalog: 9 skus with priceCents, priceLabel, badge and kind', W.STORE_CATALOG.length === 9 && W.STORE_CATALOG.every(i => Number.isInteger(i.priceCents) && typeof i.priceLabel === 'string' && 'badge' in i && i.kind));
  check('am_140 is Popular, am_900 is Best value', W.STORE_CATALOG.find(i => i.sku === 'am_140').badge === 'Popular' && W.STORE_CATALOG.find(i => i.sku === 'am_900').badge === 'Best value');
  const am0 = M.am;
  check('addAM(50, purchase)', M.addAM(50, 'purchase') === am0 + 50 && W.last('am').reason === 'purchase' && W.last('am').total === am0 + 50 && M.profile.stats.amBought === 50);
  const c0 = S.state.credits;
  check('addCredits', M.addCredits(1234, 'purchase') === c0 + 1234 && M.profile.credits === c0 + 1234);
  check('spendAM refuses overdraft', !M.spendAM(10000, 'test') && M.spendAM(5, 'test') && M.am === am0 + 45);
  const v = M.grantValue('credits_s');
  check('credits_s grants max(10,000, 120 min of rate)', v.credits === Math.max(10000, Math.round(M.totalRate() * 120)) && v.credits >= 10000, v);
  check('credits_l floor 40,000', M.grantValue('credits_l').credits >= 40000);
  const payload = { grantId: 'cs_test_1', mode: 'sandbox', at: 123, sku: 'founder', kind: 'cosmetic', granted: true, livery: 'founder', title: 'Founder' };
  check('hasEntitlement false before', !M.hasEntitlement('founder'));
  M.grantEntitlement('founder', payload);
  check('grantEntitlement pushes the payload into history (grantId readable)', M.profile.entitlements.history.some(h => h.grantId === 'cs_test_1' && h.sku === 'founder'));
  check('founder owned, livery and title stored', M.hasEntitlement('founder') && M.profile.entitlements.liveries.includes('founder') && M.profile.entitlements.titles.includes('Founder'));
  M.grantEntitlement('liveries', { grantId: 'cs_test_2', mode: 'sandbox', at: 124, sku: 'liveries', kind: 'cosmetic', granted: true, liveries: ['sable', 'kessler', 'thessaly', 'marrow', 'oros', 'keth'] });
  check('six sector liveries stored', ['sable', 'kessler', 'thessaly', 'marrow', 'oros', 'keth'].every(l => M.profile.entitlements.liveries.includes(l)));
  const a1 = M.am;
  const g = M.grantSku('am_320', { grantId: 'cs_test_3' });
  check('grantSku(am_320) adds 320 AM and records the entitlement', g.am === 320 && M.am === a1 + 320 && M.profile.entitlements.history.some(h => h.grantId === 'cs_test_3'));
  check('grantSku(sector_pass) unlocks everything', (() => { M.grantSku('sector_pass', { grantId: 'cs_test_4' }); return M.profile.unlocked.length === 8 && M.hasEntitlement('sector_pass'); })());
  check('relief convoy: 10 AM for 30 min of rate', (() => { const a = M.am, c = S.state.credits, r = M.reliefConvoy(); return r.ok && r.cost === 10 && M.am === a - 10 && S.state.credits === c + Math.round(M.totalRate() * 30); })());
  check('entitlements survive save/load', (() => { M.save(); const ok = M.load(); return ok && M.hasEntitlement('founder') && M.profile.entitlements.history.length === 4; })());
}

function testConvoyAndMisc() {
  sec('13. Convoy window, collection read model, data integrity');
  const W = makeWorld({ seed: 19 });
  W.record('convoy', 'discover');
  const M = W.Meta, S = W.Sim; M.init();
  check('no convoy in the first week', !M.convoyActive() && M.convoy().startsAt === M.profile.createdAt + 7 * DAY);
  W.advance(7 * DAY + 1000);
  check('convoy opens 7 days after creation (event)', M.convoyActive() && W.count('convoy') === 1 && W.last('convoy').active);
  W.advance(48 * HOUR);
  check('convoy closes after 48 h', !M.convoyActive() && W.count('convoy') === 2);
  check('rift is present but disabled', M.rift().enabled === false);
  const col = M.collection();
  check('collection: 24 ships, 12 species, 16 artifacts, 16 sets', col.ships.length === 24 && col.species.length === 12 && col.artifacts.length === 16 && col.sets.length === 16);
  check('every set item exists', W.COLLECTION.sets.every(s => s.items.every(id => W.COLLECTION[s.kind].some(x => x.id === id))));
  check('all dark at the start', col.ships.every(x => !x.found) && col.species.every(x => !x.found));
  check('serving a Halvorsen hauler logs the livery', (() => { S.state.companies.halvorsen.served = 1; M._onDock({ company: 'halvorsen', cls: 'hauler' }); return M.collection().ships.find(x => x.id === 'halvorsen_hauler').found && W.count('discover') === 1; })());
  check('fifth Halvorsen ship reveals the Varroan Dustkin', (() => { S.state.companies.halvorsen.served = 5; M._onDock({ company: 'halvorsen', cls: 'freighter' }); return M.collection().species.find(x => x.id === 'varroan').found; })());
  check('discoveries pay 15 XP each', M.rank.xp >= 3 * 15);
  check('sectors: 8 with themes, names, unlock defs, expedition defs', Object.keys(W.SECTORS).length === 8 && Object.values(W.SECTORS).every(s => s.theme && s.theme.planet && s.theme.nebula.length >= 3 && s.names.length >= 6 && s.unlock && s.expedition && s.bias && s.grid));
  check('expedition durations follow sector order', Object.values(W.SECTORS).every(s => s.expedition.minutes === W.EXPEDITIONS.minutes[s.index]));
  check('MODULES extended: rate, cap, buildMs, upgrade', W.MODULE_ORDER.every(id => { const d = W.MODULES[id]; return d.rate === Math.round(d.cost / 40) && d.cap === d.rate * 60 && d.buildMs === W.TIMERS.BUILD_MS[d.tier] && d.upgrade; }));
  check('spec examples: warehouse 15, dock 20, cantina 20, market 38, reactor 75, bank 100, gate 300, hub 10', [['warehouse', 15], ['dock', 20], ['cantina', 20], ['market', 38], ['reactor', 75], ['bank', 100], ['gate', 300], ['hub', 10]].every(([id, r]) => W.MODULES[id].rate === r));
  check('ranks: 10 with Harbourmaster at 900 and Commodore at 2,000', W.RANKS.length === 10 && W.RANKS[2].xp === 900 && W.RANKS[3].xp === 2000 && W.RANKS[4].xp === 4500);
  check('daily rewards: 7, day 3/6/7 AM 5/10/25', W.DAILY_REWARDS.length === 7 && W.DAILY_REWARDS[2].amount === 5 && W.DAILY_REWARDS[5].amount === 10 && W.DAILY_REWARDS[6].amount === 25);
  check('data.js untouched globals still exported', ['MODULES', 'GOODS', 'GOOD_IDS', 'PLANETS', 'COMPANIES', 'SHIP_CLASSES', 'EVENTS', 'TIER_NAMES', 'STATION_NAMES', 'GRID_COLS', 'GRID_ROWS', 'pick', 'rnd', 'irnd', 'fmt', 'SAVE_KEY'].every(n => W.G(`typeof ${n}`) !== 'undefined'));
  check('Meta public API present', ['init', 'tick', 'save', 'load', 'export', 'import', 'collect', 'collectAll', 'skipBuild', 'upgradeModule', 'launchExpedition', 'claimExpedition', 'skipExpedition', 'claimMission', 'claimDaily', 'repairStreak', 'unlockSector', 'switchSector', 'spendAM', 'renameStation', 'newStationHere', 'resetProfile', 'hopper', 'build', 'upgrade', 'sectors', 'expeditions', 'missions', 'daily', 'collection', 'nextUp', 'addAM', 'addCredits', 'unlockAllSectors', 'grantEntitlement', 'hasEntitlement', 'totalRate'].every(n => typeof M[n] === 'function') && typeof M.am === 'number' && typeof M.rank === 'object');
}

function testShippedPreset() {
  sec('14. Shipped pacing preset: the file default is slow (tuning record 4)');
  const W = makeWorld({ tuning: FILE_DEFAULT, seed: 21 });
  const slow = W.PACING_PRESETS.slow;
  check("data2.js ships with PACING_PRESET = 'slow'", W.PACING_PRESET === 'slow', W.PACING_PRESET);
  check('no override: TUNING is the slow preset', W.TUNING.rateDivisor === 120 && JSON.stringify(W.TUNING.capMinutes) === JSON.stringify([60, 75, 90]) && !!W.TUNING.sectorCosts, W.TUNING);
  check('rate = cost/120: dock 7, warehouse 5, reactor 25, gate 100, hub 3', W.MODULES.dock.rate === 7 && W.MODULES.warehouse.rate === 5 && W.MODULES.reactor.rate === 25 && W.MODULES.gate.rate === 100 && W.MODULES.hub.rate === 3);
  check('caps 60/75/90 minutes of rate', JSON.stringify(W.TIMERS.CAP_MINUTES) === JSON.stringify([60, 75, 90]) && W.MODULES.dock.cap === 420);
  check('sector costs: sable 30k .. aurelia 3M', Object.keys(slow.sectorCosts).every(id => W.SECTORS[id].unlock.credits === slow.sectorCosts[id]) && W.SECTORS.aurelia.unlock.credits === 3000000 && W.SECTORS.home.unlock.credits === 0);
  check('everything else at spec: build times, skip, upgrade multipliers, expedition costs, AM shortcut', W.TIMERS.BUILD_MS[2] === 240000 && W.TIMERS.SKIP_MINUTES_PER_AM === 8 && JSON.stringify(W.TIMERS.RATE_MUL) === JSON.stringify([1, 1.6, 2.4]) && W.Meta.expeditionCost(W.SECTORS.aurelia) === 1800 && W.SECTORS.sable.unlock.am === 60);
  check('the live-economy knobs are unchanged by the preset', W.ECON.live === 0.06 && W.TIMERS.DAY_MS === 24000 && W.ECON.shipSpeed === 60);
  // the shipped numbers flow through the live game: a dock banks 7/min to a 420 cap and sable needs 30,000
  const M = W.Meta, S = W.Sim; M.init();
  const d = W.placeNear('dock'); W.advance(2 * HOUR);
  check('shipped curve in play: dock bank caps at 420 (60 min of 7)', M.hopper(d.r, d.c).bank === 420 && M.hopper(d.r, d.c).rate === 7);
  S.state.level = 2; M.addCredits(24000, 'test');                       // wallet 29,200
  check('shipped curve in play: sable needs 30,000 credits', M.sectors().find(x => x.id === 'sable').status === 'locked' && /30,000/.test(M.sectors().find(x => x.id === 'sable').why), M.sectors().find(x => x.id === 'sable').why);
  M.addCredits(1000, 'test');                                            // wallet 30,200
  const before = S.state.credits;
  check('shipped curve in play: unlock deducts 30,000', M.sectors().find(x => x.id === 'sable').status === 'unlockable' && M.unlockSector('sable').ok && S.state.credits === before - 30000, S.state.credits);
  check('spec override still available for comparison', makeWorld({ tuning: SPEC, seed: 22 }).MODULES.dock.rate === 20);
}

// ============================================================ economy table
function economyTable() {
  sec('Economy table, shipped preset (per module; rate in credits per real minute; payback = cost / level-1 rate)');
  const W = makeWorld({ tuning: FILE_DEFAULT, seed: 20 });
  console.log(`  PACING_PRESET = '${W.PACING_PRESET}'  rate = cost/${W.ECON.rateDivisor}, caps ${W.TIMERS.CAP_MINUTES.join('/')} min`);
  const rows = [['module', 'tier', 'cost', 'rate L1/L2/L3', 'cap L1/L2/L3', 'build', 'upgrade L2/L3', 'payback']];
  const fmtMs = ms => ms >= 3600e3 ? `${ms / 3600e3} h` : ms >= 60e3 ? `${ms / 60e3} min` : `${ms / 1000} s`;
  for (const id of ['hub', ...W.MODULE_ORDER]) {
    const d = W.MODULES[id], r = d.rate, R = W.TIMERS.RATE_MUL, C = W.TIMERS.CAP_MINUTES;
    rows.push([d.name, String(d.tier), String(d.cost), `${r}/${+(r * R[1]).toFixed(1)}/${+(r * R[2]).toFixed(1)}`, `${r * C[0]}/${Math.round(r * R[1] * C[1])}/${Math.round(r * R[2] * C[2])}`,
      d.buildMs ? fmtMs(d.buildMs) : '-', d.upgrade ? `${d.cost * 2}/${d.cost * 5}` : '-', r ? `${Math.round(d.cost / r)} min` : '-']);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  for (const r of rows) console.log('  ' + r.map((c, i) => c.padEnd(widths[i])).join('  '));
  console.log(`\n  live economy: ECON.live = ${W.ECON.live}, TIMERS.DAY_MS = ${W.TIMERS.DAY_MS} (one game day = ${W.TIMERS.DAY_MS / 1000} s at speed 1), ship speed ${W.ECON.shipSpeed} cells/day`);
  console.log('  sector unlocks: ' + Object.values(W.SECTORS).map(s => `${s.id} L${s.unlock.level} ${s.unlock.credits.toLocaleString('en-US')}${s.unlock.charts ? ` +${s.unlock.charts} chart` : ''}${s.unlock.am ? ` | ${s.unlock.am} AM` : ''}${s.unlock.pass ? ' | pass' : ''}`).join('; '));
  console.log('  expeditions: ' + Object.values(W.SECTORS).map(s => `${s.id} ${s.expedition.minutes} min / ${W.Meta.expeditionCost(s)} cr`).join('; '));
}

// ============================================================ pacing bot
// Assumptions: a "normal" player logs in three times a day (08:00, 13:00, 20:00 local) for 15 minutes at speed 1,
// collects every ready bank, claims missions and the daily reward, keeps one expedition out toward the next
// sector that needs charts, builds the next module of a sensible order whenever affordable (keeping a small
// reserve), saves for a sector unlock once its level and chart requirements are met, upgrades when there is
// nothing left to build, and stays in the home sector (new sectors only bank their hub).
function pacingBot(days, tuning, label) {
  sec(`Pacing bot [${label}]: ${days} days${tuning === FILE_DEFAULT ? ' (data2.js file default)' : '  tuning ' + JSON.stringify(tuning)}`);
  console.log('  assumptions: 3 sessions a day (08:00, 13:00, 20:00 local) of 15 min at speed 1; every ready bank collected; missions, daily reward and');
  console.log('  returned expeditions claimed; one expedition kept out toward the next sector that needs charts; modules built in a fixed sensible');
  console.log('  order whenever affordable (2,000 reserve), saving for a sector once its level and chart gates are met; upgrades only when nothing is');
  console.log('  left to build; the player stays in the home sector (other stations only bank their hub); no AM spent on skips or shortcuts.');
  const storage = makeStorage(), clock = { now: new Date(2026, 9, 19, 8, 0, 0).getTime() };
  const ORDER = ['dock', 'warehouse', 'solar', 'fuel', 'quarters', 'cantina',
    'dock', 'comms', 'market', 'rec', 'habitat', 'reactor', 'customs', 'clinic',
    'warehouse', 'security', 'school', 'plaza', 'bank', 'shipyard', 'hydro', 'dock', 'habitat', 'menagerie',
    'observatory', 'gate', 'refinery', 'quarters', 'solar', 'dock', 'habitat', 'warehouse'];
  const SESSIONS = [8, 13, 20];
  const firstUnlockable = {}, firstUnlocked = {}, firstLevel = {}, firstRank = {};
  const income = { live: 0, banks: 0, catchup: 0, missions: 0, daily: 0, expeditions: 0 };
  let seed = 100, built = 0, totalEarned = 0, lastCredits = null;
  const t0 = Date.now();
  for (let day = 1; day <= days; day++) {
    for (const hour of SESSIONS) {
      clock.now = new Date(2026, 9, 18 + day, hour, 0, 0).getTime();
      const W = makeWorld({ storage, clock, seed: seed++, tuning });
      const M = W.Meta, S = W.Sim;
      let banked = 0, liveBefore;
      S.on('collect', d => { banked += d.amount; });
      const creditsBefore = storage.getItem('waystation.profile.v2') ? JSON.parse(storage.getItem('waystation.profile.v2')).credits : 6000;
      const r = M.init();
      const off = M.offlineSummary;
      if (off) income.catchup += off.credits;
      if (lastCredits != null && off) { /* banked offline shows up when collected */ }
      const label = `d${day} ${String(hour).padStart(2, '0')}h`;
      const act = () => {
        const s = S.state;
        // collect
        if (M.canCollectAll()) M.collectAll(); else for (const k of Object.keys(s.cells)) { const [rr, cc] = k.split(',').map(Number); const h = M.hopper(rr, cc); if (h && h.ready) M.collect(rr, cc); }
        // claims
        for (const m of M.missions()) if (m.claimable) { const rw = M.claimMission(m.id); if (rw) income.missions += rw.credits; }
        if (M.daily().claimable) { const rw = M.claimDaily(); if (rw) income.daily += rw.credits; }
        for (const e of M.expeditions()) if (e.status === 'ready') { const l = M.claimExpedition(e.id); if (l) income.expeditions += l.credits + l.brokered; }
        // expeditions toward the next sector that needs charts (else the next locked sector)
        const locked = M.sectors().filter(x => x.status !== 'active' && x.status !== 'owned');
        const needsChart = locked.find(x => x.def.unlock.charts > M.charts(x.id));
        const target = needsChart || locked[0];
        if (target && M.expeditionSlots() > M._openExpeditions().length && s.credits > M.expeditionCost(target.def) + 1500) M.launchExpedition(target.id);
        // unlock when possible (record the first session the gate opened before paying)
        for (const x of M.sectors()) if (x.status === 'unlockable') { if (!firstUnlockable[x.id]) firstUnlockable[x.id] = label; const u = M.unlockSector(x.id); if (u.ok && !firstUnlocked[x.id]) firstUnlocked[x.id] = label; }
        // save for a sector whose level + chart gates are met
        const next = locked.find(x => M.bestLevel() >= x.def.unlock.level && M.charts(x.id) >= x.def.unlock.charts);
        const reserve = next ? next.def.unlock.credits : 0;
        // build the next module in order if affordable (after the reserve) and its tier is open
        const counts = {}; for (const { m } of S.cells()) counts[m.id] = (counts[m.id] || 0) + 1;
        const want = {}; let nextId = null;
        for (const id of ORDER) { want[id] = (want[id] || 0) + 1; if ((counts[id] || 0) < want[id]) { nextId = id; break; } }
        if (nextId && S.tierUnlocked(W.MODULES[nextId].tier) && s.credits - W.MODULES[nextId].cost >= Math.min(reserve, 2000) + 500) { if (W.placeNear(nextId)) built++; }
        else if (!nextId || !S.tierUnlocked(W.MODULES[nextId].tier)) {
          // nothing buildable: upgrade the best earner that is idle
          let best = null;
          for (const k of Object.keys(s.cells)) { const [rr, cc] = k.split(',').map(Number); const u = M.upgrade(rr, cc); if (u && u.next && !u.upgrading && !u.building && s.credits - u.next.cost >= reserve + 500) { if (!best || u.next.rate > best.rate) best = { rr, cc, rate: u.next.rate }; } }
          if (best) M.upgradeModule(best.rr, best.cc);
        }
        for (const x of M.sectors()) if ((x.status === 'owned' || x.status === 'active') && !firstUnlocked[x.id] && x.id !== 'home') firstUnlocked[x.id] = label;
        const L = M.bestLevel(); if (!firstLevel[L]) firstLevel[L] = label;
        const R = M.rank.level; if (!firstRank[R]) firstRank[R] = label;
      };
      act();
      liveBefore = S.state.credits;
      for (let t = 0; t < 15 * 60; t += 10) {
        const c0 = S.state.credits;
        W.run(10, 0.2);
        income.live += S.state.credits - c0;
        act();
      }
      income.banks += banked;
      M.save();
    }
    if (day <= 3 || day % 5 === 0 || day === days) {
      const p = JSON.parse(storage.getItem('waystation.profile.v2'));
      const home = p.sectors.home;
      console.log(`  day ${String(day).padStart(2)}: wallet ${Math.round(p.credits).toLocaleString('en-US').padStart(9)}  AM ${String(p.am).padStart(4)}  home L${home.level} rep ${home.rep.toFixed(1)} modules ${home.grid.flat().filter(Boolean).length - 1}  rank ${p.rank.level}  unlocked ${p.unlocked.join(',')}  charts ${JSON.stringify(p.expeditions.charts)}`);
    }
  }
  console.log(`\n  pacing table (first session when each sector became unlockable / was unlocked by the bot):`);
  const W = makeWorld({ storage, clock, seed: 1, tuning });
  const targets = { sable: 'day 2', thessaly: 'day 6', aurelia: 'day 25' };
  for (const id of Object.keys(W.SECTORS)) if (id !== 'home') console.log(`    ${id.padEnd(9)} unlockable ${String(firstUnlockable[id] || `not within ${days} days`).padEnd(22)} unlocked ${String(firstUnlocked[id] || '-').padEnd(10)} ${targets[id] ? `(target ${targets[id]})` : ''}`);
  console.log(`  station level reached: ${Object.entries(firstLevel).map(([l, d]) => `L${l} ${d}`).join(', ')}`);
  console.log(`  commander rank reached: ${Object.entries(firstRank).map(([l, d]) => `R${l} ${d}`).join(', ')}`);
  const total = income.live + income.banks + income.catchup + income.missions + income.daily + income.expeditions;
  console.log(`  income over ${days} days (gross, credits): live play ${Math.round(income.live).toLocaleString('en-US')} | banks collected ${Math.round(income.banks).toLocaleString('en-US')} | offline catch-up ${Math.round(income.catchup).toLocaleString('en-US')} | missions ${income.missions.toLocaleString('en-US')} | daily ${income.daily.toLocaleString('en-US')} | expeditions ${Math.round(income.expeditions).toLocaleString('en-US')} | total ${Math.round(total).toLocaleString('en-US')}`);
  console.log(`  (bot ran in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { firstUnlockable, firstUnlocked };
}

// ============================================================ run
(function main() {
  console.log(`Waystation v2 sim-test  (${FILES.join(', ')})`);
  const tests = [testNewProfileAndTutorial, testHoppers, testOffline, testExpeditions, testMissions, testDaily, testRanks, testSectors, testExportImportAndReset, testMigration, testV1Sim, testStore, testConvoyAndMisc, testShippedPreset];
  for (const t of tests) {
    try { t(); } catch (e) { results.fail++; results.failures.push(`${t.name}: threw ${e && e.stack}`); console.log(`  THREW ${e && e.stack}`); }
  }
  economyTable();
  if (!QUICK) {
    const runs = TUNING_ARG ? [[TUNING_ARG, 'custom tuning']] : [[FILE_DEFAULT, 'shipped preset'], [SPEC, 'DESIGN2 spec numbers, for comparison']];
    if (ARGS.includes('--no-compare')) runs.length = 1;
    for (const [tuning, label] of runs) { try { pacingBot(DAYS, tuning, label); } catch (e) { results.fail++; results.failures.push(`pacingBot: threw ${e && e.stack}`); console.log(`  THREW ${e && e.stack}`); } }
  }
  console.log(`\n${results.pass} passed, ${results.fail} failed`);
  if (results.fail) { for (const f of results.failures) console.log(`  - ${f}`); process.exit(1); }
  process.exit(0);
})();

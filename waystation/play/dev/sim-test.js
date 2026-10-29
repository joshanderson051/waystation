#!/usr/bin/env node
// ============================================================
// PORT SOLACE v2 — simulation and meta-game harness (DESIGN2.md 4.13)
//   node play/dev/sim-test.js            run every check, print the economy and pacing tables, exit 0 on success
//   node play/dev/sim-test.js --quick    skip the 25-day pacing bot
//   node play/dev/sim-test.js --days 10  pacing bot horizon (default 40); --no-compare prints only the shipped-preset table
//   node play/dev/sim-test.js --tuning '{"rateDivisor":120,"sectorCosts":{"aurelia":2000000}}'   pacing bot under a PORTSOLACE_TUNING override
// Loads data.js, data2.js, sim.js, meta.js inside a vm context with a localStorage shim and a
// controllable clock (Date.now is replaced; Math.random can be seeded), then walks the journey:
// new profile -> tutorial builds instant -> timers -> offline accrual at +3 h -> expedition round trip ->
// mission completion and claim -> sector unlock and switch -> migration from a v1 save -> export/import,
// plus hopper caps, skip costs, upgrades, loot odds, daily streak, ranks, store grants and every v1 Sim method.
// The numeric sections run under PORTSOLACE_TUNING = { preset: 'spec' } (the DESIGN2 formulas, asserted with their
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
const DAYS = (() => { const i = ARGS.indexOf('--days'); return i >= 0 ? Math.max(1, +ARGS[i + 1] || 40) : 40; })();
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
  const ctx = vm.createContext({ console, localStorage: storage, PORTSOLACE_TUNING: tuning });
  vm.runInContext('Date', ctx).now = () => clock.now;
  if (opts.seed != null) vm.runInContext('Math', ctx).random = mulberry32(opts.seed);
  for (const { f, code } of SOURCES) vm.runInContext(code, ctx, { filename: f });
  const G = name => vm.runInContext(name, ctx);
  const W = { ctx, G, storage, clock, Sim: G('Sim'), Meta: G('Meta'), MODULES: G('MODULES'), SECTORS: G('SECTORS'), TIMERS: G('TIMERS'), ECON: G('ECON'),
    MISSIONS: G('MISSIONS'), COLLECTION: G('COLLECTION'), RANKS: G('RANKS'), STORE_CATALOG: G('STORE_CATALOG'), EXPEDITIONS: G('EXPEDITIONS'), DAILY_REWARDS: G('DAILY_REWARDS'),
    MODULE_ORDER: G('MODULE_ORDER'), GOOD_IDS: G('GOOD_IDS'), PACING_PRESET: G('PACING_PRESET'), PACING_PRESETS: G('PACING_PRESETS'), TUNING: G('TUNING'),
    PLOT: G('PLOT'), plotRings: G('plotRings'), plotCost: G('plotCost'), plotMs: G('plotMs'), ACHIEVEMENTS: G('ACHIEVEMENTS'), events: [] };
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
  check('the six original Commissioning missions claimed; Clear Your First Ring is now active', ms.filter(m => m.chapter === 'Commissioning' && m.id !== 'c_plot1').every(m => m.claimed) && active().includes('c_plot1'));
  check('mission events: progress, complete and claimed all fired', W.events.some(e => e.evt === 'mission' && e.data.state === 'complete') && W.events.some(e => e.evt === 'mission' && e.data.state === 'claimed'));
  check('Trade and Reach chapters are open now', active().includes('t_fuel') && active().includes('k_quarters'));
  check('50 missions in 7 chapters (48 + the two plot missions)', W.MISSIONS.length === 50 && new Set(W.MISSIONS.map(m => m.chapter)).size === 7 && W.MISSIONS.some(m => m.id === 'c_plot1') && W.MISSIONS.some(m => m.id === 'w_plot4'));
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
  storage.setItem('portsolace-save-v1', JSON.stringify(v1));
  const W = makeWorld({ storage, seed: 15 });
  const r = W.Meta.init();
  const M = W.Meta, S = W.Sim;
  check('migrated on first v2 load', r.resumed && r.migrated && M.profile.migratedFrom === 'v1');
  check('station is sectors.home with the same grid', S.state.sector === 'home' && JSON.stringify(S.state.grid) === JSON.stringify(v1.grid) && S.state.name === 'Old Faithful');
  check('credits became the wallet', M.profile.credits === 4321 && S.state.credits === 4321);
  check('rank xp = served x 5', M.profile.rank.xp === 60);
  check('every occupied cell has meta', W.Sim.cellsOf(S.state).every(({ r, c }) => { const m = S.cellMeta(r, c); return m && m.lvl === 1 && m.bank === 0 && m.readyAt === null; }));
  check('v1 key renamed to .bak', storage.getItem('portsolace-save-v1') === null && !!storage.getItem('portsolace-save-v1.bak'));
  check('v2 profile written', !!storage.getItem('portsolace.profile.v2'));
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
  check('canPlace reasons', S.canPlace('dock', 0, 0).why === 'plot' && S.canPlace('dock', S.state.plot.r0, S.state.plot.c0).why === 'Must touch the station' && S.canPlace('gate', S.state.hub.r, S.state.hub.c + 1).why === 'Needs station level 4' && S.canPlace('dock', S.state.hub.r, S.state.hub.c).why === 'Occupied' && (() => { const c = S.state.credits; S.state.credits = 0; const w = S.canPlace('dock', S.state.hub.r, S.state.hub.c + 1).why; S.state.credits = c; return w === 'Not enough credits'; })());
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
  check('Meta public API present', ['init', 'tick', 'save', 'load', 'export', 'import', 'collect', 'collectAll', 'skipBuild', 'upgradeModule', 'launchExpedition', 'claimExpedition', 'skipExpedition', 'claimMission', 'claimDaily', 'repairStreak', 'unlockSector', 'switchSector', 'spendAM', 'renameStation', 'newStationHere', 'resetProfile', 'hopper', 'build', 'upgrade', 'sectors', 'expeditions', 'missions', 'daily', 'collection', 'nextUp', 'addAM', 'addCredits', 'unlockAllSectors', 'grantEntitlement', 'hasEntitlement', 'totalRate', 'plot', 'expandPlot', 'skipPlot', 'achievements', 'claimAchievement', 'achievementBadge', 'lifetimeStats'].every(n => typeof M[n] === 'function') && typeof M.am === 'number' && typeof M.rank === 'object');
}

function testShippedPreset() {
  sec('14. Shipped pacing preset: the file default is patient (A1.1)');
  const W = makeWorld({ tuning: FILE_DEFAULT, seed: 21 });
  const P = W.PACING_PRESETS.patient;
  check("data2.js ships with PACING_PRESET = 'patient'", W.PACING_PRESET === 'patient', W.PACING_PRESET);
  check("'slow' and 'spec' stay selectable", makeWorld({ tuning: { preset: 'slow' }, seed: 22 }).MODULES.dock.rate === 7 && makeWorld({ tuning: SPEC, seed: 23 }).MODULES.dock.rate === 20);
  check('build times 90 s / 12 min / 60 min / 4 h', W.TIMERS.BUILD_MS[1] === 90e3 && W.TIMERS.BUILD_MS[2] === 720e3 && W.TIMERS.BUILD_MS[3] === 3600e3 && W.TIMERS.BUILD_MS[4] === 14400e3 && W.MODULES.gate.buildMs === 14400e3);
  check('upgrades: level 2 = 2x, level 3 = 5x the build time', JSON.stringify(W.TIMERS.UPGRADE_TIME_MUL) === JSON.stringify([2, 5]));
  check('rate = cost/150: dock 5, warehouse 4, reactor 20, gate 80, hub 3', W.MODULES.dock.rate === 5 && W.MODULES.warehouse.rate === 4 && W.MODULES.reactor.rate === 20 && W.MODULES.gate.rate === 80 && W.MODULES.hub.rate === 3);
  check('caps 180/240/360 minutes of rate (dock cap 900)', JSON.stringify(W.TIMERS.CAP_MINUTES) === JSON.stringify([180, 240, 360]) && W.MODULES.dock.cap === 900);
  check('offline accrual cap 24 h', W.TIMERS.OFFLINE_BANK_CAP_MS === 24 * HOUR);
  check('expeditions 30 min .. 24 h by sector, costs unchanged', JSON.stringify(W.EXPEDITIONS.minutes) === JSON.stringify([30, 60, 120, 240, 360, 480, 720, 1440]) && W.SECTORS.aurelia.expedition.minutes === 1440 && W.Meta.expeditionCost(W.SECTORS.aurelia) === 1800);
  check('DAY_MS 48,000, shipSpeed 40, speeds 0 | 1, live 0.06', W.TIMERS.DAY_MS === 48000 && W.ECON.shipSpeed === 40 && JSON.stringify(W.TIMERS.SPEEDS) === JSON.stringify([0, 1]) && W.ECON.live === 0.06);
  check('sector costs come from the preset', Object.keys(P.sectorCosts).every(id => W.SECTORS[id].unlock.credits === P.sectorCosts[id]) && W.SECTORS.home.unlock.credits === 0);
  check('skip formula unchanged: a 4 h build costs 30 AM', W.Meta.skipCost(4 * HOUR) === 30 && W.TIMERS.SKIP_MINUTES_PER_AM === 8);
  // the shipped numbers flow through the live game
  const M = W.Meta, S = W.Sim; M.init();
  S.state.speed = 4; S.tick(0.1);
  check('Sim.tick clamps speed to 0 or 1 (2x / 4x gone)', S.state.speed === 1 && (() => { S.state.speed = 0; S.tick(0.1); return S.state.speed === 0; })());
  S.state.speed = 1;
  const d = W.placeNear('dock'); W.placeNear('warehouse'); W.placeNear('solar');
  check('first three builds still instant', !M.build(d.r, d.c).building);
  const f = W.placeNear('fuel');
  check('fourth tier-1 build takes 90 s and costs 1 AM to skip', M.build(f.r, f.c).totalMs === 90000 && M.build(f.r, f.c).skipAM === 1);
  const u = M.upgrade(d.r, d.c);
  check('dock to level 2 takes 3 min, to level 3 7.5 min (2x / 5x of 90 s)', u.next.ms === 180000 && (() => { const k = d.r + ',' + d.c; S.state.cells[k].lvl = 2; const u3 = M.upgrade(d.r, d.c); S.state.cells[k].lvl = 1; return u3.next.ms === 450000; })(), u.next.ms);
  check('a tier-3 module at level 3 is a five-hour project; the Jump Gate twenty hours', M.upgradeMs(W.MODULES.bank, 2) === 5 * HOUR && M.upgradeMs(W.MODULES.gate, 2) === 20 * HOUR);
  W.advance(5 * HOUR);
  check('dock bank caps at 900 (180 min of 5)', M.hopper(d.r, d.c).bank === 900);
  M.save(); const c0 = W.clock.now; W.clock.now += 30 * HOUR;
  const W2 = makeWorld({ storage: W.storage, clock: W.clock, tuning: FILE_DEFAULT, seed: 24 }); W2.Meta.init();
  check('offline: hub bank after 30 h away is the 24 h-capped rate (hub 3/min -> cap 540)', W2.Meta.hopper(S.state.hub.r, S.state.hub.c).bank === 540, W2.Meta.hopper(S.state.hub.r, S.state.hub.c).bank);
  W.clock.now = c0;
}

function testPlots() {
  sec('15. Plot expansion (A1.2): rings, costs, timers, skip, migration, canPlace outside the plot');
  const W = makeWorld({ seed: 25 });
  const dims = b => (b.c1 - b.c0 + 1) + 'x' + (b.r1 - b.r0 + 1);
  const seq = (rows, cols) => W.plotRings(rows, cols, { r: Math.floor(rows / 2), c: Math.floor(cols / 2) }).map(dims);
  check('home 15x9: 7x5 -> 9x7 -> 11x7 -> 13x9 -> 15x9', JSON.stringify(seq(9, 15)) === JSON.stringify(['7x5', '9x7', '11x7', '13x9', '15x9']), seq(9, 15));
  for (const [rows, cols] of [[9, 17], [11, 15], [11, 17], [11, 19]]) {
    const q = seq(rows, cols);
    check(cols + 'x' + rows + ': starts 7x5, ends at the full grid, grows monotonically (' + q.join(' -> ') + ')', q[0] === '7x5' && q[q.length - 1] === cols + 'x' + rows && q.every((d, i) => i === 0 || (+d.split('x')[0] >= +q[i - 1].split('x')[0] && +d.split('x')[1] >= +q[i - 1].split('x')[1])));
  }
  check('ring costs 4,000 x 2.2^(k-1): 4,000 / 8,800 / 19,360 / 42,592', W.plotCost(1) === 4000 && W.plotCost(2) === 8800 && W.plotCost(3) === 19360 && W.plotCost(4) === 42592);
  check('ring times 15 min x 1.9^(k-1); far sectors x1.5', W.plotMs(1) === 15 * MIN && W.plotMs(2) === Math.round(28.5 * MIN) && W.plotMs(1, 1.5) === Math.round(22.5 * MIN));
  W.record('plot');
  const M = W.Meta, S = W.Sim; M.init();
  const hub = S.state.hub;
  check('a new station starts at ring 0, 7x5 around the hub', S.state.plot.ring === 0 && S.state.plot.r0 === hub.r - 2 && S.state.plot.r1 === hub.r + 2 && S.state.plot.c0 === hub.c - 3 && S.state.plot.c1 === hub.c + 3 && !S.state.plot.clearing);
  let info = M.plot();
  check('Meta.plot(): 35 cells, 5 rings, next ring 1 costs 4,000 for 28 cells in 15 min', info.cells === 35 && info.rings === 5 && info.next && info.next.ring === 1 && info.next.cost === 4000 && info.next.cells === 28 && info.next.ms === 15 * MIN && info.next.affordable && info.clearing === null, info);
  check('Sim.inPlot', S.inPlot(hub.r, hub.c + 3) && !S.inPlot(hub.r, hub.c + 4) && !S.inPlot(0, 0));
  check("canPlace outside the plot -> why 'plot' and place refuses", S.canPlace('dock', hub.r, hub.c + 4).why === 'plot' && !S.place('dock', hub.r, hub.c + 4) && !S.state.grid[hub.r][hub.c + 4]);
  // the tutorial inside 7x5: three instant builds, a dock on the plot edge still has an open side (ships berth from unclaimed space)
  check('dock on the plot edge is usable (open side toward unclaimed space)', S.place('dock', hub.r, hub.c + 1) && S.place('dock', hub.r, hub.c + 2) && S.place('dock', hub.r, hub.c + 3) && S.dockUsable(hub.r, hub.c + 3) && S.findBerth() !== null);
  check('31 free cells left in the start plot: enough for the tutorial and the first chapters', (() => { let n = 0; for (let r = S.state.plot.r0; r <= S.state.plot.r1; r++) for (let c = S.state.plot.c0; c <= S.state.plot.c1; c++) if (!S.state.grid[r][c]) n++; return n === 31; })());
  // expand
  M.addCredits(100000, 'test');
  const wallet = S.state.credits;
  const e = M.expandPlot();
  check('expandPlot deducts 4,000 and starts a 15 min clearing', e.ok && e.cost === 4000 && S.state.credits === wallet - 4000 && near(e.endsAt - W.clock.now, 15 * MIN, 1), e);
  check("plot event 'start' with ring and bounds", W.last('plot') && W.last('plot').state === 'start' && W.last('plot').ring === 1 && W.last('plot').bounds.c1 - W.last('plot').bounds.c0 + 1 === 9);
  info = M.plot();
  check('Meta.plot() while clearing: clearing block, no next', info.clearing && info.clearing.ring === 1 && near(info.clearing.remainingMs, 15 * MIN, 1) && info.clearing.totalMs === 15 * MIN && info.clearing.skipAM === 2 && info.next === null);
  check('a second expandPlot is refused while clearing', !M.expandPlot().ok);
  check("nextUp lists the clearing (kind 'plot')", M.nextUp().some(x => x.kind === 'plot' && x.endsAt === info.clearing.endsAt));
  check('still outside the plot until the timer passes', S.canPlace('dock', hub.r, hub.c + 4).why === 'plot');
  W.advance(15 * MIN);
  check("ring 1 cleared on time: 9x7, event 'done'", S.state.plot.ring === 1 && dims(S.state.plot) === '9x7' && !S.state.plot.clearing && W.last('plot').state === 'done' && W.last('plot').ring === 1);
  check('the new cells accept modules', S.canPlace('dock', hub.r, hub.c + 4).ok && S.place('warehouse', hub.r, hub.c + 4));
  // skip
  const e2 = M.expandPlot();
  check('ring 2 costs 8,800 and takes 28.5 min', e2.ok && e2.cost === 8800 && near(e2.endsAt - W.clock.now, 28.5 * MIN, 1));
  const am0 = M.am;
  const sk = M.skipPlot();
  check('skipPlot costs ceil(28.5/8) = 4 AM and clears at once', sk.ok && sk.cost === 4 && M.am === am0 - 4 && S.state.plot.ring === 2 && dims(S.state.plot) === '11x7' && W.last('plot').state === 'skip');
  check('skip refused with nothing clearing', !M.skipPlot().ok);
  check('plotRings stat counts rings across the profile', M.profile.stats.plotRings === 2);
  // clear the rest and run out of rings
  while (M.plot().next) { M.expandPlot(); W.advance(M.plot().clearing.totalMs); }
  check('after the last ring the plot is the full grid and next is null', S.state.plot.ring === 4 && dims(S.state.plot) === '15x9' && M.plot().next === null && !M.expandPlot().ok);
  // migration: a station saved without a plot gets the smallest ring holding every module
  const v1 = S.makeState('home'); delete v1.plot;
  v1.grid[v1.hub.r][v1.hub.c + 5] = { id: 'dock', built: 2 };          // two cells beyond the 7x5 edge -> ring 2 (11x7)
  const mig = S.sanitize(v1);
  check('migration ring = smallest ring containing every module (11x7 -> ring 2)', mig.plot.ring === 2 && dims(mig.plot) === '11x7');
  const v0 = S.makeState('home'); delete v0.plot; v0.grid[v0.hub.r][v0.hub.c + 1] = { id: 'dock', built: 2 };
  check('a compact station migrates to ring 0', S.sanitize(v0).plot.ring === 0);
  // far sectors: timers x1.5; inactive sectors settle their clearing in tick
  M.unlockAllSectors('test'); M.switchSector('marrow');
  check('marrow ring 1 takes 22.5 min', M.plot().next.ms === Math.round(22.5 * MIN));
  M.addCredits(10000, 'test'); M.expandPlot(); M.switchSector('home');
  W.advance(6000); W.advance(23 * MIN);
  check('an inactive sector finishes its clearing while you are elsewhere', M.profile.sectors.marrow.plot.ring === 1 && !M.profile.sectors.marrow.plot.clearing);
  // missions
  const W2 = makeWorld({ seed: 26 }); W2.Meta.init(); W2.Meta.addCredits(5000, 'test');
  for (const id of ['c_dock', 'c_warehouse', 'c_solar', 'c_collect', 'c_serve3', 'c_transmission']) { W2.Meta.profile.missions.completed[id] = 1; W2.Meta.profile.missions.claimed[id] = 1; }
  W2.Meta.evalMissions(W2.clock.now, true);
  check('Clear Your First Ring is the next Commissioning mission', W2.Meta.missions().find(m => m.id === 'c_plot1').active);
  W2.Meta.expandPlot(); W2.advance(15 * MIN); W2.advance(300);
  check('...and completes when ring 1 is cleared (+5 AM on claim)', W2.Meta.missions().find(m => m.id === 'c_plot1').claimable && W2.Meta.claimMission('c_plot1').am === 5);
  check('Room to Grow tracks ring 4 in Town', W2.MISSIONS.find(m => m.id === 'w_plot4').goal === 4 && W2.MISSIONS.find(m => m.id === 'w_plot4').chapter === 'Town');
  // offline: a clearing that ended while away is settled on load and counted
  W2.Meta.addCredits(10000, 'test'); W2.Meta.expandPlot(); W2.Meta.save(); W2.clock.now += 2 * HOUR;
  const W3 = makeWorld({ storage: W2.storage, clock: W2.clock, seed: 27 }); W3.record('offline'); W3.Meta.init();
  check('offline: the ring finished while away', W3.Sim.state.plot.ring === 2 && W3.last('offline').summary.plots === 1);
}

function testAchievements() {
  sec('16. Achievements (A1.3): 24 x 3 tiers, progression, claim once, badge');
  const W = makeWorld({ seed: 28 });
  W.record('achievement', 'am');
  const A = W.ACHIEVEMENTS;
  check('24 achievements, three tiers each, ascending goals', A.length === 24 && A.every(a => a.tiers.length === 3 && a.tiers[0].goal < a.tiers[1].goal && a.tiers[1].goal < a.tiers[2].goal && a.id && a.title && a.desc && a.icon && a.fam && a.stat));
  check('tiers pay 5 / 15 / 40 AM, gold 60 on the hardest', A.every(a => a.tiers[0].am === 5 && a.tiers[1].am === 15 && (a.tiers[2].am === 40 || a.tiers[2].am === 60)) && A.filter(a => a.tiers[2].am === 60).length >= 6);
  check('the named ones from the addendum exist with their goals', [['harbourmaster', 50, 500, 5000], ['banker', 50000, 1000000, 20000000], ['architect', 10, 100, 500], ['foreman', 5, 50, 200], ['surveyor', 3, 25, 150], ['cartographer', 3, 12, 24], ['collector', 10, 30, 52], ['pioneer', 2, 5, 8], ['landholder', 2, 10, 30], ['regular', 7, 30, 100], ['patron', 50, 500, 5000], ['town_planner', 20, 60, 150]].every(([id, ...g]) => { const a = A.find(x => x.id === id); return a && a.tiers.map(t => t.goal).join() === g.join(); }));
  check('one per station tier and the rank milestones', ['way_station', 'trading_hub', 'town_in_space', 'galactic_hub', 'officer', 'flag_officer', 'legend'].every(id => A.some(a => a.id === id)));
  const M = W.Meta, S = W.Sim; M.init();
  check('every stat key resolves in Meta.lifetimeStats()', (() => { const L = M.lifetimeStats(); return A.every(a => typeof L[a.stat] === 'number'); })(), Object.keys(M.lifetimeStats()));
  check('fresh profile: nothing claimable, badge 0, all tier 0', M.achievements().every(a => !a.claimable && a.tier === 0 && !a.done) && M.achievementBadge() === 0);
  const row = id => M.achievements().find(a => a.id === id);
  check('progress and goal point at the next tier', row('harbourmaster').goal === 50 && row('harbourmaster').nextAM === 5 && row('harbourmaster').progress === 0);
  M.profile.stats.servedTotal = 50; M.evalMissions(W.clock.now, true);
  check("tier 1 reached: event 'complete', claimable, badge 1", W.events.some(e => e.evt === 'achievement' && e.data.id === 'harbourmaster' && e.data.tier === 1 && e.data.state === 'complete') && row('harbourmaster').claimable && M.achievementBadge() === 1);
  const am0 = M.am;
  let c = M.claimAchievement('harbourmaster');
  check('claim pays 5 AM for bronze', c && c.am === 5 && c.tier === 1 && M.am === am0 + 5 && W.events.some(e => e.evt === 'achievement' && e.data.state === 'claimed' && e.data.tier === 1));
  check('claim once: a second claim returns null, badge 0', M.claimAchievement('harbourmaster') === null && M.achievementBadge() === 0 && row('harbourmaster').tier === 1 && row('harbourmaster').goal === 500);
  M.profile.stats.servedTotal = 5000; M.evalMissions(W.clock.now, true);
  check('jumping two tiers completes both; claims go one tier at a time', row('harbourmaster').reached === 3 && row('harbourmaster').claimable && M.claimAchievement('harbourmaster').am === 15 && M.claimAchievement('harbourmaster').am === 60 && M.claimAchievement('harbourmaster') === null);
  check('done after gold', row('harbourmaster').done && row('harbourmaster').tier === 3 && row('harbourmaster').nextAM === 0);
  check('unknown id -> null', M.claimAchievement('nope') === null);
  // derived stats
  M.profile.sectors.home.level = 3; M.unlockAllSectors('test'); M.profile.sectors.sable.level = 2;
  M.profile.rank.xp = 2000; M.profile.rank.level = 4;
  M.profile.expeditions.charts = { sable: 2, oros: 1 };
  M.profile.collection.found = { a: { count: 1 }, b: { count: 1 } };
  M.evalMissions(W.clock.now, true);
  const L = M.lifetimeStats();
  check('derived: sectorsAtL2 2, sectorsAtL3 1, rankLevel 4, chartsTotal 3, registryFound 2, sectorsUnlocked 7', L.sectorsAtL2 === 2 && L.sectorsAtL3 === 1 && L.rankLevel === 4 && L.chartsTotal === 3 && L.registryFound === 2 && M.profile.stats.sectorsUnlocked === 7);
  check('Way Station Keeper bronze, Trading Hub Director bronze, Commissioned Officer gold (rank 4), Pioneer gold (8 sectors)', row('way_station').reached === 1 && row('trading_hub').reached === 1 && row('officer').reached === 3 && row('pioneer').reached === 3);
  check('residents peak tracked by tick', (() => { S.state.residents = 25; M.tick(W.clock.now + 1); return M.profile.stats.residentsPeak === 25 && M.lifetimeStats().residentsPeak === 25; })());
  check('Aurelian liners counted on dock', (() => { S.state.companies.aurelian.served = 1; M._onDock({ company: 'aurelian', cls: 'liner' }); return M.profile.stats.aurelianServed === 1; })());
  // migration defaults: an older profile without the new fields
  M.save(); const raw = JSON.parse(W.storage.getItem('portsolace.profile.v2')); delete raw.stats.residentsPeak; delete raw.stats.aurelianServed; delete raw.stats.plotRings;
  const noAch = JSON.parse(JSON.stringify(raw)); delete noAch.achievements;
  W.storage.setItem('portsolace.profile.v2', JSON.stringify(raw));
  const W2 = makeWorld({ storage: W.storage, clock: W.clock, seed: 29 }); W2.Meta.init();
  check('older profiles get the new stats with defaults; claims survive save/load', W2.Meta.profile.stats.residentsPeak === 0 && W2.Meta.profile.stats.plotRings === 0 && W2.Meta.profile.achievements.claimed.harbourmaster === 3 && W2.Meta.achievements().length === 24);
  W.storage.setItem('portsolace.profile.v2', JSON.stringify(noAch));
  const W3 = makeWorld({ storage: W.storage, clock: W.clock, seed: 30 }); W3.Meta.init();
  check('a profile without the achievements block gets it and re-derives reached tiers from its stats', !!W3.Meta.profile.achievements && W3.Meta.achievements().find(a => a.id === 'harbourmaster').reached === 3 && W3.Meta.achievementBadge() >= 1);
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
  console.log(`\n  live economy: ECON.live = ${W.ECON.live}, TIMERS.DAY_MS = ${W.TIMERS.DAY_MS} (one game day = ${W.TIMERS.DAY_MS / 1000} s at speed 1), ship speed ${W.ECON.shipSpeed} cells/day, speeds ${W.TIMERS.SPEEDS.join('/')}`);
  console.log(`  upgrades: level 2 = ${W.TIMERS.UPGRADE_TIME_MUL[0]}x build time, level 3 = ${W.TIMERS.UPGRADE_TIME_MUL[1]}x; offline bank cap ${W.TIMERS.OFFLINE_BANK_CAP_MS / 3600e3} h`);
  console.log('  plot rings (home 15x9): ' + W.plotRings(9, 15, { r: 4, c: 7 }).map((b, k) => `ring ${k} ${b.c1 - b.c0 + 1}x${b.r1 - b.r0 + 1}${k ? ` ${W.plotCost(k).toLocaleString('en-US')} cr / ${Math.round(W.plotMs(k) / 60e3)} min` : ''}`).join('; '));
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
  const firstUnlockable = {}, firstUnlocked = {}, firstLevel = {}, firstRank = {}, firstRing = {};
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
      const creditsBefore = storage.getItem('portsolace.profile.v2') ? JSON.parse(storage.getItem('portsolace.profile.v2')).credits : 6000;
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
        // territory: clear the next ring when it is affordable after the reserve (players expand; the plot missions need it)
        const pl = M.plot();
        if (pl && pl.next && !pl.clearing && s.credits - pl.next.cost >= Math.min(reserve, 2000) + 2500) { if (M.expandPlot().ok && !firstRing[pl.next.ring]) firstRing[pl.next.ring] = label; }
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
      const p = JSON.parse(storage.getItem('portsolace.profile.v2'));
      const home = p.sectors.home;
      console.log(`  day ${String(day).padStart(2)}: wallet ${Math.round(p.credits).toLocaleString('en-US').padStart(9)}  AM ${String(p.am).padStart(4)}  home L${home.level} rep ${home.rep.toFixed(1)} modules ${home.grid.flat().filter(Boolean).length - 1}  rank ${p.rank.level}  unlocked ${p.unlocked.join(',')}  charts ${JSON.stringify(p.expeditions.charts)}`);
    }
  }
  console.log(`\n  pacing table (first session when each sector became unlockable / was unlocked by the bot):`);
  const W = makeWorld({ storage, clock, seed: 1, tuning });
  const targets = { sable: 'day 2-3', kessler: 'day 4-5', thessaly: 'day 8-10', marrow: 'day 13-15', oros: 'day 18-22', keth: 'day 24-28', aurelia: 'day 32-40' };
  for (const id of Object.keys(W.SECTORS)) if (id !== 'home') console.log(`    ${id.padEnd(9)} unlockable ${String(firstUnlockable[id] || `not within ${days} days`).padEnd(22)} unlocked ${String(firstUnlocked[id] || '-').padEnd(10)} ${targets[id] ? `(target ${targets[id]})` : ''}`);
  console.log(`  station level reached: ${Object.entries(firstLevel).map(([l, d]) => `L${l} ${d}`).join(', ')}`);
  console.log(`  plot rings cleared (home): ${Object.entries(firstRing).map(([k, d]) => `ring ${k} ${d}`).join(', ') || 'none'}`);
  console.log(`  sector costs: ${Object.values(W.SECTORS).filter(x => x.unlock.credits).map(x => `${x.id} ${x.unlock.credits.toLocaleString('en-US')}`).join(', ')}`);
  console.log(`  commander rank reached: ${Object.entries(firstRank).map(([l, d]) => `R${l} ${d}`).join(', ')}`);
  const total = income.live + income.banks + income.catchup + income.missions + income.daily + income.expeditions;
  console.log(`  income over ${days} days (gross, credits): live play ${Math.round(income.live).toLocaleString('en-US')} | banks collected ${Math.round(income.banks).toLocaleString('en-US')} | offline catch-up ${Math.round(income.catchup).toLocaleString('en-US')} | missions ${income.missions.toLocaleString('en-US')} | daily ${income.daily.toLocaleString('en-US')} | expeditions ${Math.round(income.expeditions).toLocaleString('en-US')} | total ${Math.round(total).toLocaleString('en-US')}`);
  console.log(`  (bot ran in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { firstUnlockable, firstUnlocked };
}

function testLiveries() {
  sec('17. Liveries (A5): definitions, ownership, selection, tokens, persistence');
  const W = makeWorld({ seed: 24 });
  W.record('livery', 'change');
  const M = W.Meta, S = W.Sim; M.init();
  const L = W.G('LIVERIES'), SIX = ['sable', 'kessler', 'thessaly', 'marrow', 'oros', 'keth'], HEX = /^#[0-9A-F]{6}$/i;
  check('eight liveries: default, the six sectors, founder, each with id, name, strip, seam, rim, hubCore', L.length === 8 && L.map(l => l.id).join(',') === ['default', ...SIX, 'founder'].join(',') && L.every(l => l.name && l.strip && HEX.test(l.seam) && HEX.test(l.rim) && HEX.test(l.hubCore)));
  check('default strip is the family hue; sector liveries carry their sector id and a hex strip', L[0].strip === 'family' && SIX.every(id => W.G('liveryDef')(id).sector === id && HEX.test(W.G('liveryDef')(id).strip)));
  check('the liveries sku grants exactly the six sector ids', JSON.stringify(W.STORE_CATALOG.find(i => i.sku === 'liveries').grant.liveries) === JSON.stringify(SIX));
  check('new profile: setting default, Meta.livery() default', M.profile.settings.livery === 'default' && M.livery().id === 'default');
  let list = M.liveries();
  check('liveries(): default owned+active, the rest locked, sources default / sector / store', list.length === 8 && list[0].owned && list[0].active && list[0].source === 'default' && list.slice(1).every(l => !l.owned && !l.active) && SIX.every(id => list.find(l => l.id === id).source === 'sector') && list.find(l => l.id === 'founder').source === 'store');
  const refused = M.setLivery('sable');
  check('setLivery refuses an unowned livery: no event, setting unchanged', !refused.ok && M.profile.settings.livery === 'default' && W.count('livery') === 0, refused);
  check('setLivery refuses an unknown id', !M.setLivery('nope').ok);
  check('redeem refused without a token', !M.redeemLiveryToken('keth').ok && M.liveryTokens() === 0);
  M.profile.daily = { streak: 6, lastClaimAt: W.clock.now - DAY, lastClaimKey: null };
  const r7 = M.claimDaily();
  check('day 7 of the streak grants one livery token', r7 && r7.token === 'livery' && M.liveryTokens() === 1, r7);
  check('a token buys neither founder nor default', !M.redeemLiveryToken('founder').ok && !M.redeemLiveryToken('default').ok && M.liveryTokens() === 1);
  const red = M.redeemLiveryToken('keth');
  check('redeemLiveryToken(keth): token spent, keth owned, source token', red.ok && red.left === 0 && M.liveryTokens() === 0 && M.ownsLivery('keth') && M.liveries().find(l => l.id === 'keth').source === 'token' && M.profile.entitlements.redeemed.includes('keth'), red);
  check('history records the token grant', M.profile.entitlements.history.some(h => h.sku === 'livery_token' && h.livery === 'keth'));
  check('redeem refused for an owned livery', !M.redeemLiveryToken('keth').ok);
  const set = M.setLivery('keth');
  check('setLivery(keth): ok, changed, saved, livery event {id, was}', set.ok && set.changed && M.profile.settings.livery === 'keth' && M.livery().id === 'keth' && W.count('livery') === 1 && W.last('livery').id === 'keth' && W.last('livery').was === 'default' && JSON.parse(W.storage.getItem('portsolace.profile.v2')).settings.livery === 'keth', set);
  check('setting the same livery again is ok but unchanged', M.setLivery('keth').ok && !M.setLivery('keth').changed);
  check('the other sector liveries stay locked (source sector)', !M.ownsLivery('sable') && M.liveries().find(l => l.id === 'sable').source === 'sector');
  M.grantSku('liveries', { grantId: 'cs_liv_1' });
  list = M.liveries();
  check('liveries sku: all six owned, source store (keth keeps token)', SIX.every(id => list.find(l => l.id === id).owned) && list.find(l => l.id === 'sable').source === 'store' && list.find(l => l.id === 'keth').source === 'token');
  check('founder stays locked until its sku', !M.ownsLivery('founder') && !M.setLivery('founder').ok);
  const am0 = M.am;
  M.grantSku('founder', { grantId: 'cs_liv_2' });
  check('founder sku: livery owned, title Founder, +100 AM', M.ownsLivery('founder') && M.profile.entitlements.titles.includes('Founder') && M.am === am0 + 100);
  check('setLivery(founder) ok, exactly one active', M.setLivery('founder').ok && M.livery().id === 'founder' && M.liveries().filter(l => l.active).length === 1);
  M.save();
  check('the choice survives save/load', M.load() && M.livery().id === 'founder' && M.liveryTokens() === 0);
  const json = M.export();
  M.resetProfile();
  check('reset: back to default, nothing owned', M.livery().id === 'default' && !M.ownsLivery('founder') && !M.ownsLivery('keth'));
  check('import restores the founder livery', M.import(json).ok && M.livery().id === 'founder');
  const p = JSON.parse(json); p.entitlements = { owned: {}, history: [], liveries: [], titles: [], tokens: { livery: 0 } };
  check('an unowned saved choice falls back to default; fixup adds redeemed', M.import(JSON.stringify(p)).ok && M.profile.settings.livery === 'founder' && M.livery().id === 'default' && Array.isArray(M.profile.entitlements.redeemed));
  check('hasEntitlement(liveries) alone owns the six (a server grant without the id list)', (() => { M.profile.entitlements.owned.liveries = true; return SIX.every(id => M.ownsLivery(id)) && !M.ownsLivery('founder'); })());
  check('every v1 Sim method still runs after the livery section', typeof S.totals === 'function' && !!S.totals());
}

// ------------------------------------------------------------ js/migrate.js: legacy 'waystation*' keys copied to 'portsolace*'
// A storage shim whose items are also own enumerable properties, like the real localStorage, so the script may
// enumerate with key(i)/length or with Object.keys(localStorage).
function makeEnumerableStorage(init) {
  const m = new Map();
  const s = Object.create({
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); Object.defineProperty(s, k, { value: String(v), enumerable: true, configurable: true, writable: true }); },
    removeItem(k) { m.delete(k); delete s[k]; },
    key(i) { return [...m.keys()][i] ?? null; },
    get length() { return m.size; },
  });
  Object.defineProperty(s, '_map', { value: m, enumerable: false });
  for (const [k, v] of Object.entries(init || {})) s.setItem(k, v);
  return s;
}
function runMigrate(code, storage) {
  const ctx = vm.createContext({ console, localStorage: storage });
  ctx.window = ctx;
  vm.runInContext(code, ctx, { filename: 'migrate.js' });
  return ctx;
}
function testMigrateScript() {
  sec('migrate.js: legacy key copy (M1)');
  const file = path.join(ROOT, 'migrate.js');
  if (!fs.existsSync(file)) { console.log('  skip js/migrate.js not present'); return; }
  const code = fs.readFileSync(file, 'utf8');
  const legacy = { 'waystation.profile.v2': '{"name":"Old Faithful"}', 'waystation-save-v1.bak': '{"v":1}', 'waystation.store.grants': '[1]', 'waystation.playerId': 'p_123',
    'waystation.account': '{"t":1}', 'waystation.push': 'on', 'waystation.admin': 'x', 'other.key': 'keep' };
  const st = makeEnumerableStorage(Object.assign({}, legacy, { 'portsolace.push': 'off' }));
  let threw = null;
  try { var ctx = runMigrate(code, st); } catch (e) { threw = e; }
  check('runs without throwing', !threw, threw && String(threw));
  if (threw) return;
  const mapped = k => 'portsolace' + k.slice(10);
  check('every legacy key is copied to its portsolace name', Object.keys(legacy).filter(k => k.startsWith('waystation') && k !== 'waystation.push').every(k => st.getItem(mapped(k)) === legacy[k]));
  check('an existing portsolace key is not overwritten', st.getItem('portsolace.push') === 'off');
  check('legacy keys are never deleted', Object.keys(legacy).every(k => st.getItem(k) === legacy[k]));
  check('unrelated keys are untouched and not copied', st.getItem('other.key') === 'keep' && [...st._map.keys()].filter(k => k.startsWith('other')).length === 1);
  const at = st.getItem('portsolace.migrated.v1');
  check('portsolace.migrated.v1 is an ISO time', !!at && !Number.isNaN(Date.parse(at)) && new Date(at).toISOString() === at, at);
  const api = ctx.PortSolaceMigrate;
  check('window.PortSolaceMigrate.mapKey maps the prefix', !!api && typeof api.mapKey === 'function' && api.mapKey('waystation.profile.v2') === 'portsolace.profile.v2' && api.mapKey('waystation-save-v1') === 'portsolace-save-v1' && api.mapKey('waystation.store.x') === 'portsolace.store.x');
  // a second load: the marker is written once, and a value changed since under the new name is kept
  st.setItem('portsolace.migrated.v1', '2026-01-01T00:00:00.000Z');
  st.setItem('portsolace.profile.v2', '{"name":"New Home"}');
  runMigrate(code, st);
  check('second run keeps the first migration time', st.getItem('portsolace.migrated.v1') === '2026-01-01T00:00:00.000Z');
  check('second run does not clobber newer portsolace data', st.getItem('portsolace.profile.v2') === '{"name":"New Home"}');
  // storage that throws (blocked site data) must never break boot
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {}, key() { throw new Error('blocked'); }, get length() { throw new Error('blocked'); } };
  let threw2 = null;
  try { runMigrate(code, bad); } catch (e) { threw2 = e; }
  check('throwing storage does not throw out of the script', !threw2, threw2 && String(threw2));
  let threw3 = null;
  try { const c = vm.createContext({ console }); c.window = c; vm.runInContext(code, c, { filename: 'migrate.js' }); } catch (e) { threw3 = e; }
  check('missing localStorage does not throw out of the script', !threw3, threw3 && String(threw3));
}

// ------------------------------------------------------------ play/import.html: the receiver (M5) under a stub DOM
// Runs migrate.js and the page's inline script in one vm context with stub elements, location and history, so the
// hand-off can be driven like a player would: open the link, read the page, click.
function runImportPage(hash, storage) {
  const page = fs.readFileSync(path.join(ROOT, '..', 'import.html'), 'utf8');
  const inline = /<script>\s*([\s\S]*?)<\/script>/.exec(page)[1];
  const els = {};
  const elem = id => els[id] || (els[id] = { id, textContent: '', hidden: true, className: '', value: '', files: null, _on: {},
    addEventListener(t, f) { this._on[t] = f; }, focus() {}, click() { if (this._on.click) this._on.click(); } });
  const replaced = [];
  const location = { hash, pathname: '/play/import.html', search: '', hostname: 'portsolace.com', href: 'https://portsolace.com/play/import.html' + hash,
    replace(u) { replaced.push(u); }, assign() {}, reload() {} };
  const history = { state: null, replaceState() { location.hash = ''; } };
  const ctx = vm.createContext({ console, localStorage: storage, document: { getElementById: elem }, location, history,
    atob, TextDecoder, TextEncoder, Blob, URL, DecompressionStream: globalThis.DecompressionStream, addEventListener() {} });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'migrate.js'), 'utf8'), ctx, { filename: 'migrate.js' });
  vm.runInContext(inline, ctx, { filename: 'import.html' });
  return { el: elem, replaced };
}
const settle = () => new Promise(r => setTimeout(r, 60));
async function testImportPage() {
  sec('play/import.html: receiver (M5)');
  if (!fs.existsSync(path.join(ROOT, '..', 'import.html'))) { console.log('  skip play/import.html not present'); return; }
  const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const j = keys => '#ps-import=j.' + b64url(JSON.stringify({ v: 1, from: 'https://joshanderson051.github.io', at: 1, keys }));
  const prof = name => JSON.stringify({ activeSector: 'home', sectors: { home: { name } } });
  const EVIL = { 'waystation.account.config': '{"apiBase":"https://evil.example"}', 'waystation.store': '{"mode":"stripe","apiBase":"https://evil.example"}',
    'waystation.push': '{"apiBase":"https://evil.example"}', 'waystation.migrated.v1': '2020-01-01T00:00:00.000Z' };
  const OVERRIDES = ['portsolace.account.config', 'portsolace.store', 'portsolace.push'];

  // 1. a crafted link that carries only the config overrides writes nothing and does not open the game
  let st = makeEnumerableStorage();
  let p = runImportPage(j(EVIL), st); await settle();
  check('config-only payload: no override key is written', OVERRIDES.every(k => st.getItem(k) === null), [...st._map.keys()]);
  check('config-only payload: the game is not opened', p.replaced.length === 0, p.replaced);
  check('config-only payload: reads as nothing to move', p.el('msg').textContent === 'No station was found at the old address in this browser.', p.el('msg').textContent);

  // 2. a real station plus overrides, empty browser: nothing is written before the click, then only MOVE_KEYS
  st = makeEnumerableStorage();
  p = runImportPage(j(Object.assign({ 'waystation.profile.v2': prof('<b>Old Faithful</b>'), 'waystation.playerId': 'p_1', 'waystation.account': '{"token":"B"}' }, EVIL)), st); await settle();
  check('station payload: nothing written before a click', st.getItem('portsolace.profile.v2') === null && p.replaced.length === 0);
  check('station payload: asks with Bring it over / Cancel and shows the incoming name as text', !p.el('btn-bring').hidden && !p.el('btn-cancel').hidden && p.el('name-old').textContent === '<b>Old Faithful</b>');
  p.el('btn-bring').click();
  check('Bring it over writes the station, player id and session', st.getItem('portsolace.profile.v2') === prof('<b>Old Faithful</b>') && st.getItem('portsolace.playerId') === 'p_1' && st.getItem('portsolace.account') === '{"token":"B"}');
  check('Bring it over never writes an override key', OVERRIDES.every(k => st.getItem(k) === null));
  check('Bring it over opens the game with ?moved=1', p.replaced[0] === './?moved=1', p.replaced);

  // 3. Cancel writes nothing
  st = makeEnumerableStorage();
  p = runImportPage(j({ 'waystation.profile.v2': prof('Old') }), st); await settle();
  p.el('btn-cancel').click();
  check('Cancel writes nothing and stays put', st.getItem('portsolace.profile.v2') === null && p.replaced.length === 0);

  // 4. a sign-in already here is kept unless the player chose Replace
  st = makeEnumerableStorage({ 'portsolace.account': '{"token":"A"}', 'portsolace.migrated.v1': 'x' });
  p = runImportPage(j({ 'waystation.profile.v2': prof('Old'), 'waystation.account': '{"token":"B"}' }), st); await settle();
  p.el('btn-bring').click();
  check('Bring it over keeps a different sign-in already here', st.getItem('portsolace.account') === '{"token":"A"}' && st.getItem('portsolace.profile.v2') === prof('Old'));

  // 5. a different station here: both names, Keep this one changes nothing, Replace takes everything
  const here = { 'portsolace.profile.v2': prof('Here'), 'portsolace.account': '{"token":"A"}', 'portsolace.migrated.v1': 'x' };
  const incoming = j({ 'waystation.profile.v2': prof('Old'), 'waystation.account': '{"token":"B"}' });
  st = makeEnumerableStorage(here);
  p = runImportPage(incoming, st); await settle();
  check('conflict shows both station names', p.el('name-here').textContent === 'Here' && p.el('name-old').textContent === 'Old' && !p.el('btn-replace').hidden && !p.el('btn-keep').hidden);
  p.el('btn-keep').click();
  check('Keep this one changes nothing', st.getItem('portsolace.profile.v2') === prof('Here') && st.getItem('portsolace.account') === '{"token":"A"}' && p.replaced.length === 0);
  st = makeEnumerableStorage(here);
  p = runImportPage(incoming, st); await settle();
  p.el('btn-replace').click();
  check('Replace writes the incoming station and session', st.getItem('portsolace.profile.v2') === prof('Old') && st.getItem('portsolace.account') === '{"token":"B"}' && p.replaced[0] === './?moved=1');

  // 6. the gzip form and the rejects
  if (typeof globalThis.CompressionStream === 'function') {
    const gz = require('zlib').gzipSync(Buffer.from(JSON.stringify({ v: 1, keys: { 'waystation.profile.v2': prof('Zipped') } }), 'utf8'));
    st = makeEnumerableStorage();
    p = runImportPage('#ps-import=g.' + gz.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), st); await settle();
    check('g. payload decodes and asks', p.el('name-old').textContent === 'Zipped' && !p.el('btn-bring').hidden);
  }
  st = makeEnumerableStorage();
  p = runImportPage(j({ 'waystation.profile.v2': prof('Old'), 'other.key': 'x' }), st); await settle();
  check('a key outside waystation… rejects the whole payload', p.el('head').textContent === 'The station could not be moved' && st._map.size === 1);
}

// ------------------------------------------------------------ js/gifts.js: presence and Port Authority gifts (A9, spec section 4)
// Runs gifts.js alone in a vm context with a fake fetch, a minimal Meta, a stub Overlays and a stub DOM whose nodes
// record every textContent and innerHTML write, so "the note is text" can be asserted directly.
const GIFTS_BASE = 'https://account.example.test';
function makeGiftsWorld(o = {}) {
  const storage = o.storage || makeStorage();
  const clock = { now: START };
  const calls = [], nodes = [], modals = [], listeners = {};
  const respond = o.respond || (() => ({ status: 200, json: { ok: true, gifts: [] } }));
  const fetch = async (url, init) => {
    const call = { url, method: init && init.method, headers: { ...((init && init.headers) || {}) }, body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const r = respond(call, calls);
    if (r === 'offline') throw new TypeError('Failed to fetch');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
  };
  const node = tag => {
    const n = { tag, className: '', children: [], _text: '', htmlSets: [], textSets: [],
      appendChild(c) { this.children.push(c); return c; },
      set textContent(v) { this._text = String(v); this.textSets.push(String(v)); this.children = []; },
      get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
      set innerHTML(v) { this.htmlSets.push(String(v)); this.children = []; this._text = ''; },
      get innerHTML() { return this.htmlSets.length ? this.htmlSets[this.htmlSets.length - 1] : ''; } };
    nodes.push(n); return n;
  };
  let modalText = node('div');
  const doc = {
    hidden: false, readyState: 'complete',
    body: { getAttribute: () => null },
    querySelector: sel => (sel === 'meta[name="portsolace-account"]' && o.apiBase !== '' ? { getAttribute: () => JSON.stringify({ apiBase: o.apiBase == null ? GIFTS_BASE : o.apiBase }) } : null),
    addEventListener: (evt, fn) => { (listeners[evt] ||= []).push(fn); },
    createElement: tag => node(tag),
    getElementById: id => (id === 'modal-text' ? modalText : null),
  };
  const hist = (o.history || []).slice();
  const M = {
    profile: { playerId: o.playerId || 'p_test_player_1', credits: 6000, am: 20, activeSector: 'home', unlocked: ['home', 'aurelia'], rank: { level: 3 },
      sectors: { home: { name: 'Kestrel Deep', day: 12, level: 4 } }, entitlements: { owned: {}, history: hist } },
    saves: 0, log: [],
    get credits() { return this.profile.credits; },
    addCredits(n, reason) { this.profile.credits += n; this.log.push(['credits', n, reason]); return this.profile.credits; },
    addAM(n, reason) { this.profile.am += n; this.log.push(['am', n, reason]); return this.profile.am; },
    grantEntitlement(sku, payload) { this.profile.entitlements.history.push({ sku, ...payload }); this.profile.entitlements.owned[sku] = true; return true; },
    save() { this.saves++; },
  };
  const Ov = {
    modal(opts) { modals.push(opts); modalText = node('div'); modalText.innerHTML = opts.html || ''; },
    anyOpen: () => false,
    rewardChips: r => [r.credits ? `<span class="rchip amber"><i class="ic-credits"></i><span>${r.credits} cr</span></span>` : '', r.am ? `<span class="rchip am"><i class="ic-antimatter"></i><span>${r.am} AM</span></span>` : ''].join(''),
  };
  const ctx = vm.createContext({ console, localStorage: storage, fetch, document: doc, Meta: M, Overlays: Ov, setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
  if (o.account) ctx.Account = o.account;
  ctx.window = ctx;
  vm.runInContext('Date', ctx).now = () => clock.now;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gifts.js'), 'utf8'), ctx, { filename: 'gifts.js' });
  const Gifts = vm.runInContext('Gifts', ctx);
  const visibility = hidden => { doc.hidden = hidden; for (const fn of listeners.visibilitychange || []) fn(); };
  return { Gifts, ctx, M, calls, nodes, modals, clock, doc, storage, visibility, get modalText() { return modalText; } };
}

async function testGifts() {
  sec('18. Gifts (A9): presence and Port Authority gifts (js/gifts.js)');
  const presences = W => W.calls.filter(c => c.url.endsWith('/presence'));
  const acks = W => W.calls.filter(c => c.url.endsWith('/gifts/ack'));
  const gift = (id, credits, am, note) => ({ id, credits, am, note: note || '', createdAt: START - 1000 });
  const settle = () => new Promise(r => setImmediate(r));

  // presence body shape and the Bearer rule
  let W = makeGiftsWorld();
  check('exposes Gifts.init, checkNow, state and window.Gifts', typeof W.Gifts.init === 'function' && typeof W.Gifts.checkNow === 'function' && typeof W.Gifts.state === 'object' && W.ctx.window.Gifts === W.Gifts);
  let r = await W.Gifts.checkNow();
  const p0 = W.calls[0];
  check('presence: one POST to {apiBase}/presence', r.ok && W.calls.length === 1 && p0.url === GIFTS_BASE + '/presence' && p0.method === 'POST' && /application\/json/.test(p0.headers['content-type']), W.calls.map(c => c.url));
  check('presence body: exactly playerId, summary, platform, version', p0.body && Object.keys(p0.body).sort().join() === 'platform,playerId,summary,version', p0.body);
  check('summary: name, day, level, rank, credits, am, sectors from the profile', JSON.stringify(Object.keys(p0.body.summary).sort()) === JSON.stringify(['am', 'credits', 'day', 'level', 'name', 'rank', 'sectors']) &&
    p0.body.playerId === 'p_test_player_1' && p0.body.summary.name === 'Kestrel Deep' && p0.body.summary.day === 12 && p0.body.summary.level === 4 && p0.body.summary.rank === 3 &&
    p0.body.summary.credits === 6000 && p0.body.summary.am === 20 && p0.body.summary.sectors === 2 && Object.values(p0.body.summary).slice(1).every(Number.isInteger), p0.body.summary);
  check('platform is phone or desktop, version is a string', ['phone', 'desktop'].includes(p0.body.platform) && typeof p0.body.version === 'string', p0.body);
  check('no Account: no Authorization header', !('authorization' in p0.headers));
  check('no gifts: no ack, no modal', acks(W).length === 0 && W.modals.length === 0);

  const st = makeStorage(); st.setItem('portsolace.account', JSON.stringify({ token: 'tok_signed_in', email: 'a@b.co' }));
  W = makeGiftsWorld({ storage: st, account: { state: { signedIn: true }, config: { apiBase: GIFTS_BASE } } });
  await W.Gifts.checkNow();
  check('signed in: Bearer token from Account\'s stored session', W.calls[0].headers.authorization === 'Bearer tok_signed_in', W.calls[0].headers);
  W = makeGiftsWorld({ storage: st, account: { state: { signedIn: false }, config: { apiBase: GIFTS_BASE } } });
  await W.Gifts.checkNow();
  check('a stored token while Account is signed out is not sent', W.calls.length === 1 && !('authorization' in W.calls[0].headers));
  W = makeGiftsWorld({ account: { state: { signedIn: false }, config: { apiBase: 'https://other.example.test/' } } });
  await W.Gifts.checkNow();
  check('uses Account\'s parsed apiBase (trailing slash dropped)', W.calls[0].url === 'https://other.example.test/presence', W.calls[0].url);

  // a gift is applied once, recorded, saved, acked and shown
  const g1 = gift('gft_AAAAAAAAAAAAAAAAAAAAAA', 25000, 75, 'Thanks for testing the gate.');
  W = makeGiftsWorld({ respond: c => (c.url.endsWith('/presence') ? { status: 200, json: { ok: true, gifts: [g1] } } : { status: 200, json: { ok: true, acked: 1 } }) });
  r = await W.Gifts.checkNow();
  const h1 = W.M.profile.entitlements.history.filter(h => h.grantId === g1.id);
  check('gift applied: credits and AM added through Meta with reason gift', W.M.profile.credits === 31000 && W.M.profile.am === 95 && W.M.log.some(l => l[0] === 'credits' && l[1] === 25000 && l[2] === 'gift') && W.M.log.some(l => l[0] === 'am' && l[1] === 75 && l[2] === 'gift'), W.M.log);
  check('history records {sku gift, grantId, mode gift, at, granted, note}', h1.length === 1 && h1[0].sku === 'gift' && h1[0].mode === 'gift' && h1[0].at === START && h1[0].granted.credits === 25000 && h1[0].granted.am === 75 && h1[0].note === g1.note, h1);
  check('profile saved after applying', W.M.saves >= 1);
  check('ack: POST /gifts/ack {playerId, ids:[id]}', acks(W).length === 1 && acks(W)[0].body.playerId === 'p_test_player_1' && JSON.stringify(acks(W)[0].body.ids) === JSON.stringify([g1.id]), acks(W).map(a => a.body));
  check('checkNow reports applied and acked', r.ok && r.acked && JSON.stringify(r.applied) === JSON.stringify([g1.id]), r);
  check('one modal: tag Port Authority, the crew title', W.modals.length === 1 && W.modals[0].tag === 'Port Authority' && W.modals[0].title === 'A gift from the Port Solace crew', W.modals.map(m => m.title));
  check('modal shows the amounts with the credit and Antimatter chips', W.nodes.some(n => n.className === 'chips' && /ic-credits[\s\S]*25000 cr/.test(n.innerHTML) && /ic-antimatter[\s\S]*75 AM/.test(n.innerHTML)) && W.modalText.textContent.includes(g1.note));
  r = await W.Gifts.checkNow();
  check('same gift delivered again: not re-applied, acked again, no second modal', W.M.profile.credits === 31000 && W.M.profile.am === 95 && W.M.profile.entitlements.history.filter(h => h.grantId === g1.id).length === 1 &&
    acks(W).length === 2 && JSON.stringify(r.already) === JSON.stringify([g1.id]) && W.modals.length === 1, r);

  // a gift already in the history is acked but not applied
  const old = gift('gft_BBBBBBBBBBBBBBBBBBBBBB', 9000, 9);
  const g2 = gift('gft_CCCCCCCCCCCCCCCCCCCCCC', 0, 40, 'Second one');
  W = makeGiftsWorld({ history: [{ sku: 'gift', grantId: old.id, mode: 'gift', at: START - 5000, granted: { credits: 9000, am: 9 } }],
    respond: c => (c.url.endsWith('/presence') ? { status: 200, json: { ok: true, gifts: [old, g2] } } : { status: 200, json: { ok: true } }) });
  r = await W.Gifts.checkNow();
  check('already-applied gift: no credits, not recorded twice', W.M.profile.credits === 6000 && W.M.profile.entitlements.history.filter(h => h.grantId === old.id).length === 1);
  check('the new gift alongside it is applied (AM only)', W.M.profile.am === 60 && W.M.profile.entitlements.history.some(h => h.grantId === g2.id) && !W.M.log.some(l => l[0] === 'credits'), W.M.log);
  check('one ack carrying both the applied and the already-applied id', acks(W).length === 1 && [...acks(W)[0].body.ids].sort().join() === [g2.id, old.id].sort().join(), acks(W).map(a => a.body));
  check('the modal lists only the new gift', W.modals.length === 1 && W.nodes.filter(n => n.className === 'gift').length === 1);
  W = makeGiftsWorld({ history: [{ sku: 'gift', grantId: old.id }], respond: c => (c.url.endsWith('/presence') ? { status: 200, json: { ok: true, gifts: [old] } } : { status: 200, json: { ok: true } }) });
  await W.Gifts.checkNow();
  check('only already-applied gifts: acked, no modal', acks(W).length === 1 && W.modals.length === 0 && W.M.saves === 0);

  // ack fails, the next presence re-delivers: no double grant
  const g3 = gift('gft_DDDDDDDDDDDDDDDDDDDDDD', 1000, 5);
  let ackStatus = 500;
  W = makeGiftsWorld({ respond: c => (c.url.endsWith('/presence') ? { status: 200, json: { ok: true, gifts: [g3] } } : { status: ackStatus, json: ackStatus === 200 ? { ok: true } : { error: 'server' } }) });
  r = await W.Gifts.checkNow();
  check('ack failure: gift applied once, ack reported failed, id kept as unacked', !r.acked && W.M.profile.credits === 7000 && W.M.profile.am === 25 && W.Gifts.state.unacked.includes(g3.id), { r, st: W.Gifts.state });
  ackStatus = 200;
  r = await W.Gifts.checkNow();
  check('re-delivery after a failed ack: not applied again, acked now', r.acked && W.M.profile.credits === 7000 && W.M.profile.am === 25 && W.M.profile.entitlements.history.filter(h => h.grantId === g3.id).length === 1 && W.Gifts.state.unacked.length === 0 && W.modals.length === 1, { r, st: W.Gifts.state });
  W = makeGiftsWorld({ respond: c => (c.url.endsWith('/presence') ? { status: 200, json: { ok: true, gifts: [g3] } } : 'offline') });
  r = await W.Gifts.checkNow();
  check('an offline ack is silent and the gift stays applied once', r.ok && !r.acked && W.M.profile.credits === 7000);

  // lost ack, then the admin revokes: presence no longer offers the gift, but the next check-in still sends the ack
  const g4 = gift('gft_GGGGGGGGGGGGGGGGGGGGGG', 0, 3);
  let offer = [g4], ackOk = false;
  W = makeGiftsWorld({ respond: c => (c.url.endsWith('/presence') ? { status: 200, json: { ok: true, gifts: offer } } : ackOk ? { status: 200, json: { ok: true, acked: c.body.ids } } : 'offline') });
  r = await W.Gifts.checkNow();
  const h4 = () => W.M.profile.entitlements.history.find(h => h.grantId === g4.id);
  check('a new gift is recorded with acked:false until the ack succeeds', !r.acked && W.M.profile.am === 23 && h4() && h4().acked === false, h4());
  offer = []; ackOk = true;                                    // the admin revoked it: /presence returns nothing
  const savesBefore = W.M.saves;
  r = await W.Gifts.checkNow();
  check('lost ack + revoke: the next check-in (no gifts offered) re-sends the ack', acks(W).length === 2 && JSON.stringify(acks(W)[1].body.ids) === JSON.stringify([g4.id]) && r.acked, acks(W).map(a => a.body));
  check('after the ack the history entry is marked acked and saved; no second grant', h4().acked === true && W.M.saves > savesBefore && W.M.profile.am === 23 && W.Gifts.state.unacked.length === 0, { h: h4(), st: W.Gifts.state });
  await W.Gifts.checkNow();
  check('nothing outstanding: no further ack', acks(W).length === 2);

  // outstanding acks survive a reload: they come from the stored history, not only memory
  W = makeGiftsWorld({ history: [{ sku: 'gift', grantId: g4.id, mode: 'gift', at: START - 5000, granted: { credits: 0, am: 3 }, acked: false }],
    respond: c => (c.url.endsWith('/presence') ? { status: 200, json: { ok: true, gifts: [] } } : { status: 200, json: { ok: true, acked: [] } }) });
  r = await W.Gifts.checkNow();
  check('after a reload, a history gift still marked acked:false is acked on the first check-in', acks(W).length === 1 && JSON.stringify(acks(W)[0].body.ids) === JSON.stringify([g4.id]) && W.M.profile.entitlements.history[0].acked === true && W.M.profile.am === 20, acks(W).map(a => a.body));

  // a failed profile save: applied in memory, never acked, so the server keeps offering it
  const g5 = gift('gft_HHHHHHHHHHHHHHHHHHHHHH', 400, 0);
  let saveWorks = false;
  W = makeGiftsWorld({ respond: c => (c.url.endsWith('/presence') ? { status: 200, json: { ok: true, gifts: [g5] } } : { status: 200, json: { ok: true, acked: c.body.ids } }) });
  W.M.save = function () { this.saves++; return saveWorks; };
  r = await W.Gifts.checkNow();
  check('save failed (storage full): the gift is not acked', acks(W).length === 0 && r.saved === false && !r.acked && W.Gifts.state.unacked.includes(g5.id) && W.M.profile.credits === 6400, { r, st: W.Gifts.state });
  r = await W.Gifts.checkNow();
  check('still failing: re-offered, not granted twice, still not acked', acks(W).length === 0 && W.M.profile.credits === 6400 && W.M.profile.entitlements.history.filter(h => h.grantId === g5.id).length === 1, { r });
  saveWorks = true;
  r = await W.Gifts.checkNow();
  check('once a save succeeds the gift is acked', acks(W).length === 1 && JSON.stringify(acks(W)[0].body.ids) === JSON.stringify([g5.id]) && r.acked && W.M.profile.credits === 6400 && W.Gifts.state.unacked.length === 0, { r, st: W.Gifts.state });

  // the note is untrusted: text only
  const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
  W = makeGiftsWorld({ respond: c => (c.url.endsWith('/presence') ? { status: 200, json: { ok: true, gifts: [gift('gft_EEEEEEEEEEEEEEEEEEEEEE', 10, 0, evil), gift('gft_FFFFFFFFFFFFFFFFFFFFFF', 0, 1, 'plain')] } } : { status: 200, json: {} }) });
  await W.Gifts.checkNow();
  const noteNode = W.nodes.find(n => n.className === 'gift-note' && n._text === evil);
  check('a note with HTML is set through textContent, verbatim', !!noteNode && noteNode.textSets.includes(evil));
  check('no innerHTML write and no modal option carries the note', W.nodes.every(n => n.htmlSets.every(h => !h.includes('<img') && !h.includes('<b>'))) && W.modals.every(m => !JSON.stringify(m).includes('onerror')));
  check('two gifts at once: one modal listing both', W.modals.length === 1 && W.nodes.filter(n => n.className === 'gift').length === 2);

  // unconfigured, offline, no player id: no requests or silence
  W = makeGiftsWorld({ apiBase: '' });
  r = await W.Gifts.checkNow();
  W.Gifts.init(); await settle();
  check('no apiBase: no requests at all (checkNow and init)', W.calls.length === 0 && !r.ok && r.why === 'unconfigured', r);
  W = makeGiftsWorld({ apiBase: 'not a url' });
  await W.Gifts.checkNow();
  check('a non-http apiBase counts as unconfigured', W.calls.length === 0);
  W = makeGiftsWorld({ respond: () => 'offline' });
  let threw = null;
  try { r = await W.Gifts.checkNow(); } catch (e) { threw = e; }
  check('offline presence fails silently', !threw && !r.ok && r.why === 'offline' && W.Gifts.state.lastOk === false && W.modals.length === 0, r);
  W = makeGiftsWorld({ respond: () => ({ status: 200, json: { ok: true, gifts: [{ id: '<x>', credits: 5 }, null, 'gft_x'] } }) });
  await W.Gifts.checkNow();
  check('malformed gift entries are ignored and never acked', W.M.profile.credits === 6000 && acks(W).length === 0);
  W = makeGiftsWorld({ playerId: 'short' });
  await W.Gifts.checkNow();
  check('an invalid player id sends nothing', W.calls.length === 0);

  // cadence: boot, then on becoming visible after 10+ minutes hidden
  W = makeGiftsWorld();
  W.Gifts.init(); await settle();
  check('init sends presence on boot', presences(W).length === 1 && W.Gifts.state.started);
  W.Gifts.init(); await settle();
  check('init is idempotent', presences(W).length === 1);
  W.visibility(true); W.clock.now += 2 * MIN; W.visibility(false); await settle();
  check('visible again after 2 minutes hidden: no extra check-in', presences(W).length === 1);
  W.visibility(true); W.clock.now += 11 * MIN; W.visibility(false); await settle();
  check('visible again after 11 minutes hidden: one check-in', presences(W).length === 2);
}

// ============================================================ run
(async function main() {
  console.log(`Port Solace v2 sim-test  (${FILES.join(', ')})`);
  const tests = [testNewProfileAndTutorial, testHoppers, testOffline, testExpeditions, testMissions, testDaily, testRanks, testSectors, testExportImportAndReset, testMigration, testV1Sim, testStore, testConvoyAndMisc, testShippedPreset, testPlots, testAchievements, testLiveries, testMigrateScript, testImportPage, testGifts];
  for (const t of tests) {
    try { await t(); } catch (e) { results.fail++; results.failures.push(`${t.name}: threw ${e && e.stack}`); console.log(`  THREW ${e && e.stack}`); }
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

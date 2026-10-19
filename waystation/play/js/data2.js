// ============================================================
// WAYSTATION v2 — meta-game data: sectors, missions, collection,
// expeditions, daily rewards, ranks, store catalog, timers
// Engineer S. Source of truth: DESIGN2.md sections 4, 6, 7.1.
// Loads after data.js and before sim.js (0.1).
// ============================================================
'use strict';

// ------------------------------------------------------------
// TUNING RECORD (every number that differs from the DESIGN2.md defaults,
// why, and how to revert). Measured with play/dev/sim-test.js.
//
// 1. The live economy and the clock (new knobs, not in the spec).
//    Measured v1 at speed 1: a 3-module station serves ~1.4 ships per game day
//    (one game day = 6 s) and nets ~1,000 cr per game day, i.e. ~11,600 cr per
//    real minute and ~170,000 cr per 15-minute session. The spec's banks
//    (rate = cost/40 per minute: dock 20, warehouse 15, hub 10 -> 53 cr/min for
//    that station) would be 0.5% of income, and the sector costs (18,000 ..
//    400,000) would all fall inside the first day. No +/-30% change to rates or
//    costs can bridge a 200x gap, so two knobs scale the LIVE half down to the
//    order of the come-back half, as 4.2 intends ("the live half ... banks are
//    the come-back half"):
//      TIMERS.DAY_MS  6,000 -> 24,000  one game day takes 24 s at speed 1
//                                     (ships per real minute / 4; the spec's
//                                     "1 game day per 6 s" in 4.2 becomes 24 s;
//                                     Sim.catchUp caps at 2 h = 300 game days)
//      ECON.live      1 -> 0.06        multiplier on every live credit flow and
//                                     on ship holds: docking fees, fuel, repairs,
//                                     cargo units carried, tariffs, rent, crew
//                                     spending, menagerie, office leases, upkeep,
//                                     event cash. Module costs, bank rates, goods
//                                     prices per unit and sector costs are
//                                     untouched, so a freighter now pays ~80 cr
//                                     and a full dock bank pays 1,200.
//      ECON.shipSpeed 22 -> 60 cells/game day so ships still cross the screen in
//                                     a few seconds with the longer day.
//    Revert: TIMERS.DAY_MS = 6000; ECON.live = 1; ECON.shipSpeed = 22.
//
//    Event cash (explorer +600, pirate losses) and loans are player-scale one-offs
//    and stay unscaled.
//
// 2. Spec numbers kept at their defaults: level multipliers 1.6/2.4, build
//    times 45 s / 4 min / 15 min / 60 min, skip = ceil(minutes/8) AM, upgrade
//    costs 2x/5x, expedition cost 400 x (1 + 0.5 x index), durations
//    10..120 min, loot odds, daily rewards, rank thresholds. The bank rate
//    divisor, the bank caps and the sector credit costs come from the shipped
//    pacing preset (record 4); the DESIGN2 values are PACING_PRESETS.spec.
//
// 3. Interpretation notes (no number changed):
//    - 4.7 says three missions are active; 4.9 says rank 4 "grants a third
//      mission slot". Implemented: 3 slots from the start, Commodore adds a 4th.
//    - Loot "chart guaranteed on the third run": every third claimed run to a
//      sector always carries a chart (runs 3, 6, 9 ...).
//    - A module keeps running at its current level while it upgrades (the
//      scaffold shows, but berths and beds stay in service).
//    - Offline: gaps under 60 s settle timers but emit no `offline` event.
//
// 4. PACING: THE GAME SHIPS WITH PACING_PRESET = 'patient' (Addendum A1.1,
//    owner's brief 2026-10-19: Clash of Clans / DragonVale pacing; people log
//    back in to check on it; Antimatter is the only accelerator).
//      build times 90 s / 12 min / 60 min / 4 h (first three builds instant),
//              far sectors x1.5; upgrades L2 = 2x and L3 = 5x the build time
//      banks rate = cost/150 per minute (dock 5, warehouse 4, reactor 20,
//              gate 80, hub 3), caps 180 / 240 / 360 minutes of rate,
//              offline accrual cap 24 h
//      expeditions 30 min, 1 h, 2 h, 4 h, 6 h, 8 h, 12 h, 24 h by sector
//      DAY_MS 48,000 (one game day = 48 s), shipSpeed 40 cells/day,
//              speed clamped to 0 or 1 (2x / 4x removed)
//      skip cost unchanged: max(1, ceil(remainingMinutes / 8)) AM
//      sector costs recalibrated by the pacing bot (3 x 15 min a day; targets
//              sable d2-3, kessler d4-5, thessaly d8-10, marrow d13-15,
//              oros d18-22, keth d24-28, aurelia d32-40): shipped
//              sable 90k, kessler 300k, thessaly 1.1M, marrow 1.2M,
//              oros 1.5M, keth 3M, aurelia 5.5M. Measured with them (the
//              table `node play/dev/sim-test.js` prints): sable d2 20h,
//              kessler d4 08h, thessaly d9 08h, marrow d14 20h, oros d21 20h,
//              keth d27 08h, aurelia d36 08h; station L4 on d22; the home plot
//              fully cleared on day 2; ~19M credits gross over 40 days, 89%
//              of it from banks. Brackets tried on the way: the DESIGN2 costs
//              (everything by day 3), x2 of the first draft (oros d18, keth
//              d25, aurelia d38 but kessler d3 / thessaly d6 / marrow d10).
//    History: the DESIGN2 numbers (PACING_PRESETS.spec: rate cost/40, caps
//    60/90/120, costs 18k..400k) unlock every sector by day 3 and bank 39M in
//    25 days; the v2.0 'slow' preset (cost/120, caps 60/75/90, costs 30k..3M)
//    landed sable d1 20h, thessaly d3 20h, aurelia d24 20h. Both stay
//    selectable for comparison; the harness asserts the DESIGN2 formulas under
//    'spec' and prints the pacing table for the shipped preset.
//
// 5. v2.1 additions (A1.2, A1.3): PLOT / plotRings (territory), ACHIEVEMENTS
//    (24, three tiers each). Two missions were added for the plot (50 total):
//    Commissioning "Clear your first ring" (+5 AM, so the tutorial now pays
//    35 AM) and Town "Clear ring 4". Achievements: 12 named stat ones, four
//    station-tier ones tiered by how many sectors reach the tier (1 / 3 / 8),
//    three rank milestones tiered by rank (2-4, 5-7, 8-10) and five more
//    lifetime stats, so every entry has bronze / silver / gold.
// ------------------------------------------------------------

// ------------------------------------------------------------ 4.3 / 4.2 timers and economy knobs (A1.1 presets)
const PACING_PRESET = 'patient';              // SHIPPED: 'patient' (A1.1). 'slow' = v2.0 curve, 'spec' = the DESIGN2 numbers, for comparison.
const PACING_PRESETS = {
  spec: { rateDivisor: 40, capMinutes: [60, 90, 120], buildMs: { 0: 0, 1: 45e3, 2: 240e3, 3: 900e3, 4: 3600e3 }, upgradeTimeMul: [2, 2], offlineBankCapH: 12,
    expeditionMinutes: [10, 20, 35, 50, 60, 75, 90, 120], dayMs: 24000, shipSpeed: 60, speeds: [0, 1, 2, 4],
    sectorCosts: { sable: 18000, kessler: 30000, thessaly: 60000, marrow: 75000, oros: 120000, keth: 200000, aurelia: 400000 } },
  slow: { rateDivisor: 120, capMinutes: [60, 75, 90], buildMs: { 0: 0, 1: 45e3, 2: 240e3, 3: 900e3, 4: 3600e3 }, upgradeTimeMul: [2, 2], offlineBankCapH: 12,
    expeditionMinutes: [10, 20, 35, 50, 60, 75, 90, 120], dayMs: 24000, shipSpeed: 60, speeds: [0, 1, 2, 4],
    sectorCosts: { sable: 30000, kessler: 45000, thessaly: 240000, marrow: 320000, oros: 600000, keth: 1200000, aurelia: 3000000 } },
  patient: { rateDivisor: 150, capMinutes: [180, 240, 360], buildMs: { 0: 0, 1: 90e3, 2: 720e3, 3: 3600e3, 4: 14400e3 }, upgradeTimeMul: [2, 5], offlineBankCapH: 24,
    expeditionMinutes: [30, 60, 120, 240, 360, 480, 720, 1440], dayMs: 48000, shipSpeed: 40, speeds: [0, 1],
    sectorCosts: { sable: 90000, kessler: 300000, thessaly: 1100000, marrow: 1200000, oros: 1500000, keth: 3000000, aurelia: 5500000 } },
};
// Override hook for experiments (the harness uses it; a page may define window.WAYSTATION_TUNING before data2.js):
// { preset, dayMs, live, rateDivisor, capMinutes, buildMs, upgradeTimeMul, offlineBankCapH, expeditionMinutes, shipSpeed, speeds, sectorCostMul, sectorCosts }.
const TUNING = (() => {
  const ext = (typeof WAYSTATION_TUNING !== 'undefined' && WAYSTATION_TUNING) || {};
  return Object.assign({}, PACING_PRESETS[ext.preset || PACING_PRESET] || PACING_PRESETS.patient, ext);
})();

const TIMERS = {
  DAY_MS: TUNING.dayMs,                        // real ms per game day at speed 1 (tuning records 1 and 4)
  BUILD_MS: TUNING.buildMs,                    // by tier
  BUILD_MUL_FAR: 1.5,                          // sectors 5-8 (index >= 4)
  UPGRADE_TIME_MUL: TUNING.upgradeTimeMul,     // [to level 2, to level 3] x build time
  TUTORIAL_INSTANT_BUILDS: 3,                  // first three tier-1 builds of a brand-new profile
  SKIP_MINUTES_PER_AM: 8,                      // skipAM = max(1, ceil(remainingMinutes / 8))
  CAP_MINUTES: TUNING.capMinutes,              // bank cap in minutes of rate, by level
  RATE_MUL: [1, 1.6, 2.4],                     // bank rate multiplier by level
  SPEEDS: TUNING.speeds,                       // allowed Sim.state.speed values (A1.1: 0 or 1)
  OFFLINE_BANK_CAP_MS: TUNING.offlineBankCapH * 3600e3,   // banks accrue for at most this long away
  OFFLINE_SIM_CAP_MS: 2 * 3600e3,              // the active sector simulates at most 2 h away
  OFFLINE_MIN_MS: 60e3,                        // shorter absences are a reload, not an "away"
  AUTOSAVE_MS: 10e3,
  MISSION_EVAL_MS: 250,
  STREAK_REPAIR_MS: 48 * 3600e3,
  STREAK_REPAIR_AM: 5,
  CONVOY_PERIOD_MS: 7 * 86400e3,               // 4.11 weekly convoy
  CONVOY_WINDOW_MS: 48 * 3600e3,
  CONVOY_TRAFFIC: 1.5,
  RIFT: { enabled: false, periodMs: 30 * 86400e3, windowMs: 72 * 3600e3 },   // 4.11 reserved
  START_AM: 20,
  START_CREDITS: 6000,
  RELIEF_CONVOY: { am: 10, minutes: 30 },      // 4.4 emergency credits
};

const ECON = {
  live: TUNING.live != null ? TUNING.live : 0.06,   // live-economy multiplier (tuning record 1)
  rateDivisor: TUNING.rateDivisor,             // 4.2 rate = round(cost / divisor) per real minute
  sectorCostMul: TUNING.sectorCostMul || 1,    // multiplier on SECTORS[*].unlock.credits
  shipSpeed: TUNING.shipSpeed,                 // cells per game day
  upgradeModuleWeight: 0.5,                    // 4.3 each upgrade level counts as half a module
  rankRateBonus: 0.05,                         // 4.9 Admiral of the Reach
  xp: { creditsPerXP: 100, served: 5, expedition: 20, discovery: 15, levelUp: 100 },
  rankAMPerLevel: 10,                          // 4.4 rank-ups pay 10 x level AM
};

// ------------------------------------------------------------ MODULES extension (0.8: rate, cap, buildMs, upgrade)
const UPGRADE_EFFECTS = {
  dock: { dockTime: [1, 0.85, 0.70] },         // service time multiplier by level
  capacity: { capacity: [1, 1.25, 1.5] },      // beds / homes
  power: { power: [1, 1.25, 1.5] },
};
(function extendModules() {
  const kind = { dock: 'dock', quarters: 'capacity', habitat: 'capacity', solar: 'power', reactor: 'power' };
  for (const id in MODULES) {
    const d = MODULES[id];
    const rate = id === 'hub' ? Math.max(1, Math.round(10 * 40 / ECON.rateDivisor)) : Math.round(d.cost / ECON.rateDivisor);
    Object.assign(d, {
      rate,                                    // credits per real minute at level 1
      cap: rate * TIMERS.CAP_MINUTES[0],       // bank cap at level 1
      buildMs: TIMERS.BUILD_MS[d.tier] || 0,
      upgrade: id === 'hub' ? null : { costMul: [2, 5], rateMul: TIMERS.RATE_MUL, capMinutes: TIMERS.CAP_MINUTES, kind: kind[id] || null },
    });
  }
})();

// ------------------------------------------------------------ 4.5 sectors
// theme: read by the engine (space.js). planet.kind: terrestrial | dust | none | ocean | volcanic | gas | garden | dwarf
const SECTORS = {
  home: {
    id: 'home', index: 0, name: 'Varro Reach', planet: 'Temperate amber-ivory world', grid: { cols: 15, rows: 9 },
    flavour: 'Balanced lanes under a quiet amber sun. Every commander starts here.',
    bias: { goods: {}, events: {}, companies: {}, residents: 1, rent: 1, refinery: 1, fuel: 1, gate: 1, traffic: 1 },
    unlock: { level: 1, credits: 0, charts: 0, am: null, pass: false },
    expedition: { minutes: 10, cost: 400 }, buildMul: 1,
    lootGoods: ['ore', 'crystals', 'grain'],
    names: ['Halfway Point', 'Lantern Reach', 'Threshold', 'Far Harbor', 'The Crossing', 'Vigil', 'Anchorage Nine', 'Lodestar'],
    theme: { planet: { kind: 'terrestrial', color: '#C9A86A', rim: '#FFE2A8', bands: true, caps: true }, nebula: ['#3B2A14', '#5A3A1C', '#1C2440'], stars: { count: 1400, tint: '#FFF4E0' }, light: { angle: -0.7, color: '#FFF1D6' } },
  },
  sable: {
    id: 'sable', index: 1, name: 'Sable Drift', planet: 'Ochre dust world, storms', grid: { cols: 15, rows: 9 },
    flavour: 'Dust storms the size of continents. Ore and alloy move at a premium; solar flares come twice as often.',
    bias: { goods: { ore: 1.4, alloy: 1.4 }, events: { flare: 2 }, companies: { kestrel: 1.5, halvorsen: 1.5 }, residents: 1, rent: 1, refinery: 1, fuel: 1, gate: 1, traffic: 1 },
    unlock: { level: 2, credits: 18000, charts: 0, am: 60, pass: false },
    expedition: { minutes: 20, cost: 600 }, buildMul: 1,
    lootGoods: ['ore', 'alloy', 'tech'],
    names: ['Dustfall', 'Ochre Anchor', 'Stormwatch', 'Sable Landing', 'Grit Harbor', 'The Sieve', 'Dunecrest', 'Red Lantern'],
    theme: { planet: { kind: 'dust', color: '#B5733A', rim: '#F2B27A', bands: true, caps: false, storms: true }, nebula: ['#4A2A12', '#6B3B1E', '#2A1A22'], stars: { count: 1200, tint: '#FFE6C8' }, light: { angle: -0.4, color: '#FFD9A8' } },
  },
  kessler: {
    id: 'kessler', index: 2, name: 'Kessler Belt', planet: 'No planet, asteroid field', grid: { cols: 17, rows: 9 },
    flavour: 'A belt of broken moons. Pure mining: no one settles here, but refineries run half again as hard.',
    bias: { goods: { ore: 1.3, crystals: 1.3 }, events: {}, companies: { halvorsen: 2 }, residents: 0, rent: 1, refinery: 1.5, fuel: 1, gate: 1, traffic: 1 },
    unlock: { level: 2, credits: 30000, charts: 1, am: null, pass: false },
    expedition: { minutes: 35, cost: 800 }, buildMul: 1,
    lootGoods: ['ore', 'crystals', 'alloy'],
    names: ['Kessler Station', 'Shardfall', 'Gravel Yard', 'Belt Nine', 'Rockhaven', 'The Tumble', 'Fracture', 'Cinderline'],
    theme: { planet: { kind: 'none', none: true, color: '#6B6F7A', rim: '#9AA1B0', asteroids: 120 }, nebula: ['#1C2230', '#2B3345', '#3A2E3E'], stars: { count: 1600, tint: '#E6ECFF' }, light: { angle: -1.0, color: '#DDE6FF' } },
  },
  thessaly: {
    id: 'thessaly', index: 3, name: 'Thessaly Deep', planet: 'Ocean world', grid: { cols: 15, rows: 11 },
    flavour: 'One endless sea under white swirls. Water, grain and fruit sell high, and the Tidewater liners call often.',
    bias: { goods: { water: 1.4, grain: 1.4, fruit: 1.4 }, events: {}, companies: { tidewater: 2.5 }, residents: 1, rent: 1, refinery: 1, fuel: 1, gate: 1, traffic: 1 },
    unlock: { level: 3, credits: 60000, charts: 0, am: null, pass: false },
    expedition: { minutes: 50, cost: 1000 }, buildMul: 1,
    lootGoods: ['water', 'fruit', 'xenofauna'],
    names: ['Tidewater Hold', 'Brine Harbor', 'Deepwatch', 'Saltmark', 'The Shoal', 'Pelagic', 'Wavecrest', 'Cerulean'],
    theme: { planet: { kind: 'ocean', color: '#2A6FB5', rim: '#9FDAFF', bands: false, caps: true, swirls: true }, nebula: ['#10243A', '#1B3A5A', '#0E2A33'], stars: { count: 1300, tint: '#DFF4FF' }, light: { angle: -0.8, color: '#E8F6FF' } },
  },
  marrow: {
    id: 'marrow', index: 4, name: 'Marrow Verge', planet: 'Volcanic world', grid: { cols: 15, rows: 9 },
    flavour: 'Lava seams and black glass. Fuel sells half again as high, pirates raid twice as often, Red Sand caravans run the lanes.',
    bias: { goods: {}, events: { pirates: 2 }, companies: { redsand: 2.5 }, residents: 1, rent: 1, refinery: 1, fuel: 1.5, gate: 1, traffic: 1 },
    unlock: { level: 3, credits: 75000, charts: 1, am: null, pass: false },
    expedition: { minutes: 60, cost: 1200 }, buildMul: 1.5,
    lootGoods: ['spice', 'textiles', 'ore'],
    names: ['Emberwatch', 'Blackglass', 'Marrow Gate', 'Ashfall', 'Cinder Hold', 'The Forge', 'Scoria', 'Red Verge'],
    theme: { planet: { kind: 'volcanic', color: '#2A1414', rim: '#FF6A3A', bands: false, caps: false, cracks: true }, nebula: ['#3A0F0F', '#5A1E12', '#1E0A14'], stars: { count: 1100, tint: '#FFD6C8' }, light: { angle: -0.5, color: '#FFB08A' } },
  },
  oros: {
    id: 'oros', index: 5, name: 'Oros Halo', planet: 'Ringed gas giant', grid: { cols: 17, rows: 11 },
    flavour: 'A banded giant wearing rings of ice. Fuel and tech trade high and the residents throw festivals.',
    bias: { goods: { tech: 1.4 }, events: { festival: 2 }, companies: { ouroboros: 2 }, residents: 1, rent: 1, refinery: 1, fuel: 1.4, gate: 1, traffic: 1 },
    unlock: { level: 3, credits: 120000, charts: 2, am: null, pass: false },
    expedition: { minutes: 75, cost: 1400 }, buildMul: 1.5,
    lootGoods: ['tech', 'medicine', 'fruit'],
    names: ['Ringwatch', 'Halo Station', 'Oros Anchor', 'The Girdle', 'Icefall', 'Bandwidth', 'Skyharbor', 'Perihelion'],
    theme: { planet: { kind: 'gas', color: '#C9A06A', rim: '#FFE8C0', bands: true, rings: true, caps: false }, nebula: ['#3A2A1A', '#2A3A4A', '#4A3A2A'], stars: { count: 1300, tint: '#FFF0D8' }, light: { angle: -0.6, color: '#FFF4E0' } },
  },
  keth: {
    id: 'keth', index: 6, name: 'Keth Meridian', planet: 'Garden world', grid: { cols: 17, rows: 11 },
    flavour: 'Green from pole to pole. Families settle twice as fast and pay a third more rent.',
    bias: { goods: { grain: 1.2, fruit: 1.2, livestock: 1.2 }, events: {}, companies: { meridian: 2 }, residents: 2, rent: 1.3, refinery: 1, fuel: 1, gate: 1, traffic: 1 },
    unlock: { level: 4, credits: 200000, charts: 0, am: null, pass: false },
    expedition: { minutes: 90, cost: 1600 }, buildMul: 1.5,
    lootGoods: ['grain', 'fruit', 'livestock'],
    names: ['Meridian Rest', 'Greenwatch', 'Orchard Station', 'Keth Harbor', 'Verdance', 'The Terrace', 'Harvest Gate', 'Canopy'],
    theme: { planet: { kind: 'garden', color: '#3E8A4A', rim: '#BFF0C8', bands: false, caps: true, oceans: '#2A5FA0' }, nebula: ['#1A3A2A', '#2A4A3A', '#1A2A3A'], stars: { count: 1300, tint: '#EAFFEF' }, light: { angle: -0.7, color: '#F4FFE8' } },
  },
  aurelia: {
    id: 'aurelia', index: 7, name: 'Aurelia Gate', planet: 'Violet nebula, white dwarf', grid: { cols: 19, rows: 11 },
    flavour: 'The galactic terminus. Aurelian liners dock here first, and a Jump Gate Beacon pulls twice the galactic traffic.',
    bias: { goods: { crystals: 1.3, spice: 1.3 }, events: {}, companies: { aurelian: 2 }, residents: 1, rent: 1, refinery: 1, fuel: 1, gate: 2, traffic: 1 },
    unlock: { level: 4, credits: 400000, charts: 3, am: null, pass: true },
    expedition: { minutes: 120, cost: 1800 }, buildMul: 1.5,
    lootGoods: ['tech', 'medicine', 'crystals'],
    names: ['Aurelia Gate', 'Terminus', 'Last Light', 'The Threshold', 'Dwarfwatch', 'Violet Anchor', 'Gatehouse', 'Omega Reach'],
    theme: { planet: { kind: 'dwarf', color: '#F2F4FF', rim: '#C084FF', bands: false, caps: false, dwarf: true }, nebula: ['#3A1A5A', '#5A2A7A', '#2A1A4A'], stars: { count: 1800, tint: '#F0E8FF' }, light: { angle: -0.9, color: '#F4ECFF' } },
  },
};
const SECTOR_ORDER = Object.keys(SECTORS);
for (const id of SECTOR_ORDER) SECTORS[id].expedition.minutes = TUNING.expeditionMinutes[SECTORS[id].index];   // A1.1: durations come from the preset
if (ECON.sectorCostMul !== 1) for (const id of SECTOR_ORDER) SECTORS[id].unlock.credits = Math.round(SECTORS[id].unlock.credits * ECON.sectorCostMul);
if (TUNING.sectorCosts) for (const id in TUNING.sectorCosts) if (SECTORS[id]) SECTORS[id].unlock.credits = TUNING.sectorCosts[id];

// ------------------------------------------------------------ 4.6 expeditions
const EXPEDITIONS = {
  slots: { base: 1, comms: 1, shipyard: 1, max: 3 },
  requires: 'dock',                            // one active Docking Bay
  costBase: 400, costPerIndex: 0.5,            // cost = 400 x (1 + 0.5 x index)
  minutes: TUNING.expeditionMinutes,           // by sector order (preset: patient 30 min .. 24 h)
  loot: {
    chart: { p: 0.6, guaranteeEvery: 3 },      // every third claimed run to a sector carries a chart
    goods: { min: 20, max: 80 },               // always; the sector's bias goods into the active station's stock
    am: { p: 0.35, min: 1, max: 8 },           // rarity weighted toward the low end
    discovery: { p: 0.45, weights: { common: 6, rare: 3, epic: 1 } },
    credits: { p: 0.2, minMinutes: 5, maxMinutes: 15 },   // minutes of total station rate
  },
  xp: ECON.xp.expedition,
};

// ------------------------------------------------------------ A1.2 plot expansion ("territory")
const PLOT = { start: { w: 7, h: 5 }, baseCost: 4000, baseMs: 15 * 60e3, costMul: 2.2, msMul: 1.9 };
// Ring bounds for a grid: ring 0 is the start plot around the hub, the last ring is the full grid. A ring grows by
// one cell on each side where the grid allows; when the grid is wider than tall the width grows every ring and the
// height every other ring (7x5 -> 9x7 -> 11x7 -> 13x9 -> 15x9 on home), and the other way round for tall grids.
function plotRings(rows, cols, hub) {
  const rings = [];
  const clampBox = (hw, hh) => ({ r0: Math.max(0, hub.r - hh), c0: Math.max(0, hub.c - hw), r1: Math.min(rows - 1, hub.r + hh), c1: Math.min(cols - 1, hub.c + hw) });
  let hw = Math.floor(PLOT.start.w / 2), hh = Math.floor(PLOT.start.h / 2);
  const full = b => b.r0 === 0 && b.c0 === 0 && b.r1 === rows - 1 && b.c1 === cols - 1;
  let box = clampBox(hw, hh);
  rings.push(box);
  const wide = cols >= rows;
  for (let k = 1; !full(box) && k < 64; k++) {
    const wMax = box.c0 === 0 && box.c1 === cols - 1, hMax = box.r0 === 0 && box.r1 === rows - 1;
    const growW = !wMax && (wide || k % 2 === 1 || hMax);
    const growH = !hMax && (!wide || k % 2 === 1 || wMax);
    if (growW) hw++;
    if (growH) hh++;
    box = clampBox(hw, hh);
    rings.push(box);
  }
  return rings;
}
function plotCost(ring) { return Math.round(PLOT.baseCost * Math.pow(PLOT.costMul, ring - 1)); }       // ring k (1-based)
function plotMs(ring, buildMul = 1) { return Math.round(PLOT.baseMs * Math.pow(PLOT.msMul, ring - 1) * buildMul); }
function boxCells(b) { return (b.r1 - b.r0 + 1) * (b.c1 - b.c0 + 1); }

// ------------------------------------------------------------ 4.8 daily rewards (looping; credits scale with total station rate, never below min)
const DAILY_REWARDS = [
  { day: 1, kind: 'credits', min: 1500, rateMinutes: 30, label: '1,500+ credits' },
  { day: 2, kind: 'credits', min: 3000, rateMinutes: 60, label: '3,000+ credits' },
  { day: 3, kind: 'am', amount: 5, label: '5 Antimatter' },
  { day: 4, kind: 'credits', min: 6000, rateMinutes: 120, label: '6,000+ credits' },
  { day: 5, kind: 'goods', units: 60, label: 'Goods crate' },
  { day: 6, kind: 'am', amount: 10, label: '10 Antimatter' },
  { day: 7, kind: 'am', amount: 25, token: 'livery', label: '25 Antimatter + livery token' },
];

// ------------------------------------------------------------ 4.9 commander ranks
const RANKS = [
  { level: 1, title: 'Ensign', xp: 0 },
  { level: 2, title: 'Lieutenant', xp: 300 },
  { level: 3, title: 'Harbourmaster', xp: 900, grant: 'collectAll', grantText: 'Collect All' },
  { level: 4, title: 'Commodore', xp: 2000, grant: 'missionSlot', grantText: 'An extra mission slot' },
  { level: 5, title: 'Admiral of the Reach', xp: 4500, grant: 'rateBonus', grantText: '+5% bank rate' },
  { level: 6, title: 'Fleet Admiral', xp: 7500 },
  { level: 7, title: 'Warden of the Lanes', xp: 10500 },
  { level: 8, title: 'Starholder', xp: 13500 },
  { level: 9, title: 'Voice of the Reach', xp: 16500 },
  { level: 10, title: 'Sovereign of the Expanse', xp: 19500 },
];

// ------------------------------------------------------------ 7.1 store catalog (S owns the data; P renders and grants)
const STORE_CATALOG = [
  { sku: 'am_50', kind: 'am', name: 'Antimatter · 50', desc: 'A vial of violet light.', amount: 50, bonusPct: 0, priceCents: 199, priceLabel: '$1.99', badge: null },
  { sku: 'am_140', kind: 'am', name: 'Antimatter · 140', desc: '125 plus 15 bonus.', amount: 140, bonusPct: 12, priceCents: 499, priceLabel: '$4.99', badge: 'Popular' },
  { sku: 'am_320', kind: 'am', name: 'Antimatter · 320', desc: '250 plus 70 bonus.', amount: 320, bonusPct: 28, priceCents: 999, priceLabel: '$9.99', badge: null },
  { sku: 'am_900', kind: 'am', name: 'Antimatter · 900', desc: '500 plus 400 bonus.', amount: 900, bonusPct: 80, priceCents: 2499, priceLabel: '$24.99', badge: 'Best value' },
  { sku: 'credits_s', kind: 'credits', name: 'Supply Run', desc: 'Two hours of your total station rate, at least 10,000 credits.', rateMinutes: 120, min: 10000, priceCents: 199, priceLabel: '$1.99', badge: null },
  { sku: 'credits_l', kind: 'credits', name: 'Trade Fleet', desc: 'Eight hours of your total station rate, at least 40,000 credits.', rateMinutes: 480, min: 40000, priceCents: 599, priceLabel: '$5.99', badge: null },
  { sku: 'sector_pass', kind: 'pass', name: 'Sector Pass', desc: 'Every sector unlocked for this profile. No charts needed.', grant: 'unlockAll', priceCents: 999, priceLabel: '$9.99', badge: null },
  { sku: 'founder', kind: 'cosmetic', name: "Founder's Livery", desc: 'Ivory-amber station strip, the title Founder, and 100 Antimatter.', grant: { livery: 'founder', title: 'Founder', am: 100 }, priceCents: 499, priceLabel: '$4.99', badge: null },
  { sku: 'liveries', kind: 'cosmetic', name: 'Sector Liveries', desc: 'The six sector liveries for your station strip.', grant: { liveries: ['sable', 'kessler', 'thessaly', 'marrow', 'oros', 'keth'] }, priceCents: 299, priceLabel: '$2.99', badge: null },
];

// ------------------------------------------------------------ 4.10 collection ("Registry")
// source: { serve: { company, cls?, count } } found by serving ships  |  { expedition: [sectorIds] } found by expedition discovery
const COLLECTION = {
  ships: [
    // standard liveries: serve one ship of that company and class
    { id: 'halvorsen_hauler', name: 'Halvorsen Bulk Hauler', cls: 'hauler', fam: 'halvorsen', rarity: 'common', lore: 'Slab-sided ore hauler out of Varro.\nSlow, enormous, always thirsty.', source: { serve: { company: 'halvorsen', cls: 'hauler', count: 1 } } },
    { id: 'halvorsen_freighter', name: 'Halvorsen Freighter', cls: 'freighter', fam: 'halvorsen', rarity: 'common', lore: 'The company workhorse.\nRuns ore and crystal to the inner worlds.', source: { serve: { company: 'halvorsen', cls: 'freighter', count: 1 } } },
    { id: 'kestrel_courier', name: 'Kestrel Courier', cls: 'courier', fam: 'kestrel', rarity: 'common', lore: 'Fast, narrow, blue-lit.\nTech and medicine on a schedule.', source: { serve: { company: 'kestrel', cls: 'courier', count: 1 } } },
    { id: 'kestrel_freighter', name: 'Kestrel Freighter', cls: 'freighter', fam: 'kestrel', rarity: 'common', lore: 'A courier line that grew up.\nStill in a hurry.', source: { serve: { company: 'kestrel', cls: 'freighter', count: 1 } } },
    { id: 'ouroboros_freighter', name: 'Ouroboros Freighter', cls: 'freighter', fam: 'ouroboros', rarity: 'common', lore: 'Holds full of live cargo.\nSmells like a jungle after rain.', source: { serve: { company: 'ouroboros', cls: 'freighter', count: 1 } } },
    { id: 'meridian_freighter', name: 'Meridian Freighter', cls: 'freighter', fam: 'meridian', rarity: 'common', lore: 'Farmer-owned and farmer-flown.\nGrain dust in every seam.', source: { serve: { company: 'meridian', cls: 'freighter', count: 1 } } },
    { id: 'meridian_hauler', name: 'Meridian Grain Hauler', cls: 'hauler', fam: 'meridian', rarity: 'common', lore: 'A silo with engines.\nFeeds three colonies a trip.', source: { serve: { company: 'meridian', cls: 'hauler', count: 1 } } },
    { id: 'redsand_courier', name: 'Red Sand Courier', cls: 'courier', fam: 'redsand', rarity: 'common', lore: 'Spice runner from Marrow.\nShrewd captains, quick tempers.', source: { serve: { company: 'redsand', cls: 'courier', count: 1 } } },
    { id: 'redsand_freighter', name: 'Red Sand Freighter', cls: 'freighter', fam: 'redsand', rarity: 'common', lore: 'Textile bales to the ceiling.\nHaggles over every docking fee.', source: { serve: { company: 'redsand', cls: 'freighter', count: 1 } } },
    { id: 'tidewater_hauler', name: 'Tidewater Tanker', cls: 'hauler', fam: 'tidewater', rarity: 'common', lore: 'A hull full of ice water.\nSweats in dock.', source: { serve: { company: 'tidewater', cls: 'hauler', count: 1 } } },
    { id: 'tidewater_freighter', name: 'Tidewater Freighter', cls: 'freighter', fam: 'tidewater', rarity: 'common', lore: 'Occasionally carries a very wet crate.\nThe crate is alive.', source: { serve: { company: 'tidewater', cls: 'freighter', count: 1 } } },
    { id: 'aurelian_liner', name: 'Aurelian Liner', cls: 'liner', fam: 'aurelian', rarity: 'rare', lore: 'Sixty passengers and a ballroom.\nNeeds a Jump Gate to find you.', source: { serve: { company: 'aurelian', cls: 'liner', count: 1 } } },
    // notable hulls: a company's tenth ship, or an expedition to its home sector
    { id: 'anvil_of_varro', name: 'Anvil of Varro', cls: 'hauler', fam: 'halvorsen', rarity: 'rare', lore: 'The oldest Halvorsen hull still flying.\nHer plates are patched with eight kinds of alloy.', source: { serve: { company: 'halvorsen', count: 10 } } },
    { id: 'ore_mother', name: 'Ore-Mother', cls: 'freighter', fam: 'halvorsen', rarity: 'rare', lore: 'A survey freighter that found the Sable seams.\nStill wears the prospecting scars.', source: { expedition: ['home', 'sable'] } },
    { id: 'kestrel_swift', name: 'Kestrel Swift', cls: 'courier', fam: 'kestrel', rarity: 'rare', lore: 'Holds the inner-worlds speed record.\nTwice.', source: { serve: { company: 'kestrel', count: 10 } } },
    { id: 'blue_shrike', name: 'Blue Shrike', cls: 'freighter', fam: 'kestrel', rarity: 'rare', lore: 'Ran medicine through the Sable blockade.\nNobody asked how.', source: { expedition: ['sable'] } },
    { id: 'green_serpent', name: 'Green Serpent', cls: 'freighter', fam: 'ouroboros', rarity: 'rare', lore: 'Her hold is a greenhouse with gravity.\nThe crew live in the canopy.', source: { serve: { company: 'ouroboros', count: 10 } } },
    { id: 'harvest_moon', name: 'Harvest Moon', cls: 'hauler', fam: 'meridian', rarity: 'rare', lore: 'Painted with a different field every season.\nThe farmers vote on the picture.', source: { serve: { company: 'meridian', count: 10 } } },
    { id: 'keth_plenty', name: 'Keth Plenty', cls: 'freighter', fam: 'meridian', rarity: 'rare', lore: 'Flagship of the co-op.\nCarries the seed vault once a year.', source: { expedition: ['keth'] } },
    { id: 'dune_runner', name: 'Dune Runner', cls: 'courier', fam: 'redsand', rarity: 'rare', lore: 'Flies the Marrow storm season on purpose.\nFaster when nobody else will.', source: { serve: { company: 'redsand', count: 10 } } },
    { id: 'ember_caravan', name: 'Ember Caravan', cls: 'freighter', fam: 'redsand', rarity: 'rare', lore: 'Lead ship of the great spice caravans.\nHer hull is warm to the touch.', source: { expedition: ['marrow'] } },
    { id: 'deep_tide', name: 'Deep Tide', cls: 'hauler', fam: 'tidewater', rarity: 'rare', lore: 'Pumped the first ocean water to Marrow.\nStill carries a bottle of it.', source: { serve: { company: 'tidewater', count: 10 } } },
    { id: 'brine_queen', name: 'Brine Queen', cls: 'freighter', fam: 'tidewater', rarity: 'rare', lore: 'A Thessaly research vessel refitted for trade.\nThe lab is now a fish market.', source: { expedition: ['thessaly'] } },
    { id: 'aurelia_ascendant', name: 'Aurelia Ascendant', cls: 'liner', fam: 'aurelian', rarity: 'epic', lore: 'The line\'s flagship, gold-plated at the prow.\nDocks only where the gate burns brightest.', source: { expedition: ['aurelia'] } },
  ],
  species: [
    { id: 'varroan', name: 'Varroan Dustkin', fam: 'home', rarity: 'common', silhouette: 'dustkin', lore: 'Compact miners with second eyelids against the grit.\nThey count wealth in tools, not credits.', source: { serve: { company: 'halvorsen', count: 5 } } },
    { id: 'kethi', name: 'Kethi Gardeners', fam: 'keth', rarity: 'common', silhouette: 'gardener', lore: 'Tall, slow-spoken, green at the knuckles.\nEvery ship they crew grows something.', source: { serve: { company: 'meridian', count: 5 } } },
    { id: 'sablite', name: 'Sable Foundry-born', fam: 'sable', rarity: 'common', silhouette: 'foundry', lore: 'Raised in the hive factories under the dust.\nThey find open space unsettling and docks comforting.', source: { serve: { company: 'kestrel', count: 5 } } },
    { id: 'thessalid', name: 'Thessalid Swimmers', fam: 'thessaly', rarity: 'common', silhouette: 'swimmer', lore: 'Amphibious traders who prefer wet corridors.\nTheir contracts are sung, then written.', source: { serve: { company: 'tidewater', count: 5 } } },
    { id: 'marrowite', name: 'Marrow Nomads', fam: 'marrow', rarity: 'common', silhouette: 'nomad', lore: 'Caravan families who have never slept under one sky twice.\nFiercely loyal once a bargain is struck.', source: { serve: { company: 'redsand', count: 5 } } },
    { id: 'orosian', name: 'Orosian Canopy Folk', fam: 'oros', rarity: 'common', silhouette: 'canopy', lore: 'Light-boned climbers from the jungle moon.\nThey travel with their animals and their weather.', source: { serve: { company: 'ouroboros', count: 5 } } },
    { id: 'aurelian_envoy', name: 'Aurelian Envoys', fam: 'aurelia', rarity: 'rare', silhouette: 'envoy', lore: 'Diplomats of the galactic core, robed in violet.\nThey tip in artifacts.', source: { serve: { company: 'aurelian', count: 1 } } },
    { id: 'lantern_moth', name: 'Lantern Moths', fam: 'kessler', rarity: 'rare', silhouette: 'moth', lore: 'Vacuum-dwelling drifters that follow ship lights.\nHarmless; the belt miners feed them.', source: { expedition: ['kessler'] } },
    { id: 'tidesinger', name: 'Tidesingers', fam: 'thessaly', rarity: 'rare', silhouette: 'tidesinger', lore: 'Deep-ocean giants whose songs carry through hulls.\nSeen once a generation.', source: { expedition: ['thessaly'] } },
    { id: 'ashwalker', name: 'Ashwalkers', fam: 'marrow', rarity: 'rare', silhouette: 'ashwalker', lore: 'Silicate beings that live in the lava seams.\nThey trade obsidian for stories.', source: { expedition: ['marrow'] } },
    { id: 'ring_drifter', name: 'Ring Drifters', fam: 'oros', rarity: 'rare', silhouette: 'drifter', lore: 'Gossamer organisms riding the ice rings of Oros.\nThey hum at the frequency of the station reactor.', source: { expedition: ['oros'] } },
    { id: 'gate_warden', name: 'The Gate Wardens', fam: 'aurelia', rarity: 'epic', silhouette: 'warden', lore: 'Nobody knows who built the first gate.\nThe Wardens say they only remember it.', source: { expedition: ['aurelia'] } },
  ],
  artifacts: [
    { id: 'beacon_shard', name: "Founder's Beacon Shard", fam: 'home', rarity: 'common', lore: 'A splinter of the first navigation beacon in the Reach.\nIt still blinks, faintly, on the hour.', source: { expedition: ['home'] } },
    { id: 'survey_plate', name: 'Varro Survey Plate', fam: 'home', rarity: 'rare', lore: 'An etched plate from the original mining survey.\nThe coordinates are wrong on purpose.', source: { expedition: ['home'] } },
    { id: 'storm_glass', name: 'Storm Glass', fam: 'sable', rarity: 'common', lore: 'Dust fused by lightning into a dark lens.\nHold it to a lamp and the storm is still inside.', source: { expedition: ['sable'] } },
    { id: 'foundry_seal', name: 'Foundry Seal', fam: 'sable', rarity: 'rare', lore: 'Stamp of the first Sable hive-factory.\nNo two castings carry the same number.', source: { expedition: ['sable'] } },
    { id: 'core_fragment', name: 'Kessler Core Fragment', fam: 'kessler', rarity: 'common', lore: 'Iron from the heart of a moon that no longer exists.\nHeavier than it looks.', source: { expedition: ['kessler'] } },
    { id: 'dead_ship_log', name: "Dead Ship's Log", fam: 'kessler', rarity: 'epic', lore: 'The last entries of a hauler lost in the belt.\nThe final line is a course that leads home.', source: { expedition: ['kessler'] } },
    { id: 'deep_pearl', name: 'Pearl of the Deep', fam: 'thessaly', rarity: 'common', lore: 'Grown over a century in a Tidesinger\'s throat.\nIt is warm.', source: { expedition: ['thessaly'] } },
    { id: 'tide_compass', name: 'Tidewater Compass', fam: 'thessaly', rarity: 'rare', lore: 'Points to the nearest body of water.\nAboard a station, it spins.', source: { expedition: ['thessaly'] } },
    { id: 'obsidian_idol', name: 'Obsidian Idol', fam: 'marrow', rarity: 'common', lore: 'A nomad figure carved from lava glass.\nEvery caravan carries one for luck.', source: { expedition: ['marrow'] } },
    { id: 'caravan_ledger', name: 'Caravan Ledger', fam: 'marrow', rarity: 'rare', lore: 'Three centuries of spice prices in one book.\nThe margins hold better secrets.', source: { expedition: ['marrow'] } },
    { id: 'ring_lens', name: 'Ring Ice Lens', fam: 'oros', rarity: 'common', lore: 'A disc of ring ice that never melts.\nIt bends light toward Oros, wherever you stand.', source: { expedition: ['oros'] } },
    { id: 'halo_chime', name: 'Halo Chime', fam: 'oros', rarity: 'epic', lore: 'Tuned by the Ring Drifters to the giant\'s storms.\nIt rings before a festival.', source: { expedition: ['oros'] } },
    { id: 'seed_key', name: 'Seed Vault Key', fam: 'keth', rarity: 'common', lore: 'Opens one drawer of the Keth seed vault.\nNobody knows which.', source: { expedition: ['keth'] } },
    { id: 'meridian_loom', name: 'Meridian Loom', fam: 'keth', rarity: 'rare', lore: 'A hand loom that weaves grain-fibre sailcloth.\nThe co-op flag was made on it.', source: { expedition: ['keth'] } },
    { id: 'gate_resonator', name: 'Gate Resonator', fam: 'aurelia', rarity: 'rare', lore: 'A crystal that trembles when a jump gate opens.\nAnywhere.', source: { expedition: ['aurelia'] } },
    { id: 'first_chart', name: 'The First Chart', fam: 'aurelia', rarity: 'epic', lore: 'The oldest star chart in the Expanse.\nThe Reach is on it, marked "promising".', source: { expedition: ['aurelia'] } },
  ],
  // sets: all ships of a company, all species, all artifacts of a sector (4.10)
  sets: [
    { id: 'set_halvorsen', kind: 'ships', name: 'Halvorsen Fleet', items: ['halvorsen_hauler', 'halvorsen_freighter', 'anvil_of_varro', 'ore_mother'], reward: { am: 20, title: 'Oremaster' } },
    { id: 'set_kestrel', kind: 'ships', name: 'Kestrel Fleet', items: ['kestrel_courier', 'kestrel_freighter', 'kestrel_swift', 'blue_shrike'], reward: { am: 20, title: 'Pathfinder' } },
    { id: 'set_ouroboros', kind: 'ships', name: 'Ouroboros Fleet', items: ['ouroboros_freighter', 'green_serpent'], reward: { am: 20, title: 'Keeper' } },
    { id: 'set_meridian', kind: 'ships', name: 'Meridian Fleet', items: ['meridian_freighter', 'meridian_hauler', 'harvest_moon', 'keth_plenty'], reward: { am: 20, title: 'Harvester' } },
    { id: 'set_redsand', kind: 'ships', name: 'Red Sand Fleet', items: ['redsand_courier', 'redsand_freighter', 'dune_runner', 'ember_caravan'], reward: { am: 20, title: 'Caravaneer' } },
    { id: 'set_tidewater', kind: 'ships', name: 'Tidewater Fleet', items: ['tidewater_hauler', 'tidewater_freighter', 'deep_tide', 'brine_queen'], reward: { am: 20, title: 'Tidemaster' } },
    { id: 'set_aurelian', kind: 'ships', name: 'Aurelian Fleet', items: ['aurelian_liner', 'aurelia_ascendant'], reward: { am: 40, title: 'Gatekeeper' } },
    { id: 'set_species', kind: 'species', name: 'Peoples of the Expanse', items: ['varroan', 'kethi', 'sablite', 'thessalid', 'marrowite', 'orosian', 'aurelian_envoy', 'lantern_moth', 'tidesinger', 'ashwalker', 'ring_drifter', 'gate_warden'], reward: { am: 60, title: 'Xenologist' } },
    { id: 'set_art_home', kind: 'artifacts', name: 'Relics of Varro Reach', items: ['beacon_shard', 'survey_plate'], reward: { am: 20, title: 'Antiquarian' } },
    { id: 'set_art_sable', kind: 'artifacts', name: 'Relics of Sable Drift', items: ['storm_glass', 'foundry_seal'], reward: { am: 25, title: 'Stormkeeper' } },
    { id: 'set_art_kessler', kind: 'artifacts', name: 'Relics of Kessler Belt', items: ['core_fragment', 'dead_ship_log'], reward: { am: 30, title: 'Salvager' } },
    { id: 'set_art_thessaly', kind: 'artifacts', name: 'Relics of Thessaly Deep', items: ['deep_pearl', 'tide_compass'], reward: { am: 25, title: 'Deepwarden' } },
    { id: 'set_art_marrow', kind: 'artifacts', name: 'Relics of Marrow Verge', items: ['obsidian_idol', 'caravan_ledger'], reward: { am: 25, title: 'Ashbound' } },
    { id: 'set_art_oros', kind: 'artifacts', name: 'Relics of Oros Halo', items: ['ring_lens', 'halo_chime'], reward: { am: 30, title: 'Ringbearer' } },
    { id: 'set_art_keth', kind: 'artifacts', name: 'Relics of Keth Meridian', items: ['seed_key', 'meridian_loom'], reward: { am: 25, title: 'Seedkeeper' } },
    { id: 'set_art_aurelia', kind: 'artifacts', name: 'Relics of Aurelia Gate', items: ['gate_resonator', 'first_chart'], reward: { am: 40, title: 'Cartographer' } },
  ],
};
const COLLECTION_KINDS = ['ships', 'species', 'artifacts'];

// ------------------------------------------------------------ 4.7 missions (50)
// track(state, profile) -> progress number; complete when progress >= goal. `state` is the active station.
// Trackers recount from state wherever possible; profile.stats holds only what cannot be recounted
// (collects, transmissions, expeditions, convoy service).
function mCount(state, id) {                   // placed modules of an id, under construction included
  let n = 0; const g = state.grid;
  for (let r = 0; r < g.length; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] && g[r][c].id === id) n++;
  return n;
}
function mBestLevel(profile) { let L = 1; for (const id in profile.sectors) L = Math.max(L, profile.sectors[id].level || 1); return L; }
function mFound(profile, kind) { let n = 0; for (const it of COLLECTION[kind]) if (profile.collection.found[it.id]) n++; return n; }
function mMaxCharts(profile) { let n = 0; for (const id in profile.expeditions.charts) n = Math.max(n, profile.expeditions.charts[id]); return n; }
function mTotalCharts(profile) { let n = 0; for (const id in profile.expeditions.charts) n += profile.expeditions.charts[id]; return n; }
function mOffices(state) { let n = 0; for (const id in state.companies) if (state.companies[id].office) n++; return n; }
function mMaxTrust(state) { let t = 0; for (const id in state.companies) t = Math.max(t, state.companies[id].trust); return t; }
function mAmenity(state) { return Sim.state === state ? Math.round(Sim.amenity(Sim.totals()).score * 100) : 0; }
function mSets(profile) { let n = 0; for (const s of COLLECTION.sets) if (profile.collection.sets[s.id]) n++; return n; }

const MISSIONS = [
  // ---- Commissioning (tutorial, 7): pays 35 AM in total
  { id: 'c_dock', chapter: 'Commissioning', title: 'First Berth', desc: 'Build a Docking Bay so ships have somewhere to pull up.', type: 'build', goal: 1, reward: { credits: 300, am: 5, xp: 20 }, requires: [], pointer: 'build', track: s => mCount(s, 'dock') },
  { id: 'c_warehouse', chapter: 'Commissioning', title: 'Room to Breathe', desc: 'Build a Cargo Warehouse. Ships sell into your stores and buy from them.', type: 'build', goal: 1, reward: { credits: 300, am: 5, xp: 20 }, requires: ['c_dock'], pointer: 'build', track: s => mCount(s, 'warehouse') },
  { id: 'c_solar', chapter: 'Commissioning', title: 'Lights On', desc: 'Build a Solar Array. Every module draws power.', type: 'build', goal: 1, reward: { credits: 400, am: 5, xp: 20 }, requires: ['c_warehouse'], pointer: 'build', track: s => mCount(s, 'solar') },
  { id: 'c_collect', chapter: 'Commissioning', title: 'Tap the Bank', desc: 'Every module banks credits while you are away. Click a coin to collect one.', type: 'collect', goal: 1, reward: { credits: 500, am: 5, xp: 20 }, requires: ['c_solar'], pointer: 'bank', track: (s, p) => p.stats.collects },
  { id: 'c_serve3', chapter: 'Commissioning', title: 'Open for Business', desc: 'Serve three ships. Fees and trade pay the moment they dock.', type: 'serve', goal: 3, reward: { credits: 600, am: 5, xp: 30 }, requires: ['c_collect'], pointer: null, track: s => s.stats.shipsServed },
  { id: 'c_transmission', chapter: 'Commissioning', title: 'Incoming Transmission', desc: 'Read a transmission. Events arrive every few days and some ask for a decision.', type: 'event', goal: 1, reward: { credits: 500, am: 5, xp: 30 }, requires: ['c_serve3'], pointer: null, track: (s, p) => p.stats.transmissions },
  { id: 'c_plot1', chapter: 'Commissioning', title: 'Clear Your First Ring', desc: 'Click the unclaimed space around the station and clear the first ring of your plot.', type: 'plot', goal: 1, reward: { credits: 1500, am: 5, xp: 40 }, requires: ['c_transmission'], pointer: 'plot', track: s => (s.plot ? s.plot.ring : 0) },

  // ---- Trade (8)
  { id: 't_fuel', chapter: 'Trade', title: 'Reaction Mass', desc: 'Build a Fuel Depot. Every docked ship buys fuel.', type: 'build', goal: 1, reward: { credits: 600, am: 2, xp: 30 }, requires: ['c_serve3'], track: s => mCount(s, 'fuel') },
  { id: 't_trade500', chapter: 'Trade', title: 'Moving Cargo', desc: 'Trade 500 units of cargo through your docks.', type: 'trade', goal: 500, reward: { credits: 1200, am: 3, xp: 40 }, requires: ['t_fuel'], track: s => s.stats.cargoTraded },
  { id: 't_market', chapter: 'Trade', title: 'The Exchange', desc: 'Build a Trade Exchange for better margins and buy/sell policies.', type: 'build', goal: 1, reward: { credits: 1500, am: 3, xp: 40 }, requires: ['t_trade500'], track: s => mCount(s, 'market') },
  { id: 't_serve25', chapter: 'Trade', title: 'Regular Traffic', desc: 'Serve 25 ships at this station.', type: 'serve', goal: 25, reward: { credits: 2000, am: 4, xp: 60 }, requires: ['t_market'], track: s => s.stats.shipsServed },
  { id: 't_customs', chapter: 'Trade', title: 'Paperwork', desc: 'Build a Customs Office and tariff every unit that passes through.', type: 'build', goal: 1, reward: { credits: 2000, am: 4, xp: 60 }, requires: ['t_serve25'], track: s => mCount(s, 'customs') },
  { id: 't_earn50k', chapter: 'Trade', title: 'Black Ink', desc: 'Earn 50,000 credits of gross income at this station.', type: 'earn', goal: 50000, reward: { credits: 4000, am: 5, xp: 80 }, requires: ['t_customs'], track: s => s.stats.earned },
  { id: 't_trade5k', chapter: 'Trade', title: 'Bulk Lanes', desc: 'Trade 5,000 units of cargo.', type: 'trade', goal: 5000, reward: { credits: 6000, am: 6, xp: 100 }, requires: ['t_earn50k'], track: s => s.stats.cargoTraded },
  { id: 't_convoy', chapter: 'Trade', title: 'Convoy Season', desc: 'Serve 15 ships during a weekly Convoy window.', type: 'convoy', goal: 15, reward: { credits: 8000, am: 15, xp: 120 }, requires: ['t_trade5k'], track: (s, p) => p.stats.convoyServed },

  // ---- Crew (8)
  { id: 'k_quarters', chapter: 'Crew', title: 'Bunks', desc: 'Build Crew Quarters. Crews with a bed spend more.', type: 'build', goal: 1, reward: { credits: 500, am: 2, xp: 30 }, requires: ['c_solar'], track: s => mCount(s, 'quarters') },
  { id: 'k_cantina', chapter: 'Crew', title: 'Hot Meals', desc: 'Build a Cantina. Everyone needs to eat.', type: 'build', goal: 1, reward: { credits: 600, am: 2, xp: 30 }, requires: ['k_quarters'], track: s => mCount(s, 'cantina') },
  { id: 'k_rec', chapter: 'Crew', title: 'Shore Leave', desc: 'Build a Rec Deck. Crews rate a station with somewhere to go.', type: 'build', goal: 1, reward: { credits: 1200, am: 3, xp: 40 }, requires: ['k_cantina'], track: s => mCount(s, 'rec') },
  { id: 'k_qol', chapter: 'Crew', title: 'Good Posting', desc: 'Raise quality of life to 70%.', type: 'amenity', goal: 70, reward: { credits: 2000, am: 4, xp: 60 }, requires: ['k_rec'], track: s => mAmenity(s) },
  { id: 'k_trust', chapter: 'Crew', title: 'Trusted Partner', desc: 'Earn 75 trust with any shipping company. They open an office.', type: 'trust', goal: 75, reward: { credits: 2500, am: 4, xp: 60 }, requires: ['k_qol'], track: s => mMaxTrust(s) },
  { id: 'k_clinic', chapter: 'Crew', title: 'Sick Bay', desc: 'Build a Med Bay before the next outbreak.', type: 'build', goal: 1, reward: { credits: 2000, am: 4, xp: 60 }, requires: ['k_trust'], track: s => mCount(s, 'clinic') },
  { id: 'k_offices3', chapter: 'Crew', title: 'Three Offices', desc: 'Have three companies keep offices on the station.', type: 'offices', goal: 3, reward: { credits: 5000, am: 6, xp: 100 }, requires: ['k_clinic'], track: s => mOffices(s) },
  { id: 'k_shipyard', chapter: 'Crew', title: 'Drydock', desc: 'Build a Shipyard. Repairs pay and companies trust a station that fixes hulls.', type: 'build', goal: 1, reward: { credits: 8000, am: 8, xp: 120 }, requires: ['k_offices3'], track: s => mCount(s, 'shipyard') },

  // ---- Reach (8)
  { id: 'r_launch', chapter: 'Reach', title: 'First Sortie', desc: 'Launch an expedition from the Expeditions panel.', type: 'expedition', goal: 1, reward: { credits: 600, am: 3, xp: 30 }, requires: ['c_serve3'], pointer: 'expeditions', track: (s, p) => p.stats.expeditionsLaunched },
  { id: 'r_claim', chapter: 'Reach', title: 'Debrief', desc: 'Bring an expedition home and read the debrief.', type: 'expedition', goal: 1, reward: { credits: 800, am: 3, xp: 40 }, requires: ['r_launch'], track: (s, p) => p.stats.expeditionsClaimed },
  { id: 'r_chart', chapter: 'Reach', title: 'Charted', desc: 'Hold a chart of any sector.', type: 'chart', goal: 1, reward: { credits: 1500, am: 4, xp: 60 }, requires: ['r_claim'], track: (s, p) => mTotalCharts(p) },
  { id: 'r_comms', chapter: 'Reach', title: 'Second Slot', desc: 'Build a Comms Relay for a second expedition slot.', type: 'build', goal: 1, reward: { credits: 2000, am: 4, xp: 60 }, requires: ['r_chart'], track: s => mCount(s, 'comms') },
  { id: 'r_discover3', chapter: 'Reach', title: 'Field Notes', desc: 'Make three discoveries for the Registry.', type: 'discover', goal: 3, reward: { credits: 3000, am: 6, xp: 80 }, requires: ['r_comms'], track: (s, p) => mFound(p, 'ships') + mFound(p, 'species') + mFound(p, 'artifacts') },
  { id: 'r_sector2', chapter: 'Reach', title: 'A Second Harbour', desc: 'Unlock a second sector on the galaxy map.', type: 'sector', goal: 2, reward: { credits: 5000, am: 25, xp: 150 }, requires: ['r_discover3'], pointer: 'map', track: (s, p) => p.unlocked.length },
  { id: 'r_charts3', chapter: 'Reach', title: 'Fully Charted', desc: 'Hold three charts of one sector.', type: 'chart', goal: 3, reward: { credits: 8000, am: 8, xp: 120 }, requires: ['r_sector2'], track: (s, p) => mMaxCharts(p) },
  { id: 'r_sectors4', chapter: 'Reach', title: 'Four Harbours', desc: 'Unlock four sectors.', type: 'sector', goal: 4, reward: { credits: 20000, am: 15, xp: 200 }, requires: ['r_charts3'], track: (s, p) => p.unlocked.length },

  // ---- Town (8)
  { id: 'w_habitat', chapter: 'Town', title: 'Settlers', desc: 'Build a Residential Habitat. People settle when the station feels like a place to live.', type: 'build', goal: 1, reward: { credits: 1500, am: 3, xp: 40 }, requires: ['k_qol'], track: s => mCount(s, 'habitat') },
  { id: 'w_residents10', chapter: 'Town', title: 'A Village', desc: 'House 10 permanent residents.', type: 'residents', goal: 10, reward: { credits: 2000, am: 4, xp: 60 }, requires: ['w_habitat'], track: s => s.residents },
  { id: 'w_hydro', chapter: 'Town', title: 'Green Deck', desc: 'Build Hydroponics to feed the station from on board.', type: 'build', goal: 1, reward: { credits: 2000, am: 4, xp: 60 }, requires: ['w_residents10'], track: s => mCount(s, 'hydro') },
  { id: 'w_level3', chapter: 'Town', title: 'Town in Space', desc: 'Reach station level 3.', type: 'level', goal: 3, reward: { credits: 5000, am: 10, xp: 150 }, requires: ['w_hydro'], track: s => s.level },
  { id: 'w_school', chapter: 'Town', title: 'Academy', desc: 'Build an Academy. Families follow schools.', type: 'build', goal: 1, reward: { credits: 4000, am: 5, xp: 80 }, requires: ['w_level3'], track: s => mCount(s, 'school') },
  { id: 'w_plot4', chapter: 'Town', title: 'Room to Grow', desc: 'Clear ring 4 of this station\'s plot. A town needs land.', type: 'plot', goal: 4, reward: { credits: 12000, am: 8, xp: 120 }, requires: ['w_school'], pointer: 'plot', track: s => (s.plot ? s.plot.ring : 0) },
  { id: 'w_plaza', chapter: 'Town', title: 'Promenade', desc: 'Build a Promenade so residents run businesses.', type: 'build', goal: 1, reward: { credits: 5000, am: 5, xp: 80 }, requires: ['w_school'], track: s => mCount(s, 'plaza') },
  { id: 'w_residents50', chapter: 'Town', title: 'A Town', desc: 'House 50 permanent residents.', type: 'residents', goal: 50, reward: { credits: 10000, am: 8, xp: 120 }, requires: ['w_plaza'], track: s => s.residents },
  { id: 'w_bank', chapter: 'Town', title: 'Mercantile', desc: 'Build a Mercantile Bank and lend to the companies.', type: 'build', goal: 1, reward: { credits: 12000, am: 10, xp: 150 }, requires: ['w_residents50'], track: s => mCount(s, 'bank') },

  // ---- Galactic (6)
  { id: 'g_observatory', chapter: 'Galactic', title: 'Far Sight', desc: 'Build a Deep Space Observatory.', type: 'build', goal: 1, reward: { credits: 8000, am: 8, xp: 120 }, requires: ['w_level3'], track: s => mCount(s, 'observatory') },
  { id: 'g_level4', chapter: 'Galactic', title: 'Galactic Gate', desc: 'Reach station level 4.', type: 'level', goal: 4, reward: { credits: 15000, am: 15, xp: 200 }, requires: ['g_observatory'], track: s => s.level },
  { id: 'g_gate', chapter: 'Galactic', title: 'Beacon', desc: 'Build a Jump Gate Beacon and call the liners.', type: 'build', goal: 1, reward: { credits: 20000, am: 15, xp: 200 }, requires: ['g_level4'], track: s => mCount(s, 'gate') },
  { id: 'g_liner', chapter: 'Galactic', title: 'Liner Call', desc: 'Serve an Aurelian Starways liner.', type: 'serve', goal: 1, reward: { credits: 25000, am: 20, xp: 250 }, requires: ['g_gate'], track: s => (s.companies.aurelian ? s.companies.aurelian.served : 0) },
  { id: 'g_sectors6', chapter: 'Galactic', title: 'Six Harbours', desc: 'Unlock six sectors.', type: 'sector', goal: 6, reward: { credits: 40000, am: 20, xp: 300 }, requires: ['g_liner'], track: (s, p) => p.unlocked.length },
  { id: 'g_aurelia', chapter: 'Galactic', title: 'Terminus', desc: 'Unlock Aurelia Gate, the galactic terminus.', type: 'sector', goal: 1, reward: { credits: 60000, am: 50, xp: 500 }, requires: ['g_sectors6'], track: (s, p) => (p.unlocked.includes('aurelia') ? 1 : 0) },

  // ---- Collector (4)
  { id: 'x_ships6', chapter: 'Collector', title: 'Spotter', desc: 'Log six ship variants in the Registry.', type: 'collect', goal: 6, reward: { credits: 3000, am: 5, xp: 80 }, requires: ['r_claim'], track: (s, p) => mFound(p, 'ships') },
  { id: 'x_species4', chapter: 'Collector', title: 'Xenologist', desc: 'Log four visitor species.', type: 'collect', goal: 4, reward: { credits: 5000, am: 8, xp: 120 }, requires: ['x_ships6'], track: (s, p) => mFound(p, 'species') },
  { id: 'x_artifacts4', chapter: 'Collector', title: 'Curator', desc: 'Recover four artifacts.', type: 'collect', goal: 4, reward: { credits: 8000, am: 10, xp: 150 }, requires: ['x_species4'], track: (s, p) => mFound(p, 'artifacts') },
  { id: 'x_set', chapter: 'Collector', title: 'Complete Set', desc: 'Complete any Registry set.', type: 'collect', goal: 1, reward: { credits: 15000, am: 25, xp: 250 }, requires: ['x_artifacts4'], track: (s, p) => mSets(p) },
];
const MISSION_CHAPTERS = ['Commissioning', 'Trade', 'Crew', 'Reach', 'Town', 'Galactic', 'Collector'];
const MISSION_SLOTS = { base: 3, commodore: 4 };

// ------------------------------------------------------------ A1.3 achievements (24, lifetime, profile-wide, three tiers each)
// `stat` names a key of Meta.lifetimeStats(): profile.stats lifetime counters plus derived values.
const ACH_AM = [5, 15, 40], ACH_AM_GOLD = [5, 15, 60];
const achDef = (id, title, desc, icon, fam, stat, goals, gold) => ({ id, title, desc, icon, fam, stat, tiers: goals.map((goal, i) => ({ goal, am: (gold ? ACH_AM_GOLD : ACH_AM)[i] })) });
const ACHIEVEMENTS = [
  achDef('harbourmaster', 'Harbourmaster', 'Serve ships at your docks.', 'ship', 'trade', 'servedTotal', [50, 500, 5000], true),
  achDef('banker', 'Banker', 'Collect credits from your banks.', 'credits', 'economy', 'collectedCredits', [50000, 1000000, 20000000], true),
  achDef('architect', 'Architect', 'Complete module builds.', 'hub', 'station', 'buildsDone', [10, 100, 500]),
  achDef('foreman', 'Foreman', 'Complete module upgrades.', 'reactor', 'station', 'upgrades', [5, 50, 200]),
  achDef('surveyor', 'Surveyor', 'Bring expeditions home.', 'dish', 'reach', 'expeditionsClaimed', [3, 25, 150]),
  achDef('cartographer', 'Cartographer', 'Hold charts of the sectors.', 'map', 'reach', 'chartsTotal', [3, 12, 24]),
  achDef('collector', 'Collector', 'Fill the Registry.', 'rep', 'registry', 'registryFound', [10, 30, 52], true),
  achDef('pioneer', 'Pioneer', 'Hold stations across the Expanse.', 'gate', 'reach', 'sectorsOwned', [2, 5, 8], true),
  achDef('landholder', 'Landholder', 'Clear plot rings across your stations.', 'plot', 'station', 'plotRings', [2, 10, 30]),
  achDef('regular', 'Regular', 'Claim the daily reward.', 'check', 'profile', 'dailyClaims', [7, 30, 100]),
  achDef('patron', 'Patron', 'Earn Antimatter in play.', 'am', 'profile', 'amEarned', [50, 500, 5000]),
  achDef('town_planner', 'Town Planner', 'House permanent residents (peak at one station).', 'people', 'town', 'residentsPeak', [20, 60, 150]),
  achDef('way_station', 'Way Station Keeper', 'Reach station level 2 in your sectors.', 'dock', 'levels', 'sectorsAtL2', [1, 3, 8]),
  achDef('trading_hub', 'Trading Hub Director', 'Reach station level 3 in your sectors.', 'market', 'levels', 'sectorsAtL3', [1, 3, 8]),
  achDef('town_in_space', 'Town Founder', 'Reach station level 4 in your sectors.', 'plaza', 'levels', 'sectorsAtL4', [1, 3, 8], true),
  achDef('galactic_hub', 'Galactic Hub Governor', 'Reach station level 5 in your sectors.', 'gate', 'levels', 'sectorsAtL5', [1, 3, 8], true),
  achDef('officer', 'Commissioned Officer', 'Rise through the junior ranks.', 'rep', 'rank', 'rankLevel', [2, 3, 4]),
  achDef('flag_officer', 'Flag Officer', 'Rise through the senior ranks.', 'rep', 'rank', 'rankLevel', [5, 6, 7]),
  achDef('legend', 'Legend of the Reach', 'Reach the highest ranks.', 'rep', 'rank', 'rankLevel', [8, 9, 10], true),
  achDef('quartermaster', 'Quartermaster', 'Trade cargo through your docks (all stations).', 'warehouse', 'trade', 'cargoTraded', [1000, 20000, 200000]),
  achDef('magnate', 'Magnate', 'Gross income across all stations.', 'credits', 'economy', 'earnedLifetime', [100000, 2000000, 50000000], true),
  achDef('liner_host', 'Liner Host', 'Serve Aurelian Starways liners.', 'ship', 'trade', 'aurelianServed', [1, 10, 100]),
  achDef('convoy_master', 'Convoy Master', 'Serve ships during Convoy windows.', 'ship', 'trade', 'convoyServed', [15, 100, 500]),
  achDef('impatient', 'Impatient', 'Finish timers with Antimatter.', 'am', 'profile', 'skips', [5, 50, 300]),
];

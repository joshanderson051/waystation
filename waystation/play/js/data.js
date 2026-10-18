// ============================================================
// WAYSTATION — game data: modules, goods, planets, companies
// ============================================================
'use strict';

const GRID_COLS = 15;
const GRID_ROWS = 9;

// Station level thresholds: modules built + reputation stars
const LEVEL_THRESHOLDS = [
  { level: 1, modules: 0,  rep: 0 },
  { level: 2, modules: 6,  rep: 1.0 },
  { level: 3, modules: 14, rep: 2.0 },
  { level: 4, modules: 24, rep: 3.0 },
  { level: 5, modules: 36, rep: 4.0 },
];

// power: + produces, - consumes
const MODULES = {
  hub: { name: 'Core Hub', tier: 0, cost: 0, power: 10, color: '#5aa9ff', glyph: '⬢',
    desc: 'The heart of the station. Command, life support, and the first docking collar.',
    docks: 1, storage: 50, beds: 6, food: 10 },

  // ---- Tier 1: a way station ----
  dock: { name: 'Docking Bay', tier: 1, cost: 800, power: -2, color: '#8fd3ff', glyph: '🛰',
    desc: 'One more berth. Ships queue in orbit when every berth is full, and waiting makes companies grumpy.',
    docks: 1 },
  warehouse: { name: 'Cargo Warehouse', tier: 1, cost: 600, power: -1, color: '#c9a86a', glyph: '📦',
    desc: 'Holds 200 units of cargo. No room means you cannot buy what ships are hauling.',
    storage: 200 },
  solar: { name: 'Solar Array', tier: 1, cost: 500, power: 6, color: '#ffd45a', glyph: '☀',
    desc: 'Cheap power. Goes dark during solar flares.' },
  fuel: { name: 'Fuel Depot', tier: 1, cost: 900, power: -1, color: '#ff9d5a', glyph: '⛽',
    desc: 'Sells reaction mass to every docked ship. Steady income from day one.',
    fuelIncome: 60 },
  quarters: { name: 'Crew Quarters', tier: 1, cost: 700, power: -2, color: '#9fe3a8', glyph: '🛏',
    desc: 'Twenty bunks for visiting crews. Crews with a bed spend more and leave happier.',
    beds: 20 },
  cantina: { name: 'Cantina', tier: 1, cost: 800, power: -2, color: '#f5a3c7', glyph: '🍜',
    desc: 'Hot meals for 30 people a day. Everyone needs to eat.',
    food: 30, amenity: 'food' },

  // ---- Tier 2: a trading hub ----
  comms: { name: 'Comms Relay', tier: 2, cost: 2200, power: -2, color: '#b8c6ff', glyph: '📡',
    desc: 'Broadcasts your station to nearby shipping lanes. More ships find you.',
    traffic: 0.15 },
  market: { name: 'Trade Exchange', tier: 2, cost: 1500, power: -2, color: '#ffd98a', glyph: '⚖',
    desc: 'A proper exchange. Better trade margins and lets you set buy/sell policies per good.',
    margin: 0.05 },
  rec: { name: 'Rec Deck', tier: 2, cost: 1200, power: -3, color: '#d79bff', glyph: '🎮',
    desc: 'Games, bars, a zero-g court. Crews spend their pay here and rate you higher.',
    amenity: 'fun', fun: 30 },
  hydro: { name: 'Hydroponics', tier: 2, cost: 1300, power: -3, color: '#7ee787', glyph: '🌱',
    desc: 'Grows grain on board. Feeds 40 and adds 4 units of grain a day to your stores.',
    food: 40, produces: { grain: 4 } },
  clinic: { name: 'Med Bay', tier: 2, cost: 1400, power: -2, color: '#ff8f8f', glyph: '⚕',
    desc: 'Treats crews and residents. Prevents outbreaks spreading from cargo holds.',
    amenity: 'health' },
  habitat: { name: 'Residential Habitat', tier: 2, cost: 2000, power: -3, color: '#a8e6cf', glyph: '🏠',
    desc: 'Homes for 15 permanent residents. People settle when the station feels like a place to live.',
    homes: 15 },
  reactor: { name: 'Fusion Reactor', tier: 2, cost: 3000, power: 25, color: '#5affd0', glyph: '⚛',
    desc: 'Big, reliable power. Unaffected by flares.' },
  customs: { name: 'Customs Office', tier: 2, cost: 2000, power: -1, color: '#c7c7d9', glyph: '📋',
    desc: 'Collects a tariff on every unit of cargo that passes through your docks.',
    tariff: 1.5 },
  security: { name: 'Security Post', tier: 2, cost: 1800, power: -2, color: '#ff6b6b', glyph: '🛡',
    desc: 'Deters pirates and smugglers. Each post cuts raid losses.',
    security: 1 },

  // ---- Tier 3: a town in space ----
  school: { name: 'Academy', tier: 3, cost: 2500, power: -2, color: '#ffe08a', glyph: '🎓',
    desc: 'Families move in when there is a school. Resident growth doubles.',
    amenity: 'school' },
  bank: { name: 'Mercantile Bank', tier: 3, cost: 4000, power: -2, color: '#e3c15a', glyph: '🏦',
    desc: 'Opens lending to the shipping companies. Loans earn interest; trusted companies repay.',
    bank: true },
  plaza: { name: 'Promenade', tier: 3, cost: 3500, power: -3, color: '#ffb5e8', glyph: '🏪',
    desc: 'Shops and stalls run by residents. Every resident earns the station a little business income.',
    amenity: 'fun', business: 3 },
  menagerie: { name: 'Xeno Menagerie', tier: 3, cost: 2800, power: -4, color: '#9ef0c8', glyph: '🦎',
    desc: 'Houses live animals from a dozen worlds. Each specimen in stock draws paying visitors.',
    amenity: 'fun', exhibit: 'xenofauna' },
  refinery: { name: 'Ore Refinery', tier: 3, cost: 3200, power: -6, color: '#b07d4f', glyph: '🏭',
    desc: 'Turns 6 raw ore a day into 3 refined alloy, worth far more.',
    converts: { from: 'ore', to: 'alloy', inAmt: 6, outAmt: 3 } },
  shipyard: { name: 'Shipyard', tier: 3, cost: 5000, power: -5, color: '#8ab4ff', glyph: '🔧',
    desc: 'Repairs and refits. Large fees from every ship, and companies trust a station that fixes their hulls.',
    repairIncome: 150, trust: 1 },

  // ---- Tier 4: the galactic gate ----
  observatory: { name: 'Deep Space Observatory', tier: 4, cost: 4500, power: -2, color: '#c3b1ff', glyph: '🔭',
    desc: 'Scientists and explorers make the station a destination. Reputation climbs.',
    rep: 0.5 },
  gate: { name: 'Jump Gate Beacon', tier: 4, cost: 12000, power: -15, color: '#ff7ad9', glyph: '🌀',
    desc: 'Guides long-haul galactic liners to your docks. Huge cargoes, exotic goods, wealthy passengers.',
    galactic: true },
};

const MODULE_ORDER = ['dock','warehouse','solar','fuel','quarters','cantina',
  'comms','market','rec','hydro','clinic','habitat','reactor','customs','security',
  'school','bank','plaza','menagerie','refinery','shipyard','observatory','gate'];

const TIER_NAMES = { 1: 'Way Station', 2: 'Trading Hub', 3: 'Town in Space', 4: 'Galactic Gate', 5: 'Galactic Hub' };

// ------------------------------------------------------------
// Trade goods: base price per unit (credits)
// ------------------------------------------------------------
const GOODS = {
  ore:       { name: 'Raw Ore',         base: 8,   icon: '🪨', kind: 'mineral' },
  alloy:     { name: 'Refined Alloy',   base: 30,  icon: '🔩', kind: 'mineral' },
  crystals:  { name: 'Flux Crystals',   base: 45,  icon: '💎', kind: 'mineral' },
  water:     { name: 'Ice Water',       base: 5,   icon: '🧊', kind: 'mineral' },
  grain:     { name: 'Grain',           base: 6,   icon: '🌾', kind: 'crop' },
  fruit:     { name: 'Exotic Fruit',    base: 14,  icon: '🍈', kind: 'crop' },
  spice:     { name: 'Marrow Spice',    base: 40,  icon: '🌶', kind: 'crop' },
  livestock: { name: 'Livestock',       base: 25,  icon: '🐄', kind: 'animal' },
  xenofauna: { name: 'Xenofauna',       base: 70,  icon: '🦎', kind: 'animal' },
  textiles:  { name: 'Textiles',        base: 18,  icon: '🧵', kind: 'made' },
  tech:      { name: 'Tech Components', base: 55,  icon: '⚙', kind: 'made' },
  medicine:  { name: 'Medicine',        base: 60,  icon: '💊', kind: 'made' },
};
const GOOD_IDS = Object.keys(GOODS);

// ------------------------------------------------------------
// Planets: what they export (ships bring) and import (ships buy)
// ------------------------------------------------------------
const PLANETS = {
  keth:     { name: 'Keth Prime',    type: 'Agrarian world',   color: '#7ee787',
    exports: ['grain','fruit','livestock'], imports: ['tech','medicine','textiles'] },
  varro:    { name: "Varro's Reach", type: 'Mining colony',    color: '#c9a86a',
    exports: ['ore','crystals'],            imports: ['grain','water','medicine'] },
  sable:    { name: 'Sable',         type: 'Industrial hive',  color: '#8ab4ff',
    exports: ['tech','alloy'],              imports: ['ore','grain','spice','livestock'] },
  thessaly: { name: 'Thessaly',      type: 'Ocean world',      color: '#5affd0',
    exports: ['water','xenofauna'],         imports: ['tech','textiles','grain'] },
  marrow:   { name: 'Marrow',        type: 'Desert world',     color: '#ff9d5a',
    exports: ['spice','textiles'],          imports: ['water','grain','medicine'] },
  oros:     { name: 'Oros',          type: 'Jungle moon',      color: '#9ef0c8',
    exports: ['xenofauna','medicine','fruit'], imports: ['tech','alloy'] },
  aurelia:  { name: 'Aurelia Core',  type: 'Galactic capital', color: '#ff7ad9', galactic: true,
    exports: ['tech','medicine','textiles'], imports: ['xenofauna','spice','crystals','fruit'] },
};

// ------------------------------------------------------------
// Shipping companies
// ------------------------------------------------------------
const COMPANIES = [
  { id: 'halvorsen', name: 'Halvorsen Freight',  color: '#c9a86a', home: 'varro',
    ships: ['hauler','freighter'], blurb: 'Bulk ore haulers. Slow, huge, and always hungry for fuel.' },
  { id: 'kestrel',   name: 'Kestrel Lines',      color: '#8ab4ff', home: 'sable',
    ships: ['courier','freighter'], blurb: 'Fast couriers moving tech and medicine between the inner worlds.' },
  { id: 'ouroboros', name: 'Ouroboros Haulage',  color: '#9ef0c8', home: 'oros',
    ships: ['freighter'], blurb: 'Specialists in live cargo. Their holds smell like a jungle.' },
  { id: 'meridian',  name: 'Meridian Co-op',     color: '#7ee787', home: 'keth',
    ships: ['freighter','hauler'], blurb: 'Farmer-owned co-op shipping grain and fruit to the colonies.' },
  { id: 'redsand',   name: 'Red Sand Caravans',  color: '#ff9d5a', home: 'marrow',
    ships: ['courier','freighter'], blurb: 'Spice and textile traders. Shrewd, loyal, and quick to anger.' },
  { id: 'tidewater', name: 'Tidewater Shipping', color: '#5affd0', home: 'thessaly',
    ships: ['hauler','freighter'], blurb: 'Water tankers and the occasional very wet xenofauna crate.' },
  { id: 'aurelian',  name: 'Aurelian Starways',  color: '#ff7ad9', home: 'aurelia', galactic: true,
    ships: ['liner'], blurb: 'Galactic liners carrying wealthy passengers and rare goods. Needs a Jump Gate.' },
];

const SHIP_CLASSES = {
  courier:   { name: 'Courier',        cargo: 30,  crew: 4,  dockDays: 0.6, dockFee: 150, size: 6 },
  freighter: { name: 'Freighter',      cargo: 80,  crew: 10, dockDays: 1.0, dockFee: 280, size: 8 },
  hauler:    { name: 'Bulk Hauler',    cargo: 180, crew: 16, dockDays: 1.6, dockFee: 450, size: 11 },
  liner:     { name: 'Galactic Liner', cargo: 120, crew: 40, dockDays: 2.0, dockFee: 1000, size: 13, passengers: 60 },
};

// ------------------------------------------------------------
// Random events
// ------------------------------------------------------------
const EVENTS = [
  { id: 'flare', title: 'Solar Flare', weight: 3,
    text: 'A coronal mass ejection washes over the station. Solar arrays are offline for 3 days.' },
  { id: 'pirates', title: 'Pirate Raid', weight: 2, minLevel: 2,
    text: 'Raiders hit a cargo bay. Security posts drive them off faster.' },
  { id: 'boom', title: 'Trade Boom', weight: 3,
    text: 'Demand spikes across the sector. {good} prices triple for 4 days.' },
  { id: 'glut', title: 'Market Glut', weight: 2,
    text: 'A bumper harvest floods the lanes. {good} prices halve for 4 days.' },
  { id: 'outbreak', title: 'Hold Fever', weight: 2, minLevel: 2,
    text: 'Sickness spreads from a livestock hold. A Med Bay contains it; without one, residents leave.' },
  { id: 'refugees', title: 'Refugee Convoy', weight: 2, minLevel: 2, choice: true,
    yes: 'Take them in', no: 'Turn them away',
    text: 'A convoy from a failed colony asks for shelter. Taking them in needs free homes, but word travels.' },
  { id: 'explorer', title: 'Famous Explorer Docks', weight: 1, minLevel: 2,
    text: 'A celebrated deep-space explorer stops over. The press follows. Reputation rises.' },
  { id: 'contract', title: 'Shipping Contract', weight: 2, minLevel: 2, choice: true,
    yes: 'Sign it', no: 'Decline',
    text: '{company} offers a standing contract: extra ships for 10 days in exchange for a 15% fee discount.' },
  { id: 'smugglers', title: 'Smugglers Caught', weight: 1, minLevel: 2,
    text: 'Customs catches a smuggling ring. The seized cargo is yours.' },
  { id: 'festival', title: 'Station Festival', weight: 2, minLevel: 3,
    text: 'Residents throw a festival on the Promenade. Visitors spend freely for 3 days.' },
];

const CAPTAIN_NAMES = ['Okafor','Lindqvist','Reyes','Tanaka','Mbeki','Varga','Haddad','Sorensen',
  'Delacroix','Nakamura','Oyelaran','Petrova','Banerjee','Castellanos','Ferreira','Quist','Achebe','Moreau'];

const STATION_NAMES = ['Halfway Point','Lantern Reach','Threshold','Far Harbor','Kessler Station',
  'The Crossing','Vigil','Anchorage Nine','Lodestar','Pilgrim\'s Rest'];

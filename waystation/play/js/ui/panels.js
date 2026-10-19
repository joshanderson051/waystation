// ============================================================
// WAYSTATION v2 — ui/panels.js
// Engineer H. Source of truth: DESIGN2.md 5.2 (panels), 7.3 (store panel),
// 4.5–4.10 (the data each panel shows); DESIGN.md 6.1–6.6 (v1 content
// grammar: build cards, QoL, market table, company cards) carried over.
//
// Every panel is Panels.<id>(host, ctx) -> { update(), destroy() }.
//   host : the #panel element (glass frame; this file writes head/body/foot)
//   ctx  : { ui, meta, engine, store, sound, state() } from hud.js
//          ui    = the UI facade plus the panel verbs it exposes (place,
//                  collect, collectAll, skipBuild, upgrade, demolish, travel,
//                  unlock, launch, debrief, instantReturn, claimMission,
//                  purchase, restore, focusCell, focusShip, rename, ...)
//          meta  = the Meta adapter (names fixed in hud.js, section 0)
//          state = () => Sim.state
// Rendering is signature-diffed: update() re-renders only when the HTML
// changes, countdown labels and rings tick in place every 250ms.
//
// Exports (global): Panels, PANEL_DEFS, SILHOUETTES, SECTOR_LOOK
// ============================================================
'use strict';

// Panel registry: order = rail order (settings pinned at the bottom by CSS)
const PANEL_DEFS = [
  { id: 'build', label: 'Build', icon: 'build', key: 'B', hue: 'amber' },
  { id: 'station', label: 'Station', icon: 'station', key: 'S', hue: 'ice' },
  { id: 'market', label: 'Market', icon: 'market', key: 'M', hue: 'amber' },
  { id: 'fleet', label: 'Fleet', icon: 'fleet', key: 'F', hue: 'sage' },
  { id: 'expeditions', label: 'Expeditions', icon: 'expeditions', key: 'E', hue: 'ice' },
  { id: 'map', label: 'Map', icon: 'map', key: 'G', hue: 'ivory' },
  { id: 'missions', label: 'Missions', icon: 'missions', key: 'J', hue: 'amber' },
  { id: 'registry', label: 'Registry', icon: 'registry', key: 'R', hue: 'rose' },
  { id: 'store', label: 'Store', icon: 'store', key: '', hue: 'am' },
  { id: 'settings', label: 'Settings', icon: 'settings', key: '', hue: 'ice', pinned: true },
];

// Sector looks for planet thumbnails and map nodes (4.5); SECTORS[id].theme
// overrides base / rim when present.
const SECTOR_LOOK = {
  home:     { kind: 'rock',   base: '#D9A866', dark: '#8A5A2A', rim: '#FFE9B8', bands: true, caps: true },
  sable:    { kind: 'rock',   base: '#B8793A', dark: '#5A3414', rim: '#E9C27C', storms: true },
  kessler:  { kind: 'belt',   base: '#8C949F', dark: '#3A404A', rim: '#BFC6D0' },
  thessaly: { kind: 'rock',   base: '#2F6FB5', dark: '#12305E', rim: '#BFE8F4', swirls: true },
  marrow:   { kind: 'rock',   base: '#4A1E1E', dark: '#1A0808', rim: '#FF6A3D', lava: true },
  oros:     { kind: 'gas',    base: '#C9A26A', dark: '#6A4A2E', rim: '#FFE1A8', bands: true, rings: true },
  keth:     { kind: 'rock',   base: '#4FA86B', dark: '#1E5A3A', rim: '#CBE2C4', bands: true, caps: true },
  aurelia:  { kind: 'nebula', base: '#7A4CC8', dark: '#2A1250', rim: '#DDB8FF', dwarf: true },
};
// expedition fallbacks by sector order (A1.1) when EXPEDITIONS does not carry them
const EXPEDITION_MINUTES = [30, 60, 120, 240, 360, 480, 720, 1440];
// build times by tier (A1.1) when neither MODULES[id].buildMs nor TIMERS.BUILD_MS exists
const TIER_BUILD_MS = { 1: 90e3, 2: 720e3, 3: 3600e3, 4: 14400e3 };

// 48x48 silhouettes for the Registry (4.10); ids are the HUD's own, data2
// entries map by `silhouette`, by id, else by index so no card is blank.
const SILHOUETTES = {
  ships: {
    courier:   'M24 4l6 14v16l-6 10-6-10V18Z M18 24l-8 6v8l8-4 M30 24l8 6v8l-8-4 M24 14v16',
    freighter: 'M18 6h12l4 8v22l-4 8H18l-4-8V14Z M14 20H8v10h6 M34 20h6v10h-6 M20 12h8 M20 36h8',
    hauler:    'M12 8h24v32H12Z M12 16h24 M12 24h24 M12 32h24 M8 12H4v24h4 M40 12h4v24h-4 M18 40l2 6h8l2-6',
    liner:     'M24 2c6 6 10 16 10 28l-4 12H18l-4-12C14 18 18 8 24 2Z M14 24l-8 10v6l8-6 M34 24l8 10v6l-8-6 M20 14h8 M20 20h8 M20 26h8',
  },
  // the twelve species silhouette ids from COLLECTION.species[].silhouette
  species: {
    dustkin:    'M24 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z M12 44c0-12 4-20 12-22 8 2 12 10 12 22Z M19 11h10',
    gardener:   'M24 4a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z M16 44c0-16 3-26 8-28 5 2 8 12 8 28Z M32 20c6-2 10 0 12 4-4 2-8 2-12-4Z',
    foundry:    'M24 4C14 8 10 18 10 44h28C38 18 34 8 24 4Z M16 18h16v4H16Z',
    swimmer:    'M24 4a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z M16 44c0-14 3-22 8-24 5 2 8 10 8 24Z M14 26l-8 6 6 2 M34 26l8 6-6 2',
    nomad:      'M24 4a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z M14 44c0-14 4-22 10-24 6 2 10 10 10 24Z M38 12v32',
    canopy:     'M24 6a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z M24 14v14 M24 20l-10-6 M24 20l10-6 M24 28l-8 14 M24 28l8 14',
    envoy:      'M24 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z M14 44c0-14 4-22 10-24 6 2 10 10 10 24Z M10 10a14 4 0 1 0 28 0',
    moth:       'M24 10v30 M24 18c-6-8-14-10-20-6 2 8 10 12 20 10 M24 18c6-8 14-10 20-6-2 8-10 12-20 10 M24 26c-6 0-12 4-14 12 6-2 10-4 14-8 M24 26c6 0 12 4 14 12-6-2-10-4-14-8 M20 10l-4-6 M28 10l4-6',
    tidesinger: 'M6 30c4-8 10-10 14-6s8 4 12-2 8-8 10-4-2 10-8 10-8-4-12 0-8 8-12 8-6-2-4-6Z M8 28l-2-6 M11 27l-1-7',
    ashwalker:  'M8 40l4-14 6 6 6-20 6 20 6-6 4 14Z M20 28l4-8 4 8',
    drifter:    'M24 4a14 14 0 1 1 0 28 14 14 0 0 1 0-28Z M18 32l-2 12 M24 32v12 M30 32l2 12 M18 18h2 M28 18h2',
    warden:     'M24 4C14 8 10 18 10 44h28C38 18 34 8 24 4Z M24 12c-4 0-6 4-6 8 0 5 6 8 6 8s6-3 6-8c0-4-2-8-6-8Z',
  },
  // the sixteen artifact ids from COLLECTION.artifacts
  artifacts: {
    beacon_shard:   'M24 4l8 14-8 26-8-26Z M24 4v40',
    survey_plate:   'M8 10h32v28H8Z M12 14h24v20H12Z M16 20l6 4 6-6 6 8',
    storm_glass:    'M4 24c6-10 12-14 20-14s14 4 20 14c-6 10-12 14-20 14S10 34 4 24Z M24 16a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z M24 21a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    foundry_seal:   'M6 24a18 18 0 1 0 36 0 18 18 0 0 0-36 0Z M12 24a12 12 0 1 0 24 0 12 12 0 0 0-24 0Z M24 16v16 M18 20l12 8 M30 20l-12 8',
    core_fragment:  'M10 14h18l10 10-10 10H10Z M10 14v20 M16 20v8 M22 18v12 M38 24h6 M44 20v8',
    dead_ship_log:  'M10 8h24a4 4 0 0 1 4 4v28H14a4 4 0 0 1-4-4Z M14 40a4 4 0 0 1 0-8h24 M16 14h14 M16 20h10 M16 26h12',
    deep_pearl:     'M24 10a12 12 0 1 0 0 24 12 12 0 0 0 0-24Z M12 40h24 M16 34l-4 6 M32 34l4 6 M18 16c2-2 4-3 6-3',
    tide_compass:   'M6 24a18 18 0 1 0 36 0 18 18 0 0 0-36 0Z M24 8 29 24 24 40 19 24Z M24 20a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    obsidian_idol:  'M18 6h12l2 8-4 4v8l6 6-2 12H16l-2-12 6-6v-8l-4-4Z M22 12h4',
    caravan_ledger: 'M8 8h32v32H8Z M8 16h32 M8 24h32 M8 32h32 M16 8v32',
    ring_lens:      'M24 6a18 18 0 1 0 0 36 18 18 0 0 0 0-36Z M24 14a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M12 18c4-4 8-6 12-6',
    halo_chime:     'M12 6h24 M18 6v26a6 6 0 0 0 12 0V6 M16 40h16 M24 32v8',
    seed_key:       'M24 4a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M24 10a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M24 24v20 M24 34h8 M24 40h6',
    meridian_loom:  'M8 8h32v32H8Z M14 8v32 M20 8v32 M26 8v32 M32 8v32 M8 16h32 M8 24h32 M8 32h32',
    gate_resonator: 'M24 4l10 10-10 30-10-30Z M24 4v40 M8 20c-2 3-2 6 0 9 M40 20c2 3 2 6 0 9',
    first_chart:    'M10 8h28v32H10Z M6 8h4v32H6Z M38 8h4v32h-4Z M18 18l2 2 M28 24l2 2 M22 30l2 2 M20 20l8 4-6 6',
  },
};

// ------------------------------------------------------------
// 1. Shared helpers
// ------------------------------------------------------------
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
  const c = (typeof COMPANIES !== 'undefined' ? COMPANIES : []).find(x => x.id === id);
  return c ? c.color : 'var(--amber)';
}
const coDef = id => (typeof COMPANIES !== 'undefined' ? COMPANIES : []).find(x => x.id === id);
const thr = v => v > 0.75 ? 'good' : v > 0.4 ? 'warn' : 'bad';
const trustCls = t => t > 70 ? 'good' : t > 40 ? 'warn' : 'bad';
const TIER_WORD = { good: 'OK', warn: 'Low', bad: 'Bad' };
const TIER_SHAPE = { good: 'up', warn: 'sq', bad: 'down' };
const MID = GLYPH.mid;

// module meta with 4.2 / 4.3 fallbacks when data.js has not been extended yet
const modRate = (id, lvl = 1) => { const d = MODULES[id]; const base = d.rate != null ? d.rate : (id === 'hub' ? 10 : Math.round(d.cost / 40)); return Math.round(base * (lvl === 3 ? 2.4 : lvl === 2 ? 1.6 : 1)); };
const modBuildMs = (id, sectorIdx = 0) => {
  const d = MODULES[id], T = (typeof TIMERS !== 'undefined' && TIMERS && TIMERS.BUILD_MS) || null;
  const base = d.buildMs != null ? d.buildMs : (T && T[d.tier] != null) ? T[d.tier] : (TIER_BUILD_MS[d.tier] || 90e3);
  const def = sectorList()[sectorIdx], mul = def && def.buildMul ? def.buildMul : (sectorIdx >= 4 ? 1.5 : 1);
  return base * mul;
};
// upgrades take 2x the build time to level 2 and 5x to level 3 (A1.1)
const upgradeMs = (id, toLvl, sectorIdx = 0) => modBuildMs(id, sectorIdx) * (toLvl >= 3 ? 5 : 2);

// sectors in order whether SECTORS is an array or an id-keyed object
function sectorList() {
  if (typeof SECTORS === 'undefined' || !SECTORS) return [];
  return Array.isArray(SECTORS) ? SECTORS : Object.keys(SECTORS).map(k => Object.assign({ id: k }, SECTORS[k]));
}
const sectorIndex = id => Math.max(0, sectorList().findIndex(s => s.id === id));

// 5.4 / 2.5 shelf: label on the rule, mono tag right; `tag` is HTML, `label` escaped
function shelf(label, tag, o = {}) {
  const cls = ['shelf', o.first ? 'first' : '', o.cls || ''].filter(Boolean).join(' ');
  const hue = o.hue ? ` style="--hue:${o.hue}"` : '';
  const tagHtml = tag == null ? '' : `<span class="shelf-tag${o.tagCls ? ' ' + o.tagCls : ''}">${tag}</span>`;
  return `<h3 class="${cls}"${hue}${o.attrs || ''}><span class="shelf-label">${esc(label)}</span>${tagHtml}</h3>`;
}
// SVG progress ring (2.5): 2px track, 3px arc, rounded caps; pct 0..1
// timer = { until, total } makes the arc live (tickTimers drives the offset); otherwise pct is static
function ring(pct, size = 44, hue = 'var(--ice)', inner = '', timer = null) {
  const r = (size - 4) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct || 0));
  const live = timer ? ` data-until="${Math.round(timer.until)}" data-total="${Math.round(timer.total)}"` : '';
  return `<span class="ring" style="--size:${size}px;--hue:${hue}"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">` +
    `<circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}"/>` +
    `<circle class="ring-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${timer ? c.toFixed(2) : (c * (1 - p)).toFixed(2)}" data-c="${c.toFixed(2)}"${live}/></svg>` +
    (inner ? `<span class="ring-in">${inner}</span>` : '') + `</span>`;
}
// a segmented bar: 20 segments, filled round(v*20), hue by class
const segBar = (v, cls) => `<span class="segbar ${cls || ''}" style="--n:${Math.round(Math.max(0, Math.min(1, v)) * 20)}"></span>`;
const pips = (power) => {
  const ap = Math.abs(power), n = Math.min(6, ap);
  let h = '';
  if (ap > 6) h += `<span class="pnum">${power > 0 ? '+' : GLYPH.minus}${ap}</span>`;
  h += (power > 0 ? '<i class="pip"></i>' : '<i class="pip off"></i>').repeat(n);
  return `<span class="pips">${h}</span>`;
};
const plate = (id, size = 22) => `<span class="plate" style="--hue:${famHue(id)}">${icon(id, size)}</span>`;
const countdown = (until, cls = '') => `<span class="num cd ${cls}" data-until="${Math.round(until)}"></span>`;   // text filled by tickTimers
const lvlTicks = lvl => `<span class="lvl" title="Level ${lvl}">${[1, 2, 3].map(i => `<i class="${i <= lvl ? 'on' : ''}"></i>`).join('')}<span class="lvl-n">L${lvl}</span></span>`;

let _svgSeq = 0;
// darken a hex colour toward black by k (0..1) for terminators and bands
function shade(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) return hex;
  const n = parseInt(m[1], 16), f = v => Math.round(v * (1 - k)).toString(16).padStart(2, '0');
  return '#' + f((n >> 16) & 255) + f((n >> 8) & 255) + f(n & 255);
}
// Sector planet thumbnail (4.5 themes): a disc with terminator, rim glow and the theme's feature.
// SECTORS[id].theme.planet { kind, color, rim, bands, caps, storms, swirls, cracks, rings, dwarf, none } wins over SECTOR_LOOK.
function planetSvg(id, size = 56, def) {
  const look = Object.assign({}, SECTOR_LOOK[id] || SECTOR_LOOK.home);
  const th = def && def.theme && def.theme.planet && typeof def.theme.planet === 'object' ? def.theme.planet : null;
  if (th) {
    if (th.color) { look.base = th.color; look.dark = shade(th.color, .6); }
    if (th.rim) look.rim = th.rim;
    if (th.none || th.kind === 'none') look.kind = 'belt'; else if (th.kind === 'gas') look.kind = 'gas'; else if (th.dwarf || th.kind === 'dwarf') look.kind = 'nebula'; else look.kind = 'rock';
    for (const k of ['bands', 'caps', 'storms', 'swirls', 'rings', 'dwarf']) if (th[k] != null) look[k] = !!th[k];
    if (th.cracks != null) look.lava = !!th.cracks;
    if (look.kind === 'nebula') { look.base = (def.theme.nebula && def.theme.nebula[1]) || look.base; look.rim = th.rim || look.rim; }
  }
  const u = 'p' + (++_svgSeq), c = size / 2, R = size * 0.36;
  let body = '';
  if (look.kind === 'belt') {
    const rocks = [[.3, .45, .11], [.52, .3, .07], [.68, .55, .13], [.42, .7, .08], [.78, .3, .05], [.22, .72, .05], [.6, .78, .06]];
    body = rocks.map(([x, y, r]) => `<circle cx="${(x * size).toFixed(1)}" cy="${(y * size).toFixed(1)}" r="${(r * size).toFixed(1)}" fill="url(#${u}g)"/>`).join('');
  } else if (look.kind === 'nebula') {
    body = `<ellipse cx="${c}" cy="${c}" rx="${R * 1.3}" ry="${R * .9}" fill="url(#${u}n)" transform="rotate(-25 ${c} ${c})"/>` +
      `<ellipse cx="${c * .9}" cy="${c * 1.1}" rx="${R * .9}" ry="${R * .5}" fill="url(#${u}n)" opacity=".7" transform="rotate(20 ${c} ${c})"/>` +
      (look.dwarf ? `<circle cx="${c * 1.15}" cy="${c * .85}" r="${size * .055}" fill="#FFFFFF"/><circle cx="${c * 1.15}" cy="${c * .85}" r="${size * .11}" fill="#FFFFFF" opacity=".25"/>` : '');
  } else {
    body = `<circle cx="${c}" cy="${c}" r="${R}" fill="url(#${u}g)"/>`;
    if (look.bands) body += `<path d="M${c - R * .98} ${c - R * .3}q${R} ${R * .25} ${R * 1.96} 0 M${c - R * .9} ${c + R * .25}q${R} ${R * .2} ${R * 1.8} 0 M${c - R * .7} ${c + R * .6}q${R * .7} ${R * .15} ${R * 1.4} 0" stroke="${look.dark}" stroke-width="${size * .035}" fill="none" opacity=".55" stroke-linecap="round"/>`;
    if (look.caps) body += `<ellipse cx="${c}" cy="${c - R * .82}" rx="${R * .5}" ry="${R * .14}" fill="#FFFFFF" opacity=".55"/>`;
    if (look.swirls) body += `<path d="M${c - R * .6} ${c - R * .2}c${R * .3} -${R * .3} ${R * .7} -${R * .1} ${R * .9} ${R * .2} M${c - R * .4} ${c + R * .45}c${R * .3} -${R * .25} ${R * .6} -${R * .05} ${R * .8} ${R * .15}" stroke="#FFFFFF" stroke-width="${size * .03}" fill="none" opacity=".6" stroke-linecap="round"/>`;
    if (look.storms) body += `<circle cx="${c + R * .3}" cy="${c + R * .2}" r="${R * .22}" fill="${look.rim}" opacity=".5"/><circle cx="${c - R * .35}" cy="${c - R * .3}" r="${R * .14}" fill="${look.rim}" opacity=".4"/>`;
    if (look.lava) body += `<path d="M${c - R * .7} ${c + R * .1}l${R * .4} -${R * .3} ${R * .3} ${R * .4} ${R * .5} -${R * .2} M${c - R * .2} ${c + R * .7}l${R * .3} -${R * .4} ${R * .4} ${R * .2}" stroke="${look.rim}" stroke-width="${size * .03}" fill="none" stroke-linecap="round" opacity=".9"/>`;
    if (look.rings) body += `<ellipse cx="${c}" cy="${c}" rx="${R * 1.55}" ry="${R * .32}" stroke="${look.rim}" stroke-width="${size * .04}" fill="none" opacity=".75" transform="rotate(-18 ${c} ${c})"/>`;
    body += `<circle cx="${c}" cy="${c}" r="${R}" fill="url(#${u}t)"/>`;
  }
  return `<svg class="planet" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><defs>` +
    `<radialGradient id="${u}g" cx="38%" cy="35%" r="70%"><stop offset="0" stop-color="${look.rim}" stop-opacity=".9"/><stop offset=".35" stop-color="${look.base}"/><stop offset="1" stop-color="${look.dark}"/></radialGradient>` +
    `<linearGradient id="${u}t" x1="0" y1="0" x2="1" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></linearGradient>` +
    `<radialGradient id="${u}n" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${look.rim}" stop-opacity=".9"/><stop offset=".5" stop-color="${look.base}" stop-opacity=".6"/><stop offset="1" stop-color="${look.base}" stop-opacity="0"/></radialGradient>` +
    `</defs><circle cx="${c}" cy="${c}" r="${R * 1.12}" fill="${look.rim}" opacity="${look.kind === 'rock' || look.kind === 'gas' ? '.14' : '0'}"/>${body}</svg>`;
}
// 48px silhouette card art; `found` draws in hue, else a dark ghost
function silhouette(group, idOrItem, index, found, hue) {
  const set = SILHOUETTES[group] || SILHOUETTES.artifacts, keys = Object.keys(set);
  const item = typeof idOrItem === 'object' ? idOrItem : { id: idOrItem };
  const key = (item.silhouette && set[item.silhouette]) ? item.silhouette : (item.cls && set[item.cls]) ? item.cls : set[item.id] ? item.id : keys[(index || 0) % keys.length];
  return `<svg class="sil${found ? ' found' : ''}" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" style="--hue:${hue || 'var(--ivory)'}"><path d="${set[key]}"/></svg>`;
}

// Signature-diffed render that keeps the scroll position and staggers rows on first paint (2.2).
// Live values (countdowns, rings, hopper banks) are filled by tickTimers right after the paint and
// every 250ms after that, so a ticking number never forces a whole-panel re-render.
function paint(el, html, store, key, meta) {
  if (!el) return false;
  if (store[key] === html && store.__last === key) return false;   // same key and same HTML: nothing to do; a different key (tab) always repaints
  const first = store[key] == null;
  store[key] = html; store.__last = key;
  const scroll = el.scrollTop;
  el.innerHTML = html;
  if (first) {
    let i = 0;
    for (const ch of el.children) {
      ch.style.setProperty('--i', String(i++)); ch.classList.add('row-in');
      // drop the finished animation: a retained fill-mode keeps a compositor layer that paints stale under glass
      const done = () => ch.classList.remove('row-in');
      ch.addEventListener('animationend', done, { once: true });
      setTimeout(done, 1200);
    }
  }
  el.scrollTop = scroll;
  tickTimers(el, meta);
  return true;
}
// Live readouts between renders: [data-until] countdowns, .ring-arc[data-until] arcs,
// [data-live="bank:r,c" | "bankpct:r,c" | "banked"] hopper figures.
function tickTimers(root, meta) {
  if (!root) return;
  const now = Date.now();
  for (const el of root.querySelectorAll('[data-until]')) { if (el.classList.contains('ring-arc')) continue; const s = Fmt.ms(+el.dataset.until - now); if (el.textContent !== s) el.textContent = s; }
  for (const el of root.querySelectorAll('.ring-arc[data-until]')) {
    const total = +el.dataset.total || 1, left = Math.max(0, +el.dataset.until - now), c = +el.dataset.c;
    el.setAttribute('stroke-dashoffset', (c * (left / total)).toFixed(2));
  }
  if (!meta) return;
  for (const el of root.querySelectorAll('[data-live]')) {
    const [kind, rc] = el.dataset.live.split(':');
    if (kind === 'banked') { const s = Fmt.n(meta.bankedTotal()); if (el.textContent !== s) el.textContent = s; continue; }
    const [r, c] = (rc || '').split(',').map(Number), hp = meta.hopper(r, c); if (!hp) continue;
    if (kind === 'bank') { const s = Fmt.n(Math.floor(hp.bank)); if (el.textContent !== s) el.textContent = s; }
    else if (kind === 'bankpct') el.style.setProperty('--p', (hp.cap ? Math.min(100, hp.bank / hp.cap * 100) : 0).toFixed(1) + '%');
  }
}

const TIER_WORDS = ['bronze', 'silver', 'gold'];

// A1.2 Territory block for the Station overview: plot size, ring k of n, Expand or the clearing timer.
// A compact plan of the grid shows the plot (ice) and the next ring (dashed).
function territoryBlock(s, ctx) {
  const p = ctx.meta.plot(); if (!p || p.whole) return '';
  const rows = s.grid.length, cols = s.grid[0].length, w = p.c1 - p.c0 + 1, hgt = p.r1 - p.r0 + 1, cl = p.clearing, nx = p.next;
  const g = 4, W = cols * g, H = rows * g;
  const nb = { r0: Math.max(0, p.r0 - 1), c0: Math.max(0, p.c0 - 1), r1: Math.min(rows - 1, p.r1 + 1), c1: Math.min(cols - 1, p.c1 + 1) };
  const plan = `<svg class="plot-plan" viewBox="-1 -1 ${W + 2} ${H + 2}" width="${Math.round(W * 1.4)}" height="${Math.round(H * 1.4)}" aria-hidden="true">` +
    `<rect class="pp-grid" x="0" y="0" width="${W}" height="${H}"/>` +
    (nx || cl ? `<rect class="pp-next${cl ? ' clearing' : ''}" x="${nb.c0 * g}" y="${nb.r0 * g}" width="${(nb.c1 - nb.c0 + 1) * g}" height="${(nb.r1 - nb.r0 + 1) * g}"/>` : '') +
    `<rect class="pp-plot" x="${p.c0 * g}" y="${p.r0 * g}" width="${w * g}" height="${hgt * g}"/></svg>`;
  let h = shelf('Territory', esc(`${p.ring ? `Ring ${p.ring} of ${Math.max(1, p.rings - 1)}` : 'Starting plot'} ${MID} ${w}x${hgt} plot`), { hue: 'var(--ice)' });
  if (cl) {
    const left = cl.remainingMs != null ? cl.remainingMs : Math.max(0, (cl.endsAt || 0) - Date.now()), until = cl.endsAt || Date.now() + left, total = Math.max(1, cl.totalMs || left);
    const am = cl.skipAM != null ? cl.skipAM : Math.max(1, Math.ceil(left / 480000));
    h += `<div class="block ice terr"><i class="spine"></i>${ring(0, 56, 'var(--ice)', icon('territory', 22), { until, total })}` +
      `<div class="block-main"><span class="tile-lbl">Clearing ring ${cl.ring}</span><span class="bank-val num c-ice">${countdown(until)}</span><span class="bank-note">Crews are clearing the debris. The plot grows to ring ${cl.ring} when they finish.</span></div>` +
      `<button type="button" class="btn big am" data-act="skip-plot" title="Finish now">${icon('skip', 16)}<span>Skip ${MID} ${am} AM</span></button></div>`;
  } else if (nx) {
    const short = s.credits < nx.cost ? nx.cost - s.credits : 0, cannot = !!short || nx.affordable === false;
    h += `<div class="block ice terr"><i class="spine"></i>${plan}<div class="block-main"><span class="tile-lbl">Next ring ${nx.ring} ${MID} ${Fmt.n(nx.cells)} cells</span><span class="bank-val num c-ice">${Fmt.n(nx.cost)}<small> cr</small></span><span class="bank-note">${icon('clock', 12)} ${Fmt.dur(nx.ms)} to clear${cannot ? ` ${MID} <span class="c-warn">${short ? `need ${Fmt.n(short)} more` : 'not yet affordable'}</span>` : ''}</span></div>` +
      `<button type="button" class="btn big${cannot ? '' : ' primary'}" data-act="expand">${icon('territory', 16)}<span>Expand</span></button></div>`;
  } else {
    h += `<div class="block ice terr"><i class="spine"></i>${plan}<div class="block-main"><span class="tile-lbl">Whole sector claimed</span><span class="bank-note">${w}x${hgt}, ${Fmt.n(p.cells)} cells. Nothing left to clear here.</span></div></div>`;
  }
  return h;
}

// ------------------------------------------------------------
// 2. Panel frame: head (Display title + micro subtitle + close), optional
//    tab strip, scrollable body, optional sticky footer.
// ------------------------------------------------------------
function frame(host, spec, ctx) {
  const def = PANEL_DEFS.find(p => p.id === spec.id) || {};
  host.dataset.hue = spec.hue || def.hue || 'amber';
  const tabs = spec.tabs ? `<div class="panel-tabs" role="tablist">${spec.tabs.map(t => `<button type="button" role="tab" class="ptab${t.id === spec.tab ? ' active' : ''}" data-tab="${t.id}" aria-selected="${t.id === spec.tab}">${esc(t.label)}${t.badge ? `<span class="ptab-badge">${t.badge}</span>` : ''}</button>`).join('')}</div>` : '';
  host.innerHTML = `<i class="spine"></i><header class="panel-head"><div class="panel-head-main"><h2 class="panel-title">${esc(spec.title)}</h2><div class="panel-sub micro">${spec.sub || ''}</div></div>` +
    `<button type="button" class="btn icon ghost panel-close" title="Close (Esc)" aria-label="Close panel">${icon('close', 16)}</button></header>${tabs}<div class="panel-body" tabindex="0"></div>${spec.foot ? '<footer class="panel-foot"></footer>' : ''}`;
  const body = host.querySelector('.panel-body'), foot = host.querySelector('.panel-foot');
  host.querySelector('.panel-close').addEventListener('click', () => ctx.ui.closePanel());
  return {
    body, foot, sub: host.querySelector('.panel-sub'), tabs: host.querySelector('.panel-tabs'),
    setSub(html) { const s = host.querySelector('.panel-sub'); if (s && s.innerHTML !== html) s.innerHTML = html; },
    setTab(id) { for (const b of $$('.ptab', host)) { const on = b.dataset.tab === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); } },
  };
}

// ------------------------------------------------------------
// 3. Panels
// ------------------------------------------------------------
const Panels = {
  // ---------------------------------------------------------- Build (5.2)
  build(host, ctx) {
    const F = frame(host, { id: 'build', title: 'Build', sub: '' }, ctx), sig = {};
    const render = () => {
      const s = ctx.state(); if (!s) return;
      const T = Sim.totals(), placing = ctx.engine.placing();
      const rate = Sim.cells().reduce((a, { r, c, m }) => { const hp = ctx.meta.hopper(r, c); return a + (hp ? hp.rate : modRate(m.id)); }, 0);
      F.setSub(`Level ${s.level} ${MID} ${T.modules} module${T.modules === 1 ? '' : 's'} ${MID} ${Fmt.n(s.credits)} cr`);
      const over = T.used > T.produced;
      let h = `<div class="tiles"><div class="tile"><span class="tile-lbl">Station rate</span><span class="tile-val num c-amber-hi">+${Fmt.n(rate)}<small>/min</small></span></div>` +
        `<div class="tile"><span class="tile-lbl">Power</span><span class="tile-val num ${over ? 'c-bad' : T.flare ? 'c-warn' : 'c-ice'}">${over ? GLYPH.down + ' ' : T.flare ? GLYPH.sq + ' ' : ''}${T.used} / ${T.produced}</span></div>` +
        `<div class="tile"><span class="tile-lbl">Berths</span><span class="tile-val num c-ice">${T.docks}</span></div></div>`;
      const sIdx = sectorIndex(s.sector || 'home');
      // A1.2: is there any empty cell inside the plot that touches the station? If not, every tier needs more plot.
      const plot = ctx.meta.plot();
      let freeInPlot = !plot;
      if (plot) {
        outer: for (let r = plot.r0; r <= plot.r1; r++) for (let c = plot.c0; c <= plot.c1; c++) {
          if (!s.grid[r] || s.grid[r][c] || !ctx.meta.inPlot(r, c)) continue;
          if ([[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].some(([nr, nc]) => s.grid[nr] && s.grid[nr][nc])) { freeInPlot = true; break outer; }
        }
      }
      const selCell = ctx.engine.selected(), selId = selCell && s.grid[selCell.r] && s.grid[selCell.r][selCell.c] ? s.grid[selCell.r][selCell.c].id : null;
      for (const tier of [1, 2, 3, 4]) {
        const ids = MODULE_ORDER.filter(id => MODULES[id].tier === tier);
        const unlocked = Sim.tierUnlocked(tier), th = LEVEL_THRESHOLDS.find(t => t.level === tier);
        const builtKinds = ids.filter(id => T.counts[id]).length;
        const tag = !unlocked ? `${GLYPH.sq} Locked ${MID} ${th.modules} modules ${MID} ${th.rep.toFixed(1)} rep` : !freeInPlot ? `${GLYPH.sq} Needs more plot ${MID} ${builtKinds}/${ids.length} built` : `${builtKinds}/${ids.length} built`;
        const placingTier = placing && MODULES[placing] && MODULES[placing].tier === tier;
        h += shelf(`Tier ${tier} ${MID} ${TIER_NAMES[tier]}`, esc(tag), { first: tier === 1, cls: 'tier-head' + (unlocked ? '' : ' locked') + (placingTier ? ' placing' : ''), tagCls: unlocked && freeInPlot ? '' : 'warn' });
        for (const id of ids) {
          const d = MODULES[id], poor = s.credits < d.cost, sel = placing === id, count = T.counts[id] || 0;
          const cls = ['card', 'bcard', sel ? 'selected' : '', !unlocked ? 'locked' : poor ? 'poor' : ''].filter(Boolean).join(' ');
          const desc = sel ? 'Click a bracketed cell. Right-click or Esc to stop.' : d.desc;
          const r = modRate(id);
          const meta = unlocked
            ? `<span class="m" title="Credits banked per real minute">${icon('credits', 12)}+${r}/min</span><span class="m" title="Build time">${icon('clock', 12)}${Fmt.dur(modBuildMs(id, sIdx))}</span>` +
              (id === selId ? `<span class="m up" title="Upgrade times">${icon('upgrade', 12)}L2 ${Fmt.dur(upgradeMs(id, 2, sIdx))} ${MID} L3 ${Fmt.dur(upgradeMs(id, 3, sIdx))}</span>` : '')
            : `<span class="m lock">${icon('lock', 12)}Level ${tier}</span>`;
          h += `<div class="${cls}" data-mod="${id}" data-fam="${famOf(id)}" title="${esc(d.desc)}" role="button" tabindex="0"><i class="spine"></i>${plate(id)}` +
            `<div class="card-main"><div class="name">${esc(d.name)}${sel ? ' <span class="chip ivory">Placing</span>' : count ? ` <span class="tag">${GLYPH.times}${count}</span>` : ''}</div>` +
            `<div class="card-meta">${meta}</div><div class="desc">${esc(desc)}</div></div>` +
            `<div class="card-side"><div class="cost">${Fmt.n(d.cost)}</div>${pips(d.power)}${unlocked && poor ? `<div class="need">Need ${Fmt.n(d.cost - s.credits)}</div>` : ''}</div></div>`;
        }
      }
      paint(F.body, h, sig, 'b');
    };
    const click = e => {
      const card = e.target.closest('.card[data-mod]'); if (!card) return;
      const id = card.dataset.mod, d = MODULES[id]; if (!d) return;
      if (!Sim.tierUnlocked(d.tier)) { ctx.ui.toast(`Reach station level ${d.tier} to unlock ${d.name}`, 'warn'); ctx.sound.error(); return; }
      ctx.ui.place(ctx.engine.placing() === id ? null : id);
    };
    F.body.addEventListener('click', click);
    F.body.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.card[data-mod]')) { e.preventDefault(); click(e); } });
    render();
    return { update: render, destroy() { } };
  },

  // ---------------------------------------------------------- Station (5.2): overview or selected module
  station(host, ctx) {
    const F = frame(host, { id: 'station', title: 'Station', sub: '' }, ctx), sig = {};
    const render = () => {
      const s = ctx.state(); if (!s) return;
      const sel = ctx.engine.selected();
      const m = sel && s.grid[sel.r] && s.grid[sel.r][sel.c];
      if (m) renderSelected(s, sel, m); else renderOverview(s);
    };
    const renderOverview = s => {
      const T = Sim.totals(), A = Sim.amenity(T), q = A.score, qc = thr(q);
      F.setSub(`${esc(s.name)} ${MID} ${Fmt.day(s.day)} ${MID} L${s.level} ${esc(TIER_NAMES[s.level] || 'Galactic Hub')}`);
      const ready = ctx.meta.readyCells(), banked = ctx.meta.bankedTotal(), canAll = ctx.meta.canCollectAll();
      let h = `<div class="name-row"><input type="text" id="station-name-input" class="input" maxlength="28" value="${esc(s.name)}" aria-label="Station name" spellcheck="false"><button type="button" class="btn" data-act="rename">Rename</button></div>`;
      h += `<div class="hero-row">` +
        `<div class="qol-card"><div class="qol-ring-wrap">${ring(q, 64, `var(--${qc})`, `<span class="num qol-pct">${Fmt.pct(q)}</span>`)}</div><div class="qol-meta"><span class="tile-lbl">Quality of life</span><span class="chip ${qc}" data-shape="${TIER_SHAPE[qc]}">${TIER_WORD[qc]}</span></div></div>` +
        `<div class="tiles col"><div class="tile"><span class="tile-lbl">Residents</span><span class="tile-val num c-sage">${s.residents} <small>/ ${T.homes} homes</small></span></div>` +
        `<div class="tile"><span class="tile-lbl">Power</span><span class="tile-val num ${T.used > T.produced ? 'c-bad' : 'c-ice'}">${T.used} <small>/ ${T.produced}</small></span></div>` +
        `<div class="tile"><span class="tile-lbl">Berths</span><span class="tile-val num c-ice">${T.docks} <small>${T.visitors} aboard</small></span></div></div></div>`;
      for (const [label, v] of [['Food', A.food], ['Beds for crews', A.beds], ['Entertainment', A.fun], ['Health care', A.health]]) {
        const c = thr(v);
        h += `<div class="qol-row ${c}"><span class="qol-lbl">${label}</span>${segBar(v, c)}<span class="qol-val num">${Fmt.pct(v)}</span><span class="chip ${c}" data-shape="${TIER_SHAPE[c]}">${TIER_WORD[c]}</span></div>`;
      }
      // banked total + Collect all (rank 3+)
      h += `<div class="bank-card${ready.length ? ' ready' : ''}"><i class="spine"></i><div class="bank-main"><span class="tile-lbl">Banked across the station</span><span class="bank-val num c-amber-hi"><span data-live="banked"></span><small> cr</small></span><span class="bank-note">${ready.length ? `${ready.length} hopper${ready.length === 1 ? '' : 's'} ready to tap` : 'Hoppers fill while you are away'}</span></div>` +
        `<button type="button" class="btn big primary" data-act="collect-all"${(!canAll || !banked) ? ' disabled' : ''} title="${canAll ? 'Collect every hopper' : 'Rank 3 Harbourmaster unlocks Collect all'}">${icon('collect', 16)}<span>Collect all</span></button></div>` +
        (canAll ? '' : `<p class="fine">${icon('lock', 12)} Collect all unlocks at rank 3. Tap hoppers on the station to collect them one by one.</p>`);
      h += territoryBlock(s, ctx);
      h += shelf('Income', esc(Fmt.signed(s.income.yesterday) + ' yesterday'), { tagCls: s.income.yesterday >= 0 ? 'c-good' : 'c-bad' });
      const cats = Object.entries(s.income.breakdown || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      h += `<div class="kv"><span>Today so far</span><span class="num ink">${Fmt.signed(s.income.today)}</span>`;
      for (const [cat, v] of cats) h += `<span>${esc(Fmt.cap(cat))}</span><span class="num ${v >= 0 ? 'good' : 'bad'}">${Fmt.signed(v)}</span>`;
      h += `</div>`;
      h += shelf('Telemetry', esc(`Storage ${Fmt.n(T.stockTotal)} / ${Fmt.n(T.storage)}`));
      h += `<div class="kv"><span>Modules</span><span class="num">${T.modules}</span><span>Berths</span><span class="num">${T.docks}</span>` +
        `<span>Food served / day</span><span class="num">${T.food}</span><span>Visitor beds</span><span class="num">${T.beds}</span>` +
        `<span>Power</span><span class="num">${T.used} / ${T.produced}${T.flare ? ' <span class="chip warn" data-shape="sq">Flare</span>' : ''}</span>` +
        `<span>Ships served</span><span class="num">${Fmt.n(s.stats.shipsServed)}</span><span>Cargo traded</span><span class="num">${Fmt.n(s.stats.cargoTraded)} units</span>` +
        `<span>Lifetime earnings</span><span class="num amber">${Fmt.n(s.stats.earned)}</span></div>`;
      h += `<p class="idle">Click a module on the station to inspect, collect, upgrade or scrap it.</p>`;
      paint(F.body, h, sig, 'ov', ctx.meta);
    };
    const renderSelected = (s, sel, m) => {
      const d = MODULES[m.id], hp = ctx.meta.hopper(sel.r, sel.c), bd = ctx.meta.build(sel.r, sel.c), up = ctx.meta.upgrade(sel.r, sel.c);
      const lvl = up ? up.lvl : ((s.cells && s.cells[`${sel.r},${sel.c}`] && s.cells[`${sel.r},${sel.c}`].lvl) || 1);
      F.setSub(`Grid ${Fmt.grid(sel.r, sel.c)} ${MID} ${esc(famOf(m.id))} ${MID} <button type="button" class="linkish" data-act="back">${GLYPH.arrow} Station overview</button>`);
      let h = `<div class="card bcard static" data-mod="${m.id}" data-fam="${famOf(m.id)}"><i class="spine"></i>${plate(m.id, 24)}<div class="card-main"><div class="name">${esc(d.name)} ${lvlTicks(lvl)}</div><div class="desc wrap">${esc(d.desc)}</div></div>` +
        `<div class="card-side"><div class="cost">${Fmt.n(d.cost)}</div>${pips(d.power)}</div></div>`;
      // tell state line
      if (d.docks && m.id !== 'hub') {
        h += Sim.dockUsable(sel.r, sel.c) ? `<p class="status good">${GLYPH.up} Berth clear</p>` : `<p class="status bad">${GLYPH.down} Berth blocked: no empty side for ships to pull up to</p>`;
        const ship = s.ships.find(sh => sh.dock && sh.dock.r === sel.r && sh.dock.c === sel.c && sh.state === 'docked');
        if (ship) { const co = coDef(ship.company); h += `<p class="status">Docked: ${esc(ship.captain)}, ${esc(co ? co.name : ship.company)} ${MID} leaves in ${Math.max(0, ship.dockedUntil - Sim.now()).toFixed(1)} d</p>`; }
      }
      // under construction
      if (bd && bd.building) {
        const until = Date.now() + bd.remainingMs, total = Math.max(1, bd.totalMs), startedAt = until - total;
        h += shelf('Under construction', countdown(until), { tagCls: 'c-ice' });
        h += `<div class="block ice"><i class="spine"></i>${ring(0, 56, 'var(--ice)', icon(m.id, 22), { until, total })}` +
          `<div class="block-main"><span class="tile-lbl">Scaffold ${MID} ${Fmt.dur(Date.now() - startedAt)} in</span><p class="body">Welding crews are on it. The module goes live when the ring closes.</p></div>` +
          `<button type="button" class="btn big am" data-act="skip" title="Skip the wait">${icon('skip', 16)}<span>Skip ${MID} ${bd.skipAM} AM</span></button></div>`;
      } else if (hp) {
        // hopper bank: the figure and the meter are live (data-live), the note re-renders by the minute
        const rc = hp.full ? 'full' : hp.ready ? 'ready' : '', minsLeft = Math.ceil((hp.cap - hp.bank) / Math.max(1, hp.rate));
        h += shelf('Hopper', esc(`${Fmt.n(hp.rate)} cr / min ${MID} cap ${Fmt.n(hp.cap)}`));
        h += `<div class="block amber ${rc}"><i class="spine"></i><div class="block-main"><span class="tile-lbl">Banked</span><span class="bank-val num c-amber-hi"><span data-live="bank:${sel.r},${sel.c}"></span><small> cr</small></span>` +
          `<span class="meter amber" data-live="bankpct:${sel.r},${sel.c}"></span><span class="bank-note">${hp.full ? `${GLYPH.sq} Full. Nothing more accrues until you collect.` : hp.ready ? `${GLYPH.up} Ready to collect` : `Fills in ${Fmt.dur(minsLeft * 60000)}`}</span></div>` +
          `<button type="button" class="btn big primary" data-act="collect"${hp.bank < 1 ? ' disabled' : ''}>${icon('collect', 16)}<span>Collect</span></button></div>`;
      }
      // upgrade
      if (!(bd && bd.building) && m.id !== 'hub') {
        if (up && up.next) {
          const n = up.next, poor = s.credits < n.cost;
          h += shelf(`Upgrade to level ${lvl + 1}`, esc(`${Fmt.n(n.cost)} cr ${MID} ${Fmt.dur(n.ms || upgradeMs(m.id, lvl + 1, sectorIndex(s.sector || 'home')))}`));
          h += `<div class="kv tight"><span>Rate</span><span class="num">${Fmt.n(hp ? hp.rate : modRate(m.id, lvl))} ${GLYPH.arrow} <b class="c-amber-hi">${Fmt.n(n.rate)}</b> / min</span><span>Capacity</span><span class="num">${Fmt.n(hp ? hp.cap : 0)} ${GLYPH.arrow} <b class="c-amber-hi">${Fmt.n(n.cap)}</b></span>${n.note ? `<span>Also</span><span class="ink">${esc(n.note)}</span>` : ''}</div>` +
            `<div class="actions"><button type="button" class="btn big primary" data-act="upgrade"${poor ? ' disabled' : ''} title="${poor ? `Need ${Fmt.n(n.cost - s.credits)} more credits` : 'Start the upgrade'}">${icon('upgrade', 16)}<span>Upgrade ${MID} ${Fmt.n(n.cost)}</span></button>${poor ? `<span class="why">Need ${Fmt.n(n.cost - s.credits)} more</span>` : ''}</div>`;
        } else if (up) {
          h += shelf('Upgrade', `${GLYPH.sq} Max level`, { tagCls: 'c-ink2' });
        }
      }
      // demolish
      if (m.id === 'hub') h += `<p class="status">The Core Hub cannot be removed.</p>`;
      else {
        const dem = Sim.canDemolish(sel.r, sel.c);
        h += `<div class="actions end"><button type="button" class="btn danger" data-act="scrap"${dem.ok ? '' : ` disabled title="${esc(dem.why)}"`}>${icon('scrap', 14)}<span>Scrap for ${Fmt.n(d.cost * 0.5)}</span></button>${dem.ok ? '' : `<span class="why">${esc(dem.why)}</span>`}</div>`;
      }
      paint(F.body, h, sig, 'sel:' + sel.r + ',' + sel.c, ctx.meta);
    };
    const click = e => {
      const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
      const sel = ctx.engine.selected(), act = b.dataset.act;
      if (act === 'rename') { const inp = host.querySelector('#station-name-input'); if (inp) ctx.ui.rename(inp.value); }
      else if (act === 'collect-all') ctx.ui.collectAll(b);
      else if (act === 'expand') ctx.ui.plotConfirm();
      else if (act === 'skip-plot') ctx.ui.skipPlot();
      else if (act === 'back') ctx.ui.deselect();
      else if (!sel) return;
      else if (act === 'collect') ctx.ui.collect(sel.r, sel.c);
      else if (act === 'skip') ctx.ui.skipBuild(sel.r, sel.c);
      else if (act === 'upgrade') ctx.ui.upgrade(sel.r, sel.c);
      else if (act === 'scrap') ctx.ui.demolish(sel.r, sel.c);
    };
    host.addEventListener('click', click);
    host.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'station-name-input') { e.preventDefault(); ctx.ui.rename(e.target.value); } });
    render();
    return { update() { tickTimers(F.body, ctx.meta); if (document.activeElement && document.activeElement.id === 'station-name-input') return; render(); }, destroy() { } };
  },

  // ---------------------------------------------------------- Market (6.4 → 14px rows)
  market(host, ctx) {
    const F = frame(host, { id: 'market', title: 'Market', sub: '' }, ctx), sig = {};
    const render = () => {
      const s = ctx.state(); if (!s) return;
      const T = Sim.totals();
      const buyPct = Math.round((0.65 - T.margin) * 100), sellPct = Math.round((1.05 + T.margin) * 100);
      F.setSub(`Trade exchange ${MID} Storage ${Fmt.n(T.stockTotal)} / ${Fmt.n(T.storage)}`);
      let h = `<p class="lead">Ships sell cargo into your warehouses at <span class="num">${buyPct}%</span> of market price and buy what their home world needs at <span class="num">${sellPct}%</span>. Hover a row for the worlds that want it.</p>`;
      const boom = s.fx.boom && s.day < s.fx.boom.until ? s.fx.boom : null, glut = s.fx.glut && s.day < s.fx.glut.until ? s.fx.glut : null;
      if (boom || glut) {
        h += `<div class="chips">`;
        if (boom) h += `<span class="chip good" data-shape="up">Boom ${MID} ${esc(GOODS[boom.good].name)} ${GLYPH.times}3 ${GLYPH.arrow} D${boom.until}</span>`;
        if (glut) h += `<span class="chip warn" data-shape="sq">Glut ${MID} ${esc(GOODS[glut.good].name)} ${GLYPH.times}${GLYPH.half} ${GLYPH.arrow} D${glut.until}</span>`;
        h += `</div>`;
      }
      if (!T.hasMarket) h += `<div class="shelf-note warn"><i class="sq"></i>Needs a Trade Exchange ${MID} policies locked</div>`;
      h += `<table class="market"><thead><tr><th class="kind"></th><th class="icon"></th><th>Good</th><th class="r stock">Stock</th><th class="r price">Price</th><th class="pol">Policy</th><th class="act"></th></tr></thead><tbody>`;
      for (const g of GOOD_IDS) {
        const G = GOODS[g], p = Sim.effPrice(g), pol = s.policy[g], stock = s.stock[g];
        const tr = p > G.base * 1.05 ? 'up c-good' : p < G.base * 0.95 ? 'down c-bad' : 'flat';
        const rowCls = boom && boom.good === g ? ' class="boom"' : glut && glut.good === g ? ' class="glut"' : '';
        const mult = boom && boom.good === g ? `<span class="mult">${GLYPH.times}3</span>` : glut && glut.good === g ? `<span class="mult">${GLYPH.times}${GLYPH.half}</span>` : '';
        const from = Object.values(PLANETS).filter(pl => pl.exports.includes(g)).map(pl => pl.name).join(', ');
        const to = Object.values(PLANETS).filter(pl => pl.imports.includes(g)).map(pl => pl.name).join(', ');
        const dis = T.hasMarket ? '' : ' disabled';
        h += `<tr${rowCls} title="From: ${esc(from)}&#10;Wanted by: ${esc(to || 'nobody nearby')}" style="--hue:${kindHue(G.kind)}"><td class="kind"><i></i></td><td class="icon">${icon(g, 16)}</td><td class="gname">${esc(G.name)}</td>` +
          `<td class="stock num">${stock}</td><td class="price num"><i class="tri ${tr}"></i><span class="prc">${p.toFixed(1)}</span>${mult}</td>` +
          `<td class="pol"><div class="seg small"><button type="button" data-g="${g}" data-k="buy" class="${pol.buy ? 'on' : ''}"${dis} title="Buy ${esc(G.name)} from ships">Buy</button><button type="button" data-g="${g}" data-k="sell" class="${pol.sell ? 'on' : ''}"${dis} title="Sell ${esc(G.name)} to ships">Sell</button></div></td>` +
          `<td class="act"><button type="button" class="btn icon small danger dump" data-dump="${g}" title="Sell all to a passing broker at half price"${stock ? '' : ' disabled'}>${icon('dump', 14)}</button></td></tr>`;
      }
      h += `</tbody></table>`;
      paint(F.body, h, sig, 'm');
    };
    F.body.addEventListener('click', e => {
      const pol = e.target.closest('button[data-g][data-k]');
      if (pol) { if (pol.disabled) return; Sim.setPolicy(pol.dataset.g, pol.dataset.k, !ctx.state().policy[pol.dataset.g][pol.dataset.k]); ctx.sound.click(); return; }
      const dump = e.target.closest('button[data-dump]');
      if (dump && !dump.disabled) ctx.ui.confirm('Sell to a broker?', `Everything in stock of <b>${esc(GOODS[dump.dataset.dump].name)}</b> goes to a passing broker at half price.`, () => Sim.dumpStock(dump.dataset.dump), { yes: 'Sell all', danger: true });
    });
    render();
    return { update: render, destroy() { } };
  },

  // ---------------------------------------------------------- Fleet (5.2): ships in the sector + companies
  fleet(host, ctx) {
    const F = frame(host, { id: 'fleet', title: 'Fleet', sub: '' }, ctx), sig = {};
    const STATE_WORD = { docked: ['Docked', 'good'], approach: ['On approach', 'ice'], queue: ['Holding', 'warn'], depart: ['Departing', 'ink'], leaving: ['Departing', 'ink'] };
    const render = () => {
      const s = ctx.state(); if (!s) return;
      const T = Sim.totals();
      const docked = s.ships.filter(x => x.state === 'docked').length, hold = s.ships.filter(x => x.state === 'queue').length;
      F.setSub(`${docked} docked ${MID} ${hold} holding ${MID} ${T.docks} berth${T.docks === 1 ? '' : 's'}${s.recentAway > 1.5 ? ` ${MID} <span class="c-warn">${GLYPH.sq} diverting</span>` : ''}`);
      let h = shelf('Ships in the sector', esc(`${s.ships.length} ship${s.ships.length === 1 ? '' : 's'}`), { first: true, hue: 'var(--ice)' });
      if (!s.ships.length) h += `<p class="idle">No ships in the lanes right now. Comms Relays and trust bring more.</p>`;
      const focused = ctx.ui.focusedShip();
      for (const sh of [...s.ships].sort((a, b) => (a.state === 'docked' ? 0 : a.state === 'approach' ? 1 : 2) - (b.state === 'docked' ? 0 : b.state === 'approach' ? 1 : 2))) {
        const co = coDef(sh.company), cls = SHIP_CLASSES[sh.cls], [word, wc] = STATE_WORD[sh.state] || ['In lane', 'ink'];
        const held = Object.values(sh.cargo || {}).reduce((a, q) => a + Math.max(0, q), 0);
        const extra = sh.state === 'docked' ? `leaves in ${Math.max(0, sh.dockedUntil - Sim.now()).toFixed(1)} d` : sh.state === 'queue' ? `${Math.max(0, Sim.now() - sh.waitStart).toFixed(1)} d for a berth` : sh.dock ? `Berth ${Fmt.grid(sh.dock.r, sh.dock.c)}` : '';
        h += `<div class="ship-row${focused === sh.id ? ' focused' : ''}" data-ship="${sh.id}" style="--hue:${coHue(sh.company)}" role="button" tabindex="0" title="Focus the camera on this ship">` +
          `<span class="ship-dot"></span><span class="ship-ic">${icon('ship', 18)}</span><div class="ship-main"><span class="ship-name">${esc(co ? co.name : sh.company)} <span class="tag">${esc(cls.name)}</span></span><span class="ship-sub">${esc(sh.captain)} ${MID} hold ${held}/${cls.cargo}${extra ? ` ${MID} ${esc(extra)}` : ''}</span></div>` +
          `<span class="chip ${wc}" data-shape="${wc === 'good' ? 'up' : wc === 'warn' ? 'sq' : 'sq'}">${word}</span></div>`;
      }
      const avg = Math.round(COMPANIES.reduce((a, c) => a + s.companies[c.id].trust, 0) / COMPANIES.length);
      h += shelf('Shipping companies', esc(`Trust avg ${avg}`), { hue: 'var(--sage)' });
      const goodsRow = (label, ids) => `<div class="goods-row"><span class="lbl">${label}</span>${ids.map(g => `<span style="color:${kindHue(GOODS[g].kind)}" title="${esc(GOODS[g].name)}">${icon(g, 14)}</span>`).join('')}</div>`;
      for (const c of COMPANIES) {
        const co = s.companies[c.id], pl = PLANETS[c.home], locked = !!c.galactic && !T.galactic;
        let chips = '';
        if (co.office) chips += `<span class="chip good" data-shape="up">Office</span>`;
        if (s.day < co.contractUntil) chips += `<span class="chip ice" data-shape="sq">Contract ${GLYPH.arrow} D${co.contractUntil}</span>`;
        if (locked) chips += `<span class="chip ink" data-shape="sq">Needs Jump Gate</span>`;
        if (co.loan) chips += `<span class="chip amber" data-shape="sq">Loan ${Fmt.n(co.loan.remaining)} left ${MID} ${Fmt.n(co.loan.perDay)}/day</span>`;
        const tc = trustCls(co.trust), filled = Math.min(10, Math.floor(co.trust / 10));
        const lend = (!locked && !co.loan) ? `<button type="button" class="btn${T.hasBank ? ' primary' : ''}" data-lend="${c.id}"${T.hasBank ? '' : ' disabled title="Build a Mercantile Bank first"'}>${icon('lend', 14)}<span>Lend</span></button>` : '';
        h += `<div class="co${locked ? ' locked' : ''}" style="--hue:${coHue(c.id)}"><i class="spine"></i><div class="co-head"><span class="name">${esc(c.name)}</span><span class="tag">${esc(pl.name)}</span></div>` +
          `<div class="co-chips">${chips}</div><p class="blurb">${esc(c.blurb)}</p>` +
          goodsRow('Brings', pl.exports) + goodsRow('Buys', pl.imports) +
          `<div class="trust" title="Trust ${co.trust} / 100"><div class="trust-bar">${'<i class="on"></i>'.repeat(filled)}${'<i></i>'.repeat(10 - filled)}</div><span class="trust-val num">${co.trust} / 100</span><span class="chip ${tc}" data-shape="${TIER_SHAPE[tc]}">${TIER_WORD[tc]}</span></div>` +
          `<div class="co-foot"><span class="tag">Ships served ${co.served}</span>${lend}</div></div>`;
      }
      paint(F.body, h, sig, 'f');
    };
    F.body.addEventListener('click', e => {
      const b = e.target.closest('button[data-lend]'); if (b && !b.disabled) { ctx.ui.lendDialog(b.dataset.lend); return; }
      const row = e.target.closest('.ship-row[data-ship]'); if (row) ctx.ui.focusShip(+row.dataset.ship);
    });
    F.body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('.ship-row')) ctx.ui.focusShip(+e.target.closest('.ship-row').dataset.ship); });
    render();
    return { update: render, destroy() { } };
  },

  // ---------------------------------------------------------- Expeditions (4.6, 5.2)
  expeditions(host, ctx) {
    const F = frame(host, { id: 'expeditions', title: 'Expeditions', sub: '' }, ctx), sig = {};
    const render = () => {
      const s = ctx.state(); if (!s) return;
      const T = Sim.totals(), slots = ctx.meta.slots(), list = ctx.meta.expeditions().filter(x => x.status !== 'claimed');
      const hasDock = (T.counts.dock || 0) > 0;
      F.setSub(`${slots.used} of ${slots.max} slot${slots.max === 1 ? '' : 's'} in use ${MID} ${hasDock ? 'docking bay ready' : `<span class="c-warn">${GLYPH.sq} needs a Docking Bay</span>`}`);
      let h = '';
      const ready = list.filter(x => x.status === 'ready'), out = list.filter(x => x.status === 'out');
      if (list.length) {
        h += shelf('Under way', esc(`${ready.length} ready ${MID} ${out.length} out`), { first: true, hue: 'var(--ice)' });
        for (const x of [...ready, ...out]) {
          const def = sectorList().find(d => d.id === x.sector) || { id: x.sector, name: x.sector };
          const total = Math.max(1, x.endsAt - x.startedAt), left = Math.max(0, x.endsAt - Date.now());
          const skipAM = Math.max(1, Math.ceil(left / 60000 / 8));
          if (x.status === 'ready') {
            h += `<div class="exp-card ready" data-exp="${esc(x.id)}"><i class="spine"></i>${planetSvg(def.id, 52, def)}<div class="exp-main"><span class="exp-name">${esc(def.name)}</span><span class="exp-sub c-good">${GLYPH.up} Returned ${MID} loot sealed</span></div>` +
              `<button type="button" class="btn big primary" data-act="debrief" data-exp="${esc(x.id)}">${icon('chart', 16)}<span>Debrief</span></button></div>`;
          } else {
            h += `<div class="exp-card" data-exp="${esc(x.id)}"><i class="spine"></i>${ring(0, 52, 'var(--ice)', planetSvg(def.id, 34, def), { until: x.endsAt, total })}<div class="exp-main"><span class="exp-name">${esc(def.name)}</span><span class="exp-sub">Back in ${countdown(x.endsAt, 'c-ice')}</span></div>` +
              `<button type="button" class="btn am" data-act="instant" data-exp="${esc(x.id)}" title="Bring the crew home now">${icon('skip', 14)}<span>Return ${MID} ${skipAM} AM</span></button></div>`;
          }
        }
      }
      h += shelf('Destinations', esc(`${Fmt.n(s.credits)} cr available`), { first: !list.length, hue: 'var(--ice)' });
      if (!hasDock) h += `<div class="shelf-note warn"><i class="sq"></i>Build a Docking Bay to launch expeditions</div>`;
      const free = slots.used < slots.max;
      h += `<div class="dest-grid">`;
      sectorList().forEach((def, i) => {
        const ex = def.expedition || {}, EX = (typeof EXPEDITIONS !== 'undefined' && EXPEDITIONS) || {};
        const minutes = ex.minutes || (Array.isArray(EX.minutes) && EX.minutes[i]) || EXPEDITION_MINUTES[i] || 30;
        const cost = ex.cost || Math.round((EX.costBase || 400) * (1 + (EX.costPerIndex != null ? EX.costPerIndex : 0.5) * i));
        const charts = ctx.meta.charts(def.id), running = list.some(x => x.sector === def.id);
        const can = hasDock && free && s.credits >= cost && !running;
        const why = !hasDock ? 'Needs a Docking Bay' : running ? 'Crew already out there' : !free ? 'No free slot' : s.credits < cost ? `Need ${Fmt.n(cost - s.credits)} more` : '';
        h += `<div class="dest${running ? ' running' : ''}" style="--hue:${(SECTOR_LOOK[def.id] || SECTOR_LOOK.home).rim}">${planetSvg(def.id, 56, def)}<div class="dest-main"><span class="dest-name">${esc(def.name)}</span>` +
          `<span class="dest-meta">${icon('clock', 12)}${Fmt.dur(minutes * 60000)}<span class="sep">${MID}</span>${icon('credits', 12)}${Fmt.n(cost)}</span>` +
          `<span class="charts" title="Charts ${charts} / 3">${[0, 1, 2].map(k => `<i class="${k < charts ? 'on' : ''}"></i>`).join('')}<span class="charts-lbl">${charts}/3 charted</span></span></div>` +
          `<button type="button" class="btn${can ? ' primary' : ''}" data-act="launch" data-sector="${esc(def.id)}"${can ? '' : ` disabled title="${esc(why)}"`}>${icon('expeditions', 14)}<span>${running ? 'Out' : 'Launch'}</span></button></div>`;
      });
      h += `</div>`;
      paint(F.body, h, sig, 'e', ctx.meta);
    };
    F.body.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]'); if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (act === 'launch') ctx.ui.launch(b.dataset.sector);
      else if (act === 'debrief') ctx.ui.debrief(b.dataset.exp, b);
      else if (act === 'instant') ctx.ui.instantReturn(b.dataset.exp);
    });
    render();
    return { update() { tickTimers(F.body, ctx.meta); render(); }, destroy() { } };
  },

  // ---------------------------------------------------------- Map (4.5, 5.2): SVG constellation + sector card
  map(host, ctx) {
    const F = frame(host, { id: 'map', title: 'Galaxy', sub: '' }, ctx), sig = {};
    let picked = null;
    const NODE = [[.09, .70], [.22, .30], [.35, .74], [.48, .28], [.61, .70], [.74, .26], [.86, .66], [.95, .24]];
    const render = () => {
      const s = ctx.state(); if (!s) return;
      const rows = ctx.meta.sectors();
      if (!rows.length) { paint(F.body, '<p class="idle">Charting the galaxy…</p>', sig, 'map'); return; }
      const active = rows.find(r => r.status === 'active') || rows[0];
      if (!picked) picked = active.def.id;
      const owned = rows.filter(r => r.status === 'active' || r.status === 'owned').length;
      F.setSub(`${owned} of ${rows.length} sectors ${MID} ${esc(active.def.name)} active`);
      const W = 400, H = 200;
      let svg = `<svg class="galaxy" viewBox="0 0 ${W} ${H}" width="100%" aria-label="Galaxy map" role="group">`;
      // routes
      for (let i = 0; i < rows.length - 1 && i < NODE.length - 1; i++) {
        const [ax, ay] = NODE[i], [bx, by] = NODE[i + 1];
        const lit = (rows[i].status === 'active' || rows[i].status === 'owned') && (rows[i + 1].status === 'active' || rows[i + 1].status === 'owned');
        svg += `<line class="route${lit ? ' lit' : ''}" x1="${ax * W}" y1="${ay * H}" x2="${bx * W}" y2="${by * H}"/>`;
      }
      rows.forEach((r, i) => {
        const [nx, ny] = NODE[i] || [.5, .5], x = nx * W, y = ny * H, look = SECTOR_LOOK[r.def.id] || SECTOR_LOOK.home;
        const cls = ['node', r.status, picked === r.def.id ? 'picked' : ''].filter(Boolean).join(' ');
        const R = r.status === 'active' ? 10 : r.status === 'locked' ? 6.5 : 8;
        svg += `<g class="${cls}" data-sector="${esc(r.def.id)}" tabindex="0" role="button" aria-label="${esc(r.def.name)} ${esc(r.status)}" style="--hue:${look.rim}">` +
          `<circle class="halo" cx="${x}" cy="${y}" r="22"/><circle class="glow" cx="${x}" cy="${y}" r="${R + 6}"/><circle class="disc" cx="${x}" cy="${y}" r="${R}" fill="${r.status === 'locked' ? 'var(--surface-3)' : look.base}"/>` +
          (r.status === 'locked' ? `<path class="lock" d="M${x - 3} ${y - .5}h6v4h-6Z M${x - 2} ${y - .5}v-1.5a2 2 0 0 1 4 0v1.5" />` : '') +
          `<text class="node-lbl" x="${x}" y="${y + (ny > .5 ? R + 16 : -(R + 8))}" text-anchor="middle">${esc(r.def.name.toUpperCase())}</text></g>`;
      });
      svg += `</svg>`;
      const r = rows.find(x => x.def.id === picked) || active;
      const def = r.def, look = SECTOR_LOOK[def.id] || SECTOR_LOOK.home, sum = r.summary || {};
      const status = { active: ['Active sector', 'good', 'up'], owned: ['Owned', 'ice', 'sq'], unlockable: ['Ready to unlock', 'amber', 'sq'], locked: ['Locked', 'ink', 'sq'] }[r.status] || ['', 'ink', 'sq'];
      let card = `<div class="sector-card" data-status="${esc(r.status)}" style="--hue:${look.rim}"><i class="spine"></i><div class="sector-head">${planetSvg(def.id, 72, def)}<div class="sector-title"><span class="sector-name">${esc(def.name)}</span>` +
        `<span class="chip ${status[1]}" data-shape="${status[2]}">${status[0]}</span><span class="sector-grid micro">${esc(def.grid ? (Array.isArray(def.grid) ? def.grid.join('x') : `${def.grid.cols || def.grid.w || 15}x${def.grid.rows || def.grid.h || 9}`) : '15x9')} plot ${MID} ${esc(def.planet || def.world || (look.kind === 'belt' ? 'asteroid belt' : look.kind === 'nebula' ? 'violet nebula' : 'world'))}</span></div></div>`;
      if (def.flavour || def.flavor || def.desc) card += `<p class="body sector-flavour">${esc(def.flavour || def.flavor || def.desc)}</p>`;
      const bias = biasText(def);
      if (bias) card += `<div class="sector-bias">${icon('trend-up', 12)}<span>${esc(bias)}</span></div>`;
      const ex = def.expedition || {};
      if (ex.minutes) card += `<div class="sector-bias">${icon('expeditions', 12)}<span>Expedition ${Fmt.dur(ex.minutes * 60000)} ${MID} ${Fmt.n(ex.cost || 0)} cr ${MID} ${ctx.meta.charts(def.id)}/3 charts</span></div>`;
      if (r.status === 'active' || r.status === 'owned') {
        card += `<div class="kv tight"><span>Station</span><span class="ink">${esc(sum.name || '—')}</span><span>Level</span><span class="num">${sum.level || 1}</span><span>Modules</span><span class="num">${sum.modules || 0}</span><span>Banked</span><span class="num amber">${Fmt.n(sum.banked || 0)} cr</span></div>`;
      } else {
        card += `<div class="sector-lock"><span class="lock-ic">${icon('lock', 16)}</span><span class="lock-text">${esc(r.why || unlockText(def))}</span></div>`;
      }
      const amCost = def.unlock && (def.unlock.am || def.unlock.AM);
      card += `<div class="actions">`;
      if (r.status === 'active') card += `<span class="why">You are here.</span>`;
      else if (r.status === 'owned') card += `<button type="button" class="btn big primary" data-act="travel" data-sector="${esc(def.id)}">${icon('travel', 16)}<span>Travel</span></button>`;
      else {
        card += `<button type="button" class="btn big primary" data-act="unlock" data-sector="${esc(def.id)}"${r.status === 'unlockable' ? '' : ' disabled'}>${icon('lock', 16)}<span>Unlock</span></button>`;
        if (amCost) card += `<button type="button" class="btn big am" data-act="unlock-am" data-sector="${esc(def.id)}"${ctx.meta.am() >= amCost ? '' : ` disabled title="Need ${Fmt.n(amCost - ctx.meta.am())} more AM"`}>${icon('am', 16)}<span>Unlock ${MID} ${amCost} AM</span></button>`;
        if (def.unlock && def.unlock.pass) card += `<button type="button" class="btn big am" data-act="store">${icon('store', 16)}<span>Sector Pass</span></button>`;
      }
      card += `</div></div>`;
      paint(F.body, `<div class="galaxy-wrap">${svg}</div>${card}`, sig, 'map');
    };
    const unlockText = def => {
      const u = def.unlock; if (!u) return 'Reach the next level to chart a route.';
      if (typeof u === 'string') return u;
      const parts = [];
      if (u.level > 1) parts.push(`station level ${u.level}`); if (u.credits) parts.push(`${Fmt.n(u.credits)} cr`); if (u.charts) parts.push(`${u.charts} chart${u.charts === 1 ? '' : 's'}`);
      let t = parts.length ? `Needs ${parts.join(', ')}` : 'Locked';
      if (u.am) t += ` ${MID} or ${u.am} AM now`; if (u.pass) t += ` ${MID} or the Sector Pass`;
      return t;
    };
    // SECTORS[id].bias { goods: {ore: 1.4}, events: {flare: 2}, residents, rent, refinery, fuel, gate, traffic } -> one line
    const biasText = def => {
      if (def.biasText) return def.biasText;
      const b = def.bias; if (!b) return '';
      if (typeof b === 'string') return b;
      const out = [], pct = v => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
      const goods = Object.entries(b.goods || {}).filter(([, v]) => v !== 1);
      if (goods.length) { const byV = {}; for (const [g, v] of goods) (byV[v] ||= []).push(GOODS[g] ? GOODS[g].name.toLowerCase() : g); for (const [v, names] of Object.entries(byV)) out.push(`${Fmt.cap(names.join(', '))} ${pct(+v)}`); }
      for (const [ev, v] of Object.entries(b.events || {})) if (v !== 1) out.push(`${Fmt.cap(ev === 'flare' ? 'flares' : ev)} ${GLYPH.times}${v}`);
      if (b.residents === 0) out.push('No residents'); else if (b.residents && b.residents !== 1) out.push(`Residents grow ${GLYPH.times}${b.residents}`);
      if (b.rent && b.rent !== 1) out.push(`Rent ${pct(b.rent)}`); if (b.refinery && b.refinery !== 1) out.push(`Refinery ${pct(b.refinery)}`);
      if (b.fuel && b.fuel !== 1) out.push(`Fuel ${pct(b.fuel)}`); if (b.gate && b.gate !== 1) out.push(`Gate traffic ${pct(b.gate)}`); if (b.traffic && b.traffic !== 1) out.push(`Traffic ${pct(b.traffic)}`);
      return out.length ? out.join(` ${MID} `) : 'Balanced lanes';
    };
    F.body.addEventListener('click', e => {
      const n = e.target.closest('.node[data-sector]'); if (n) { picked = n.dataset.sector; ctx.sound.click(); sig.map = ''; render(); return; }
      const b = e.target.closest('button[data-act]'); if (!b || b.disabled) return;
      const id = b.dataset.sector, act = b.dataset.act;
      if (act === 'travel') ctx.ui.travel(id);
      else if (act === 'unlock') ctx.ui.unlock(id, false);
      else if (act === 'unlock-am') ctx.ui.unlock(id, true);
      else if (act === 'store') ctx.ui.openPanel('store');
    });
    F.body.addEventListener('keydown', e => { const n = e.target.closest && e.target.closest('.node[data-sector]'); if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); picked = n.dataset.sector; sig.map = ''; render(); } });
    render();
    return { update: render, destroy() { }, pick(id) { picked = id; sig.map = ''; render(); } };
  },

  // ---------------------------------------------------------- Missions (4.7, 5.2)
  missions(host, ctx) {
    let tab = 'missions';
    const F = frame(host, { id: 'missions', title: 'Missions', sub: '', tabs: [{ id: 'missions', label: 'Missions' }, { id: 'achievements', label: 'Achievements' }], tab }, ctx), sig = {};
    const open = new Set();
    const render = () => { if (tab === 'achievements') renderAch(); else renderMissions(); };
    // A1.3: lifetime, tiered; claimable first, then in progress, gold last
    const renderAch = () => {
      const list = ctx.meta.achievements();
      const claimable = list.filter(a => a.claimable).length, golds = list.filter(a => a.done).length;
      F.setSub(`${golds} of ${list.length} gold${claimable ? ` ${MID} <span class="c-amber">${claimable} to claim</span>` : ''}`);
      const order = a => a.claimable ? 0 : a.done ? 2 : 1;
      let h = shelf('Career', esc(claimable ? `${claimable} to claim` : 'bronze · silver · gold'), { first: true });
      if (!list.length) h += `<p class="idle">Achievements track your whole career: ships served, credits collected, rings cleared, sectors opened.</p>`;
      for (const a of [...list].sort((x, y) => order(x) - order(y))) h += achRow(a);
      paint(F.body, h, sig, 'ach');
    };
    const achRow = a => {
      const tier = Math.max(0, Math.min(3, a.tier || 0)), goal = Math.max(1, a.goal || 1), p = a.done ? 1 : Math.min(1, (a.progress || 0) / goal);
      const segs = TIER_WORDS.map((w, i) => `<i class="${i < tier ? 'on ' + w : i === tier && !a.done ? 'cur ' + w : ''}"${i === tier && !a.done ? ` style="--p:${(p * 100).toFixed(1)}%"` : ''}></i>`).join('');
      const ic = (typeof Icons !== 'undefined' && Icons && typeof Icons.has === 'function' && a.icon && Icons.has(a.icon)) ? a.icon : 'award';
      return `<div class="ach${a.claimable ? ' claimable' : a.done ? ' done' : ''}" data-ach="${esc(a.id)}"><i class="spine"></i><span class="ach-ic">${icon(ic, 20)}</span>` +
        `<div class="ach-main"><div class="ach-title">${esc(a.title)}${a.done ? ` <span class="tier-chip gold">Gold</span>` : tier ? ` <span class="tier-chip ${TIER_WORDS[tier - 1]}">${Fmt.cap(TIER_WORDS[tier - 1])}</span>` : ''}</div>` +
        `<div class="ach-desc">${esc(a.desc || '')}</div>` +
        `<div class="ach-prog"><span class="tiers" title="Bronze, silver, gold">${segs}</span><span class="num">${a.done ? 'Complete' : `${Fmt.n(Math.min(a.progress || 0, goal))} / ${Fmt.n(goal)}`}</span>${!a.done && a.nextAM ? `<span class="rchip am sm">${icon('am', 12)}<span>${Fmt.n(a.nextAM)} AM</span></span>` : ''}</div></div>` +
        (a.claimable ? `<button type="button" class="btn big primary" data-claim-ach="${esc(a.id)}">${icon('collect', 16)}<span>Claim</span></button>` : '') + `</div>`;
    };
    const renderMissions = () => {
      const all = ctx.meta.missions();
      // three active at a time (4.7): the `active` flag when Meta sets it, else the next open mission in each chapter
      let active;
      if (all.some(m => m.active != null)) active = all.filter(m => m.active || m.claimable);
      else {
        const slots = ctx.meta.rank().level >= 4 ? 4 : 3, seen = new Set(); active = [];
        for (const m of all) { if (m.done || m.claimed) continue; if (m.claimable) { active.push(m); continue; } if (seen.has(m.chapter)) continue; seen.add(m.chapter); active.push(m); }
        active = active.sort((a, b) => (b.claimable ? 1 : 0) - (a.claimable ? 1 : 0)).slice(0, slots);
      }
      const claimable = all.filter(m => m.claimable).length, done = all.filter(m => m.done || m.claimed).length;
      F.setSub(`${done} of ${all.length} complete${claimable ? ` ${MID} <span class="c-amber">${claimable} to claim</span>` : ''}`);
      let h = shelf('Active', esc(`${active.length} of ${(typeof Meta !== 'undefined' && typeof Meta.missionSlots === 'function') ? Meta.missionSlots() : 3}`), { first: true });
      if (!active.length) h += `<p class="idle">Every goal is complete. New chapters open as the station grows.</p>`;
      for (const m of active) h += missionCard(m, true);
      const chapters = [];
      for (const m of all) { let ch = chapters.find(c => c.name === (m.chapter || 'Missions')); if (!ch) { ch = { name: m.chapter || 'Missions', items: [] }; chapters.push(ch); } ch.items.push(m); }
      for (const ch of chapters) {
        const d = ch.items.filter(m => m.done || m.claimed).length, isOpen = open.has(ch.name);
        h += `<button type="button" class="shelf chapter${isOpen ? ' open' : ''}" data-chapter="${esc(ch.name)}" aria-expanded="${isOpen}"><span class="shelf-label">${icon('chevron-right', 12, 'chev')}${esc(ch.name)}</span><span class="shelf-tag">${d}/${ch.items.length} done</span></button>`;
        if (isOpen) h += `<div class="chapter-body">${ch.items.map(m => missionCard(m, false)).join('')}</div>`;
      }
      paint(F.body, h, sig, 'mi');
    };
    const missionCard = (m, big) => {
      const goal = Math.max(1, m.goal || 1), p = Math.min(1, (m.progress || 0) / goal), state = m.claimable ? 'claimable' : (m.done || m.claimed) ? 'done' : '';
      return `<div class="mission${big ? ' big' : ''} ${state}" data-mission="${esc(m.id)}"><i class="spine"></i><div class="mission-main"><div class="mission-title">${(m.done || m.claimed) && !m.claimable ? icon('check', 14) : ''}${esc(m.title)}</div>` +
        (big || !state ? `<div class="mission-desc">${esc(m.desc || '')}</div>` : '') +
        `<div class="mission-prog"><span class="meter amber" style="--p:${(p * 100).toFixed(1)}%"></span><span class="num">${Fmt.n(Math.min(m.progress || 0, goal))} / ${Fmt.n(goal)}</span></div>` +
        `<div class="mission-reward">${Overlays.rewardChips(m.reward, 'sm')}</div></div>` +
        (m.claimable ? `<button type="button" class="btn big primary" data-claim="${esc(m.id)}">${icon('collect', 16)}<span>Claim</span></button>` : (m.done || m.claimed) ? `<span class="chip good" data-shape="up">Claimed</span>` : '') + `</div>`;
    };
    const setTab = id => { tab = id === 'achievements' ? 'achievements' : 'missions'; F.setTab(tab); render(); };
    if (F.tabs) F.tabs.addEventListener('click', e => { const b = e.target.closest('.ptab'); if (b) { setTab(b.dataset.tab); ctx.sound.click(); } });
    F.body.addEventListener('click', e => {
      const b = e.target.closest('button[data-claim]'); if (b) { ctx.ui.claimMission(b.dataset.claim, b); return; }
      const ab = e.target.closest('button[data-claim-ach]'); if (ab) { ctx.ui.claimAchievement(ab.dataset.claimAch, ab); return; }
      const ch = e.target.closest('.chapter[data-chapter]'); if (ch) { const n = ch.dataset.chapter; if (open.has(n)) open.delete(n); else open.add(n); ctx.sound.click(); sig.mi = ''; render(); }
    });
    render();
    return { update: render, destroy() { }, setTab };
  },

  // ---------------------------------------------------------- Registry (4.10, 5.2)
  registry(host, ctx) {
    let tab = 'ships';
    const F = frame(host, { id: 'registry', title: 'Registry', sub: '', tabs: [{ id: 'ships', label: 'Ships' }, { id: 'species', label: 'Species' }, { id: 'artifacts', label: 'Artifacts' }], tab }, ctx), sig = {};
    const RARITY_HUE = { common: 'var(--ice)', uncommon: 'var(--sage)', rare: 'var(--amber)', epic: 'var(--rose)', legendary: 'var(--am)' };
    const render = () => {
      const col = ctx.meta.collection(); const items = col[tab] || [];
      const found = items.filter(i => i.found).length;
      const totalAll = ['ships', 'species', 'artifacts'].reduce((a, k) => a + (col[k] || []).length, 0), foundAll = ['ships', 'species', 'artifacts'].reduce((a, k) => a + (col[k] || []).filter(i => i.found).length, 0);
      F.setSub(`${foundAll} of ${totalAll} catalogued ${MID} ${esc(Fmt.cap(tab))} ${found}/${items.length}`);
      // sets from COLLECTION.sets (4.10): all ships of a company, all species, all artifacts of a sector; leftovers in "Catalogue"
      const defs = (typeof COLLECTION !== 'undefined' && COLLECTION && Array.isArray(COLLECTION.sets)) ? COLLECTION.sets.filter(s => s.kind === tab) : [];
      const sets = defs.map(s => ({ key: s.name, id: s.id, reward: s.reward, items: s.items.map(id => items.find(i => i.id === id)).filter(Boolean) })).filter(s => s.items.length);
      const placed = new Set(sets.flatMap(s => s.items.map(i => i.id)));
      const rest = items.filter(i => !placed.has(i.id));
      if (rest.length) sets.push({ key: sets.length ? 'Catalogue' : Fmt.cap(tab), items: rest });
      const hueOf = it => tab === 'ships' ? coHue(it.fam || it.company) : (SECTOR_LOOK[it.fam] || {}).rim || RARITY_HUE[it.rarity] || 'var(--ivory)';
      let h = `<div class="setbar"><span class="tile-lbl">${esc(Fmt.cap(tab))} found</span><span class="meter rose" style="--p:${items.length ? (found / items.length * 100).toFixed(1) : 0}%"></span><span class="num">${found} / ${items.length}</span></div>`;
      if (!items.length) h += `<p class="idle">Nothing catalogued yet. Serve ships and launch expeditions to fill the registry.</p>`;
      sets.forEach((set, si) => {
        const d = set.items.filter(i => i.found).length, complete = d === set.items.length && set.items.length > 0;
        const reward = set.reward;
        h += shelf(set.key, `${d}/${set.items.length}${complete ? ` ${MID} <span class="c-good">${GLYPH.up} complete</span>` : reward ? ` ${MID} pays ${reward.am ? reward.am + ' AM' : reward.credits ? Fmt.n(reward.credits) + ' cr' : ''}${reward.title ? ` + "${esc(reward.title)}"` : ''}` : ''}`, { first: si === 0, hue: 'var(--rose)' });
        h += `<div class="sil-grid">`;
        set.items.forEach((it, i) => {
          const hue = hueOf(it);
          h += `<div class="sil-card${it.found ? ' found' : ''}" style="--hue:${hue}" title="${esc(it.found ? (it.lore || it.name) : 'Not yet found')}" tabindex="0">${silhouette(tab, it, si * 7 + i, it.found, hue)}` +
            `<span class="sil-name">${it.found ? esc(it.name) : 'Unknown'}</span>${it.rarity ? `<span class="sil-rarity micro">${esc(it.rarity)}</span>` : ''}${it.found && it.count > 1 ? `<span class="sil-count tag">${GLYPH.times}${it.count}</span>` : ''}` +
            (it.found && it.lore ? `<p class="sil-lore">${esc(it.lore)}</p>` : '') + `</div>`;
        });
        h += `</div>`;
      });
      paint(F.body, h, sig, 'r:' + tab);
    };
    if (F.tabs) F.tabs.addEventListener('click', e => { const b = e.target.closest('.ptab'); if (!b) return; tab = b.dataset.tab; F.setTab(tab); ctx.sound.click(); render(); });
    render();
    return { update: render, destroy() { } };
  },

  // ---------------------------------------------------------- Store (7.3)
  store(host, ctx) {
    const F = frame(host, { id: 'store', title: 'Store', sub: '' }, ctx), sig = {};
    const render = () => {
      const cat = ctx.store.catalog(), mode = ctx.store.mode();
      F.setSub(`${Fmt.n(ctx.meta.am())} AM in the vault ${MID} ${mode === 'stripe' ? 'secure checkout' : 'sandbox'}`);
      const am = cat.filter(i => i.kind === 'am'), boosts = cat.filter(i => i.kind === 'credits' || i.kind === 'boost'), passes = cat.filter(i => i.kind === 'pass'), cosm = cat.filter(i => i.kind === 'cosmetic');
      let h = mode !== 'stripe' ? `<div class="ribbon"><i class="sq"></i>Test mode. Purchases are free and local until Stripe is connected.</div>` : '';
      h += `<div class="store-hero"><i class="spine"></i><div class="store-hero-head"><span class="store-hero-ic">${icon('am', 28)}</span><div><div class="store-hero-title">Antimatter</div><p class="body">Skip waits, bring crews home early and open sectors on your own schedule. Earned by play, or bought here.</p></div></div>` +
        `<div class="am-tiles">${am.map(i => tile(i)).join('')}</div></div>`;
      const relief = (typeof TIMERS !== 'undefined' && TIMERS.RELIEF_CONVOY) || { am: 10, minutes: 30 };
      const reliefRow = `<div class="sku" style="--hue:var(--am)"><i class="spine"></i><span class="sku-ic">${icon('credits', 20)}</span><div class="sku-main"><span class="sku-name">Relief convoy</span><span class="sku-desc">${relief.minutes} minutes of your whole station's rate, delivered now, paid with Antimatter you already hold.</span></div><button type="button" class="btn am" data-act="relief">${icon('am', 14)}<span>${relief.am} AM</span></button></div>`;
      h += shelf('Boosts', 'credits now', { hue: 'var(--amber)' }); h += `<div class="sku-list">${boosts.map(i => row(i, 'amber')).join('')}${reliefRow}</div>`;
      if (passes.length || cosm.length) { h += shelf('Passes and cosmetics', null, { hue: 'var(--rose)' }); h += `<div class="sku-list">${[...passes, ...cosm].map(i => row(i, i.kind === 'pass' ? 'am' : 'rose', i.kind === 'cosmetic')).join('')}</div>`; }
      h += shelf('Restore purchases', null, { hue: 'var(--ice)' });
      h += `<div class="restore"><input type="email" class="input" id="restore-email" placeholder="email used at checkout" aria-label="Email used at checkout" autocomplete="email"><button type="button" class="btn" data-act="restore">${icon('reroll', 14)}<span>Restore</span></button></div>`;
      h += `<p class="legal micro">Prices in USD. Antimatter is a game currency with no cash value and cannot be refunded or transferred. Sandbox grants are local to this browser.</p>`;
      paint(F.body, h, sig, 's');
    };
    // Store.catalog() entries: { sku, kind, title, desc, amount, grant, priceCents, priceLabel, badge, owned }
    const rawOf = sku => (typeof STORE_CATALOG !== 'undefined' && Array.isArray(STORE_CATALOG)) ? STORE_CATALOG.find(x => x.sku === sku) || {} : {};
    const amOf = i => (i.grant && i.grant.am) || (i.kind === 'am' ? i.amount : 0) || 0;
    const tile = i => {
      const raw = rawOf(i.sku), bonus = raw.bonusPct || 0;
      return `<button type="button" class="am-tile${i.badge ? ' lifted' : ''}${i.owned ? ' owned' : ''}" data-sku="${esc(i.sku)}"${i.owned ? ' disabled' : ''} aria-label="${esc(i.title)} for ${esc(i.priceLabel)}"><i class="spine"></i>${i.badge ? `<span class="am-badge">${esc(i.badge)}</span>` : ''}` +
        `<span class="am-ic">${icon('am', 22)}</span><span class="am-amount num">${Fmt.n(amOf(i))}</span><span class="am-lbl">AM${bonus ? ` <span class="c-good">+${bonus}%</span>` : ''}</span><span class="am-price num">${esc(i.priceLabel || '')}</span></button>`;
    };
    const row = (i, hue, soon) => `<div class="sku${i.owned ? ' owned' : ''}${soon ? ' soon' : ''}" style="--hue:var(--${hue})"><i class="spine"></i><span class="sku-ic">${icon(i.kind === 'pass' ? 'map' : i.kind === 'cosmetic' ? 'ship' : 'credits', 20)}</span>` +
      `<div class="sku-main"><span class="sku-name">${esc(i.title || i.sku)}</span><span class="sku-desc">${esc(i.desc || '')}</span></div>` +
      (i.owned ? `<span class="chip good" data-shape="up">Owned</span>` : soon ? `<span class="chip ivory" title="Liveries arrive in a coming update; nothing is sold until they show on your station">Coming soon</span>` : `<button type="button" class="btn${hue === 'am' ? ' am' : ' primary'}" data-sku="${esc(i.sku)}">${esc(i.priceLabel || 'Buy')}</button>`) + `</div>`;
    F.body.addEventListener('click', e => {
      const b = e.target.closest('[data-sku]'); if (b && !b.disabled) { ctx.ui.purchase(b.dataset.sku, b); return; }
      const rl = e.target.closest('[data-act="relief"]');
      if (rl) {
        const res = (typeof Meta !== 'undefined' && typeof Meta.reliefConvoy === 'function') ? Meta.reliefConvoy() : null;
        if (res && res.ok) { ctx.ui.toast(`Relief convoy arrived: +${Fmt.n(res.credits)} credits`, 'good'); if (ctx.sound && ctx.sound.click) ctx.sound.click(); }
        else { ctx.ui.toast((res && res.why) || 'Not enough Antimatter', 'warn'); if (ctx.sound && ctx.sound.error) ctx.sound.error(); }
        sig.s = ''; render(); ctx.ui.refresh(); return;
      }
      const r = e.target.closest('[data-act="restore"]'); if (r) { const inp = host.querySelector('#restore-email'); ctx.ui.restore(inp ? inp.value.trim() : ''); }
    });
    render();
    return { update() { if (document.activeElement && document.activeElement.id === 'restore-email') return; render(); }, destroy() { } };
  },

  // ---------------------------------------------------------- Settings (5.2)
  settings(host, ctx) {
    const F = frame(host, { id: 'settings', title: 'Settings', sub: 'Sound, motion, notifications, save data' }, ctx), sig = {};
    // A3 push notifications: js/notify.js loads after this file and may be absent in previews, so every call is guarded
    const notifyApi = () => (typeof Notify !== 'undefined' && Notify && typeof Notify.state === 'function') ? Notify : null;
    const NOTIFY_CHIP = { on: ['good', 'On'], off: ['ink', 'Off'], pending: ['ice', 'Connecting'], blocked: ['warn', 'Blocked'], error: ['warn', 'Offline'], unsupported: ['ink', 'Unavailable'], unconfigured: ['ink', 'Not connected'] };
    const NOTIFY_SUB = {
      off: 'A browser notification when a build, upgrade, expedition or clearing finishes, even with the tab closed',
      pending: 'Asking the browser and the notification service',
      blocked: 'Notifications are blocked for this site. Allow them in the browser\'s site settings, then switch this on again.',
      unsupported: 'This browser cannot show notifications for a closed tab.',
      unconfigured: 'The notification service is not connected yet.',
    };
    const render = () => {
      const st = ctx.meta.settings(), snd = ctx.sound.settings, perf = ctx.engine.perf();
      const sw = (id, on, label, sub, o = {}) => `<div class="setting"><div class="setting-main"><span class="setting-lbl">${esc(label)}</span>${sub ? `<span class="setting-sub">${esc(sub)}</span>` : ''}</div>${o.chip ? `<span class="chip ${o.chip[0]}">${esc(o.chip[1])}</span>` : ''}<button type="button" class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" data-switch="${id}" aria-label="${esc(label)}"${o.disabled ? ' disabled' : ''}><i></i></button></div>`;
      const notifyRows = () => {
        const N = notifyApi() ? notifyApi().state() : { status: 'unsupported', wanted: false, daily: false, detail: '' };
        const s2 = NOTIFY_CHIP[N.status] ? N.status : 'off';
        const live = s2 === 'on' || (s2 === 'error' && N.wanted);
        const sub = s2 === 'on' ? NOTIFY_SUB.off : s2 === 'error' ? (N.detail || 'The notification service could not be reached. It keeps trying.') : (NOTIFY_SUB[s2] || NOTIFY_SUB.off);
        let h2 = sw('notify', live || s2 === 'pending', 'Notify me when something finishes', sub, { chip: NOTIFY_CHIP[s2], disabled: s2 === 'unsupported' || s2 === 'unconfigured' || s2 === 'pending' });
        if (live) {
          h2 += sw('notifyDaily', !!N.daily, 'Daily reward reminder', 'At 9 in the morning when a reward is waiting');
          h2 += `<div class="actions"><button type="button" class="btn" data-act="notify-test">${icon('bell', 14)}<span>Send a test notification</span></button></div>`;
        }
        return h2;
      };
      const slider = (id, v, label) => `<div class="setting"><div class="setting-main"><span class="setting-lbl">${esc(label)}</span></div><input type="range" class="slider" min="0" max="100" value="${Math.round(v * 100)}" data-slider="${id}" aria-label="${esc(label)}"><span class="num slider-val">${Math.round(v * 100)}</span></div>`;
      const seg = (id, val, opts, label) => `<div class="setting"><div class="setting-main"><span class="setting-lbl">${esc(label)}</span></div><div class="seg">${opts.map(([v, l]) => `<button type="button" data-seg="${id}" data-v="${v}" class="${String(val) === String(v) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div></div>`;
      // A2.1 account shelf: not connected / signed out / signed in
      const acct = ctx.account, ast = acct ? acct.state() : null;
      let h = shelf('Account', null, { first: true, hue: 'var(--ice)', attrs: ' id="acct-shelf"' });
      if (!acct || !acct.available()) h += `<p class="fine acct-off">${icon('cloud', 14)} Cloud saves are not connected on this build yet. Your profile is saved in this browser; export it from Save data to move it.</p>`;
      else if (!ast.signedIn) h += `<div class="acct"><div class="acct-main"><span class="setting-lbl">Sign in to save across devices</span><span class="setting-sub">One cloud save per account, newest wins. A recovery phrase instead of email resets.</span></div><button type="button" class="btn primary" data-act="signin">${icon('cloud', 14)}<span>Sign in</span></button></div>`;
      else {
        const when = ast.lastSyncAt ? `${Fmt.ago(Date.now() - ast.lastSyncAt)} ago` : 'not yet', line = ast.syncing ? 'Syncing…' : ast.lastError ? `Error: ${ast.lastError}` : ast.dirty ? 'Changes waiting to sync' : 'Synced';
        h += `<div class="acct signed"><div class="acct-main"><span class="setting-lbl">${icon('user', 14)} ${esc(ast.user ? ast.user.email : '')}</span><span class="setting-sub">${esc(line)} ${MID} last synced ${esc(when)}</span></div></div>` +
          `<div class="actions"><button type="button" class="btn" data-act="sync">${icon('reroll', 14)}<span>Sync now</span></button><button type="button" class="btn ghost" data-act="signout">${icon('cloud', 14)}<span>Sign out</span></button><button type="button" class="btn ghost danger" data-act="delete-account">${icon('scrap', 14)}<span>Delete account</span></button></div>`;
      }
      h += shelf('Sound', null, { hue: 'var(--ice)' });
      h += sw('sfx', snd.sfx, 'Interface sounds', 'Clicks, collects, chimes') + slider('sfxVol', snd.sfxVol, 'Effects volume');
      h += sw('music', snd.music, 'Bridge ambience', 'A low hum and a slow pad') + slider('musicVol', snd.musicVol, 'Ambience volume');
      h += shelf('Motion and performance', null, { hue: 'var(--ice)' });
      h += seg('motion', st.motion || 'auto', [['auto', 'System'], ['reduced', 'Reduced'], ['full', 'Full']], 'Motion');
      h += seg('perf', st.perf == null ? 'auto' : st.perf, [['auto', 'Auto'], ['2', 'High'], ['1', 'Medium'], ['0', 'Low']], `Effects tier${perf ? ` ${MID} ${Math.round(perf.fps)} fps` : ''}`);
      h += sw('perfTag', !!st.perfTag, 'Show performance readout', 'fps and tier in the context bar');
      h += shelf('Notifications', null, { hue: 'var(--ice)' });
      h += notifyRows();
      h += shelf('Save data', null, { hue: 'var(--amber)' });
      h += `<div class="actions"><button type="button" class="btn" data-act="export">${icon('export', 14)}<span>Export save</span></button><button type="button" class="btn" data-act="import">${icon('import', 14)}<span>Import save</span></button><button type="button" class="btn" data-act="restore">${icon('reroll', 14)}<span>Restore purchases</span></button></div>`;
      h += `<textarea id="save-io" class="input io" rows="3" placeholder="Export writes your profile here. Paste a profile and press Import to load it." aria-label="Save data" spellcheck="false"></textarea>`;
      h += shelf('Danger', null, { hue: 'var(--bad)' });
      h += `<div class="actions"><button type="button" class="btn danger" data-act="scrap-station">${icon('scrap', 14)}<span>Scrap this station</span></button><button type="button" class="btn danger" data-act="reset-profile">${icon('bad', 14)}<span>Reset profile</span></button></div>` +
        `<p class="fine">Scrapping starts a new station in this sector; your rank, Antimatter and other sectors stay. Resetting the profile erases everything.</p>`;
      if (typeof Admin !== 'undefined' && Admin.configured()) {
        h += shelf('Admin', null, { hue: 'var(--am)' });
        h += `<div class="actions"><button type="button" class="btn am" data-act="admin">${icon('lock', 14)}<span>${Admin.unlocked() ? 'Bridge admin console' : 'Bridge admin…'}</span></button></div>` +
          `<p class="fine">Passphrase-protected testing console (also Ctrl+Shift+A). Grants made there are tagged admin in the profile history.</p>`;
      }
      h += shelf('About', null, { hue: 'var(--ink-3)' });
      h += `<div class="actions"><button type="button" class="btn" data-act="replay-tour">${icon('play', 14)}<span>Replay the tour</span></button><a class="btn" href="../manual/" target="_blank" rel="noopener">${icon('registry', 14)}<span>Open the manual</span></a></div>`;
      h += `<p class="fine">Waystation v2 ${MID} a browser space-station builder. Hand-written HTML, CSS and JavaScript with PixiJS for the world. Procedural audio, no trackers, saves on your device. ${MID} Licence: all original work; PixiJS under MIT.</p>`;
      paint(F.body, h, sig, 'st');
    };
    host.addEventListener('click', e => {
      const sw = e.target.closest('[data-switch]');
      if (sw) {
        const id = sw.dataset.switch, on = !sw.classList.contains('on');
        if (id === 'notify' || id === 'notifyDaily') {
          const N = notifyApi(); if (!N || sw.disabled) return;
          if (id === 'notify') { const p = on ? N.enable() : N.disable(); if (p && typeof p.then === 'function') p.then(() => { sig.st = ''; render(); }); }   // enable() must run inside the click: the permission prompt needs the gesture
          else N.setDaily(on);
          ctx.sound.click(); sig.st = ''; render(); return;
        }
        if (id === 'sfx' || id === 'music') ctx.sound.set(id, on); else ctx.ui.setSetting(id, on);
        ctx.sound.click(); sig.st = ''; render(); return;
      }
      const seg = e.target.closest('[data-seg]');
      if (seg) { ctx.ui.setSetting(seg.dataset.seg, seg.dataset.v); ctx.sound.click(); sig.st = ''; render(); return; }
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const io = host.querySelector('#save-io'), act = b.dataset.act;
      if (act === 'export') { const txt = ctx.meta.exportSave(); if (io) { io.value = txt || ''; io.focus(); io.select(); } ctx.ui.toast(txt ? 'Profile exported. Copy the text to keep it safe.' : 'Nothing to export yet', txt ? 'good' : 'warn'); }
      else if (act === 'import') { const txt = io ? io.value.trim() : ''; if (!txt) { ctx.ui.toast('Paste a profile first', 'warn'); return; } ctx.ui.confirm('Import this profile?', 'The current profile in this browser will be replaced.', () => { const ok = ctx.meta.importSave(txt); ctx.ui.toast(ok ? 'Profile imported' : 'That does not look like a Waystation profile', ok ? 'good' : 'bad'); if (ok) ctx.ui.refresh(); }, { yes: 'Import', danger: true }); }
      else if (act === 'restore') ctx.ui.openPanel('store');
      else if (act === 'notify-test') { const N = notifyApi(); if (N) N.test().then(ok => ctx.ui.toast(ok ? 'A test notification is on its way. It can take up to a minute.' : 'The test could not be sent. Check the notification service.', ok ? 'good' : 'warn')); }
      else if (act === 'scrap-station') ctx.ui.scrapStation();
      else if (act === 'reset-profile') ctx.ui.resetProfile();
      else if (act === 'admin') { if (typeof Admin !== 'undefined') Admin.open(); }
      else if (act === 'signin') ctx.ui.openPortal('login');
      else if (act === 'sync') ctx.ui.accountSync(b);
      else if (act === 'signout') ctx.ui.accountSignOut();
      else if (act === 'delete-account') ctx.ui.accountDelete();
      else if (act === 'replay-tour') ctx.ui.replayTour();
    });
    host.addEventListener('input', e => {
      const sl = e.target.closest('[data-slider]'); if (!sl) return;
      const v = (+sl.value) / 100; ctx.sound.set(sl.dataset.slider, v);
      const out = sl.parentElement.querySelector('.slider-val'); if (out) out.textContent = String(Math.round(v * 100));
      sig.st = '';
    });
    render();
    return { update() { if (host.contains(document.activeElement) && document.activeElement.matches('input,textarea')) return; render(); }, destroy() { } };
  },
};

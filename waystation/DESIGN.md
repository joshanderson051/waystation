# WAYSTATION — Visual Design Specification (canonical)

**Direction:** Bridge Console: Keel & Shelf (winner), revised per the three judgements.
**Status:** FINAL. This file is the single source of truth for the visual overhaul. Where code, comments or earlier drafts disagree with this file, this file wins.
**Readers:** Engineer R (canvas renderer: `js/render.js`, new `js/art.js`, new `js/fx.js`) and Engineer H (DOM HUD: `index.html`, `css/style.css`, `js/ui.js`, `js/main.js`). `js/sim.js` and `js/data.js` are not rewritten; section 0 lists the only edits allowed to them.

Units: `px` means CSS pixels unless written `device px`. "Units" (u) in module art means 1/100 of the cell in the 100x100 design space. Durations are milliseconds unless written `s`.

---

## 0. Contract between renderer and HUD

This section is the hard interface. Neither engineer changes anything here without updating this file.

### 0.1 Files and load order

```
index.html
css/style.css
js/data.js        unchanged data (glyph/icon emoji fields are IGNORED by all code; H may delete them)
js/sim.js         unchanged simulation (already emits: built, demolished, dock, depart, spawn, levelup, day, change, log, toast, event)
js/art.js         NEW (Engineer A1): PAL loader, FAMILY map, desat(), COMPANY_COLOR, registryOf(), ICONS path library, Icons.svg()/Icons.path(), `const ART = {}` registry, shared drawing helpers
js/art-mod-a.js   NEW (Engineer A2): ART.hub, dock, warehouse, solar, fuel, quarters, cantina, comms, market, rec, hydro, clinic
js/art-mod-b.js   NEW (Engineer A3): ART.habitat, reactor, customs, security, school, bank, plaza, menagerie, refinery, shipyard, observatory, gate
js/fx.js          NEW (Engineer R2): particle pool (section 14.1 FX API)
js/ships.js       NEW (Engineer R2): ship hull sprites, engine bloom, nav lights, shadow, HOLD plate (section 9) behind the `Ships` API below
js/render.js      rewritten (Engineer R1): world, modules, placement, selection, floaters, thumbnail, perf
js/ui.js          rewritten (Engineer H2)
js/main.js        rewritten (Engineer H2)
```

`<script>` order: `data, sim, art, art-mod-a, art-mod-b, fx, ships, render, ui, main`. Every file is a classic script (`'use strict'`, globals, no ES modules, no bundler).

**PAL key convention**: `PAL[name]` where `name` is the CSS token without its leading dashes, hyphens kept: `PAL.amber`, `PAL['amber-hi']`, `PAL.lamp`, `PAL.hull`, `PAL['hull-edge']`, `PAL['hull-rim']`, `PAL.truss`, `PAL.void`, `PAL.ivory`, `PAL.ice`, `PAL['ice-hi']`, `PAL.gold`, `PAL.sage`, `PAL.rose`, `PAL.good`, `PAL.warn`, `PAL.bad`, `PAL.ink`, `PAL['ink-2']`, `PAL['ink-3']`, `PAL['surface-1']` … for every token in section 2. `PAL.load()` fills them (falling back to the hex in section 2) and `PAL.ready` is true afterwards. `PAL.family(id)` returns the resolved family color for a module id.

**Ships API** (ships.js, used only by render.js):

```
Ships.draw(ctx, ship, o)   // o = { x, y (CSS px centre), cell, t (seconds), now (Sim.now()), hovered, overHull, reduced, tier }
                           // draws, in order: shadow (if overHull), engine bloom + exhaust request (if moving), hull sprite rotated by ship.angle,
                           // nav lights, HOLD plate (if ship.state === 'queue'), hover ring (if hovered). Emits exhaust via FX.exhaust.
Ships.purge()              // drop hull/bloom caches (cell or DPR change)
Ships.halfLength(ship, cell) // = SHIP_CLASSES[ship.cls].size * cell / 14 (same as today, so shipAt hit radii are unchanged)
```

### 0.2 DOM ids that stay

- Canvas: `<canvas id="station">` inside `#canvas-wrap`. R adds a second canvas `#bg` (alpha:false) as the first child of `#canvas-wrap` if it is not already present in `index.html`; H puts both in `index.html` anyway: `<canvas id="bg"></canvas><canvas id="station"></canvas>`.
- Sidebar panels: `#panel-build`, `#panel-station`, `#panel-market`, `#panel-companies`, `#panel-log` (and `#log-list` inside the log panel).
- Overlays inside `#canvas-wrap`: `#tooltip`, `#toasts`, plus new `#condition` (banner), `#orders` (objective strip), `#level-banner`.
- Top bar ids stay: `#station-name, #s-day, #s-credits, #s-income, #s-power, #s-visitors, #s-residents, #stars, #s-level, #speed, #btn-save, #btn-new`. New: `#registry`, `#s-income-delta`, `#power-pips`.
- Status bar: `#hint`, `#queue-info`.
- Modal: `#modal .box`, `#modal-title`, `#modal-text`, `#modal-extra`, `#modal-actions`; new `#modal-tag` (mono header line).
- Title screen: `#title` (full-screen overlay), `#title-name` (input), `#btn-commission`, `#btn-resume`, `#btn-newstation`, `#title-thumb` (canvas 120x72).

### 0.3 Render API (unchanged surface, additive extras)

Unchanged, used by `main.js` / `ui.js` exactly as today:

```
Render.init(canvas)            // canvas is #station; Render finds/creates #bg itself
Render.resize()                // also wired to a ResizeObserver inside Render
Render.px(x) / Render.py(y)    // grid coords (fractional) -> CSS px, top-down mapping
Render.cellAt(mx, my)          // -> {r,c} | null
Render.shipAt(mx, my)          // -> ship | null
Render.draw(dt)                // dt in seconds
Render.hover                   // {r,c} | null   (set by main.js)
Render.placing                 // module id | null (set by main.js / ui.js)
Render.selected                // {r,c} | null   (set by main.js / ui.js)
Render.cell                    // current cell size in CSS px (read-only for others)
```

Additive (H may call; must feature-test `typeof Render.x === 'function'`):

```
Render.thumbnail(state, w, h)  // -> HTMLCanvasElement: baked plan of state.grid, used by the title screen
Render.mouse(mx, my)           // CSS px within canvas or null; feeds parallax + hover chip + tell priority
Render.perf()                  // -> {ms: EMA frame ms, tier: 0|1|2} for the status bar debug tag (hidden by default)
```

Render subscribes to Sim events itself: `built`, `demolished`, `dock`, `depart`, `spawn`, `levelup`, `change`. Render never writes to `Sim.state`.

### 0.4 Shared helpers exported by `art.js` (global objects, no modules)

```
PAL                 // object of resolved colors, filled by PAL.load() (see 0.5)
FAMILY[id]          // 'ops'|'power'|'trade'|'life'|'culture'|'hub'  for every MODULES id
FAMILY_COLOR[fam]   // token name: ops:'--ice', power:'--gold', trade:'--amber', life:'--sage', culture:'--rose', hub:'--ivory'
KIND_COLOR[kind]    // goods: mineral:'#8C949F', crop:'--sage', animal:'--rose', made:'--amber'
desat(hex, k)       // mixes toward its own luminance grey by k; k = .15 for company colors
COMPANY_COLOR[id]   // desat(COMPANIES[i].color, .15) computed once at load
ICONS[id]           // { d: 'M...', fill?: true } in a 24x24 viewBox; ids = all module ids, all good ids, UI ids (see 6.0)
Icons.svg(id, size, className) // -> string '<svg viewBox="0 0 24 24" width=.. class="ic ..."><path d=".." .../></svg>'
Icons.path(id)      // -> Path2D (cached) for canvas use
ART[id]             // module drawing bundle (section 8.0)
```

### 0.5 CSS custom properties the renderer reads

`PAL.load()` runs `getComputedStyle(document.documentElement).getPropertyValue(name).trim()` for every token in section 2, falls back to the hex written in section 2 when the value is empty, and re-runs on `document.fonts.ready` and whenever `body[data-level]` changes (MutationObserver on `document.body`, attributes only). The renderer never hard-codes a color that has a token.

### 0.6 Body data attributes (set by H, read by CSS and R)

- `body[data-level="1..5"]` set on `levelup` and at boot from `Sim.state.level`.
- `body[data-condition="flare"|"festival"|"alert"]` or absent. `flare` while `Sim.totals().flare`; `festival` while `Sim.state.day < Sim.state.fx.festivalUntil`; `alert` for 6 s of real time after a `pirates` or `outbreak` event resolves (the sim has no raid duration, so the HUD owns this timer).
- `body[data-placing]` present while `Render.placing` is set.
- `body[data-motion="reduced"]` when `matchMedia('(prefers-reduced-motion: reduce)')` matches; R also reads the media query directly.

### 0.7 Allowed edits outside the owned files

- `data.js`: H may delete `glyph` and `icon` fields. No other change. `color` stays (sim passes `coDef.color` into floaters).
- `sim.js`: no edits. Known consequences the design accounts for: `Sim.tick` returns early while `state.pending` is set (the game pauses during a modal); floaters are created by Sim with `{x,y,text,color,ttl:1.6}` and Sim mutates `ttl`/`y` each tick (Render ignores those fields; see 9.6); ships spawn 3 cells off a random edge and fly straight at their berth (no fixed lanes; see 7.6).

---

## 1. Visual identity and mood

**Design idea in one sentence:** the player sits at the operations console of their own station, and everything on screen is that console: black glass, a few flat colors that each mean exactly one thing, numbers that are always real, and motion that only happens when something changed.

The screen is a true-black field. Panels are not cards floating on a dark theme; they are regions of the same black surface, each marked by a short **keel**, a 4 px vertical rail with both ends cut at 45°, sitting on the surface's left edge, and organised by **shelves**, 1 px neutral hairlines with a 24 px amber index tick at their left end. The keel and the shelf never touch: our frame grammar is a detached chamfered rail plus a ruled line, never an elbow, never a curve, never a pill. The palette is warm but not hot: **amber** is the console's own chrome and money, **ice** is operations (docks, ships, power, traffic), **sage** is people (crews, residents, culture of care), **rose** is culture and the galactic tier, and **ivory** is the hub, the wordmark and the player's own hand (hover, placement, selection). Mint, signal orange and red appear only as status and always with a shape. Every small label is real data: the station registry, the day, the berth number, the grid cell. This is kin in spirit to a classic Starfleet bridge (black ground, flat semantic color, numbered sections, calm) and shares none of its geometry, palette or type.

The station is drawn in plan view as slate hull plating with a family-colored signal strip, warm lamp-colored windows that light when people are home, and one quiet animated **tell** per module that encodes live state: a dish sweeps because comms are on, dock lights step because a ship is on approach, the reactor core breathes faster because load is high. Ships are small crisp silhouettes with company livery and a soft additive engine bloom. Nothing blinks for decoration, nothing strobes, nothing scrolls on its own. The mood is confident quiet: a well-run bridge at night, a planet filling the upper corner of the viewport, and a town slowly lighting up below it.

---

## 2. Color system

All tokens live on `:root` in `style.css`. Canvas reads them via `PAL.load()`. Hex values are exact.

```css
:root{
  /* black is the material */
  --void:#04050A;          /* canvas space, title backdrop */
  --bg:#090B12;            /* page body */
  --surface-1:#0F1119;     /* top rail, sidebar, status bar, modal, tooltip, toast */
  --surface-2:#161A25;     /* cards, table zebra, inputs, glyph plates */
  --surface-3:#1E2432;     /* hover, active row, pressed */
  --hairline:#262C3A;      /* shelves, dividers, table rules */
  --hairline-2:#343B4C;    /* hover border, focused input border */

  /* canvas structure (also read by PAL) */
  --hull:#1B2030;          /* module plate fill */
  --hull-edge:#2A3142;     /* truss edge, plate inner line */
  --hull-rim:rgba(243,233,214,.25);   /* 1px ivory plate rim */
  --truss:#232838;         /* truss fill */

  /* identity hues: solid / hi / dim(55%) / ghost(14%) */
  --amber:#E9A23B; --amber-hi:#FFC46A; --amber-dim:rgba(233,162,59,.55); --amber-ghost:rgba(233,162,59,.14);
  --ice:#8FD3E8;   --ice-hi:#BFE8F4;   --ice-dim:rgba(143,211,232,.55);  --ice-ghost:rgba(143,211,232,.14);
  --sage:#A8C8A0;  --sage-hi:#CBE2C4;  --sage-dim:rgba(168,200,160,.55); --sage-ghost:rgba(168,200,160,.14);
  --rose:#E58BB8;  --rose-hi:#F2B6D3;  --rose-dim:rgba(229,139,184,.55); --rose-ghost:rgba(229,139,184,.14);
  --gold:#FFE28A;          /* POWER module family only; never used for DOM text */
  --ivory:#F3E9D6; --ivory-dim:rgba(243,233,214,.6); --ivory-ghost:rgba(243,233,214,.14);
  --lamp:#FFE9B8;          /* every lit window, lamp and beacon on the canvas */

  /* status: never decorative, always paired with a shape or a word */
  --good:#6FD3A3; --warn:#FF8F3D; --bad:#FF4F5E;
  --good-ghost:rgba(111,211,163,.14); --warn-ghost:rgba(255,143,61,.14); --bad-ghost:rgba(255,79,94,.14);

  /* text (neutral, never warm-tinted) */
  --ink:#E6E8EC; --ink-2:#A3A7B0; --ink-3:#6B707C;
  --on-accent:#140C00;     /* text on filled amber / ivory */

  /* glow: one layer, hero values only */
  --glow-amber:0 0 8px rgba(233,162,59,.35);
  --glow-ice:0 0 8px rgba(143,211,232,.35);

  /* hazard hatch: the only striped surface in the product */
  --hazard:repeating-linear-gradient(135deg,var(--warn) 0 5px,#140C00 5px 10px);
}
```

### 2.1 Semantic roles

| Role | Token | Where |
|---|---|---|
| Chrome | `--amber` | keels, shelf index ticks, tab underline, primary buttons, section header index, selected card outline |
| Money | `--amber-hi` (value), `--amber` (labels) | credits, costs, income, loan figures, cost floaters |
| Operations telemetry | `--ice` | power values and pips, ships served, berths, traffic chips, Station panel telemetry, engine/approach vectors are company-colored but the dock progress arc is ice |
| People | `--sage` | residents, visitors, QoL ring and bars (when not thresholded), trust labels |
| Culture / galactic | `--rose` | gate, observatory, menagerie, plaza, rec; the Aurelian liner chip |
| Player's hand | `--ivory` | hover outline, placement brackets, ghost outline, selection brackets, on-segment fill of segmented controls, wordmark |
| Lit elements | `--lamp` | canvas only: windows, lamps, LEDs in neutral state, running lights |
| Status | `--good/--warn/--bad` | plus shape: ▲ / ■ / ▼, chevrons, hatch, dashed ring |

Rules: body text never sits on a colored fill; text on filled amber or ivory uses `--on-accent`. Family colors never appear as DOM text; in the DOM they appear only as the 4 px card keel, the glyph plate stroke and the goods-kind bar. Red is never decorative. Only two things glow: the Credits value (`--glow-amber`) and, at level 4+, the shelves' index ticks.

### 2.2 Module families (`FAMILY` in art.js; data.js `color` is ignored by rendering)

| Family | Token | Modules |
|---|---|---|
| hub | `--ivory` (plate rim ice) | hub |
| ops | `--ice` | dock, comms, customs, security, shipyard |
| power | `--gold` | solar, reactor |
| trade | `--amber` | warehouse, fuel, market, bank, refinery |
| life | `--sage` | quarters, cantina, hydro, clinic, habitat, school |
| culture | `--rose` | rec, plaza, menagerie, observatory, gate |

Goods kinds: mineral `#8C949F`, crop `--sage`, animal `--rose`, made `--amber`.

Company colors: `COMPANY_COLOR[id] = desat(color, .15)` where `desat` mixes each channel toward the color's own luminance `L = .2126R + .7152G + .0722B` by 15%. Computed once in `art.js`; `ui.js` and `render.js` both read `COMPANY_COLOR`, never `COMPANIES[i].color` directly (floaters arriving with raw `coDef.color` are mapped through `desat` in Render).

### 2.3 Level evolution (the only level-dependent styling)

`body[data-level="4"], body[data-level="5"] { --ink:#F2F4F7; }` and the shelf index ticks gain `box-shadow: var(--glow-amber)`. Nothing else changes with level. No hue ever changes role or appears later than level 1.

### 2.4 Contrast (WCAG, on `--surface-1`; engineers verify with a checker before sign-off)

`--ink` 15:1 · `--ink-2` 7.9:1 · `--ink-3` 3.9:1 (micro-tags only) · `--amber` 8.8:1 · `--amber-hi` 12:1 · `--ice` 11:1 · `--sage` 10:1 · `--rose` 7.8:1 · `--good` 10:1 · `--warn` 8.5:1 · `--bad` 5.7:1 · `--on-accent` on `--amber` 9:1, on `--ivory` 14:1.

---

## 3. Typography

One Google Fonts request, two families plus one mono:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600&family=Barlow:wght@400;500&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
```

Fallback stacks: `'Barlow Condensed','Bahnschrift Condensed','Arial Narrow',sans-serif` · `'Barlow','Segoe UI',system-ui,sans-serif` · `'JetBrains Mono','Cascadia Mono',Consolas,monospace`.

| Role | Face / weight | Size | Tracking | Case | Used for |
|---|---|---|---|---|---|
| Wordmark | Barlow Condensed 600 | 18px (title screen 56px) | .30em | upper | "WAYSTATION" |
| Section header | Barlow Condensed 600 | 12px | .12em | upper | tier heads, panel section headers, modal title tag, condition banner, level banner (24px) |
| Tab label | Barlow Condensed 600 | 12px | .10em | upper | the five sidebar tabs |
| Label | Barlow Condensed 500 | **11px** (floor) | .10em | upper | stat labels, table headers, chips, QoL labels |
| Card name | Barlow Condensed 600 | 15px | .01em | sentence | module and company names, tooltip title (13px) |
| Body | Barlow 400 | 13px / 1.45 | 0 | sentence | descriptions, hints, notes; modal body 14px / 1.55 |
| Body strong | Barlow 500 | 13px | 0 | sentence | inline emphasis, button labels in modals |
| Hero number | JetBrains Mono 600 | 18px | 0 | — | Credits |
| Number | JetBrains Mono 500 | 13px | 0 | — | every other value: top rail, table cells, kv, trust, costs (costs 13px 600) |
| Log | JetBrains Mono 500 | 12px | 0 | — | log lines |
| Micro-tag | JetBrains Mono 500 | 10px | .08em | upper | registry, day, grid coords, berth ids, "×3", "NEED 300", footer tags. Only for information duplicated elsewhere. |

Every numeric element gets `font-variant-numeric: tabular-nums`. Uppercase only for labels of three words or fewer; sentence case everywhere else. 11px is the floor for anything a player must read to play; 10px exists only for mono micro-tags.

**Canvas text** uses the same faces: JetBrains Mono 500 for readouts and plates, Barlow Condensed 600 for the hover chip and level banner. Render awaits `Promise.all([document.fonts.load('600 12px "Barlow Condensed"'), document.fonts.load('500 12px "JetBrains Mono"')])` before baking any sprite containing text, draws tag-less variants until then, and purges sprite caches on `document.fonts.ready`. `ctx.font` is set once per text pass, never per item. Canvas `letterSpacing` is feature-detected (`'letterSpacing' in ctx`); when absent, tracked labels stay in the DOM.

---

## 4. Layout

### 4.1 Frame

`#app` is a grid: rows `60px 1fr 28px`. `#main` is a grid: columns `1fr clamp(344px, 27vw, 392px)`. Sidebar and bars are opaque `--surface-1`; the canvas is full-bleed in `#canvas-wrap` with nothing over it except the overlays listed in 0.2. No `backdrop-filter` anywhere.

At 1440x900: sidebar 388px, canvas 1052x812, `cell = floor(min(1052/19, 812/13)) = 55px`, grid 825x495 centred at (113..938, 158..653).
At 1280x720: sidebar 346px, canvas 934x632, `cell = floor(min(934/19, 632/13)) = 48px`, grid 720x432 at (107..827, 100..532).

The cell formula keeps the current `(GRID_COLS+4, GRID_ROWS+4)` margin so the queue orbit (radius 2.5 cells from the hub) and spawn points stay visible. R additionally rounds the cell down so that `cell * devicePixelRatio` is an integer.

### 4.2 Wireframe at 1440x900

```
+------------------------------------------------------------------------------------------------------+ 0
| WAYSTATION  Lantern Reach    | CREDITS  | INCOME   | POWER         | VISITORS | RESIDENTS | REPUTATION | L2 TRADING HUB |  ■ 1x 2x 4x  | SAVE  NEW |
| WS-1910 · DAY 041            |  12,450  | ▲ +380   | 14 / 20 ▮▮▮▮▯▯|  22 / 26 |   0 / 0   | ▮▮▮▮▯     |                |              |           |
+------------------------------------------------------------------------------+-------------------------+ 60
| [CONDITION · SOLAR FLARE · SOLAR ARRAYS DARK 2 DAYS]  (24px overlay, only when set)  | 01 BUILD 02 STATION 03 MARKET 04 COMPANIES 05 LOG |
| [◇ BUILD A DOCKING BAY  ◆ BUILD A SOLAR ARRAY  ◇ SERVE 3 SHIPS] (24px overlay, 1st 5 min) | ────────────────────▔▔▔▔▔▔ (sliding underline)   |
|                                                                   (planet)   | ▌ TIER 1 · WAY STATION            6/6 BUILT  |
|    .   .   .   .   .   .   .   .   .   .   .   .   .   .   .                 | ┃ [ic] Docking Bay ×2            800  ▯▯   |
|    .   .   .   .   .   .   .   .   .   .   .   .   .   .   .                 | ┃      One more berth. Ships queue…        |
|    .   .   .   .   .   .  [WH]═[DK]  .   .   .   .   .   .   .   ship →      | ┃ [ic] Cargo Warehouse            600  ▯   |
|    .   .   .   .   .  [SO]═(HUB)═[FU]  .   .   .   .   .   .   .             | ┃ [ic] Solar Array                500  ▮▮▮▮▮▮|
|    .   .   .   .   .   .  [QT]═[CN]  .   .   .   .   .   .   .               | ┃ ...                                       |
|    .   .   .   .   .   .   .   .   .   .   .   .   .   .   .                 | ▌ TIER 2 · TRADING HUB   LOCKED · 6 MOD · 1.0 REP |
|    .   .   .   .   .   .   .   .   .   .   .   .   .   .   .                 | ┃ (locked cards at 40%)                     |
|  ▌TRADE  Kestrel courier paid 280          (toasts, bottom-left, max 4)      |                                             |
|  PLOT 15x9 · CELL 4:7                                                        | WS-1910 · DAY 041 · 55PX            (footer)|
+------------------------------------------------------------------------------+---------------------------+ 872
| Pick a module in 01 BUILD, then click a bracketed cell.                     SHIPS 3 DOCKED · 1 HOLD · BERTHS 4 |
+------------------------------------------------------------------------------------------------------+ 900
                                                                               ^ 4px amber keel on the sidebar's left edge,
                                                                                 inset 8px from top and bottom
```

What moved: the tab strip becomes a numbered horizontal row with a single sliding underline (no vertical tab rail); Day leaves the stat row and joins the registry line under the wordmark; Reputation stars become five pips; Level becomes a chip; the hint and ship counts stay in the status bar; toasts stay bottom-left of the canvas; the modal centres over the **canvas area** (not the viewport) so the sidebar remains visible behind the backdrop; the planet moves to the top-right corner of the canvas, partly clipped by the canvas edges (7.3); onboarding lives in an overlay strip at the top of the canvas, not inside a panel.

### 4.3 Top rail composition (left to right, flex, 14px gaps, 14px side padding)

1. Wordmark block (min 170px): "WAYSTATION" 18px ivory .30em; under it 10px mono `--ink-3`: `WS-{registry} · DAY {day}`; station name 11px label `--ink-2` right of the wordmark.
2. Stat blocks separated by 1px `--hairline` 28px tall dividers: CREDITS, INCOME, POWER, VISITORS, RESIDENTS, REPUTATION, LEVEL chip (section 6.2).
3. `margin-left:auto` then the speed segmented control (4 segments x 36px) and SAVE / NEW lozenges.

### 4.4 Degradation

- `≤1366px` wide: VISITORS and RESIDENTS blocks drop their labels (label becomes the block's `title`), REPUTATION drops its label, the registry line under the wordmark hides, SAVE and NEW become 28px icon lozenges (`ICONS.save`, `ICONS.new`) with tooltips. Everything still fits one row at 1280 (measured sum ≈ 1150px).
- `≤1180px` wide: station name hides from the top rail (it remains in the Station panel header and the sidebar footer).
- Sidebar `≤360px` (true at 1280): panel padding 12px, build cards 56px tall with the description clamped to one line, market rows stack STOCK over PRICE in one mono column (6.6), company cards hide the blurb behind the tooltip.
- Height `<760px`: top rail stays 60px; the objective strip and condition banner share one 24px overlay (condition wins).
- Nothing wraps to a second row; nothing scrolls horizontally. Panels scroll vertically only.

---

## 5. Panel chrome system

### 5.1 Grammar

- **Keel**: a 4px wide vertical rail in a hue, on the left edge of a surface, with both ends cut at 45° (`clip-path: polygon(0 4px, 100% 0, 100% calc(100% - 4px), 0 100%)`). It is a `::before` pseudo-element on a `position:relative` non-scrolling wrapper, `pointer-events:none`. It is always inset from the surface's top and bottom (8px on the sidebar and modal, 6px on toasts and tooltips, 8px on cards) so it never meets a horizontal line. The keel is never a full-height border and never turns a corner.
- **Shelf**: a 1px `--hairline` rule across the full width of a panel section, with a 24px x 2px `--amber` index tick sitting on its left end, and the section label riding on the rule. The tick and any keel are separated by at least 6px of surface. Implemented as `border-top: 1px solid var(--hairline)` plus a `::before` tick on the header element.
- **Corners**: 3px radius on cards, lozenges, chips and inputs. Panels, bars, modal and tooltip are square-cornered. No chamfers on boxes, no pill shapes, no quarter-circles.
- **Surfaces**: `--surface-1` panel, `--surface-2` cards and rows, `--surface-3` hover and active row. No borders around cards (the keel and surface step are enough); 1px `--hairline` separators only inside tables and lists. No gradients, no bevels, no textures, no scanlines, no glass. One drop shadow in the product: the modal, `0 24px 60px rgba(0,0,0,.6)`.

### 5.2 Sidebar

`#sidebar` is `display:flex; flex-direction:column; position:relative; min-height:0; background:var(--surface-1)`. Its keel is amber, on its left edge, inset 8px top and bottom (`::before` on `#sidebar`, so it never scrolls with the panel). Children: `#tabs` (36px), `.panel` (flex:1, `overflow-y:auto`, padding 14px 14px 14px 18px; 12px at ≤360px), `#sidebar-foot` (22px, mono micro-tag `--ink-3`: `WS-1910 · DAY 041 · {name}`).

### 5.3 Tabs

`#tabs` is a 36px row of five equal buttons on `--surface-1` with a 1px `--hairline` bottom rule. Each button: a 2px x 10px hue tick (Build `--amber`, Station `--ice`, Market `--amber`, Companies `--sage`, Log `--ink-3`), then the index in 10px mono `--ink-3` (`01`), then the label in Barlow Condensed 600 12px .10em (`BUILD`); inactive label `--ink-2`, hover `--ink`, active `--ink`. Key hints (`B`, `M`) are 10px mono `--ink-3` right-aligned inside the Build and Market tabs at ≥ 1366px, otherwise in the tab's `title`. The active state is marked by one shared element `#tab-indicator`: `position:absolute; bottom:-1px; height:2px; background:var(--amber)` whose `transform: translateX()` and `width` tween over `--dur-state`. No tab is ever a filled color block.

Panel switch: the incoming panel gets `clip-path: inset(0 0 0 100%)` → `inset(0)` over `--dur-state` with `--ease`; the outgoing panel is hidden immediately. Under reduced motion the switch is instant.

### 5.4 Section headers and dividers

- **Section header** (tier heads, "QUALITY OF LIFE", "SELECTED MODULE", "SHIPPING COMPANIES"): 28px tall; the shelf rule runs across the top; the index tick at left; label Barlow Condensed 600 12px .12em `--ink` with the family or section hue only on the tick, not the text; right-aligned mono micro-tag in `--ink-2` (`6/6 BUILT`, `STORAGE 410 / 650`, `TRUST AVG 52`). Margin `16px 0 8px`; first header in a panel has `margin-top:0`.
- **Locked tier head**: label `--ink-3`, tick `--ink-3`, right tag in `--warn` with a leading ■: `■ LOCKED · 6 MODULES · 1.0 REP`.
- **Divider**: 1px `--hairline`, 10px vertical margin, no label.
- **Placing state**: while `body[data-placing]`, the Build panel's tier head rule for the selected module's tier becomes a 3px `--hazard` strip (one of the three sanctioned hazard surfaces).

### 5.5 Buttons (lozenges)

- Base: min-height 28px, padding 0 12px, `--surface-2` fill, 1px `--hairline` border, radius 3px, a 2px `--amber` index bar on the inside left edge (inset 4px top/bottom), Barlow Condensed 600 12px .08em uppercase `--ink`. Hover: border `--hairline-2`, fill `--surface-3`, `--dur-micro`. Active (pressed): fill `--surface-3`, index bar `--amber-hi`.
- `.primary`: solid `--amber` fill, `--on-accent` text, no index bar, no border; hover `--amber-hi`.
- `.danger`: index bar and text `--bad`; hover fill `--bad-ghost`.
- `.ghost`: no fill, no border, text `--ink-2`, index bar `--hairline-2`; hover text `--ink`.
- Disabled: opacity .4, `cursor:not-allowed`, no hover change.
- Icon lozenge: 28x28, icon 14px `currentColor`.

### 5.6 Segmented control (speed, Buy | Sell)

A lozenge group with 1px gaps on `--surface-1`. Segments: 28px tall (22px in market rows), `--surface-2`, 1px `--hairline` border, no index bar. The on segment fills `--ivory` with `--on-accent` text and shows a 4px filled square before its label; off segments show a 4px hollow square. Speed labels: `■` (pause glyph is a 6px square drawn in CSS, not a character), `1×`, `2×`, `4×` in 12px mono.

### 5.7 Chips

18px tall, radius 3px, 10px mono .08em uppercase, padding 0 6px, ghost fill of their hue with text in the hue (`--amber-ghost` + `--amber`, `--good-ghost` + `--good`, …). Status chips carry a leading shape: ▲ good, ■ warn/neutral, ▼ bad.

### 5.8 Inputs

`--surface-2` fill, 1px `--hairline` border, radius 3px, 32px tall, JetBrains Mono 500 14px `--ink`, padding 0 10px. Focus: border `--hairline-2` plus the focus ring.

### 5.9 Focus, hover, disabled

`:focus-visible { outline: 2px solid var(--ivory); outline-offset: 2px; }` on every interactive element (ivory is the player's hand). Hover never translates or scales anything in the DOM; it changes surface and border only. Disabled is 40% opacity and no hover.

### 5.10 Condition states

- `body[data-condition="alert"]`: a 24px `#condition` overlay at the top of `#canvas-wrap`: `--surface-1` at 94%, a 3px `--hazard` strip along its bottom edge, text Barlow Condensed 600 12px .12em `--bad`: `CONDITION · PIRATE RAID` / `CONDITION · HOLD FEVER`. Its top border is 1px `--bad` pulsing opacity .55→.8 on a 1.4s sine. The top rail's bottom hairline turns `--bad`. **Sidebar keel, cards and all other frames keep their hues.**
- `body[data-condition="flare"]`: `#condition` reads `CONDITION · SOLAR FLARE · SOLAR ARRAYS DARK {n} DAYS` in `--warn` with the hazard strip; the POWER value turns `--warn` with a ■ prefix. Canvas: solar plates switch to the offline variant (8.0).
- `body[data-condition="festival"]`: `#condition` reads `FESTIVAL · VISITOR SPENDING ×2 · {n} DAYS` in `--rose`, no hazard strip. Canvas: plaza awnings light.
- Removed when the effect expires; the banner exits with a 240ms fade.

---

## 6. Component designs

### 6.0 Icon library

`ICONS` ids: all 24 module ids; all 12 good ids; UI ids `save, new, pause, lock, comms, dish, ship, berth, power, credits, people, rep, trend-up, trend-down, trend-flat, check, warn, bad, info, close, reroll, lend, scrap, dump, buy, sell`. All drawn in a 24x24 viewBox with 1.5-unit strokes, round joins, `currentColor`; filled icons set `fill:true`. In the DOM: `Icons.svg(id, 16, 'ic')` returns inline SVG; CSS `.ic{display:inline-block;vertical-align:-3px;flex:none}`. On canvas: `Icons.path(id)` returns a cached `Path2D`; draw with `ctx.save(); ctx.translate(x,y); ctx.scale(size/24,size/24); ctx.lineWidth = 1.5; ctx.stroke(path)`. No emoji remains anywhere in `index.html`, `ui.js` output, canvas text or `data.js` consumers.

### 6.1 Build card

Grid `4px 40px 1fr auto`, column gap 10px, 60px tall (56px at sidebar ≤360px), `--surface-2`, radius 3px, margin-bottom 6px, padding 0 10px 0 0, cursor pointer.

- Column 1: the family keel, 4px wide, inset 8px top/bottom, chamfered ends, in `FAMILY_COLOR`.
- Column 2: 36x36 glyph plate, `--surface-3`, radius 3px, 1px stroke in family color at 55%; icon `Icons.svg(id, 20)` in the family color.
- Column 3: name Barlow Condensed 600 15px `--ink` with built count as a 10px mono `--ink-3` micro-tag `×3` after it; below, one line Barlow 400 12px `--ink-2`, `text-overflow:ellipsis`, full description in the tooltip (`title`).
- Column 4 (right-aligned): cost JetBrains Mono 600 13px `--amber-hi`; below, power as pips: `+6` = 6 filled 5x8px `--ice` pips, `-2` = 2 hollow pips (1px `--ice-dim` stroke), 2px gaps, right-aligned, plus the signed number in 10px mono `--ink-3` left of the pips when |power| > 6 (then pips cap at 6).

States:
- **hover**: fill `--surface-3`.
- **selected (placing)**: 2px `--amber` outline (`box-shadow: inset 0 0 0 2px var(--amber)`), fill `--surface-3`, a `PLACING` chip in `--ivory` fill / `--on-accent` text replacing the built-count tag; the description line reads "Click a bracketed cell. Right-click or Esc to stop."
- **unaffordable**: cost turns `--ink-3`; a 10px mono `--warn` micro-tag `NEED 300` sits under the pips (the shortfall). The card stays interactive: clicking it still enters placing mode (the ghost will carry the reason plate) and toasts `Need 300 more credits for a Docking Bay` as class `warn`.
- **locked**: opacity .4, glyph `--ink-3`, keel `--ink-3`, `cursor:not-allowed`; click toasts `Reach station level 2 to unlock Comms Relay` (class `warn`). The tier head carries the LOCKED tag (5.4).

### 6.2 Top rail readouts

Each stat is a block: label 11px Barlow Condensed 500 .10em `--ink-2` over a JetBrains Mono value 13px `--ink`, line heights 14/18, vertical centre in the 60px rail.

- **CREDITS**: value 18px 600 `--amber-hi` with `text-shadow: var(--glow-amber)`; negative values `--bad` with a leading ▼. Flashes `--good`/`--bad` for 600ms on change.
- **INCOME**: value 13px, prefixed by a 6px triangle: ▲ `--good` when `income.yesterday ≥ 0`, ▼ `--bad` otherwise, with explicit sign `+380` / `-140`.
- **POWER**: `14 / 20` in `--ice`; to the right, `#power-pips`: pips 6x10px, 2px gaps, count = `min(8, ceil(produced/4))` pips each representing `produced/count` units; used pips filled `--ice`, spare pips `--surface-3` with 1px `--hairline`, overdraw pips (used > produced) `--bad` with a 45° hatch (`repeating-linear-gradient(45deg, var(--bad) 0 2px, transparent 2px 4px)`) and the value turns `--bad` with a leading ▼. During a flare the value is `--warn` with ■ and a `FLARE` chip.
- **VISITORS**: `22 / 26` in `--sage` (visitors / beds).
- **RESIDENTS**: `15 / 30` in `--sage` (residents / homes).
- **REPUTATION**: five 8x14px radius-2 pips, 3px gaps; filled `--amber` for whole stars; the fractional pip is filled from the bottom by `frac*100%` via an inner `<i>` with height; empty pips `--surface-3` with 1px `--hairline`. `title="Reputation 2.35 / 5"`. No star glyphs.
- **LEVEL**: chip `L2 · TRADING HUB`, `--amber-ghost` fill, `--amber` text, 11px Barlow Condensed 600.
- **Registry**: `WS-{1000 + hash(name) % 9000}` where `hash` is a 32-bit FNV-1a of the station name; same function in `art.js` (`registryOf(name)`) so title screen, top rail and canvas agree.

Number tickers: every mono value animates from old to new over `--dur-number` (400ms) with easeOutCubic in one shared rAF loop (`Ticker.set(el, value, fmtFn)`), formatting with `fmt()` each frame; `tabular-nums` keeps widths stable. Values that change by less than 1 snap. Under reduced motion, values snap.

### 6.3 Station panel

Order: header `{STATION NAME}` with right tag `L2 · DAY 041`; **QoL ring**: 44px conic ring (`background: conic-gradient(var(--c) calc(var(--p)*1%), var(--surface-3) 0)` masked to a 5px stroke with a `--surface-1` inner disc), the percentage inside in 13px mono, ring color by threshold (`--good` > 75, `--warn` > 40, else `--bad`), label `QUALITY OF LIFE` and a word tag `OK` / `LOW` / `BAD` beside it; then the four **QoL bars**: 20 segments 3px wide, 1px gaps, 8px tall, filled count `round(v*20)`, color by threshold, each with a label at left (`FOOD`, `BEDS FOR CREWS`, `ENTERTAINMENT`, `HEALTH CARE`), a percentage in mono at right, and a word tag `OK` / `LOW` / `BAD` after the percentage (prefix glyph ▲ ■ ▼ on the label). Then the **kv telemetry** (`--ice` values): Modules, Berths, Cargo storage, Food served / day, Visitor beds, Homes, Power (with `(flare)` as a ■ chip), Ships served, Cargo traded, Lifetime earnings (amber). Then **yesterday's ledger** header with the signed total and the breakdown as a kv list. Then **SELECTED MODULE** (6.9). Idle text: "Click a module on the station to inspect or scrap it." in `--ink-2`.

### 6.4 Market

Header `TRADE EXCHANGE` with right tag `STORAGE 410 / 650`. Lead note 12px `--ink-2` with the sell/buy percentages in mono. Boom/glut lines become chips: `▲ BOOM · GRAIN ×3 → D44` (`--good`) / `■ GLUT · ORE ×½ → D44` (`--warn`). Without a Trade Exchange a shelf note reads `■ NEEDS EXCHANGE · policies locked` in `--warn`.

**Table**: header row 11px labels on a 1px `--hairline`; rows 30px, zebra `--surface-2` on even rows, hover `--surface-3`. Columns at ≥360px sidebar: `2px kind bar | 16px icon | name | stock (mono, right) | price (mono, right) + trend | BUY|SELL | ⋯`. Trend is a 6px triangle (▲ `--good` if price > base*1.05, ▼ `--bad` if < base*0.95, a 6px dash `--ink-3` otherwise) followed by the price. At ≤360px, stock stacks above price in one mono column (10px stock `--ink-2` over 13px price). Buy | Sell is the two-segment control at 22px (on segment ivory with filled square); disabled (no Exchange) segments at 40%. **Dump** is a row-hover action: a 22px icon lozenge (`ICONS.dump`, `.danger`) appearing in the last column on row hover or focus-within; `title="Sell all to a passing broker at half price"`; disabled when stock is 0. Boom/glut rows widen the kind bar to 3px in `--good`/`--warn` and append a `×3` / `×½` micro-tag after the price. Row `title` keeps the From / Wanted-by lists.

Footer note (first-open only, dismissible): "Turn Sell off for Raw Ore if you run a Refinery, and for Xenofauna if you run a Menagerie." (12.3).

### 6.5 Company card

`--surface-2`, radius 3px, padding 10px 12px 10px 16px, margin-bottom 8px, keel 4px in `COMPANY_COLOR` inset 8px. Head: name 15px Barlow Condensed 600; chips: `▲ OFFICE` (`--good`), `■ CONTRACT → D52` (`--ice`), `■ NEEDS JUMP GATE` (`--ink-3`), `■ LOAN 1,200 LEFT · 140/DAY` (`--amber`). Blurb 12px `--ink-2` (hidden behind the card `title` at ≤360px). Home line: `{PLANET} · {type}` 11px label, then two icon rows: `BRINGS` with goods icons 14px in kind colors, `BUYS` likewise. **Trust gauge**: 10 segments 6x10px with 1px gaps in the company color, filled `floor(trust/10)`, empty `--surface-3` + hairline; right: mono `64 / 100` and word tag `OK` (>70) / `LOW` (>40) / `BAD`. Row: `SHIPS SERVED 12` micro-tag left; `LEND` lozenge (`.primary` when a bank exists and no loan) right. Locked galactic company: card at 50% with the NEEDS JUMP GATE chip.

### 6.6 Log lines

`#log-list` lines: JetBrains Mono 500 12px, padding 4px 0, 1px `--hairline` separators. Structure: `D014` in `--amber-dim` (width 4ch), category code in `--ink-3` (`TRD` trade/dock, `EVT` event, `SEC` security, `RES` residents, `PWR` power, `BLD` build; derived in ui.js from the message's keywords and `cls`), message in `--ink-2`; `good` lines prefix ▲ in `--good`, `warn` ■ in `--warn`, `bad` ▼ in `--bad`, with the message in `--ink`. New lines fade in over `--dur-micro`. Day boundaries get an extra 1px `--hairline-2`. No cursor, no typing effect.

### 6.7 Tooltip

`#tooltip`: `--surface-1` at 94% opacity, 1px `--hairline` border, radius 3px, max-width 280px, padding 8px 10px 8px 14px, keel 3px in the subject's hue (module family, company color, or `--ivory` for cells) inset 6px. Title 13px Barlow Condensed 600 in the hue; body 12px Barlow `--ink-2`; mono footer 10px `--ink-3`: modules `GRID 4:07 · PWR −2 · BERTH CLEAR` (`BERTH BLOCKED` in `--bad` with ▼), ships `KESTREL · COURIER · HOLD 30/30`. Appears after 80ms with a 100ms fade; follows the cursor at +14,+14 clamped inside `#canvas-wrap`. Ship tooltip: company (hue), class, captain, crew, state line (`Docked · leaves in 0.8 d` / `■ Holding 1.2 d for a berth` in `--warn` / `On approach` / `Departing`), hold as icon+qty rows, WANTS as icons. After 600ms of hover, a second block fades in: completed trades as mono lines. Placing mode suppresses module tooltips (today's behaviour).

### 6.8 Modal (incoming transmission)

`#modal` backdrop `rgba(4,5,10,.75)` covers the viewport; `.box` is 460px (max 92vw) centred over `#canvas-wrap`'s rectangle (H computes the centre from `#canvas-wrap.getBoundingClientRect()` on open and on resize). Box: `--surface-1`, square corners, the one drop shadow, keel 4px inset 8px: `--amber` for events, `--ice` for confirmations and lend dialogs, `--bad` for pirates/outbreak. **Header strip** 28px, `--surface-2`: `Icons.svg('dish', 14)` in the keel hue, then `#modal-tag` 10px mono `--ink-2`: `TRANSMISSION 02 · DAY 041 · SRC SECTOR COMMS` (index = events seen this game, counted in ui.js and stored in `localStorage` `ws.evt`), or `SRC {COMPANY}` for contract events. Alert events (pirates, outbreak) add a 3px `--hazard` strip under the header (sanctioned surface #2). Title 18px Barlow Condensed 600 `--ink`; body 14px/1.55 `--ink-2` padding 16px 20px; `#modal-extra` holds inputs; actions right-aligned, primary filled amber, secondary base lozenge. Enter: opacity 0→1 and `clip-path: inset(0 0 100% 0)` → `inset(0)` over `--dur-state`. The first event of a game appends: "Transmissions like this arrive every few days. Most need no reply." (12.3).

### 6.9 Selected module block (Station panel)

Header `SELECTED MODULE` with right tag `GRID 4:07`. A static build card (no hover) showing the module; under it a status line: docks show `▲ Berth clear` (`--good`) or `▼ Berth blocked: no empty side for ships to pull up to` (`--bad`); if a ship is docked, `Docked: Capt. Okafor, Kestrel Lines · leaves in 0.8 d`. Then `SCRAP FOR 400` as a `.danger` lozenge (disabled with `title=why` when `canDemolish` fails, and `why` shown as 12px `--ink-2` beside it).

### 6.10 Toast

`#toasts` bottom-left of the canvas, 14px inset, column, 6px gaps, max 4 (oldest removed). Toast: `--surface-1` at 94%, radius 3px, max-width 320px, padding 6px 10px 6px 14px, keel 4px inset 6px in class hue: default `--amber`, `good` `--good`, `bad` `--bad`, `warn` `--warn`, `gold` → `--amber-hi`. Content: chip label 10px mono (`TRADE`, `EVENT`, `ALERT`, `BUILD`, `SAVE`; derived from class and message in ui.js) then 12px Barlow `--ink`. Enter: `translateX(-8px)`→0 + fade over 180ms; hold 3.5s while the keel drains top-to-bottom (a `::after` in `--surface-1` growing `height: 0→100%` linearly); exit fade 300ms. `pointer-events:none`.

### 6.11 Status bar

`#statusbar`: `--surface-1`, 1px `--hairline` top. Left `#hint` 12px Barlow `--ink-2` (contextual, 12.2). Right `#queue-info` 11px mono `--ink-2`: `SHIPS 3 DOCKED · 1 HOLD · BERTHS 4`; when `recentAway > 1.5` append a chip `■ DIVERTING · BUILD DOCKS` in `--warn`. Nothing in the status bar blinks.

---

## 7. Canvas world

### 7.1 Projection: top-down plan view, mapping unchanged

The 15x9 grid, 4-neighbour adjacency, the dock "one empty side" rule, the queue orbit and the straight-line approach are only unambiguous in plan. An isometric diamond would waste the corners of a 16:9 canvas, make a ship over a module ambiguous, and force every player to judge adjacency on a skewed grid. `px/py` remain `ox + x*cell`, `oy + y*cell`. Depth comes from light instead: a fixed key light from top-left gives every plate a 2 device px bright edge on top/left and a 2 device px dark edge on bottom/right, every sprite bakes a 3 device px shadow skirt down-right, and ships cast a 35% black shadow at (+2,+3) device px when over hull.

### 7.2 Background (`#bg`, `{alpha:false}`, baked on resize, DPR change and name change, debounced 120ms)

1. Fill `--void`.
2. Nebula: 4-octave value noise at 1/6 resolution upscaled with `imageSmoothingEnabled = true`, two tints: warm indigo `rgb(44,36,84)` and dusk teal `rgb(18,70,84)`, alpha `d*.22`, final luminance capped at 16% (verify: no nebula pixel brighter than `#2A2A3A`). Seeded by `registryOf(name)`.
3. 380 far stars as 1x1 device px `fillRect` in three alpha buckets (.3 / .5 / .8), warm white `rgb(236,232,222)`.
4. Planet (7.3).
5. Vignette: radial from transparent at 55% radius to `rgba(0,0,0,.5)` at the corners.

No lanes are baked (7.6).

### 7.3 Planet

Computed from the grid rectangle so it never sits under hull. Let `G` be the grid bounding box inflated by 0.5 cell. `r0 = 0.11 * min(W,H)`; centre `C = (W − 0.55r, 0.55r)`, so the disc is cut by the top and right canvas edges. Reduce `r` from `r0` in 2px steps until the disc does not intersect `G`, with a floor of `0.06 * min(W,H)`; if the floor is reached and it still intersects, move `C` up by the overlap. Results: 1440x900 → r ≈ 84px at (1006,46); 1280x720 → r ≈ 49px at (907,27). Body: radial gradient from the lit limb (top-left) `#8A5A3C` through `#4A3030` to the terminator `#2A1E22`, then a second radial of `rgba(4,5,10,.6)` offset down-right for the terminator shadow; a 2px atmosphere rim `rgba(243,233,214,.28)` on the lit side only (arc from −150° to 30°); one ring, 14° tilt, 1px at 22% alpha `--ivory`, drawn in two halves so the back half is under the body. The planet is dusty ochre so the one big background object agrees with the amber chrome.

### 7.4 Ambient motion (dynamic canvas)

- 36 near stars (2x2 device px) twinkling `alpha = .4 + .4*sin(t*ω + φ)` with periods 4–8s.
- One 512x512 mid-star tile (120 stars, 1px) drawn 4 times wrapping, offset by `mouse*0.006` for parallax (needs `Render.mouse`).
- One shooting star every 25–50s: a 1px line, 60px long, 500ms, alpha .6→0, never crossing the grid rectangle.
- No scan sweep, no grid pulse, no breathing backgrounds.

### 7.5 Grid presentation

Dots, not lines: 1 device px `rgba(243,233,214,.09)` at every intersection, rising to .22 while placing (tween 160ms). Two range rings around the hub centre at radii 4 and 7 cells: 1px `rgba(143,211,232,.06)`; the outer ring carries 36 bearing ticks 4px long at the same alpha. Bottom-left mono readout `PLOT 15x9 · CELL 4:07` 10px at 35% `--ivory`, showing the hover cell (blank when none), on no plate (it is non-essential).

### 7.6 Lanes and approach

Ships spawn 3 cells off a random edge and fly straight at their berth, so fixed lanes would be ignored by the traffic. Instead, Render stamps each ship's entry point on first sight (`WeakMap<ship, {x0,y0}>`) and, while `state === 'approach'`, draws its actual path: a 1px dotted line (`setLineDash([2,6])`) from the entry point to `ship.target` at 7% `--ivory`, with the final 2 cells at 20% `--ice`. The line is the real approach vector.

### 7.7 Connectors (trusses)

Built into one `Path2D` on Sim `change` for the fill and one for the edges. Truss width `0.16*cell`: fill `--truss`, 1px edges `--hull-edge`, a 1px centre conduit in `--ice` at 30% (static). Flow is shown by **one running light per spar**: a 2 device px `--lamp` dot travelling from the hub-side end to the far end over 1.2s, every 2.5s, phase-offset by `(r*7 + c*13) * .37`; at most one dot per spar, drawn in a single `fillRect` pass. A 2px `--ice` node where each spar meets a plate. New spars grow from the hub side over 250ms on `built`. Under reduced motion the running lights stop.

---

## 8. Module art

### 8.0 Rules (apply to all 24)

**Design space** 100x100 units per cell. Every module exports `ART[id] = { tellClass: 'A'|'B', silhouette(g, u), lit(g, u, st), tell(g, u, t, st) }` where `g` is the 2D context already translated to the cell's top-left and scaled so 1 unit = cell/100 CSS px (so all drawing is in 0..100 units; `u` is passed as the CSS px per unit = cell/100 for anyone who needs device-size clamps), `st` is a small state object Render builds per frame (see 8.2), and `t` is seconds offset by `(r*7 + c*13) * .37`. `silhouette` draws ONLY the family-colored silhouette (fill at 55% alpha, stroke 2u at 100%) using `st.color` passed as the resolved family color; Render draws plate, strip, rivets and tags itself. Render calls `lit` and `tell` with `g` in the same unit space and `ctx.save()/restore()` around each call; art functions must not rely on state leaking between calls and must not call `Sim` directly (everything they need is in `st`).

**Baked sprite** (one `drawImage` per module per frame), keyed `${id}|${cellDevicePx}|${variant}|${tag}`, 6 device px padding, cleared on cell change, font ready and variant change:
1. Shadow skirt: three rounded rects offset (+2,+3) device px at `rgba(0,0,0,.25/.15/.08)` growing 1 device px each (no `shadowBlur`).
2. Plate: rounded rect inset 6u, radius 10u, fill `--hull`; 1.5u rim `--hull-rim`; 2 device px top/left highlight `rgba(255,255,255,.10)`; 2 device px bottom/right shade `rgba(0,0,0,.55)`.
3. Signal strip: 4u tall along the top edge inside the rim, in the family color, inset by the radius.
4. Rivets: four r=2u dots at the plate corners, `rgba(255,255,255,.3)`.
5. Silhouette: `ART[id].silhouette` in family color, 55% fill / 100% stroke 2u (stroke ≥ 1 device px).
6. Registry tag: `{PREFIX}-{NN}` in JetBrains Mono 500, 12u, `--ivory` at 30%, bottom-right inside the rim; drawn only when `cell ≥ 48px` and fonts are ready. Prefix is the module id's first two letters uppercased (`DK`, `WH`, `SO`, `FU`, `QU`, `CA`, `CO`, `MA`, `RE`(rec), `HY`, `CL`, `HA`, `RX`(reactor), `CU`, `SE`, `SC`, `BA`, `PL`, `ME`, `RF`(refinery), `SH`, `OB`, `GA`); `NN` is the build index among modules of the same id ordered by `built` day then `r`, then `c` (Render derives it; it may renumber after a scrap, which is acceptable). Docks additionally show the berth number as a 14u tag top-right (`01` is the hub's own collar, docks number from `02`).

**Variants**: exactly two: `normal` and `offline` (solar only: plate `#2A2F3D`, rim `#55596A`, strip `#55596A`, silhouette `#6C7284`, 45° hatch at 12% `rgba(255,255,255,.12)` 3u pitch). Everything that depends on state is drawn live, never baked.

**Live layers** (per frame, after the sprite, ≤ 8 path ops each, no gradients, no text except the dock chevron count):
- `lit`: lamp elements, always `--lamp`, 4u squares or r=2u dots (≥ 2 device px; Render clamps). Count/alpha driven by state (e.g. windows lit = occupancy ratio).
- `tell`: the one idle animation. Class **A** tells carry sim state and run whenever the module is powered: hub, dock, solar, reactor, comms, gate, habitat, quarters, warehouse, refinery, shipyard, security, bank, menagerie, plaza, market, clinic. Class **B** tells are pure ambience: cantina, rec, school, customs, observatory, fuel, hydro. B tells run only when `cell ≥ 44px`, the module is within 3 cells of the mouse or the total module count ≤ 12, and at most 16 B tells run at once (nearest the mouse win). Under reduced motion all tells stop except beacons (security during alert, habitat antenna) and dock LEDs. Below 36px cells all tells stop; below 44px B tells stop.
- Unpowered (`T.efficiency < 1`): every consumer's tell freezes at phase 0 and its lit elements drop to 50% alpha.

**Status overlays** (outer 4u of the cell, after the sprite):
- Power shortage: dashed `--warn` ring (`setLineDash([4,3])` device px, 1px) inset 2u, rotating 1 rev/12s, plus a 6u ▲ in `--warn` at the top-right corner, on every consumer while `T.efficiency < 1`.
- Flare offline: the `offline` variant (solar only), tell frozen, lit off.
- Dock berth state: shown by the dock's own collar and LEDs (table below), never by a bare dot.
- Hover / selected: section 10.

Minimum feature 3u; lit dots 4u; LEDs `max(2 device px, 4u)`. Silhouettes must read with the signal strip hidden and the tell disabled (Gate 1 acceptance).

### 8.1 Per-module art

Family colors as in 2.2. "Lamp" always means `--lamp`.

| Module | Silhouette (family) | Distinguishing details | Lit elements | Tell (class) | Status |
|---|---|---|---|---|---|
| **hub** | Hexagon plate filling the cell (R 48u), ivory rim 2u, ice inner ring | three concentric rings R 26/34/42u; middle ring split into 6 arcs with 4u gaps; six radial seams to the vertices | 6 lamp dots at the vertices; lamp core r=6u | (A) middle ring rotates 1 rev/20s; core breathes r ±2u over 3s, faster (2s) when `used/produced > .9`; one baked radial glow sprite (r 16 device px, ivory .35) under the core | power deficit: ring turns dashed `--warn` |
| **dock** | U-shaped collar, arms 14u thick, open toward `berthPoint` side (recomputed on `change`); two clamp pads 10x6u at the arm tips (ice) | a 4u dark LED slit along the open edge with 3 LEDs; umbilical stub 4u toward the hub side; berth tag `02` | 3 LEDs: free `--good` steady; approaching: lamp chasing outward 1 step/s; docked: `--ice` steady and clamps slide closed 6u over 300ms; blocked: LEDs off | (A) as the LED behaviour; while docked, a 2px `--ice` progress arc runs along the collar's outer edge from 0 to `1 − left/dockDays` | blocked (`!dockUsable`): three 6u `--bad` chevrons pointing inward on the collar's outer edge and a 4u `--hazard` hatch along the collar rim (sanctioned hazard surface #3) |
| **warehouse** | 3x3 crate grid, 20u crates with 4u gaps (amber) | one lid highlighted 2u lighter; a 2u diagonal strap on the centre crate | crates fill bottom-up at 100% alpha = `round(stockTotal/storage * 9)`; unfilled crates 35% | (A) when stock changes, the newly filled or emptied crate flashes lamp for 400ms | storage ≥ 95%: top row gets a 2u `--warn` outline |
| **solar** | two 2x4 panel wings (each 30x56u) on a 6u spine (gold) | panel cells separated by 2u dark lines; junction box 8u on the spine | one lamp dot on the junction box | (A) a 6u-wide specular band (`rgba(255,255,255,.18)`) sweeps each wing every 6s; wings tilt ±6° over a game day (`sin(day*2π)`) | flare: `offline` variant, tell frozen, lamp off |
| **fuel** | twin vertical cylinders 24x60u, 8u apart (amber) | a 6u hazard band (amber/dark stripes, 3 stripes) at 70% height; hose loop 3u to the plate edge; gauge slit 4x40u | 2 lamp valve dots at the cylinder tops | (B) gauge level drifts ±5% over 8s; a lamp drip dot falls 10u every 2s when a ship is docked adjacent | — |
| **quarters** | rounded bay 70x56u with 2 rows of 4 bunk slits 10x6u (sage) | door notch 8u on the hub side | window slits lit = `round(visitors/beds * 8)` | (A) one lit window toggles every ~4s via hash of `(t/4, r, c)` | no visitors: all windows at 20% |
| **cantina** | round table disc R 22u with 6 seat ticks; service counter bar 50x8u along the bottom (sage) | a 2u rose neon line on the counter | counter strip lamp; door glow dot | (B) three pooled steam ticks (2u) rise 12u over 1.2s and fade, staggered | — |
| **comms** | dish disc R 22u on a 6u mast rising from the bottom edge (ice) | two concentric arcs in front of the dish (R 28/34u, 90° span); feed horn dot | lamp dot on the mast top | (A) dish rotates 1 rev/8s about the mast top; an expanding 1px ice ring (R 10→40u, alpha .4→0) every 1.7s | — |
| **market** | balance beam 60x4u on a 20u post with two pans (R 10u) (amber) | a ticker strip 60x6u along the bottom with 4 tick marks | lamp dot at the beam pivot | (A) tick marks scroll left 6u/s; each colored `--good`/`--bad`/`--ink-3` from the sign of the last four price trends (`effPrice − base`) | — |
| **rec** | ring court R 26u with a centre dot, 4 corner lamp posts (rose) | a 2u scoreboard slit on the top rim | 4 corner lamps | (B) lamps brighten in sequence every 2s; a 3u ball dot drifts on an ellipse | — |
| **hydro** | half-ellipse glass dome 70x44u over 4 crop rows (sage) | a 2u dome highlight arc; a 3u leaf tick on each row | rows lit in sage-pink `#D9B8D0` (the only non-lamp lit element: grow light) | (B) rows breathe alpha .6→1 over 4s | unpowered: rows at 30% |
| **clinic** | rounded bay 64x56u with a cross cut-out 28x28u (sage, cross ivory) | an ECG slit 40x6u along the bottom; two bed ticks | lamp door dot | (A) ECG trace scrolls with one beat per second (1px polyline, 6 points); the beat pulses the cross outline 1u | outbreak event with clinic: cross turns `--good` for 6s |
| **habitat** | ring of 8 window squares (10u) around a 24u courtyard (sage) | a 3u antenna with a dot; courtyard tree dot | windows lit = `round(residents/homes * 8)` | (A) one lit window toggles every 5s via hash; antenna lamp blinks 0.5Hz (beacon; survives reduced motion) | residents 0: windows 20% |
| **reactor** | torus ring R 30u, 10u thick, central core R 10u (gold, core `#9FE8D8`) | three thin orbit arcs (1px, R 36/40/44u, 120° spans); two coolant pipes 4u to the plate edge | core | (A) arcs rotate at 1 rev/5s, /7s, /11s; core breathes at `1 + 3*load` Hz where `load = used/produced`; core turns `--warn` above 90% load; one baked radial glow sprite (r 12 device px) under the core | — |
| **customs** | checkpoint box 36x28u with a gate bar 56x4u across a lane (ice) | a stamp square 10u on the box; barrier stripes 3 ticks | lamp on the box | (B) a 2u scan bar sweeps across the lane every 3s | — |
| **security** | shield chevron 44x50u with two turret stubs 8u at the shoulders (ice) | beacon dot top centre; a 60° sweep wedge from the centre | beacon lamp | (A) sweep wedge rotates 1 rev/6s at 15% alpha; beacon turns `--bad` blinking 1Hz while `data-condition="alert"` (survives reduced motion) | — |
| **school** | tiered semicircle (lecture bowl) R 32u open toward the top, 3 tier lines (sage) | lectern dot at the focus | lamp lectern | (B) two 3u dots orbit on tilted ellipses above the bowl, 1 rev/4s and /6s | — |
| **bank** | column facade: 4 columns 6x36u under a 56x6u lintel; vault circle R 14u below (amber) | 8 vault spokes; a 2u lintel highlight | lamp over the door | (A) a specular glint sweeps the vault disc every 5s; the glint turns `--warn` while any company has an outstanding loan | — |
| **plaza** | cross-shaped concourse (arms 20u wide) with 4 stall squares 12u in the corners (rose) | awning ticks 2u on each stall | stall awning lamps | (A) crowd dots (2u, lamp at 70%) random-walk slowly; count = `clamp(round(residents/5), 0, 6)`; festival: count doubles and awnings brighten to 100% | — |
| **menagerie** | dome grid (3x2 panes) 70x50u over a 10u glass band (rose) | a 3u creature silhouette (two humps) behind the band; foliage dots | band lit in rose at 40% when `stock.xenofauna > 0`, dark otherwise | (A) silhouette paces left-right over 6s only when xenofauna is in stock | — |
| **refinery** | three stacks 10x40u over a 60x24u hopper (amber) | a molten channel 40x4u in `--warn`; a 4u hazard band on the hopper | molten channel (warn, not lamp) pulsing | (A) puff tick (3u, `--ink-2`) rises from a stack every 2s only while converting (`stock.ore ≥ 6`); channel glow pulses .6→1 over 2s; idle (no ore): channel at 30%, no puffs | — |
| **shipyard** | gantry frame 70x56u around an empty hull outline (ice) | two crane dots on the top beam; a wrench tick | lamp on the gantry | (A) the crane traverses the beam over 3s and `FX.sparks` emits 2 sparks/s at the crane while any ship is docked on an adjacent dock | — |
| **observatory** | half-dome R 30u with a 6u slit; telescope line from the centre (rose) | tripod mark; lens dot | lamp lens | (B) slit rotates 1 rev/30s; lens glints every 7s | — |
| **gate** | two concentric rings R 44/34u, 6u thick, with 12 rune ticks on the outer ring; a chevron 20u at the top (rose, lens core `--ice-hi`) | a lens core R 10u | lens core | (A) rings counter-rotate 1 rev/12s and 1 rev/18s; two 90° alpha arcs swirl in the lens; the lens brightens from 40% to 100% as any liner's distance to the hub falls below 6 cells; one baked radial glow sprite (r 20 device px, ice .4). The showpiece; its tell runs down to 36px cells | — |

### 8.2 State object Render passes to `lit`/`tell`

```
st = { color,          // resolved family color string for this module (PAL.family(id))
       lamp,           // PAL.lamp
       T, efficiency, powered, hover:boolean, selected:boolean, reduced:boolean,
       cellPx,         // cell size in CSS px (for ">= 2 device px" clamps: minPx = 2 / devicePixelRatio)
       dpr,
       dock:{ open:'n'|'s'|'e'|'w'|null, usable, approaching, docked, progress, berth:number },  // docks and hub only
       ratio,          // occupancy or fill ratio for quarters/habitat/warehouse (0..1)
       load,           // used/produced for reactor/hub (0..1+)
       day,            // Sim.state.day + Sim.state.t (fractional day, for solar tilt)
       trends,         // market only: array of 4 signs (-1|0|1) of the last price trends
       flags:{ flare, festival, alert, loan, converting, xeno, linerNear, shipAdjacent, stockChanged } }
```

Computed once per frame from `Sim.totals()` (called once per frame, shared) and `Sim.state`.

---

## 9. Ship art

### 9.1 Common rules

Hull sprites are baked `Path2D` drawings in a 64x64 design space (nose at +x), per `(class, company)`, at the two cell sizes in use (normal, and 1.5× for the hover/tooltip plate). Half-length `L = cls.size * cell / 14` exactly as today, so `shipAt` hit radii are unchanged. Base hull `#B8B2A6`; 1px outline `rgba(255,255,255,.5)`; a 2px livery stripe in `COMPANY_COLOR` along the spine; port (left when facing +x) red `#FF5A5A` and starboard green `#5AE08A` nav dots 1.5px blinking 1Hz with per-ship phase `(id*.37) % 1`; one baked shadow sprite at 35% black drawn at (+2,+3) device px whenever the ship's centre is over an occupied cell. Rotation `sh.angle` as today.

| Class | Size | Silhouette | Livery |
|---|---|---|---|
| **Courier** | 6 | slim dart: nose at (32,0), tail at (−28,±10), two short nacelles 10x4 units at (−10,±14) | stripe down the centre line; nacelle tips in company color |
| **Freighter** | 8 | boxy hull 52x24 with a forward bridge block 10x14 and 3 container segments (alternating shade `#A9A396` / `#B8B2A6`) | stripe across the containers; bridge window strip lamp |
| **Hauler** | 11 | long spine 60x8 with 4 cargo pods 12x12 (two per side) and two engine blocks at the tail | stripe on the spine; pods filled company color at 55% |
| **Liner** | 13 | elongated oval 60x20 with a tail fin 8x14 and a dotted window row of 8 lamp dots at 80% | a band behind the bridge; three engines |

### 9.2 Engine

One cached additive radial sprite per company color at radii 8 / 16 / 32 device px (baked once with `createRadialGradient` at bake time only), drawn with `globalCompositeOperation = 'lighter'` at .6 alpha behind the tail, scale `0.6 + speed/maxSpeed`; plus 2 exhaust particles per frame while moving (1px, company color, 400ms, drift opposite the heading). Docked: no bloom, nav lights continue. Idle in queue: bloom at .25.

### 9.3 Approach, docking, undocking

- Approach: the real path line (7.6). The target dock's LEDs chase outward.
- Docking (on Sim `dock`): dock clamps close over 300ms; a 1px ice ring expands from the collar R 0.2→0.6 cell over 300ms; the 2px ice progress arc then runs along the collar edge for the stay. The old ring around the ship is removed.
- Undocking (on Sim `depart`): clamps open over 300ms; bloom ramps from 0 to full over 400ms.

### 9.4 Waiting (queue)

Ships orbit as today. Above the hull: a `--warn` bracket pair (two 8px L-brackets, 1px) and a 10px mono plate `HOLD 1.2d` in `--warn` on `rgba(4,5,10,.8)`, updated from `now − waitStart`. No "waiting" text.

### 9.5 Trade feedback

- Credits floaters (9.6).
- Cargo transfer: on `dock`, after the first trade line appears (ship.trades length changes), `FX.motes` sends 3 amber motes (2px) along the truss path from the dock cell to the nearest warehouse (BFS over occupied cells from the dock; the hub counts as storage if no warehouse) over 600ms; purchases send the motes back the other way.
- Credits to console: when a ship departs with `earned > 0`, 6 gold motes fly from the ship toward the top-left of the canvas (the Credits readout's direction) over 600ms with ease-in, and H flashes `#s-credits` on the `depart` event.

### 9.6 Floaters (Render owns presentation; Sim owns creation)

Sim pushes `{x, y, text, color, ttl}` and mutates `ttl`/`y`. Render keeps `WeakMap<floater, {t0, x0, y0, value, hidden}>`, stamping on first sight and ignoring Sim's later `y`/`ttl`. Presentation: JetBrains Mono 600 at `max(12, cell*.3)` px, 3px dark halo (`strokeText` in `rgba(4,5,10,.9)`, lineWidth 3), color = `desat(color, .15)` if it is a company color, `--warn` for cost floaters (Sim passes `#ff9d5a` → mapped to `--warn`), `--good` for refunds; rises 0.5 cell over 1.0s with easeOutCubic, fading over the last 30%. Coalescing: a new floater within 0.3s and 0.3 cells of a live one with the same sign adds its numeric value to it (re-formatted with `fmt`) and is marked hidden. Cap 6 visible; oldest hidden first. Render stops drawing a floater at 1.0s even though Sim keeps it to 1.6s.

---

## 10. Placement and selection feedback

**Entering placement** (`Render.placing` set): grid dots brighten to .22; cells that are not legal candidates dim via one `rgba(4,5,10,.4)` fill of the grid rectangle with every candidate cell punched out (`evenodd` path).

**Candidate cells**: for every empty cell adjacent to the station, `Sim.canPlace(id, r, c)`; legal cells get four 6px L-brackets (1px) at their corners in `--ivory` at `.55 ± .15` on a 2.5s sine, all in one `Path2D` stroked once; illegal-but-adjacent cells get `--bad` brackets at .3 plus a 45° hatch at 10%.

**Ghost**: the real sprite at 55% alpha with a 1px dashed `--ivory` outline, snapped to the hover cell (position lerps 80ms). Preview spars draw to each occupied neighbour at 40%. For a dock, the open side is previewed with a 1px dotted `--ice` lane 2 cells long. On an illegal cell the ghost outline turns `--bad` and a 10px mono plate under the cell states the reason, mapped from `Sim.canPlace().why`: `Occupied` → `OCCUPIED`; `Needs station level N` → `LOCKED · LEVEL N`; `Not enough credits` → `NEED {cost − credits} MORE CR`; `Must touch the station` → `NOT ADJACENT`. Advisories in `--warn` (placement still allowed): placing a dock whose four in-bounds neighbours are all occupied → `BERTH WILL BE BLOCKED`; placing any module on the last open side of an existing dock → `BLOCKS BERTH {NN}`.

**Commit** (Sim `built`): sprite scales 0.7→1.06→1.0 over 180ms (ease-out-back); 12 weld sparks in the family color over 300ms (`FX.sparks`); a 1px `--ivory` ring expands 0.5→1.3 cells over 400ms; spars grow from the hub side over 250ms; the cost floater arrives from Sim.

**Selected module**: four 10px L-brackets (1px `--ivory`) drawing in over 160ms and breathing 2px on a 3s sine, plus a leader line to a readout chip `DOCK 03 · BERTH CLEAR` (Barlow Condensed 600 11px caps on `rgba(4,5,10,.8)`), placed above the cell (below it when in the top row). The 8px rounded gold ring is removed.

**Hover** (not placing): 1px `--ivory` outline at 35% on the hovered module; the readout chip appears after 300ms. Hovering a ship: 1px `--ivory` ring at R `L+4`.

---

## 11. Motion language

Tokens in `:root`:

```css
--ease:cubic-bezier(.2,.7,.2,1);
--ease-exit:cubic-bezier(.3,0,.8,.15);
--ease-back:cubic-bezier(.34,1.3,.64,1);
--dur-micro:160ms;   /* hover, toggles, focus, chip, log fade */
--dur-state:240ms;   /* tab wipe, modal, bracket draw, banner enter/exit */
--dur-number:400ms;  /* tickers, ring expand */
--dur-long:600ms;    /* boot, motes */
```

**What animates**: surface and border color on hover (`--dur-micro`); the tab indicator slide and panel wipe (`--dur-state`); number tickers (rAF, `--dur-number`, easeOutCubic); toast enter/hold/exit (180 / 3500 / 300); modal wipe (`--dur-state`); the condition banner enter/exit (`--dur-state`); the level banner (2s, 12.4); boot (once per session, 11.1); placement commit, dock clamps, rings, sparks, motes (section 9–10); module tells, running lights, twinkle, the shooting star.

**What never animates**: panel frames, keels, shelves, labels, table rows, the Build list order, backgrounds (except the baked re-render on resize), status bar text, card positions (no layout shifts; new unlocked cards fade in, they do not slide others). Nothing strobes. Alert pulses are ±25% alpha on a 1.4s sine, only on the condition banner's border and the security beacon.

**Panel reveal**: `clip-path: inset(0 0 0 100%)` → `inset(0)` with an opacity dip to .6 at 40%, `--dur-state`. **Number tickers** use one shared rAF loop, never CSS counters or `@property`. **Transitions** are allowed only on `transform`, `opacity`, `clip-path`, `background-color`, `border-color`, `color`.

### 11.1 Boot (first frame after the title screen or on load with a save)

Once per session, 600ms total: the sidebar keel scales from `scaleY(0)` (origin top) over 300ms; shelf ticks scale from `scaleX(0)` staggered 40ms; labels fade in staggered 40ms; hero numbers tick up from 0 over 500ms. Skipped under reduced motion.

### 11.2 Reduced motion

`prefers-reduced-motion: reduce` (or `body[data-motion="reduced"]`): no breathing, wipes, parallax, twinkle, running lights, shooting stars or tells (beacons and dock LEDs remain); tickers snap; particles at 30% of their caps; toasts still fade.

---

## 12. Title screen and onboarding

### 12.1 Title screen (`#title`, full-screen over the live `#bg` canvas)

`main.js` no longer runs `Sim.load() || Sim.newGame()` silently. On load: R bakes the background for the current name (or a random `STATION_NAMES` pick), then H shows `#title`: backdrop `--void` at 0 (the baked nebula and planet show through), a centred column: wordmark `WAYSTATION` 56px Barlow Condensed 600 `--ivory` .30em; under it `STATION COMMISSIONING` 12px Barlow Condensed 600 `--amber` .12em; a 420px `--surface-1` card with an amber keel (inset 8px), padding 20px 24px 20px 28px.

- **With a save**: a RESUME card first: `Icons.svg('ship')`, `RESUME` label, then `Lantern Reach · DAY 41 · L2 TRADING HUB · 12,480 CR` in 13px mono, and `#title-thumb`, a 120x72 canvas from `Render.thumbnail(savedState, 120, 72)` (plates as 6px rounded rects in family colors at 80%, hub ivory, on `--void`; trusses 2px). The whole card is the `#btn-resume` button (`.primary` styling on hover). Below it, a quiet `.danger` lozenge `NEW STATION` (`#btn-newstation`) that reveals the commissioning form with a confirm step ("Your current station will be scrapped.").
- **Without a save** (or after NEW STATION): label `STATION NAME`; `#title-name` input (mono 16px) prefilled with a random `STATION_NAMES` pick; a `.ghost` icon lozenge `Icons.svg('reroll')` that picks another name and re-bakes the background (debounced 120ms); a mono line `REGISTRY WS-{registryOf(name)} WILL BE ASSIGNED ON COMMISSION` updating live; primary `COMMISSION STATION` (`#btn-commission`). Enter commits.
- Commission: `Sim.newGame()` then `Sim.state.name = name` (newGame picks a random name; H overwrites it before the first `change` and calls `Sim.save()`), `#title` fades out over `--dur-state`, boot plays (11.1), the hub's first spars weld in. The Resume path restores `Sim.load()` and plays boot without the welds.

The first `Render.thumbnail` and the title backdrop require `#bg`; the title never shows a blank black screen for more than one frame.

### 12.2 Status-bar hint table (state-driven, evaluated in `refreshTop`, first match wins)

| Condition | `#hint` text |
|---|---|
| `Sim.state.pending` | "Incoming transmission. Read it to continue." |
| `Render.placing` and the hover cell is illegal | the mapped reason in sentence case, e.g. "Not adjacent: modules must touch the station." |
| `Render.placing` | "Placing {name}: click a bracketed cell. Right-click or Esc to stop." |
| `T.efficiency < 1` | "Power shortage: modules run slower. Build a Solar Array or a Fusion Reactor." |
| any dock with `!dockUsable` | "Berth {NN} is blocked: it has no empty side. Ships cannot pull up to it." |
| `recentAway > 1.5` | "Ships are diverting. Build another Docking Bay." |
| `T.flare` | "Solar flare: solar arrays are dark. Reactors are immune." |
| first ship ever on approach (`stats.shipsServed === 0` and a ship in `approach`) | "{Class} from {planet} on approach to Berth {NN}. It will dock, trade and refuel." |
| first queued ship (`stats.shipsServed < 5` and a ship in `queue`) | "A ship is holding in orbit. Build another Docking Bay." |
| `Render.selected` | "Scrap returns half the build cost. The Core Hub cannot be removed." |
| default | "Pick a module in 01 BUILD, then click a bracketed cell. Click a module to inspect it." |

### 12.3 First five minutes

- **Objective strip** `#orders`: a 24px overlay at the top of `#canvas-wrap` (under `#condition` when both show): three items in Barlow Condensed 600 11px .10em `--ink-2`, each with a hollow 8px diamond that fills `--good` when its condition is true: `BUILD A DOCKING BAY` (`counts.dock ≥ 1`), `BUILD A SOLAR ARRAY` (`counts.solar ≥ 1`), `SERVE 3 SHIPS` (`stats.shipsServed ≥ 3`). Items are derived from real state every `refreshTop`; the strip hides 2s after the third fills and sets `localStorage['ws.orders'] = 'done'`; it never shows again for that save. A hover `title` on each item gives the why: "Ships need a berth. One bay, one ship at a time." / "Every module draws power. Arrays are cheap; flares dim them." / "Served ships pay fees and raise company trust."
- **First-open panel notes**: the first time each panel opens, a dismissible 2-line note (`--surface-2`, 12px Barlow `--ink-2`, keel `--ink-3`, an `×` icon lozenge) sits under the panel's first header: Build: "Tiers unlock with module count and reputation. Costs are in credits; pips are power." Station: "Quality of life above 55% brings residents when homes are free." Market: "Turn Sell off for Raw Ore if you run a Refinery, and for Xenofauna if you run a Menagerie." Companies: "Serve ships fast and trust grows. At 75 trust a company opens an office here." Log: none. Dismissal is stored in `localStorage['ws.notes.v1']` as a set of panel ids.
- **First event**: the modal body appends "Transmissions like this arrive every few days. Most need no reply." when `localStorage['ws.evt']` is unset.
- No tutorial wall, no arrows on the canvas, no forced sequence.

### 12.4 Level-up banner

On Sim `levelup`: `#level-banner` across the top of the canvas (under the overlays), 36px, `--surface-1` at 94%, amber keel, text Barlow Condensed 600 24px .12em `--ink`: `THRESHOLD · NOW A TRADING HUB`; clip-path wipe in from the left over `--dur-state`, hold 1.5s, fade 300ms (2s total). Newly unlocked Build cards fade in with a 120ms stagger the next time the Build panel renders.

---

## 13. Readability and accessibility

- **Sizes**: body 13px; anything a player must read to play is ≥ 11px; 10px only for mono micro-tags that duplicate information available elsewhere. Line height 1.45 body, 1.55 modal.
- **Contrast**: per 2.4; body text ≥ 7:1, primary ≥ 15:1, labels ≥ 3.9:1 (micro-tags only at that floor). Body text never sits on colored fills; filled controls use `--on-accent`.
- **Status never by hue alone**: good ▲ or filled square, warn ■, bad ▼ or chevrons; words `OK` / `LOW` / `BAD` on gauges; dashed ring = under-powered; hatch = offline or blocked; brackets = selection or placement; hollow vs filled pips; trend triangles plus the number; power overdraw pips hatched plus ▼; red and green never appear as a pair without differing shapes.
- **Canvas labels**: every readout sits on `rgba(4,5,10,.8)` or carries a 3px `rgba(4,5,10,.9)` halo; star alpha near the grid stays below 45%; the planet never overlaps the inflated grid box.
- **Targets**: every interactive target ≥ 28px tall; build cards ≥ 56px; market segments 22px tall but ≥ 44px wide.
- **Keyboard**: Tab order top rail → tabs → panel content → status; `focus-visible` ivory ring on everything; existing keys stay (Space pause, 1/2/4 speed, B Build, M Market, Esc cancel) and are shown as mono hints on the Build and Market tabs and in the speed control's `title`s; arrow keys move between tabs when a tab is focused.
- **Motion**: reduced motion honoured per 11.2; nothing flashes faster than 1Hz; no full-screen color changes.
- **Color-blind check**: the five family colors differ in luminance (gold 0.78, ivory 0.84, ice 0.58, sage 0.52, amber 0.44, rose 0.38) and every module has a distinct silhouette, so families are a hint, not the carrier.

---

## 14. Implementation notes

### 14.1 Canvas (Engineer R)

- Two canvases in `#canvas-wrap`: `#bg` (`getContext('2d', {alpha:false})`, baked) and `#station` (dynamic). Size both with a `ResizeObserver` using `device-pixel-content-box` inside try/catch (fallback `contentRect × devicePixelRatio`); set `ctx.setTransform(dpr,0,0,dpr,0,0)`; pick `cell` so `cell*dpr` is an integer; snap hairlines with `Math.round(v*dpr)/dpr + .5/dpr`.
- Caches: module sprites `Map` keyed `${id}|${cellDevicePx}|${variant}|${tag}`; ship hulls per `(class, company, size)`; glow discs per color at r 8/16/32; engine blooms per company. Purge on cell change, `fonts.ready`, and DPR change. Draw sprites with integer-aligned `drawImage`, never scaled.
- One `Path2D` for truss fill, one for truss edges (rebuilt on `change`); one `Path2D` for candidate brackets per frame; one for grid dots (rebuilt on resize).
- `FX` (fx.js): a 512-slot pool in typed arrays (`x, y, vx, vy, t0, life, kind, color index`) with swap-remove; drawn grouped by kind under one `'lighter'` pass for additive kinds (sparks, blooms, motes) and one normal pass for the rest. API: `FX.update(dt)`, `FX.draw(ctx)`, `FX.sparks(x,y,color,n,ms)`, `FX.motes(points[],color,n,ms,ease)`, `FX.ring(x,y,r0,r1,color,ms)`, `FX.exhaust(x,y,angle,color)`.
- Never per frame: `shadowBlur`, `ctx.filter`, `createRadialGradient`, `measureText`, per-star `arc()`, per-module `ctx.font`. Stars are `fillRect`. `ctx.font` is set once per text pass; `measureText` results are cached by string.
- `Sim.totals()` once per frame, shared via `st` (8.2). `Sim.cells()` iterated once to build a per-frame array.
- Budget at DPR 2, 1440x900: bg 0 (blit of nothing; it is a separate canvas) · mid-star tile 4 `drawImage` ≈ .1ms · near stars ≈ .1 · trusses 2 strokes ≈ .1 · ≤ 40 modules × (1 `drawImage` + ≤ 8 live ops) ≈ 1.5 · ≤ 16 ships ≈ .5 · ≤ 512 particles ≈ 1.2 · ≤ 12 `fillText` ≈ .3 → ≈ 4ms. Instrument with an EMA of `performance.now()` deltas; if the EMA exceeds 8ms for 60 frames, step down a tier: tier 1 drops parallax and halves particle caps; tier 2 also disables B tells and the running lights. `Render.perf()` reports it.
- Fonts: bake text-bearing sprites only after the `document.fonts.load` promises in section 3 resolve; until then use tag-less variants; purge on `fonts.ready`.
- Thumbnail: `Render.thumbnail(state, w, h)` draws from `state.grid` only (no sim calls) so the title screen can render a save before `Sim.load()` is committed (H passes `JSON.parse(localStorage[SAVE_KEY])`).

### 14.2 DOM (Engineer H)

- No emoji anywhere; icons via `Icons.svg`. No `backdrop-filter`; panels opaque; overlays at 94%.
- Keels and shelf ticks are `::before`/`::after` pseudo-elements with `clip-path`, `pointer-events:none`, on non-scrolling wrappers (`#sidebar`, `.card`, `.toast`, `#tooltip`, `#modal .box`), never on `.panel`.
- `UI.refresh` computes a signature string per panel from the values it displays and skips `innerHTML` when unchanged; `renderStation` (currently rebuilt every 333ms from `main.js`) is diffed the same way so tickers and wipes never stutter at 4×. Card, tab, market and company click handlers attach once via delegation on the panel element. Scroll position is preserved as today.
- Tickers: `Ticker.set(el, value, fmtFn)` in one rAF loop; flash classes `.flash-good` / `.flash-bad` removed after 600ms.
- `body[data-level]`, `body[data-condition]`, `body[data-placing]`, `body[data-motion]` maintained in `main.js` from Sim events, `matchMedia` and `Render.placing`.
- `transition` only on `transform`, `opacity`, `clip-path`, `background-color`, `border-color`, `color`. Tab wipe via `clip-path`. `prefers-reduced-motion` media block zeroes every duration token.
- Fonts: one Google Fonts request with `display=swap` and both `preconnect`s. `font-variant-numeric: tabular-nums` on `.num`, `.val`, `.mono`.
- `localStorage` keys: `ws.orders`, `ws.notes.v1`, `ws.evt` (never the save key, which Sim owns).

### 14.3 Avoid (both)

Quarter-circle elbows, pill shapes, stacked filled color blocks, vertical text, LCARS palette hexes, Antonio/Swiss 911-style faces; glass, scanlines, glitch, chromatic aberration, lens flares; random four-digit numbers (every tag is derived); any red used decoratively; proportional digits in tickers; `shadowBlur` or `ctx.filter` at runtime; emoji; anything designed only at 1920 wide; changing a hue's role with level or tab.

### 14.4 Delivery gates

- **Gate 1 (shippable on its own)**: tokens, type, horizontal tabs, keel/shelf chrome, top rail with tickers, build/station/market/company/log components, icon library complete, baked plate + silhouette + strip sprites for all 24 modules (tells disabled), ship hulls and engine bloom, trusses with static conduit, grid dots, placement brackets and ghost with reason plates, selection brackets, background bake with planet, floaters per 9.6, title screen with resume thumbnail. Acceptance: every module reads at 48px with its tell off; Market fits 12 rows at 1280x720; no emoji in the DOM; frame EMA ≤ 5ms at DPR 2.
- **Gate 2**: tells (A then B), running lights, particles (sparks, rings, motes, exhaust), dock LED tri-state and clamps, progress arc, hover chips, condition banner and states, number flash, toast keel drain, level banner.
- **Gate 3**: objective strip, hint table, first-open notes, boot sequence, perf tiering, reduced-motion audit, 1280x720 and 1920x1080 screenshot review, contrast verification.

---

## Appendix A. Decisions that resolve the judges' risks

1. Palette moved away from the amber/peach/lavender triad: ops is **ice** `#8FD3E8`, people are **sage** `#A8C8A0`, amber is the only chrome, ivory is the player's hand; `--gold` for POWER is `#FFE28A`, distinct from `--amber-hi`, and never used as DOM text.
2. The vertical tab keel is gone; tabs are a numbered horizontal row with one sliding amber underline and hue ticks, never filled blocks.
3. The L is broken: the keel is a detached, 45°-chamfered 4px rail inset from every horizontal edge; shelves are neutral hairlines with a separate 24px amber index tick.
4. Sidebar `clamp(344px, 27vw, 392px)`; the Market table stacks stock over price at ≤360px and moves Dump to a row-hover action.
5. Ivory, not a family color, carries hover, placement, ghost and selection, so a dock plate and a placement bracket never read as the same thing.
6. Hull plates raised to `#1B2030` with an ivory rim, a baked 3 device px shadow skirt, 2 device px key-light edges, and one baked radial glow permitted on hero objects (hub core, reactor core, gate lens, engines).
7. Dock LEDs are ≥ 2 device px on a dark slit, the collar edge carries the progress arc, blocked adds chevrons plus hazard hatch.
8. Level changes only `--ink` brightness and the shelf-tick glow at 4+; no hue roles change with level.
9. Label floor is 11px; 10px is mono micro-tags only.
10. Alert conditions touch only the banner and the top rail's hairline; sidebar frames stay in hue; pulses are ±25% alpha at 1.4s on the banner border only.
11. The planet is computed from the grid rectangle, cut by the top-right canvas edges, and can never intersect the inflated grid box.
12. Idle motion is budgeted: one running light per spar instead of dash drift, A/B tell classes with a cap of 16 B tells, nothing below 36px cells.
13. Sprites bake only plate, silhouette, strip and tag; lit elements and tells are live; exactly two variants.
14. Render owns floater presentation via a `WeakMap`, leaving `sim.js` untouched; fixed lanes are replaced by each ship's real approach vector.
15. Berth and registry tags are derived from state (`built` order, name hash) and baked only after fonts load.
16. Scope is phased into three gates, with Gate 1 shippable and the icon library first.

# WAYSTATION v2 — "Bridge, Cinematic" + "The Expanse" (canonical)

**Status:** FINAL for the v2 build. Supersedes DESIGN.md sections 1, 3, 4, 5, 6, 7 (presentation), 11, 12 and adds the meta-game, the galaxy, the economy and the store. DESIGN.md section 2 (color tokens), section 8 (module art), section 9 (ship art) and section 14.3 (things to avoid) stay in force except where this file says otherwise. Where this file and DESIGN.md disagree, this file wins.

**Why v2 exists (the owner's brief, 2026-10-18):** v1 reads like a quiet 80s console. The owner wants a modern game that grabs attention and holds it: a cinematic sci-fi bridge interface (the *feel* of a Star Trek or Star Wars display, never their trade dress), a satisfying interface you want to touch, lots going on, and the retention loop of DragonVale: timers you come back for, things you tap to collect, places to unlock, a collection to complete, goals to chase, and a premium currency sold through in-app purchases (Stripe later, sandbox now). Readability must go up, not down.

**Readers:** Engineer E (world engine, `js/engine/*`), Engineer H (HUD and panels, `index.html`, `css/style.css`, `js/ui/*`), Engineer S (simulation and meta-game, `js/data2.js`, `js/meta.js`, edits to `js/sim.js`), Engineer P (store and payments, `js/store.js`, `workers/store/*`). The integrator owns `js/main.js`, the title screen and final polish.

Units: CSS px unless written device px. Durations in ms unless written s. "Real time" means wall-clock (`Date.now()`), which keeps running while the tab is closed; "game time" means simulated days, which only advance while the game runs.

---

## 0. The contract (hard interface; nobody changes it without updating this file)

### 0.1 Files and load order (`play/index.html`)

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/pixi.js/8.6.6/pixi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/pixi-filters@6.1.5/dist/pixi-filters.min.js"></script>
<script src="js/data.js"></script>        <!-- unchanged v1 data -->
<script src="js/data2.js"></script>       <!-- S: sectors, missions, collection, expeditions, daily, ranks, store catalog -->
<script src="js/sim.js"></script>         <!-- S: v1 station economy + the hooks listed in 0.6 -->
<script src="js/meta.js"></script>        <!-- S: profile, sectors, hoppers, build timers, upgrades, expeditions, missions, daily, Antimatter -->
<script src="js/art.js"></script>         <!-- unchanged: PAL, FAMILY, ICONS, Icons, ART registry, ArtKit -->
<script src="js/art-mod-a.js"></script>   <!-- unchanged module art (hub..clinic) -->
<script src="js/art-mod-b.js"></script>   <!-- unchanged module art (habitat..gate) -->
<script src="js/ships.js"></script>       <!-- unchanged ship art; E bakes it to textures -->
<script src="js/engine/stage.js"></script>   <!-- E: Pixi app, layers, resize, DPR, ticker, texture baking -->
<script src="js/engine/camera.js"></script>  <!-- E: pan, zoom, focus, drift, world<->screen -->
<script src="js/engine/space.js"></script>   <!-- E: parallax stars, nebula, planet, lanes, comets, sector themes -->
<script src="js/engine/world.js"></script>   <!-- E: station layer: plates, trusses, lamps, scaffolds, bank chips, hover, selection, placement -->
<script src="js/engine/traffic.js"></script> <!-- E: ships, trails, engine bloom, docking choreography -->
<script src="js/engine/fx.js"></script>      <!-- E: particles, bursts, floaters, flights to HUD, shockwaves -->
<script src="js/engine/post.js"></script>    <!-- E: bloom on the emissive layer, vignette, flash -->
<script src="js/engine/input.js"></script>   <!-- E: pointer, wheel, pinch, keyboard camera; emits Engine events -->
<script src="js/engine/index.js"></script>   <!-- E: the Engine facade (0.3) -->
<script src="js/ui/sound.js"></script>       <!-- H: WebAudio synth (section 9) -->
<script src="js/ui/format.js"></script>      <!-- H: number/time formatting, tweened counters -->
<script src="js/ui/overlays.js"></script>    <!-- H: modal, toast, tooltip, celebrations, daily overlay -->
<script src="js/ui/panels.js"></script>      <!-- H: every side panel (build, station, market, fleet, expeditions, map, missions, registry, store, settings) -->
<script src="js/ui/hud.js"></script>         <!-- H: the UI facade (0.4): status bar, command rail, context bar, panel host -->
<script src="js/store.js"></script>          <!-- P: catalog, providers (sandbox | stripe), purchase, claim, restore -->
<script src="js/main.js"></script>           <!-- integrator: boot, title, loop, wiring -->
```

Classic scripts, top-level globals, no modules, no bundler. PixiJS is the only framework. Everything else is hand-written.

### 0.2 Globals

`Sim` (v1 station economy), `Meta` (profile and meta-game), `Engine` (world), `UI` (HUD), `Store`, `Sound`, plus the v1 art globals `PAL, FAMILY, FAMILY_COLOR, COMPANY_COLOR, ICONS, Icons, ART, ArtKit, Ships, registryOf` and the v1 data globals `MODULES, GOODS, GOOD_IDS, PLANETS, COMPANIES, SHIP_CLASSES, EVENTS, TIER_NAMES, STATION_NAMES, GRID_COLS, GRID_ROWS, pick, rnd, irnd, fmt`. New data globals from `data2.js`: `SECTORS, MISSIONS, COLLECTION, EXPEDITIONS, DAILY_REWARDS, RANKS, STORE_CATALOG, TIMERS`.

### 0.3 Engine facade (`js/engine/index.js`)

```js
Engine.init(hostEl)                       // async; creates the Pixi app inside hostEl (full-bleed), bakes textures, starts the ticker
Engine.setSector(sectorDef, state)        // rebuilds space + world for a sector; `state` is that sector's station state (Sim.state shape)
Engine.setPaused(bool)                    // ships and tells freeze; ambient motion continues
Engine.resize()                           // host size or DPR changed
Engine.placing   = moduleId | null        // placement mode (ghost + brackets)
Engine.selected  = {r, c} | null          // selection brackets + focus glow
Engine.hover                              // read-only {r, c} | null
Engine.camera: { zoom, x, y, min, max, focusCell(r, c, {zoom, ms}), fit({ms}), drift(bool), shake(px) }
Engine.cellAt(screenX, screenY) -> {r, c} | null
Engine.cellToScreen(r, c) -> {x, y}       // centre of a cell in CSS px of the host (for DOM anchoring)
Engine.on(evt, fn) / Engine.off(evt, fn)  // 'cell-click' {r,c,occupied,x,y}  'cell-hover' {r,c}|null  'ship-click' {ship,x,y}
                                          // 'bank-click' {r,c}  'scaffold-click' {r,c}  'empty-click' {x,y}  'context' {r,c|null}  'camera' {zoom,x,y}
Engine.fx: {
  collect(r, c, amount, targetEl),        // coin burst at the module + 8-14 glyphs fly to targetEl's centre over 600-800ms, then resolve()
  buildStart(r, c), buildDone(r, c),      // scaffold weld sparks / completion ring + flash
  floater(r, c, text, color),             // rising number/text at a cell
  pulse(r, c, color),                     // one soft ring (hover tap, selection, mission ping)
  shock(x, y, strength),                  // shockwave (pirate raid, level up) in screen px
  levelUp(), flash(color, alpha, ms),     // full-world beats
  warp()                                  // sector transition: 900ms streak + fade used by UI.map travel
}
Engine.thumbnail(state, w, h) -> HTMLCanvasElement   // title resume card and the galaxy map cards
Engine.perf -> { fps, tier }              // tier 0..2 (2 = all effects); Engine auto-downgrades under 45fps
```

The engine reads `Sim.state` (grid, ships, hub, fx, name, level) and `Meta` (hopper banks, build timers, upgrades) every frame through the read-only helpers in 0.5. It never mutates them. It subscribes to `Sim.on(...)` for `built, demolished, dock, depart, spawn, levelup, change, collect, build-done, upgrade, sector`.

### 0.4 UI facade (`js/ui/hud.js`)

```js
UI.init()                 // builds the HUD into #app (status bar, rail, panel host, context bar), binds Sim/Meta/Engine/Store events
UI.start()                // first frame after the title: boot sequence, tutorial missions, daily overlay if claimable
UI.tick()                 // every 250ms from main: counters, timers, hopper chips, mission progress
UI.refresh()              // after any state change the HUD cannot infer from events
UI.openPanel(id) / UI.closePanel() / UI.panel -> id|null   // ids: build station market fleet expeditions map missions registry store settings
UI.select(r, c) / UI.deselect()
UI.setSpeed(n) / UI.togglePause()
UI.showEvent()            // Sim.state.pending transmission modal
UI.modalOpen() -> bool / UI.escModal()
UI.toast(msg, kind)       // kind: good warn bad gold info
UI.celebrate(kind, data)  // 'rank' 'level' 'unlock' 'mission' 'expedition' 'purchase' 'daily'
UI.resetProgress()        // first-run notes and tutorial pointers for a new station
UI.anchor(name) -> HTMLElement   // 'credits' 'am' 'rank' for Engine.fx flights
```

### 0.5 Sim and Meta read model (what E and H read; S guarantees these shapes)

```js
Sim.state = {                              // the ACTIVE sector's station (v1 shape, plus the fields marked +)
  name, day, t, credits, speed, grid, hub, stock, prices, policy, companies, ships, nextShipId, shipTimer,
  residents, rep, level, fx, pending, nextEventDay, income, recentAway, log, stats,
  +sector: 'home',                         // SECTORS id
  +cells: { 'r,c': { lvl: 1|2|3, bank: 0, readyAt: null|ms, builtAt: ms } },   // meta data per occupied cell
}
Sim.state.grid[r][c] = { id } | null       // unchanged (E keys everything by r,c)
Meta.profile = { v: 2, playerId, createdAt, lastSeenAt, am, rank: { xp }, activeSector, unlocked: [ids],
                 sectors: { id: stationState }, collection, missions, daily, expeditions, entitlements, settings, stats }
Meta.hopper(r, c) -> { bank, cap, rate /*per real minute*/, ready /*bank >= 0.25*cap*/, full } | null
Meta.build(r, c)  -> { building: bool, remainingMs, totalMs, skipAM } | null
Meta.upgrade(r, c) -> { lvl, next: { cost, rate, cap } | null }
Meta.am -> number;  Meta.rank -> { level, title, xp, next, pct }
Meta.sectors() -> [{ def, status: 'active'|'owned'|'unlockable'|'locked', why, summary: { name, level, credits, modules } }]
Meta.expeditions() -> [{ id, sector, startedAt, endsAt, remainingMs, status: 'out'|'ready'|'claimed', slot }]
Meta.missions() -> [{ id, title, desc, progress, goal, reward: { credits?, am?, xp? }, done, claimable, chapter }]
Meta.daily() -> { streak, dayIndex 0..6, claimable, rewards: DAILY_REWARDS }
Meta.collection() -> { ships: [...], species: [...], artifacts: [...] } each { id, name, lore, found: bool, count, rarity, fam }
```

### 0.6 Events on the Sim bus (`Sim.on/emit`)

v1: `built {id,r,c}`, `demolished`, `dock`, `depart`, `spawn`, `levelup {level}`, `day`, `change`, `log`, `toast`, `event`.
v2 (emitted by Meta unless noted): `collect {r,c,amount}`, `hopper {r,c}` (bank crossed the ready or full threshold), `build-start {r,c,id,totalMs}`, `build-done {r,c,id}`, `upgrade {r,c,lvl}`, `am {delta,reason,total}`, `rank {level,title}`, `mission {id,state:'progress'|'complete'|'claimed'}`, `daily {claimed,streak}`, `expedition {id,state:'launched'|'ready'|'claimed', loot}`, `sector {id,state:'unlocked'|'switched'}`, `discover {kind,id}`, `purchase {sku,granted}` (Store), `offline {ms, credits, events}` (once on load).

### 0.7 Body attributes (set by UI and main; read by CSS and E)

`data-screen="title"` · `data-level` · `data-condition="alert|flare|festival"` · `data-placing` · `data-panel="<id>"` · `data-motion="reduced"` · `data-boot` · `data-perf="0|1|2"` · `data-sector="<id>"` · `data-store="sandbox|stripe"`.

### 0.8 Allowed edits outside owned files

S may edit `sim.js` freely (it owns it) but must keep every v1 public method and event. Nobody edits `art.js`, `art-mod-*.js`, `ships.js`, `data.js` except S adding fields to `MODULES` entries (`rate`, `bank`, `buildMs`, `upgrade`) and new exports at the end of `data.js` is **not** allowed: new data goes in `data2.js`. H owns `index.html` and `style.css`; E owns nothing in the DOM except the host element `#world` (full-bleed, z-index 0) which H provides.

---

## 1. Experience pillars

1. **A bridge you want to sit at.** The world fills the screen; the interface floats over it as luminous glass. Everything important glows a little, nothing glows a lot. Readouts move when numbers change and are still when they don't.
2. **Touch is rewarded.** Every click answers within one frame with light, motion and sound: a module pulses, a counter tweens, coins fly to the credits readout, a panel sweeps in. Collecting a full bank is the single most satisfying act in the game and it happens every few minutes.
3. **There is always something cooking.** A build finishing in 4 minutes, an expedition back in 40, a daily reward at midnight, a sector 18,000 credits away, a mission two ships from complete. The HUD shows the next thing that will happen and when.
4. **Out there.** The galaxy map makes the other sectors visible from day one, with their planets and their locks. Unlocking one is a trip, not a menu item.
5. **Readable first.** Body text 14px minimum, numbers 16px minimum, labels 12px, contrast at least 7:1 on glass. Hue is never the only carrier; shapes and words stay.
6. **Original.** The feel of a starship bridge, not its franchise: no LCARS elbows, palette or typeface, no franchise names, insignia or sounds. Our vocabulary: holographic glass, swept chamfered frames, animated readouts, numbered sections, calm computer voice in the copy, amber and ice light on deep space.

---

## 2. Visual language v2: "Bridge, Cinematic"

### 2.1 Tokens (additions to DESIGN.md section 2; `:root` in `style.css`)

```css
:root{
  /* space (behind everything; the engine paints these, the DOM never shows them) */
  --space-0:#03040A; --space-1:#070B18; --space-2:#0B1226;
  /* holographic glass surfaces (DOM): translucent navy + backdrop blur + luminous edge */
  --glass:rgba(10,15,30,.72); --glass-2:rgba(16,23,44,.78); --glass-3:rgba(24,33,60,.84);
  --edge:rgba(143,211,232,.22); --edge-2:rgba(143,211,232,.42); --edge-amber:rgba(233,162,59,.45);
  --blur:14px;
  /* light */
  --glow-amber-2:0 0 18px rgba(233,162,59,.45), 0 0 2px rgba(255,196,106,.8);
  --glow-ice-2:0 0 18px rgba(143,211,232,.40), 0 0 2px rgba(191,232,244,.8);
  --glow-good:0 0 14px rgba(111,211,163,.45);
  --glow-am:0 0 16px rgba(192,132,255,.55);
  /* Antimatter (premium currency) hue: violet, used only for AM figures, AM buttons and AM-only items */
  --am:#C084FF; --am-hi:#DDB8FF; --am-ghost:rgba(192,132,255,.16);
  /* chamfer */
  --cut:10px; --cut-sm:6px;
  /* type scale v2 */
  --fs-body:14px; --fs-body-lg:15px; --fs-label:12px; --fs-num:16px; --fs-num-lg:22px; --fs-hero:34px;
  /* motion v2 */
  --dur-micro:140ms; --dur-state:280ms; --dur-panel:360ms; --dur-long:700ms;
  --ease-out:cubic-bezier(.16,1,.3,1); --ease-in-out:cubic-bezier(.65,0,.35,1); --ease-back:cubic-bezier(.34,1.4,.64,1);
}
```

The v1 identity hues (amber, ice, sage, rose, gold, ivory, lamp) keep their roles. Amber is still the console's own light; ice is operations; violet is new and means premium.

### 2.2 Surfaces

- **Glass panel**: `background: var(--glass); backdrop-filter: blur(var(--blur)); border: 1px solid var(--edge)`, chamfered corners via `clip-path: polygon(...)` cutting the top-left and bottom-right corners by `--cut` (a swept frame, not a pill, not an elbow). A 1px inner highlight line (`inset 0 1px 0 rgba(255,255,255,.06)`) and a 2px luminous **spine** on the panel's leading edge (left for left panels, top for bars) in the panel's hue, glowing (`--glow-amber-2`). Panels never stack more than two deep.
- **Cards** inside panels: `--glass-2`, chamfer `--cut-sm`, hover `--glass-3` + edge `--edge-2` + translateY(-1px) (hover may move in v2, by one pixel). Selected: amber spine + `--glow-amber-2`.
- **Bars** (status bar, context bar): glass, full width, no chamfer, bottom/top edge line.
- **Readouts**: numbers in JetBrains Mono 600 with `text-shadow` glow in their hue when they change (class `.lit` for 600ms).
- **Reveal**: a panel opens by sliding 24px from its edge while fading in over `--dur-panel` `--ease-out`, its content rows stagger 24ms each; a thin horizontal **scan line** sweeps down the panel once (`::after`, 2px, ice at 40%, 420ms). Closing is 180ms, no scan.
- **Hazard and alerts** keep DESIGN.md 5.10 but the condition banner becomes a full-width glass strip under the status bar with a slow red edge pulse.
- No bevels, no skeuomorphic metal, no lens dirt, no scanline overlays on the whole screen, no gradients on text.

### 2.3 Typography v2

Same three families. New roles:

| Role | Face | Size | Tracking | Use |
|---|---|---|---|---|
| Hero number | JetBrains Mono 600 | 22px | 0 | credits in the status bar |
| Big number | JetBrains Mono 600 | 16–18px | 0 | AM, income, panel totals, timers |
| Number | JetBrains Mono 500 | 14px | 0 | everything else numeric |
| Display | Barlow Condensed 700 | 28–34px | .06em upper | panel titles, celebrations, sector names |
| Section | Barlow Condensed 600 | 13px | .14em upper | shelf labels |
| Label | Barlow Condensed 500 | 12px | .10em upper | field labels, chips (12px floor; 11px only inside 18px chips) |
| Body | Barlow 400 | 14px / 1.5 | 0 | descriptions, lore, hints; 15px in modals |
| Micro | JetBrains Mono 500 | 11px | .08em upper | registry, coordinates, timestamps |

Wordmark stays Barlow Condensed 600 .30em; title screen 64px with a light sweep.

### 2.4 Layout (1440x900 reference; works from 1180x700, tablet landscape 1024x768 with the rail collapsed to icons)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ STATUS BAR 56px: wordmark · sector/station · ● credits ▲income · ⚛ AM [+] · │
│                 ⚡ power · ☺ residents/visitors · ★ rep · RANK ring · ⏱ speed │
├─────┬────────────────────────────────────────────────────────┬───────────────┤
│RAIL │                                                        │ NOTICES       │
│72px │                 WORLD (full-bleed Pixi canvas)         │ (toasts,      │
│icons│        camera: pan / zoom / focus                      │  next-up      │
│+lbl │                                                        │  timers)      │
│     │   ┌ PANEL 440px (slides from the rail) ┐               │               │
│     │   │ title · tabs · content · footer    │               │               │
│     │   └────────────────────────────────────┘               │               │
├─────┴────────────────────────────────────────────────────────┴───────────────┤
│ CONTEXT BAR 48px: hint · selected module quick actions · placing controls    │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Status bar**: left, the wordmark small and the active sector name (click opens the map); centre, the resource readouts as glass chips with icons from `ICONS` (`credits`, a new `am` icon drawn by H as an inline SVG, `power`, `people`, `rep`), each with a tweened counter; the AM chip has a `+` lozenge that opens the Store; right, the Commander rank ring (progress arc, level number) and the speed control. Credits gets `--glow-amber-2` permanently; AM gets `--glow-am`.
- **Command rail** (left, 72px, glass): nine buttons, icon 22px + 11px label: Build, Station, Market, Fleet, Expeditions, Map, Missions, Registry, Store, and Settings pinned at the bottom. Badges: Missions shows claimable count (amber), Expeditions shows ready count (ice), Store shows a violet dot when an offer is active. Active button has an amber spine and a lit icon.
- **Panel host**: one panel at a time, 440px wide (min 360), full height between bars, 12px inset from the rail; glass; title in Display with a subtitle micro line; optional tab strip; scrollable body; sticky footer for the primary action. Opening a panel never blocks the world; the camera keeps 55% of the width clear (it pans right when a panel opens if the station would be covered).
- **Notices** (right, 320px): toasts stack from the top (max 4); below them the **Next up** strip: the three soonest timers (build, expedition, daily) as small glass rows with countdowns; clicking one focuses the module or opens the panel.
- **Context bar** (bottom, 48px): left, the hint line (DESIGN.md 12.2 table, extended for v2 states); centre, when a module is selected, quick actions (Collect, Upgrade, Skip build, Demolish) as lozenges; right, perf tag (hidden by default) and the `?` keys reference.
- **World**: the Pixi canvas fills `#world` behind all of it. Bank chips, scaffold rings and floaters live in the world (they zoom with the camera); tooltips live in the DOM anchored with `Engine.cellToScreen`.
- ≤1180px: rail collapses to icons (48px), panel 380px. ≤1024px: notices hide behind a bell icon, context bar actions become icons. Phones: a message screen ("Waystation is a desktop and tablet game") rather than a broken layout.

### 2.5 Controls and lozenges v2

Lozenges keep the v1 grammar (index bar, primary amber, danger, ghost) but grow: min-height 32px, 13px type, padding 0 14px; `.big` 40px/14px. Press: `transform: scale(.97)` for 90ms then back, plus a glow flash in the lozenge hue. Primary buttons carry `--glow-amber-2` at rest. AM-costing buttons are violet (`.am`: fill `--am-ghost`, text `--am`, index bar `--am`, hover glow `--glow-am`). Disabled 40%.

Chips, segmented controls, inputs: as v1 with glass fills. Progress rings: SVG circles, 2px track `--hairline-2`, 3px arc in hue, rounded caps, animated `stroke-dashoffset`.

### 2.6 Motion v2

- Counters tween over 400ms (`format.js` `tween(el, from, to)`); money up flashes amber, down flashes red; AM changes flash violet.
- Collect: Engine burst + flight; the credits chip scales 1.0→1.08→1.0 over 260ms when the first glyph arrives, each later glyph adds a 60ms pulse; `Sound.collect(n)`.
- Build done: ring completes, flash, module "lands" (scale 1.15→1 with `--ease-back`), weld sparks, `Sound.built()`; a toast "Comms Relay online" with a Focus button.
- Panel open/close per 2.2; rail button press per 2.5.
- Celebrations (`UI.celebrate`): a full-screen glass band sweeps in from the left at 40% height with Display text ("RANK 4 · HARBOURMASTER", "SECTOR UNLOCKED · SABLE DRIFT", "MISSION COMPLETE"), reward chips, 1.6s, `Engine.fx.levelUp()` behind it; never more than one at a time (queue).
- Idle: nothing in the DOM moves on its own except timers counting down and the rank ring filling. The world keeps its ambient motion (space, tells, ships).
- Reduced motion: no tweens longer than 120ms, no sweeps, no flights (coins appear at the counter), no camera drift, no bloom pulsing.

---

## 3. World rendering (Engineer E; PixiJS 8, WebGL)

### 3.1 Stage and layers (`stage.js`)

`new PIXI.Application(); await app.init({ background: SPACE_0, resizeTo: host, antialias: true, resolution: min(devicePixelRatio, 2), autoDensity: true, preference: 'webgl' })`. Layers (containers, in order): `space.far` (static stars, nebula) · `space.mid` (parallax stars, planet, lanes) · `world.shadow` · `world.truss` · `world.plates` · `world.scaffold` · `world.emissive` (lamps, LEDs, cores, bank chips; **the bloom layer**) · `traffic` (ships + trails) · `fx` (particles, floaters, rings) · `overlay` (hover, brackets, placement ghost) · `post` (vignette sprite, flash). Space layers move with a fraction of the camera (0.08 far, 0.25 mid); everything from `world.shadow` up is inside the camera container.

**Texture baking** is the bridge to the v1 art: `bakeModule(id, variant, open, lvl, size)` draws `ART[id]` into an offscreen 2D canvas at `size` device px (DESIGN.md 8.0 rules, v1 `bakeSprite` logic reused) and returns `PIXI.Texture.from(canvas)`; cached by key; rebaked when the camera crosses a zoom band (0.75 / 1.25 / 2.0) so art stays crisp. Ships bake the same way from `Ships`. Emissive parts (windows, lamps, LEDs, cores) are baked **separately** into an additive texture so they can live on the emissive layer and bloom; E adds the `emissive` pass by calling the module's `lit` with a flag, or, where art-mod files do not separate lit elements, by thresholding the baked sprite (luma > 0.78 of lamp/ice/amber hues) into a mask texture. Module levels 2 and 3 add an ivory corner tick and a second/third signal-strip segment (drawn by E over the baked texture).

### 3.2 Camera (`camera.js`)

Zoom 0.55–2.6 (default 1.0 = v1 cell size), wheel and pinch zoom to the cursor, drag pan with inertia (friction 0.92), bounds = station box inflated by 6 cells, `focusCell` eases over 600ms `--ease-in-out`, `fit()` frames the station with 15% margin, `drift(true)` on the title: slow 0.0025 cells/s orbit + 0.98→1.02 breathing zoom. Double-click a module focuses at zoom 1.6. Keyboard: arrows pan, +/- zoom, 0 fit, F focus selection. The camera pans right by half the panel width when a panel opens and the station would be covered (UI calls `camera.avoid(rectPx)`).

### 3.3 Space (`space.js`; sector-themed from `SECTORS[id].theme`)

- Far: 1,400 stars on a 4096-px wrapped field (3 sizes, alpha 0.3–0.9, 2% twinkle at 0.2–1Hz), a nebula built from 6–9 large soft radial sprites (baked gradients, 600–1400 px, additive, 6–14% alpha, theme hues) with a slow 0.004 rad/s rotation each.
- Mid: 300 nearer stars at 0.25 parallax; the **planet**: a disc of theme colour with a baked 2D canvas texture (noise bands, polar caps when the theme says so), a terminator (multiply gradient at the theme's light angle), an atmosphere rim (additive radial glow in the theme's rim hue, 6% of the disc radius), slow rotation of the band texture (a second layer scrolling under a mask) and rings for the gas-giant theme; placed per theme (default upper-right, 38% of the viewport height radius) and never overlapping the inflated station box. Shipping lanes: 3–5 faint arcs (ice 8%) from the viewport edges to the station with light pulses travelling inwards every 4–9 s. A comet crosses every 70–140 s. Theme examples: `home` amber-ivory world · `sable` ochre dust world with storms · `kessler` no planet, asteroid field (120 drifting rock sprites) · `thessaly` deep blue ocean with white swirls · `marrow` black-red volcanic with lava cracks · `oros` banded gas giant with rings · `keth` green-blue garden world · `aurelia` violet nebula, white dwarf.

### 3.4 Station (`world.js`)

- Plates from baked textures on `world.plates`; a soft drop shadow (black 35%, blur 10 at zoom 1, offset 0/4) on `world.shadow`; trusses as v1 but with a faint ice emissive seam that pulses when power is healthy (period 3 s) and goes dark when the grid is overdrawn.
- **Tells** (DESIGN.md 8.1 animated states) are reproduced by E by rebaking the animated frame at 10 fps for the modules that have them (cache 10 frames per state) or by driving overlay sprites (dock LEDs, dish sweep, reactor breathe) where the art exposes parts. Dock LEDs stepping on approach is mandatory; the rest degrade gracefully by perf tier.
- **Scaffold** (`Meta.build(r,c).building`): the plate at 35% alpha under a hatched frame, a progress ring (ice) around the cell, a mono timer label under it ("4:12"), weld sparks every 1.5 s. Clicking emits `scaffold-click` (UI offers Skip for AM).
- **Bank chip** (`Meta.hopper(r,c).ready`): a bobbing coin glyph (amber disc, `ICONS.credits`) 18 px above the plate on the emissive layer, bob 4 px at 0.8 Hz, scale 1.0 when ready, 1.15 with a halo when full; clicking emits `bank-click`. Shift-click or long-press anywhere emits `bank-click` for every ready cell within 3 cells.
- Hover: ivory outline 1.5 px + soft halo; selection: v1 brackets, animated draw, plus a focus glow; placement: ghost plate at 45% with family hue tint, valid cells bracketed ivory, invalid hatched; the cursor cell snaps.
- Upgrades: level ticks and strip segments (3.1).

### 3.5 Traffic (`traffic.js`)

Ships from `Sim.state.ships` as baked sprites, company livery, engine bloom on the emissive layer scaled with speed, a 40-px fading trail (ribbon of 12 points), nav lights (red/green 1 Hz), docking choreography as v1 9.3, floaters via `fx`. Ship hover shows a DOM tooltip (UI). Liner class gets a longer bloom and a rose running light.

### 3.6 FX (`fx.js`)

A pooled `ParticleContainer` (cap 2,000 at tier 2, 800 at tier 1, 250 at tier 0): sparks, motes, exhaust, coin glyphs; rings as `Graphics` with tweened radius/alpha; floaters as `BitmapText` (JetBrains Mono baked at 32 px) rising 28 px over 1.2 s. `collect()` spawns N = clamp(8, amount/50, 14) coin glyphs that arc to the HUD anchor (world → screen conversion each frame, since the camera may move), each resolving with a HUD pulse; `levelUp()` is a radial burst of 180 motes plus a ring; `warp()` is 400 streaks accelerating outward over 900 ms with a white flash.

### 3.7 Post (`post.js`)

`AdvancedBloomFilter({ threshold: .42, bloomScale: 1.1, brightness: 1.0, blur: 6, quality: 4 })` on `world.emissive` and `traffic` only (never on plates or text); a vignette sprite (radial black 0→38%) on `post`; `flash(color, alpha, ms)` as a full-screen quad. Tier 1 drops bloom quality to 2 and the trail ribbons; tier 0 drops bloom, twinkle and comets. Bloom pulses only through the content under it, never by animating the filter.

### 3.8 Input (`input.js`)

Pointer down/move/up on the canvas with a 4-px drag threshold separating pans from clicks; wheel zoom; pinch via two pointers; right-click emits `context`; hover throttled to animation frames; keyboard per 3.2 (only when no input element is focused and no modal is open: `UI.modalOpen()`).

### 3.9 Harness and gates (E)

`play/dev/engine-preview.html`: loads data, data2, sim, meta (or a stub `Meta` with fake banks and timers), art, ships, engine; stages a 28-module station via `Sim.place`, 6 ships, 3 scaffolds, 5 ready banks; buttons to switch sector themes, fire every `Engine.fx`, toggle perf tiers, and print fps. Gates: 60 fps at 1440x900 DPR 1 on tier 2 with that scene; no WebGL warnings; crisp art at zoom 2.0; `Engine.thumbnail` still works.

---

## 4. Game design v2: "The Expanse" (Engineer S)

### 4.1 Loop summary

**Minute:** place modules, serve ships, trade, tap banks, read transmissions. **Session (10–30 min):** finish builds, launch an expedition, claim missions, push the rank ring. **Day:** daily reward, expeditions returned overnight, banks full across sectors, a new sector within reach. **Week:** unlock sectors, complete collection sets, buy the pass or AM if you are impatient.

### 4.2 Credits, banks ("hoppers") and offline income

- Every module with `rate > 0` accrues `rate` credits per **real minute** into its cell's `bank`, capped at `cap` (default 60 minutes of rate, 90 at level 2, 120 at level 3). Defaults: `rate = round(cost / 40)` per minute at level 1 (warehouse 15, dock 20, cantina 20, market 38, reactor 75, bank 100, gate 300); `cap = rate * 60`. Level 2 multiplies rate by 1.6, level 3 by 2.4. The hub has rate 10.
- `Meta.collect(r, c)` moves the bank to credits (floor), emits `collect`, counts toward missions and rank XP (1 XP per 100 credits). `collectAll()` is granted at rank 3.
- Ships, trade, rent and fees keep paying instantly as v1 (that is the live half of the economy; banks are the come-back half).
- **Offline**: on load, for each sector, banks accrue for `min(elapsed, 12h)`; builds and expeditions advance by elapsed real time; the active sector also simulates `min(elapsed, 2h)` of game days in a fast catch-up (`Sim.catchUp(ms)`, 1 game day per 6 s of real time at speed 1, so cap the loop) so ships and events feel like they happened. Emit `offline {ms, credits, events}` once; UI shows a "While you were away" summary.

### 4.3 Build timers, skips and upgrades

- `Sim.place` deducts credits, sets `cells['r,c'] = { lvl:1, bank:0, readyAt: now + buildMs, builtAt: now }`. A cell under construction counts for adjacency and power draw but not for berths, beds, stock or rates; `Sim.totals()` and the renderer treat it as inactive. `buildMs`: tier 1 = 45 s (the first three tier-1 builds of a brand-new profile are instant, tutorial), tier 2 = 4 min, tier 3 = 15 min, tier 4 = 60 min; sectors 5–8 multiply by 1.5. When `readyAt` passes, Meta emits `build-done`, the module becomes active and `Sim.recomputeLevel()` runs.
- Skip cost `skipAM = max(1, ceil(remainingMinutes / 8))`. Skipping emits `build-done` immediately.
- Upgrades: level 2 costs 2× module cost, level 3 costs 5×, each a timer of 2× the build time (skippable); upgrades raise rate and cap and, for docks, shorten service time 15%/30%; for quarters/habitats add 25%/50% capacity; for solar/reactor add 25%/50% power. Upgrades count as `built` for level thresholds at 0.5 module each.

### 4.4 Antimatter (AM): the premium currency

Earned: missions (2–25), daily rewards (5/10/25 on days 3/6/7), expeditions (0–8, rarity weighted), collection set completion (20–60), rank-ups (10 × level). Spent: skip timers (4.3), expedition instant return (same formula), early sector unlock (4.5), cosmetics (liveries 40–120, beacon colours 25), emergency credits ("Relief convoy": 10 AM for 30 minutes of total station rate). Bought: Store (section 7). A new profile starts with 20 AM so the first skip is free to try; the tutorial missions pay out another 30.

### 4.5 Sectors (the galaxy)

`SECTORS` (data2.js), in unlock order:

| id | Name | Planet / theme | Grid | Flavour and bias | Unlock |
|---|---|---|---|---|---|
| home | Varro Reach | temperate amber-ivory world | 15x9 | balanced, the tutorial | start |
| sable | Sable Drift | ochre dust world, storms | 15x9 | ore and alloy +40%, flares ×2 | L2 and 18,000 cr, or 60 AM |
| kessler | Kessler Belt | no planet, asteroid field | 17x9 | mining, no residents, refinery +50% | L2, 30,000 cr and 1 chart |
| thessaly | Thessaly Deep | ocean world | 15x11 | water/grain/fruit +40%, Tidewater liners | L3 and 60,000 cr |
| marrow | Marrow Verge | volcanic world | 15x9 | fuel +50%, pirates ×2, Red Sand caravans | L3, 75,000 cr and 1 chart |
| oros | Oros Halo | ringed gas giant | 17x11 | fuel and tech +40%, festivals | L3, 120,000 cr and 2 charts |
| keth | Keth Meridian | garden world | 17x11 | residents grow 2×, rent +30% | L4 and 200,000 cr |
| aurelia | Aurelia Gate | violet nebula, white dwarf | 19x11 | the galactic terminus, Aurelian liners, gate +100% | L4, 400,000 cr and 3 charts, or the Sector Pass |

"L" is the **best level reached in any sector**. Charts come from expeditions to that sector (4.6). The AM shortcut on `sable` and the pass on `aurelia` exist so a paying player can go now; everyone else gets there by playing. Each sector is a full station state with its own name (picked from a per-sector name list), registry, grid, level, credits (credits are **shared** across sectors: `Meta.profile.credits` is the wallet and `Sim.state.credits` mirrors it for the active sector), and rep (per sector). Switching: `Meta.switchSector(id)` saves the active state, swaps `Sim.state`, calls `Engine.setSector`, emits `sector`. The map shows every sector's summary and banked total.

### 4.6 Expeditions

Launched from the Expeditions panel to any sector, including locked ones. Requires one Docking Bay; slots: 1, +1 with a Comms Relay, +1 with a Shipyard (max 3). Cost 400 × (1 + 0.5 × distance index) credits; duration 10, 20, 35, 50, 60, 75, 90, 120 minutes by sector order (sectors 5–8 are long on purpose). Loot table on return: 1 **chart** for that sector (60%, guaranteed on the third run), goods (always, 20–80 units of the sector's bias goods, into the active station's stock), AM (35%: 1–8), a **discovery** (45%): a ship class, a species or an artifact from `COLLECTION` weighted by rarity and by the sector's pool, credits (20%: 5–15 minutes of station rate). The return is a ready expedition in the panel with a "Debrief" button that plays the loot as a sequence of chips; claiming emits `expedition` and `discover`. Instant return costs the skip formula on the remaining minutes.

### 4.7 Missions (goals)

`MISSIONS`: 48 entries in chapters: *Commissioning* (6, the tutorial: build dock, warehouse, solar, serve 3 ships, collect a bank, read a transmission), *Trade* (8), *Crew* (8), *Reach* (8: expeditions, charts, second sector), *Town* (8), *Galactic* (6), *Collector* (4). Each: `{ id, chapter, title, desc, type, goal, reward: {credits, am, xp}, requires: [ids], track: fn(state, profile) }`. Three missions are active at a time (the next in each open chapter); progress is evaluated on `change`, `collect`, `depart`, `expedition`, `discover`, `sector`; completion emits `mission complete`; the player **claims** the reward in the panel (that is the DragonVale beat: you come back and tap the goal). Claimed rewards fly to the HUD. Tutorial missions also drive `UI` pointers (the Build button pulses until the first dock is placed, etc.).

### 4.8 Daily reward and streak

Calendar day boundaries in local time. `DAILY_REWARDS` = [1,500 cr · 3,000 cr · 5 AM · 6,000 cr · goods crate · 10 AM · 25 AM + a livery token], looping with credits scaled by the player's total station rate (min values above). Claimable once per day from the overlay that appears on start (or from the status bar bell). Missing a day resets the streak to day 1 unless repaired for 5 AM within 48 h.

### 4.9 Commander rank

XP from banks (1 per 100 cr), served ships (5), missions (reward.xp), expeditions (20), discoveries (15), level-ups (100). `RANKS`: 1 Ensign (0), 2 Lieutenant (300), 3 Harbourmaster (900, grants Collect All), 4 Commodore (2,000, grants a third mission slot), 5 Admiral of the Reach (4,500, grants a 5% rate bonus), then +3,000 per rank with cosmetic titles. Rank is profile-wide; station level stays per sector.

### 4.10 Collection ("Registry")

`COLLECTION.ships` (the 10 v1 ship classes × notable company variants, 24 entries), `COLLECTION.species` (12 alien visitor species, found by serving ships from particular companies or by expeditions; each has a two-line lore and a silhouette id for H to draw as an inline SVG), `COLLECTION.artifacts` (16, expeditions only; rarities common/rare/epic). Sets: completing all ships of a company, all species, all artifacts of a sector pays AM and a title. The Registry panel shows silhouettes dark until found.

### 4.11 Events and seasons

v1 transmissions stay. v2 adds a weekly **Convoy** (a 48-hour window every 7 days from profile creation: ship traffic +50%, a special mission chain with AM) and a monthly **Rift** flag reserved for later (data present, disabled). Festival, flare, pirates keep their conditions.

### 4.12 Save format and migration

`localStorage['waystation.profile.v2']` = `Meta.profile` JSON; autosave every 10 s and on `pagehide`. On first v2 load, if `waystation-save-v1` exists, migrate: that station becomes `sectors.home`, credits become the wallet, every occupied cell gets `cells['r,c'] = {lvl:1, bank:0, readyAt:null, builtAt:now}`, rank xp = served ships × 5, and the v1 key is renamed to `waystation-save-v1.bak`. `Meta.export()` / `Meta.import(json)` for the Settings panel.

### 4.13 Harness and gates (S)

`play/dev/sim-test.js` (node): loads data, data2, sim, meta in a vm with a localStorage shim; runs: new profile → tutorial builds instant → timers → offline accrual at +3h → expedition round trip → mission completion and claim → sector unlock and switch → migration from a v1 save → export/import; prints an economy table (rate per module, minutes to each sector unlock at a "normal" play pace: a player who logs in 3× a day for 15 minutes should reach `sable` on day 2, `thessaly` by day 6, `aurelia` by day 25). `node play/dev/sim-test.js` must exit 0.

---

## 5. HUD and panels (Engineer H)

### 5.1 Status bar, rail, context bar, notices: section 2.4. Keyboard: Space pause · 1/2/4 speed · B Build · S Station · M Market · F Fleet · E Expeditions · G Map · J Missions · R Registry · Esc close/cancel · arrows/+/-/0 camera (engine) · `?` keys overlay.

### 5.2 Panels (each a function `Panels.<id>(host, ctx)` that renders and returns `{ update(), destroy() }`)

- **Build**: tiers as shelves with build cards (plate, name, cost, rate/min, power pips, build time, lock reason); a card click enters placement and the context bar shows "Click a bracketed cell · Esc cancels"; cards for unaffordable modules dim their cost; the tier head shows "x/y built"; the top of the panel shows total rate/min and power balance.
- **Station**: when nothing is selected, the station overview: QoL ring, residents, power, berths, income breakdown, total banked with **Collect all** (rank 3+), station name edit. When a module is selected: its card, level and upgrade (cost, timer, AM skip), bank with Collect, build progress with Skip, tell state, demolish (confirm).
- **Market**: v1 table with 14px rows, the Trade Exchange policies, booms/gluts chips.
- **Fleet**: companies (trust bars, offices, loans) and ships currently in the sector (docked / approach / queue) with click-to-focus.
- **Expeditions**: slots, the sector picker (cards with planet thumbnails, duration, cost, chart progress 0–3), running expeditions with countdown rings and Instant return (AM), ready ones with Debrief.
- **Map**: the galaxy as an SVG constellation (8 nodes on a curve with faint routes, the active one lit, locked ones with lock chips and their requirement, unlockable ones pulsing amber); a node click shows a sector card (planet thumbnail from the sector theme, flavour, bias, lock, Unlock / Unlock with AM / Travel). Travel: `Engine.fx.warp()` then `Meta.switchSector` then `Engine.setSector`; the panel stays open on return.
- **Missions**: three active mission cards with progress bars and Claim; chapters below as collapsed shelves with done counts; claimed rewards fly to the HUD anchors.
- **Registry**: tabs Ships / Species / Artifacts; grid of silhouette cards; found ones in colour with lore; set progress and set rewards.
- **Store**: section 7.3.
- **Settings**: sound and music toggles with volume, reduced motion override, perf tier override, export/import save, restore purchases, about and licence, "Scrap this station" (new station in this sector) and "Reset profile" (double confirm).

### 5.3 Overlays (`overlays.js`)

Modal (transmissions and confirms) as a centred glass dialog with a violet or amber spine by kind, 15px body, choices as big lozenges; toasts (glass, hue spine, icon, 4 s, hover to hold); tooltip (glass, anchored, 14px); celebrations (2.6); **Daily** overlay (7-day strip with today lit, Claim, streak); **While you were away** summary (credits banked, builds done, expeditions back, ships served); keys overlay.

### 5.4 Title screen v2

The world drifts behind (home theme), a dark glass band holds the wordmark at 64px with a single light sweep on load, under it "STATION COMMISSIONING" in amber. With a profile: a wide resume card (sector thumbnail, "COMMANDER · RANK 3 HARBOURMASTER", station name, day, credits, AM, banked total waiting) and a quiet "New profile" ghost button with a confirm. Without: the name field, reroll, registry line, and **Commission** (big primary). The first commission plays the boot and opens the tutorial pointer on Build.

### 5.5 Harness and gates (H)

`play/dev/hud2-preview.html`: the HUD with a mock `Sim`, `Meta`, `Store`, `Engine` (stubs that log calls and expose fake data: 28 modules, 3 timers, 2 expeditions, 6 missions, every celebration, every toast kind, every panel). Gates: every panel renders without errors at 1440x900 and 1180x700; contrast ≥ 7:1 for body text on glass (check with the computed background over `--space-1`); every interactive target ≥ 32px tall; keyboard reachable; screenshots of each panel saved to `play/dev/shots/` with `tools/pageshots.js`.

---

## 6. Simulation hooks S adds to `sim.js` (v1 methods and events all stay)

- `Sim.place(id, r, c)` → also creates the cell meta and emits `build-start` through Meta (`Meta.onPlace`).
- `Sim.demolish(r, c)` → clears cell meta (bank is lost, say so in the confirm).
- `Sim.totals()` → ignores cells under construction; applies upgrade multipliers; applies the sector bias from `SECTORS[Sim.state.sector].bias` to prices, residents growth and event weights.
- `Sim.catchUp(ms)` → fast-forward helper for offline (4.2).
- `Sim.newGame(sectorId = 'home')` → sizes the grid from the sector def, places the hub, picks a name from the sector's list.
- `Sim.save()/load()` become thin wrappers over `Meta.save()/load()` (the v1 key is only read for migration).
- Credits: `Sim.state.credits` stays the authority while a sector is active; `Meta` copies it into the wallet on save and on switch.

---

## 7. Store and payments (Engineer P)

### 7.1 Catalog (`STORE_CATALOG` in data2.js, owned by S but specified here)

| sku | kind | grants | price |
|---|---|---|---|
| am_50 | am | 50 AM | $1.99 |
| am_140 | am | 140 AM (+12%) | $4.99 · "Popular" |
| am_320 | am | 320 AM (+28%) | $9.99 |
| am_900 | am | 900 AM (+80%) | $24.99 · "Best value" |
| credits_s | credits | 2 hours of total station rate (min 10,000) | $1.99 |
| credits_l | credits | 8 hours of total station rate (min 40,000) | $5.99 |
| sector_pass | pass | every sector unlocked for this profile (no charts needed) | $9.99 |
| founder | cosmetic | Founder's livery (ivory-amber station strip) + title "Founder" + 100 AM | $4.99 |
| liveries | cosmetic | the 6 sector liveries | $2.99 |

### 7.2 Client (`js/store.js`)

```js
Store.configure({ mode: 'sandbox'|'stripe', apiBase, successPath })  // read from <meta name="waystation-store" content='{"mode":"sandbox"}'> in index.html
Store.catalog()                 // STORE_CATALOG with price labels and badges
Store.mode
Store.purchase(sku) -> Promise<{ ok, sku, granted }>   // sandbox: UI confirm ("TEST MODE · nothing is charged") then grant; stripe: POST {apiBase}/checkout → redirect to session.url
Store.resume()                  // on load: ?purchase=success&session_id=… → GET {apiBase}/claim?session_id&playerId → grant once → emit `purchase`; ?purchase=cancel → toast
Store.restore(email) -> Promise // GET {apiBase}/restore?email&playerId → grants not yet applied
Store.grant(sku)                // applies the grant via Meta (addAM, addCredits, unlockAll, entitlements) and records sku in profile.entitlements.history (idempotent by sessionId)
```

Sandbox is the default and is clearly labelled in the Store panel ("Test mode. Purchases are free and local until Stripe is connected."). `data-store` on body drives a small ribbon.

### 7.3 Store panel (H renders, P supplies the data and actions)

A hero card for the AM packs (four price tiles, the popular one lifted with a violet spine), then Boosts (credits), then Passes and Cosmetics, then "Restore purchases" and the legal micro line. Buying plays `UI.celebrate('purchase')` and flies AM to the anchor. Prices come from the catalog; nothing is hard-coded in the panel.

### 7.4 Server (`workers/store/`, Cloudflare Worker, no SDK)

`src/index.js` (module worker): `POST /checkout {sku, playerId, returnUrl}` → creates a Stripe Checkout Session with `mode=payment`, `line_items[0][price]=PRICES[sku]`, `client_reference_id=playerId`, `metadata[sku]`, `success_url={returnUrl}?purchase=success&session_id={CHECKOUT_SESSION_ID}`, `cancel_url={returnUrl}?purchase=cancel` using `fetch('https://api.stripe.com/v1/checkout/sessions')` with the secret key; `GET /claim?session_id&playerId` → retrieves the session, checks `payment_status=paid` and `client_reference_id`, writes `grant:{session_id}` and appends to `player:{playerId}` in KV once, returns `{sku, granted:true}`; `POST /webhook` → verifies `Stripe-Signature` (HMAC-SHA256 via WebCrypto over `t.payload`, tolerance 5 min) and records the grant the same way; `GET /entitlements?playerId` and `GET /restore?email&playerId` (lists Checkout Sessions by `customer_details.email` via the search API, grants unclaimed ones). CORS for the site origin only. `wrangler.toml` with a KV binding `STORE`, vars `ALLOWED_ORIGIN`, `PRICES` (JSON sku→price id), secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. `README.md`: create the nine products and prices in Stripe (test mode first), paste price ids, `wrangler login`, `wrangler kv namespace create STORE`, `wrangler secret put …`, `wrangler deploy`, set the webhook endpoint, flip the site's meta to `{"mode":"stripe","apiBase":"https://…workers.dev"}`. `test/store.test.js` (node) exercises the handlers with a mocked `fetch`.

---

## 8. Readability and accessibility v2

Body ≥ 14px, numbers ≥ 14px, labels ≥ 12px; glass panels keep ≥ 7:1 for body text and ≥ 4.5:1 for labels against the darkest and brightest space under them (check both); status never by hue alone (shapes, words); all controls ≥ 32px tall; focus ring ivory 2px; full keyboard operation of panels; `prefers-reduced-motion` honoured per 2.6; pause on `visibilitychange` is **not** done (timers are real time; the sim pauses, banks keep filling); screen reader labels on rail buttons and chips; no flashing above 3 Hz; a perf tier switch for weak GPUs.

---

## 9. Sound (`js/ui/sound.js`, WebAudio, procedural, no files)

`Sound.init()` on the first user gesture; master, music and sfx gains persisted in `Meta.profile.settings`. Palette: `ui.hover` (very soft 2 ms tick), `ui.click` (sine blip 880→1320 Hz, 60 ms), `ui.open` (filtered noise sweep up, 180 ms), `ui.close` (down), `collect(n)` (ascending pentatonic arpeggio of 3–6 notes, triangle, with a tiny bell), `built` (major chord pad with a chime), `rankUp` (fanfare: 4-note rising brass-ish saw with a filter sweep), `alert` (two-tone low), `error` (short buzz), `warp` (riser + whoosh), `purchase` (collect + chord). Ambient: a bridge hum (two detuned saws at 55/55.3 Hz through a low-pass at 180 Hz, −30 dB) plus a slow pad (3 sines, 8-bar random walk in a lydian scale, −26 dB) that brightens one filter notch when a panel opens; it ducks 6 dB under celebrations. Everything respects the toggles and `document.hidden`.

---

## 10. Delivery gates for integration

1. `play/dev/engine-preview.html`, `play/dev/hud2-preview.html`, `node play/dev/sim-test.js`, `node workers/store/test/store.test.js` all pass.
2. `play/index.html` boots to the title in < 2.5 s on a warm cache, commissions a station, places a module with a visible timer, collects a bank with the flight, launches an expedition, claims a mission, opens every panel, buys an AM pack in sandbox, unlocks `sable` with AM, travels there and back, with zero console errors.
3. A v1 save migrates and its station is intact in `home`.
4. 60 fps at 1440x900 with the staged station at tier 2; no layout at 1180x700 overlaps.
5. Screenshots in `play/dev/shots/` for: title, bridge with the Build panel, collect flight mid-air, map, expeditions, store, celebration.

---

## Appendix A. Glossary

**Bank / hopper**: a module's local accumulation of credits waiting to be tapped. **Chart**: proof of an expedition to a sector; three charts fully chart it. **AM / Antimatter**: the premium currency (violet). **Sector**: a star system with its own station. **Rank**: the profile-wide commander level. **Tell**: a module's one quiet live-state animation (DESIGN.md 8.1). **Spine**: the 2px luminous leading edge of a v2 panel (the v1 keel, lit).


---

## Addendum A1 — v2.1 "Patient": pacing, plot expansion, achievements (2026-10-19, owner's brief)

The owner, after playing v2: the game must be slow, in the way Clash of Clans and DragonVale are slow. People log back in to check on it. Build times and upgrade times are the heartbeat; acceleration is something you buy. There must be levels and achievements, and territory to expand. Where this addendum and the sections above disagree, this addendum wins.

### A1.1 Pacing preset `patient` (S; ships as the file default in `data2.js`, replacing `slow`)

- **Build times** (`TIMERS.BUILD_MS`): tier 1 = 90 s (the first three builds of a profile stay instant), tier 2 = 12 min, tier 3 = 60 min, tier 4 = 4 h. Far sectors (index >= 4) x1.5. **Upgrades**: level 2 takes 2x the build time, level 3 takes 5x. A tier-3 module at level 3 is therefore a five-hour project; the Jump Gate at level 3 is twenty hours.
- **Banks**: rate = cost / 150 per real minute at level 1 (x1.6 / x2.4 at levels 2 / 3); caps = 180 / 240 / 360 minutes of rate. Offline accrual cap 24 h.
- **Expeditions**: durations 30 min, 1 h, 2 h, 4 h, 6 h, 8 h, 12 h, 24 h by sector order; costs unchanged. Charts still guaranteed on the third run.
- **Game time**: `TIMERS.DAY_MS` = 48,000 (one game day = 48 s at 1x); `ECON.shipSpeed` tuned so ships read as calm (about 40 cells/day). `ECON.live` stays 0.06. The 2x and 4x speeds are **removed from the product**: `Sim.state.speed` is clamped to 0 or 1 by `Sim.tick` and by `UI.setSpeed`; the HUD shows only Pause and 1x.
- **Skip cost** stays `max(1, ceil(remainingMinutes / 8))` AM, so a 4 h build costs 30 AM to finish (about one dollar at the 140 pack). Antimatter is the only accelerator.
- **Sector unlock costs**: recalibrated by the pacing bot (three 15-minute sessions a day) to land **sable day 2-3, kessler day 4-5, thessaly day 8-10, marrow day 13-15, oros day 18-22, keth day 24-28, aurelia day 32-40**. S prints the table and ships the costs that hit it.
- Daily reward credits scale with the station's total rate as before; the Store's credit packs keep their floors.

### A1.2 Plot expansion ("territory") per station (S, E, H)

Every station starts with a **7x5 plot** around the hub inside its sector grid; the rest of the grid is **unclaimed space**: dim, hatched, with drifting debris (E). The player buys the next **ring** of cells with credits, waits for the clearing timer (or pays Antimatter), and the plot grows: 7x5 -> 9x7 -> 11x7 -> 13x9 -> 15x9 (home); larger grids add rings up to their size (17x9, 15x11, 17x11, 19x11). Ring k (1-based) costs `PLOT.baseCost x PLOT.costMul^(k-1)` credits (base 4,000, mul 2.2) and takes `PLOT.baseMs x PLOT.msMul^(k-1)` (base 15 min, mul 1.9); far sectors x1.5 on time. Rings are cleared one at a time.

- Data (`data2.js`): `PLOT = { start: {w:7, h:5}, baseCost: 4000, baseMs: 15*60e3, costMul: 2.2, msMul: 1.9 }` and `plotRings(rows, cols, hub)` -> the list of ring bounds `{r0,c0,r1,c1}` for a grid (ring 0 = the start plot, last ring = the full grid; a ring grows by one cell on each side where the grid allows, alternating width-first when the grid is wider than tall).
- State: `Sim.state.plot = { ring: 0, r0, c0, r1, c1, clearing: null | { ring, startedAt, endsAt, totalMs } }`. Migration of an existing profile sets `ring` to the smallest ring containing every occupied cell.
- Read model: `Meta.plot() -> { ring, rings, r0, c0, r1, c1, cells, next: { ring, cost, ms, cells, affordable } | null, clearing: { ring, endsAt, remainingMs, totalMs, skipAM } | null }`; `Sim.inPlot(r, c) -> bool`; `Sim.canPlace` returns `{ ok:false, why:'plot' }` outside the plot.
- Mutators: `Meta.expandPlot() -> { ok, cost, endsAt, why }`, `Meta.skipPlot() -> { ok, cost }`. Events: `plot {state:'start'|'done'|'skip', ring, bounds}`. `Meta.nextUp()` includes the clearing timer (`kind:'plot'`). Missions: two new ones in *Commissioning* ("Clear your first ring") and *Town* ("Clear ring 4"). Achievements below track rings cleared across sectors.
- Engine: cells outside the plot draw on `world.shadow` as a hatched unclaimed field (ice at 6-8%) with 1-3 small debris sprites per cell drifting slowly; the plot edge is a faint dashed ivory boundary; the ring being cleared shows a sweeping clear-progress band along the boundary plus a mono timer at the plot's bottom edge; completion plays a reveal (the band brightens, debris blows outward as motes, `Engine.fx.pulse` on each new cell over 400 ms). Clicking an unclaimed cell emits **`'plot-click' {r, c, ring}`** (the ring that cell belongs to); placement mode treats unclaimed cells as invalid (hatched). Camera bounds use the full grid as before.
- HUD: `plot-click` opens a confirm: "Clear ring 2 . 20 cells . 8,800 cr . 28 min" with Clear / Clear now for N AM (when a clearing is already running: "Clearing ring 2 . 14:20 left . Skip for 2 AM"). The Station overview gets a **Territory** block (plot size, ring k of n, Expand button, timer). The Build panel's tier heads show "needs more plot" when no valid cell exists in the plot for a module. Next-up shows the clearing timer. Context hint: "Unclaimed space: click it to clear the next ring".

### A1.3 Achievements (S, H)

Lifetime, profile-wide, tiered; separate from missions (which are chapter goals) and from rank (which is XP). `ACHIEVEMENTS` in `data2.js`: 24 entries, each `{ id, title, desc, icon, fam, stat, tiers: [{ goal, am }] }` with 3 tiers (bronze/silver/gold) paying 5 / 15 / 40 AM (gold on the hardest ones 60). Stats come from `profile.stats` (lifetime: servedTotal, collects, amEarned, buildsDone, upgrades, expeditionsClaimed, discoveries, missionsClaimed, dailyClaims, sectorsUnlocked, plotRings) and derived values (best level, rank, charts total, registry found count, banked lifetime, residents peak, Aurelian liners served, convoys served). Examples: *Harbourmaster* (serve 50 / 500 / 5,000 ships), *Banker* (collect 50k / 1M / 20M credits), *Architect* (build 10 / 100 / 500 modules), *Foreman* (upgrade 5 / 50 / 200), *Surveyor* (claim 3 / 25 / 150 expeditions), *Cartographer* (charts 3 / 12 / 24), *Collector* (registry 10 / 30 / 52), *Pioneer* (sectors 2 / 5 / 8), *Landholder* (rings 2 / 10 / 30), *Regular* (dailies 7 / 30 / 100), *Patron* (AM earned 50 / 500 / 5,000), *Town Planner* (residents 20 / 60 / 150), plus one per tier reached in any sector and one per rank milestone.
- Read model: `Meta.achievements() -> [{ id, title, desc, icon, fam, tier /*claimed tiers 0..3*/, progress, goal /*next tier goal*/, nextAM, claimable, done }]`; `Meta.claimAchievement(id) -> { am, tier } | null`; event `achievement { id, tier, state:'complete'|'claimed' }`; `Meta.achievementBadge() -> count claimable`.
- HUD: the Missions panel becomes **Missions | Achievements** tabs; achievement rows show a three-segment tier bar, progress and a Claim lozenge; the rail badge counts missions **and** achievements; `UI.celebrate('achievement', {title, tier, am})` uses the amber band with a bronze/silver/gold chip.

### A1.4 Levels

Station tiers (L1-L5) and Commander rank (ten ranks) are the two level systems; the HUD already shows both. The status bar's rank ring gains a tooltip with the next rank's grant. No new system.

### A1.5 Gates for v2.1

`node play/dev/sim-test.js` extends section 14 for the `patient` default and adds sections for plots (rings per grid size, costs, timers, skip, migration ring, canPlace outside the plot) and achievements (tier progression, claim once, badge count), plus the recalibrated pacing table. The HUD harness adds the Territory block, a plot confirm, the Achievements tab and the celebration. The engine harness stages a 9x7 plot on a 15x9 grid with ring 2 clearing. The integrated journey gains: click unclaimed space -> clear ring with AM -> build on the new cells -> claim an achievement.


---

## Addendum A2 — accounts and cloud saves, the tutorial, the manual, the admin console (2026-10-19, owner's brief)

The owner: "a portal so people can log in to save their games", "a game manual people can read", "a tutorial at the beginning that explains the game". Where this addendum and the sections above disagree, this addendum wins.

### A2.1 Accounts and cloud saves (P: `workers/account`, `play/js/account.js`; H: the portal and account UI)

Design: email and password accounts on a second Cloudflare Worker, one cloud save per account (the whole `Meta.profile`), newest-wins sync with a chooser when both sides moved. No third-party identity provider and no email sending in this version: password reset works through a **recovery phrase** handed out once at sign-up (email-based reset is a documented later step that needs an email provider).

**Worker `workers/account`** (module worker, plain fetch, WebCrypto, KV binding `ACCOUNTS`, vars `ALLOWED_ORIGIN`, secret `PEPPER`; same house style as `workers/store`, with `wrangler.toml`, `package.json`, `test/account.test.js`, `README.md` for the owner):
- `POST /signup {email, password}` -> `{token, user:{id,email}, recovery}`; email normalised to lower case, password >= 10 characters, 409 if the email exists. Password hash: PBKDF2-SHA256, 210,000 iterations, 16-byte salt, with `PEPPER` appended; stored as `user:{email}` = `{id, email, pw:{salt,hash,iter}, rec:{salt,hash}, createdAt}`. The recovery phrase is ten words from a 512-word list, shown once, stored hashed the same way.
- `POST /login {email, password}` -> `{token, user}`; `POST /logout` (Bearer) -> `{ok}`; `POST /recover {email, recovery, newPassword}` -> `{token, user, recovery}` (a new phrase; every older token is revoked by bumping `user.tokenGen`).
- Tokens: 32 random bytes base64url; stored `tok:{sha256(token)}` = `{userId, email, gen, createdAt}` with a 30-day KV TTL, refreshed on use (sliding).
- `GET /me` (Bearer) -> `{user, save: {updatedAt, version, size} | null}`.
- `GET /save` (Bearer) -> `{version, updatedAt, profile}`; `PUT /save {profile, baseVersion}` -> `{version, updatedAt}` or **409** `{error:'conflict', server:{version, updatedAt, summary}}` when `baseVersion` is not the stored version; profile JSON capped at 1 MB; stored `save:{userId}` = `{version, updatedAt, summary:{name, day, level, credits, am, sectors, rank}, profile}` (summary computed server-side from known fields, defensively).
- `DELETE /account {password}` (Bearer) -> wipes user, tokens and save. `GET /health`.
- Rate limits in KV per IP: 10 sign-ups per hour, 20 logins per 10 minutes, 5 recoveries per hour; 429 with `retryAfter`. CORS restricted to `ALLOWED_ORIGIN` (comma list), `cache-control: no-store`, JSON errors `{error, message}`.
- Tests: sign-up/login/wrong password/duplicate email, token sliding and revocation on recover, save put/get, 409 on a stale baseVersion, size cap, delete, CORS, rate limit, PBKDF2 vectors stable across runs.

**Client `play/js/account.js`** (classic script, `Account` global; loads after `hud.js`, before `admin.js` and `main.js`):
- `Account.configure({apiBase})` from `<meta name="waystation-account" content='{"apiBase":"https://…workers.dev"}'>`; empty or absent apiBase -> `Account.available === false` and every method resolves `{ok:false, why:'Cloud saves are not connected yet'}`.
- `Account.state` -> `{available, signedIn, user:{email}|null, syncing, dirty, lastSyncAt, lastError, cloud:{version, updatedAt, summary}|null}`; `Account.on(evt, fn)`; Sim bus event `account {state:'signed-in'|'signed-out'|'synced'|'conflict'|'error'|'offline', ...}`.
- `Account.signup(email, password) -> {ok, recovery, why}`, `Account.login(email, password) -> {ok, why}`, `Account.logout()`, `Account.recover(email, phrase, newPassword) -> {ok, recovery, why}`, `Account.deleteAccount(password) -> {ok, why}`, `Account.syncNow() -> {ok, why}`, `Account.pull() -> {ok}` (replace local with cloud through `Meta.import`), `Account.push()`.
- `Account.boot() -> Promise<{status:'none'|'local'|'cloud'|'conflict'|'offline'}>`, called by main.js after `Meta.init()` and before the title: with a stored token it calls `/me`; with a cloud save it compares `Meta.profile.savedAt` and `Meta.profile.cloud` (`{version, syncedAt}` written after every successful sync) against the server version: cloud ahead and local unchanged since the last sync -> pull; local ahead -> push; both moved -> `await Account.ui.choose({local:{summary, savedAt}, cloud:{summary, updatedAt}})` (H sets the hook; default newest) then pull or push. Network failure -> `'offline'`, play continues locally and sync retries.
- Push policy: debounced 20 s after any `change`, immediately on `sector switched`, `purchase`, `mission claimed`, `achievement claimed`, `pagehide` (fetch with `keepalive:true`), and every 60 s while dirty; never more than one in flight; 401 -> signed out with a toast; 409 -> refresh `cloud` and run the chooser.
- Storage: `localStorage['waystation.account']` = `{token, email}`. After sign-up/login on a browser with an existing local profile, the chooser decides whether the local profile becomes the cloud save or the cloud save replaces it.
- A node test under `workers/account/test/client.test.js` loads account.js in a vm with fake fetch/localStorage/Meta/Sim and covers configure-absent, signup, login, boot pull/push/conflict, 401, 409, debounce.

**UI (H)**:
- Title screen: a ghost lozenge **Sign in** at the right end of the title band (or "Signed in · email" with the cloud summary and a "Not you?" link). It opens the **Portal** modal: tabs Sign in | Create account | Recover; email and password fields (password at least 10 characters, show/hide), inline errors, a spinner on the button; after sign-up a sheet shows the recovery phrase in a copyable block with "I have saved my recovery phrase" before it can be dismissed; after sign-in the chooser sheet appears when `Account.boot` or the sign-in reports a conflict: two cards (This browser / Cloud) with day, level, credits, Antimatter, sectors and the time, buttons Keep this browser's / Use the cloud save.
- Status bar: a small cloud glyph after the rank ring: synced (ice), syncing (pulsing), offline or error (warn), hidden when not available; tooltip with the time of the last sync; click opens Settings > Account.
- Settings: an **Account** shelf: signed out -> "Sign in to save across devices" and a Sign in button; signed in -> email, last synced, Sync now, Sign out, Delete account (double confirm, password). When `Account.available` is false the shelf says "Cloud saves are not connected on this build yet. Your profile is saved in this browser; export it from Save data to move it."
- Copy: "cloud save", never "the server"; the recovery phrase is explained as the only way back in without the password.

### A2.2 The tutorial (H: `play/js/ui/tutorial.js`, `Tutorial` global; loads after `panels.js`, before `hud.js`)

A guided tour of coach marks that runs once on the first commission of a profile, is skippable at any step, replays from Settings and from the manual, and never blocks the simulation.

- Mechanics: a full-screen dim layer with a **spotlight** cut around the target element (`clip-path` with an evenodd polygon, 8 px padding, 6 px radius; the target stays clickable); a glass **callout** anchored beside the target (auto-flips to stay on screen) with a kicker ("Tour · 4 of 13"), a title, two or three sentences, and lozenges **Next** / **Skip tour** (Enter / Esc); steps with a `waitFor` predicate or event show "Do it to continue" and advance automatically when satisfied, with Next hidden until then; the daily sheet and celebrations are deferred while the tour runs (`Tutorial.active`); reduced motion disables the spotlight fade.
- `Tutorial.start({replay})`, `Tutorial.skip()`, `Tutorial.active`, `Tutorial.done` (persisted in `Meta.profile.settings.tutorialDone`). `UI.start()` calls `Tutorial.start()` when the station is fresh (no dock built, no ships served) and the tour was never finished or skipped.
- Steps (targets in brackets): 1 Welcome, Commander: the Core Hub and the world; drag to pan, wheel to zoom [the hub, via `Engine.cellToScreen`]. 2 The status bar: credits, Antimatter, power, residents, reputation, rank [#statusbar]. 3 Open Build [rail Build; waitFor panel 'build']. 4 Place a Docking Bay on a bracketed cell: ships need a berth [the dock card; waitFor `built dock`]. 5 Power: place a Solar Array [solar card; waitFor `built solar`]. 6 Storage: a Cargo Warehouse [warehouse card; waitFor `built warehouse`]. 7 Builds take time from now on: the timer, the ring, and Antimatter to skip [a tier-1 card's time line]. 8 Banks: modules earn into a bank; a glowing coin means ready; tap it [the hub cell; waitFor first `collect` or Next]. 9 Ships and trade: Fleet shows who is docked, Market what they buy and sell [rail Fleet]. 10 Missions and achievements: claim rewards here [rail Missions]. 11 Territory and the galaxy: unclaimed space, rings, eight sectors [rail Map]. 12 Expeditions bring charts, cargo and discoveries [rail Expeditions]. 13 Daily reward, the Store and the manual; "You have the bridge." [status-bar daily button] with a **Read the manual** link (`../manual/`) and Finish.
- Settings gets **Replay the tour** under About; the keys overlay gets "Tour: Settings > Replay".

### A2.3 The manual (writer: `waystation/manual/index.html`, `waystation/manual/manual.css`, figures in `waystation/assets/manual/`)

A long, readable page in the landing page's visual language (it links `../site.css` and adds `manual.css` for the article layout): a sticky table of contents on the left at desktop widths, numbered sections, glass figure frames with captions, keyboard chips, and the same tokens and type. Sections: 1 What Waystation is; 2 Your first ten minutes (mirrors the tour); 3 The bridge (every status-bar readout, the rail, panels, context bar, Next up); 4 Building (tiers, costs, placement rules, docks' open side, build times by tier, upgrades, scrapping); 5 Banks and income (rates, caps, offline accrual, Collect all at rank 3); 6 Ships, companies and trade (companies, trust, offices, loans, market policies, booms and gluts); 7 Power and conditions (solar, reactor, flares, overdraw, pirates, festivals); 8 Crews, residents and quality of life; 9 Reputation and station tiers (what unlocks each); 10 Territory (plot rings, costs and times); 11 The galaxy (eight sectors with their worlds, biases and unlock rules; the shared wallet); 12 Expeditions (slots, durations, loot, charts); 13 Missions and achievements; 14 Daily reward and Commander rank (the rank table and its grants); 15 The Registry; 16 Antimatter and the Store (what it buys, what it never gates, test mode note); 17 Saves, accounts and devices (local save, export/import, cloud saves when connected, recovery phrase); 18 Controls and accessibility (keys, camera, reduced motion, performance tiers); 19 Glossary. Every number comes from `play/js/data.js` and `play/js/data2.js` (the `patient` preset), never from memory. Figures: 8 to 10 WebP captures of the real game at 1440x900 (title, bridge, Build panel with a scaffold, a bank being collected, Map, Expeditions, Missions | Achievements, Store, Territory confirm, Settings), each under 150 KB. Links to the manual: the landing page rail and footer (integrator), Settings > About "Open the manual" and the tour's last step (H), the 404 page is unchanged.

### A2.4 The admin console (integrator; shipped)

`play/js/ui/admin.js`: Settings > Admin > "Bridge admin" or Ctrl+Shift+A opens a passphrase gate; the SHA-256 of the passphrase is in `<meta name="waystation-admin" content="sha256:…">` in `play/index.html` and the passphrase itself is never committed. The console grants Antimatter and credits (recorded as `admin_am` / `admin_credits` in `profile.entitlements.history` with `mode:'admin'`), finishes timers, returns expeditions, fills banks, adds XP and reputation, unlocks sectors, makes the daily claimable, forces the store mode and locks again. Change the passphrase with `node -e "console.log(require('crypto').createHash('sha256').update('new passphrase').digest('hex'))"` and paste the hex into the meta tag. It is a convenience gate in a client-side game, not a security boundary.

## Addendum A3 — push notifications for finished timers (2026-10-19)

Opt-in browser notifications when a build, upgrade, expedition or plot clearing finishes while the tab is closed, plus an optional daily-reward reminder. Nothing is requested or registered until the player flips the switch. Where this addendum and the sections above disagree, this addendum wins.

### A3.1 Contract changes

- 0.1 load order: `<script src="js/notify.js"></script>` after `js/store.js`, before `js/ui/admin.js` and `js/main.js`. 0.2 globals: `Notify`. `play/sw.js` is the service worker (`push`, `notificationclick`, `pushsubscriptionchange` only: no fetch handler, no caching, the site stays static); `Notify` registers it, never a plain page load.
- `<meta name="waystation-push" content='{"apiBase":"https://…workers.dev"}'>` in `play/index.html` (optional `publicKey` skips `GET /key`). Empty or absent `apiBase` is sandbox: `Notify.state().status === 'unconfigured'`, the switch is disabled and reads "Not connected". `localStorage['waystation.push']` overrides the tag for local testing.
- `Meta.profile.settings.notify` (bool) and `settings.notifyDaily` (bool, default off). `main.js` calls `Notify.boot()` right after `Meta.init()`; boot re-attaches silently only when `notify` is on and `Notification.permission === 'granted'`.

### A3.2 Client (`play/js/notify.js`, classic script)

`Notify.boot()`, `enable()` (must run inside the click: permission prompt, register `sw.js`, `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` with the key from `GET /key`, `POST /subscribe`, the returned token kept in `localStorage['waystation.push.sub']`), `disable()` (`POST /unsubscribe`, `unsubscribe()`, unregister), `setDaily(on)`, `test()` (a `test` timer due now, so the real cron delivers it within a minute), `state() -> {status, detail, supported, configured, wanted, daily, permission, subscribed, lastSync}` with `status` one of `unsupported | unconfigured | off | pending | on | blocked | error`, `timers({all})`.

The schedule is every pending timer, not `Meta.nextUp()`'s three: `cells[k].readyAt` in every station of `Meta.profile.sectors` (`cell.up` makes it an upgrade), `Meta.expeditions()` with status `out`, `plot.clearing`, and with `notifyDaily` the daily reward at 09:00 local on the day `Meta.daily().nextAt` falls on. Ids: `build:{sector}:{r,c}`, `upgrade:{sector}:{r,c}`, `plot:{sector}:{ring}`, `expedition:{id}`, `daily`, `test`. Titles are finished-state sentences: "Comms Relay online", "Comms Relay is now level 2", "Expedition back from Sable Drift", "Ring 2 cleared", "Daily reward ready", with " · Sable Drift" appended for an inactive sector. Posted as one list (the soonest 64) on `change, build-start, build-done, upgrade, expedition, plot, daily, sector, offline`, debounced 4 s and only when the set of (id, dueAt) changed; flushed at once with `keepalive` on `visibilitychange` to hidden and on `pagehide`. While the tab is visible, timers due within 120 s stay out (the player is watching them). A 404 `no-subscription` or 403 `bad-token` makes the client subscribe again (at most three times in a row); three consecutive network failures show `error` ("Offline") without touching the setting; a changed `playerId` (new or imported profile) moves the subscription over.

### A3.3 Settings panel (H, `panels.js`)

Shelf "Notifications" (ice) between "Motion and performance" and "Save data": the switch **Notify me when something finishes** with a status chip before it (On `.good` · Off `.ink` · Connecting `.ice` · Blocked `.warn` · Offline `.warn` · Unavailable `.ink` · Not connected `.ink`), disabled while unsupported, unconfigured or pending, and a 12 px sub line that explains the state (blocked: how to allow it again). When on, two more rows: the switch **Daily reward reminder** ("At 9 in the morning when a reward is waiting") and the lozenge **Send a test notification** (`.btn`, bell icon). `.switch:disabled` at 40%. The panel re-renders from `Notify.state()` on its 250 ms tick, so the chip follows the subscription without events.

### A3.4 Server (`workers/push`, Cloudflare Worker, no SDK; house style of `workers/store`)

`GET /health`, `GET /key -> {publicKey}`, `POST /subscribe {playerId, subscription} -> {token}` (same endpoint and keys: same token, no write; a different browser replaces the old one), `POST /schedule {playerId, token, station?, timers:[{id, kind, title, dueAt}]} -> {count, nextDueAt, unchanged}` (replaces; ≤ 64 timers; kinds `build upgrade expedition plot daily test`; titles ≤ 80 characters; timers more than 10 min over are dropped; no write when unchanged), `POST /unsubscribe {playerId, token}`. KV binding `PUSH`: `sub:{pid}`, `timers:{pid}`, and one `index` key `{pid: soonest dueAt}` so the cron reads one key a minute (the KV free plan allows 1,000 list operations a day, a 1-minute cron would need 1,440). Cron `* * * * *` (`[triggers]`): visit every player whose soonest timer is due, send one message per player (the timer's title, or "3 things finished at Harrow Point" with the titles in the body), delete sent timers, prune subscriptions on 404/410, keep timers on 429/5xx/401/403 for the next minute, forget timers more than 2 h overdue, at most 40 sends per run (50 subrequests on the free plan), rebuild `index` from the `timers:` keys every 15 minutes. Web Push in `src/webpush.js` with WebCrypto only: aes128gcm per RFC 8291 (checked against the RFC's Appendix A vector), VAPID ES256 JWT per RFC 8292 (`aud` = endpoint origin, `exp` 12 h, `sub` from `VAPID_SUBJECT`), headers `TTL: 86400`, `Urgency: normal`, `Topic: waystation`. Vars `ALLOWED_ORIGIN`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`; secret `VAPID_PRIVATE_KEY` (`npm run keys` makes the pair). Budget on the free plan: each schedule change is one or two KV writes of the 1,000 a day, about 400 changes a day across all players.

### A3.5 Gates

`npm test` in `workers/push` green (the RFC 8291 vector byte for byte, the handlers, the cron with a scripted push service and decrypted payloads, and `notify.js` in a vm with a fake browser); `node test/e2e-local.mjs` against `npm run dev` delivers and decrypts a due timer through the local cron; in Chrome against the deployed worker: switch on → Allow → "Send a test notification" arrives within a minute → a 90 s build with the tab closed notifies; the switch reads "Not connected" and the game is untouched when the `<meta>` tag is empty.

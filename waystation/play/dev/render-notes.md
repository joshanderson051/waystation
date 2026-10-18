# render.js — reviewer notes (Engineer R1)

Scope: `js/render.js` implements DESIGN.md 0.3, 0.5-0.6, 4.1, 7, 8.0, 8.2, 9.3-9.6, 10, 11.2, 14.1 and `Render.thumbnail`.
It is a classic script exporting one global, `Render`, built by an IIFE so all working state is private (`S`).

## 1. Frame pipeline (`Render.draw(dt)`)

Order per frame on `#station` (the `#bg` canvas is never touched per frame):

| # | Pass | Notes |
|---|------|-------|
| 0 | `updateReduced()` | `matchMedia('(prefers-reduced-motion: reduce)')` OR `body[data-motion="reduced"]`; `FX.setReduced` on change |
| 1 | `clearRect` | |
| 2 | `drawAmbient` | mid-star tile (512 CSS px, 120 1-px stars, baked once per DPR) drawn wrapping with `mouse*0.006` parallax (off at tier >= 1 / reduced); 36 near stars (2x2 device px, placed outside the inflated grid box) grouped into 8 alpha buckets; shooting star every 25-50 s rejected if its segment crosses the grid rect |
| — | `if (!Sim.state) return` | title screen: only ambient + `FX.draw` run |
| 3 | `structureStale` -> `onChange()` | catches `Sim.load()` (emits no `change`) by state identity + occupied-cell count (no allocation) |
| 4 | `frameShared` | **`Sim.totals()` exactly once**; ships-by-dock map; liner-near flag; stock-change stamp; condition flags |
| 5 | `drawGrid` | dots Path2D (rebuilt on resize) at alpha .09 -> .22 while placing (160 ms tween); rings Path2D (4 and 7 cells, 36 bearing ticks) |
| 6 | `drawPlacementField` (placing only) | legal/illegal candidate scan via `Sim.canPlace`; one evenodd dim fill; one Path2D of ivory brackets; one of bad brackets + clipped hatch. Drawn *under* trusses/modules so the station stays bright |
| 7 | `drawApproachVectors` | stamps entry per ship (WeakMap); dotted real vector entry -> `ship.target`, last 2 cells ice |
| 8 | `drawTrusses` | fill / edge / conduit / nodes Path2Ds (rebuilt lazily when `trussDirty`), growing spars drawn individually for 250 ms, one `fillRect` pass of running lights (off at tier 2 / reduced) |
| 9 | `drawModules` | per cell: sprite blit, hero glow, `lit`, `tell`, power-shortage overlay (details in section 3) |
| 10 | `drawGhost` (placing only) | preview spars 40 %, dock lane, sprite 55 %, dashed outline, reason/advisory plate |
| 11 | `drawShips` | `Ships.draw(ctx, ship, o)` per ship; fallback dart when ships.js is absent |
| 12 | `FX.draw` | |
| 13 | `drawSelection` | hover outline (+ chip after 300 ms), selected brackets (160 ms draw-in, 2 px breathe) + leader + chip |
| 14 | `drawFloaters` | one `ctx.font` set; halo `strokeText` + `fillText` |
| 15 | `drawReadout` | `PLOT 15x9 · CELL r:cc` bottom-left, 10 px mono, ivory 35 % |
| 16 | `perfSample` | EMA of `draw()` duration (`0.9/0.1`); > 8 ms for 60 frames -> tier+1 (max 2); < 4 ms for 600 frames -> tier-1; `FX.setTier` on change |

Text passes set `ctx.font` once each (readout, plates, chip, floaters, sprite bake). `measureText` goes through `textWidth()` cached by `font|string`.

## 2. Cache keys and purges

| Cache | Key | Purged on |
|-------|-----|-----------|
| `S.sprites` (module sprites) | `${id}|${cellDevicePx}|${variant}|${tag}` where `variant` = `normal` or `offline` (solar in flare), `tag` = `''` until fonts are ready or when `cell < 48`, else `${REG}|${BERTH}` e.g. `DK-02|03`, `WH-01|` | cell change, `document.fonts.load` resolve, `fonts.ready` |
| `S.glows` (radial glow discs) | `${color}|${rDevicePx}` (hub ivory r16, reactor `#9FE8D8` r12, gate ice r20) | cell/DPR change |
| `S.textW` (measureText) | `${font}|${string}` | cell change |
| `S.midTile` | one per DPR | size/cell change |
| `alphaCache` / `desatCache` / `parseCache` | `${color}|${alpha}` etc. | never (bounded by token set) |
| `S.trussFill/Edge/Conduit/Nodes` Path2D | — | `trussDirty` (Sim `change`, resize, spar growth finishing) |
| `S.dotsPath`, `S.ringsPath` | — | resize; rings also on `change` |
| `Ships.purge()` | — | called on cell change |

Sprite bake (`bakeSprite`) is in device px: canvas `cellDev + 12`, translate 6, scale `cellDev/100`, so 1 u = 1 % of the cell and `dpu = 100/cellDev` units = one device px. Layers: 3 shadow shapes at (+2,+3) device px, plate (rounded rect inset 6u r10u; hub = hexagon R48u), key-light edges via clip + translated 2-device-px strokes, 1.5u rim, strip (16..84u at y 7.5u, 4u), four r2u rivets, `ART[id].silhouette(g, cell/100, st)` (fallback: inner plate + two-letter tag), offline hatch, tags (JetBrains Mono 500 12u registry bottom-right at 30 % ivory; dock berth 14u top-right at 55 % ivory). `drawImage` is at `x - 6/dpr` with `x = ox + c*cell`, both device-aligned, never scaled.

Background bake (`bakeBackground`, debounced 120 ms on resize / DPR / name; `Render.bakeBackground(name)` for the title reroll): void fill, value-noise nebula at 1/6 res seeded by `registryOf(name)` (two tints, alpha `d*.22`, per-pixel luminance clamped to 16 %), 380 far stars as 1x1 device px rects (any star inside the inflated grid box forced to the .3 bucket), planet (`computePlanet`: r0 = .11 min(W,H), C = (W-.55r, .55r), shrink 2 px steps until no overlap with the inflated grid box, floor .06, then lift), vignette.

## 3. Per-frame `st` construction (8.2)

`frameShared(s)` once per frame produces `T = Sim.totals()` and the shared `flags`:

```
flags = { flare: T.flare, festival: day < fx.festivalUntil, alert: body[data-condition]==='alert',
          loan: any company.loan, converting: stock.ore >= 6, xeno: stock.xenofauna > 0,
          linerNear: any liner within 6 cells of the hub centre, shipAdjacent: false, stockChanged: now - stockChangedAt < 400ms }
```

`buildSt(id, key, r, c, def, T, flags, s, powered, trends)` is called **once per module per frame** (only when `ART[id]` exists) and returns

```
{ color: PAL.family(id) (fallbacks: FAMILY/FAMILY_COLOR, local map), lamp: PAL.lamp,
  T, efficiency: T.efficiency, powered, hover, selected, reduced, cellPx: cell, dpr,
  dock: { open:'n'|'s'|'e'|'w'|null, usable, approaching, docked, progress, berth } | null   // docks and hub only
  ratio: quarters visitors/beds | habitat residents/homes | warehouse stockTotal/storage | 0,
  load: used/produced (2 when produced is 0 and used > 0),
  day: s.day + s.t,
  trends: market only -> 4 signs of (effPrice - base) for the 4 goods furthest from base (|d| > 2 % of base counts),
  flags: Object.assign({}, flags, { shipAdjacent })   // shipAdjacent = a docked ship on a 4-neighbour berth }
```

`powered = !offline && (def.power >= 0 || T.efficiency >= 1)`. `dock.open` is derived from the offset of `Sim.berthPoint(r,c)` from the cell centre, recomputed on `change`; `progress = 1 - (dockedUntil - Sim.now()) / dockDays` clamped; `berth` = 1 for the hub, docks from 2 in build order (built day, r, c).

Live-layer rules applied around the calls:
- `lit`: skipped for offline solar; `globalAlpha = .5` when unpowered; `ctx.save(); translate(x,y); scale(cell/100)`.
- `tell`: `t = time + (r*7 + c*13)*.37`, or `0` (frozen at phase 0) when unpowered/offline. Gating (`tellAllowed`): none below 36 px; under reduced motion only `security`, `habitat`, `dock` (they draw beacons/LEDs themselves from `st.reduced`); class B (from `ART[id].tellClass`, else the 8.0 list) needs cell >= 44, tier < 2, and membership in `bTellBudget` = nearest 16 to the mouse among B modules within 3 cells (or all B modules when total modules <= 12).
- Each art call is wrapped in `save/restore` and `try/catch` so a sibling error never kills the frame.
- Power shortage overlay (consumers while `T.efficiency < 1`): dashed warn rounded ring inset 2u, dash `[4,3]` device px, `lineDashOffset` rotating 1 rev / 12 s, 6u triangle top-right.

## 4. Events -> effects

| Sim event | Render reaction |
|-----------|-----------------|
| `change` | `onChange`: cells array, BFS hub distances, registry/berth tags, dock open sides, spars (hub-side oriented; new spars touching `growCell` get `born = now`), name-change rebake, rings path |
| `built` | pop (`0.7 -> 1.06 -> 1.0`, 180 ms ease-out-back), `FX.sparks(cx, cy, family, 12, 300)`, `FX.ring(cx, cy, .5cell, 1.3cell, ivory, 400)`, `growCell` for spar growth |
| `demolished` | clear pop / hover key |
| `dock` | `FX.ring` ice `.2 -> .6` cell 300 ms at the collar; BFS path dock -> nearest warehouse (hub if none); `FX.motes(points, amber, 3, 600, easeOutCubic)` dock->storage when the ship sold to us (`Bought` lines), storage->dock when it bought (`Sold`/`Took` lines) |
| `depart` | `earned > 0`: `FX.motes([ship, (16,16)], amber-hi, 6, 600, easeInQuad)` |
| `spawn` | stamp entry point |

## 5. Floaters (9.6)

`WeakMap<floater, { t0, x0, y0, value, sign, text, color, hidden, numeric }>`; Sim's later `y`/`ttl` mutations are ignored. Color map: `#ff9d5a` -> `--warn`, `#7ee787` -> `--good`, a raw company color -> `desat(color, .15)`. Coalescing: a new numeric floater within 300 ms and 0.3 cells of a live one with the same sign adds its value (`fmt`) and is hidden. Cap 6 visible (oldest hidden). Drawn for 1.0 s: rises 0.5 cell with easeOutCubic, fades over the last 30 %, JetBrains Mono 600 `max(12, cell*.3)` px, 3 px halo.

## 6. Smoke test

`scratchpad/smoke.js` loads data.js, sim.js and render.js under a mocked DOM/canvas (Proxy context recording calls) and runs 13 scenarios twice: without siblings (fallback paths) and with stubbed `PAL/ART/FX/Ships` (asserts the `st` key set, the `Ships.draw` option keys, FX point shape, and that unpowered tells receive `t === 0`).

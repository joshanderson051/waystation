# art-mod-b.js notes (Engineer A3)

Per-module shapes used, in the 100x100 unit space, and every deviation from DESIGN.md 8.1.
General choices that apply to all twelve entries are listed first.

## General

- All helpers are local (`_B` namespace); the file depends only on `ART`, `PAL` (with section-2 hex fallbacks) and the `st` contract. `withAlpha` is not called; `_B.a(color, alpha)` is an equivalent that parses `#rgb/#rrggbb/#rrggbbaa/rgb()/rgba()`.
- `silhouette(g, u, st)`: fill family color at 55%, stroke 2u at 100% (clamped to >= 1 device px). If `st` is missing the module's own family token is used. Dark notches/ticks (gate runes, customs barrier ticks, refinery hazard band, bank door) use `--void` at 60-75% so stripes read inside the family fill.
- `lit`: lamp elements use `st.lamp`; dots are r=2u, squares 4u, both clamped to >= 2 device px; all lit alpha is multiplied by 0.5 when `st.powered === false`.
- `tell`: `_B.tt(t, st)` returns 0 when `!st.powered` or `st.reduced`, so every tell freezes at phase 0 in both cases (a static frame rather than nothing). Exceptions that keep moving under reduced motion: the habitat antenna beacon and the security alert beacon. Pure-motion marks that would look wrong frozen (refinery puffs, observatory glint, habitat window toggle, security wedge) are skipped under reduced motion.
- Baked radial glows (reactor core, gate lens) are offscreen canvases built once per `(color, radius, alpha)` with `createRadialGradient` at bake time and `drawImage`d in `lit` (before the core/lens so they sit under it). They degrade to nothing if `document` is absent.

## habitat (A)

Eight 10u rounded windows at 17u spacing around a 24u courtyard outline (ring spans 26..74), tree dot r 3.5 at centre, 3u antenna mast at x 82 (y 14..28) with a dot. Lit: 6u lamp squares inside the first `round(ratio*8)` windows; ratio 0 draws all eight at 20%. Tell: window index from `hash01(floor(t/5),3,7)`; a lit window is covered with `--hull`, an unlit one gets a lamp square. Beacon: lamp dot at the antenna tip, on for 1s of every 2s.
Deviation: lit window squares are 6u, not 4u, so the lamp fills the 10u frame.

## reactor (A)

Torus between R 25 and 35 (ring R 30, 10u thick), core r 10 in `#9FE8D8` (fill 55%, stroke 100%), coolant pipes 10x4 at left/right from the torus to x 6 / 94. Lit: baked glow r 12 device px plus a lamp hot spot r 4. Tell: three 1-CSS-px arcs R 36/40/44 spanning 120 deg at 1 rev/5s, /7s, /11s (alternating direction); core ring r = 10 +- 2 sin at `1 + 3*load` Hz, filled 35%, stroked 2u, in `--warn` when `load > .9`.
Deviation: the orbit arcs are drawn only by the tell (so they rotate); the baked silhouette has torus, core and pipes only. Frozen tells still show the arcs at phase 0.

## customs (B)

Vertical lane (2u edge lines at x 52 and 90, y 10..90), checkpoint box 36x28 at (8,36), gate bar 52x4 at (40,48) with three dark barrier ticks, stamp square 10u outlined on the box. Lit: lamp dot at (38,41) on the box. Tell: 2u scan bar across the lane (x 54..88) sweeping y 12..88 every 3s.
Deviation: gate bar is 52u, not 56u, so it ends inside the plate rim.

## security (A)

Shield polygon (28,24)-(72,24)-(72,48)-(50,74)-(28,48) (44x50), inner shield stroke inset 6u, 8u turret stubs at (20,22) and (72,22), 4x10 beacon post at the top centre. Lit: beacon lamp r 2 at (50,14). Tell: 60 deg wedge from (50,46), R 24, 15% family alpha, 1 rev/6s; during `flags.alert` the beacon alternates `--bad` r 3 / `--hull` r 2.5 at 1Hz (runs under reduced motion and regardless of power).
Deviation: the wedge is tell-only (not baked), so it can rotate.

## school (B)

Lower half-disc R 32 centred (50,44) (the chord at y 44 is the open top), tier arcs R 24/16/8, lectern 8x6 on the chord. Lit: lamp dot in the lectern. Tell: two faint ellipse tracks (22x7 tilted +0.3 rad, 18x9 tilted -0.4 rad, centre (50,26)) and two family-colored r 2 dots orbiting at 1 rev/4s and 1 rev/6s (opposite directions).
Deviation: orbit dots are r 2 (4u) instead of 3u, meeting the minimum feature size.

## bank (A)

Lintel 56x6 at (22,12) with a 2u lighter highlight (family mixed 40% toward white), four 6x36 columns at x 24/40/56/72, dark door 6x12 between the middle columns, vault circle R 14 at (50,74) with 8 spokes (r 4..12) and a hub dot. Lit: lamp over the door at (51,37). Tell: a 5u band tilted 0.35 rad sweeps x 30..70 across the clipped vault disc during the first 1.2s of every 5s, `rgba(255,255,255,.18)` normally, `--warn` at 70% while `flags.loan`.

## plaza (A)

Cross concourse polygon (arms 20u, spanning 10..90), four 12u stalls at (18,18) (70,18) (18,70) (70,70), 16x2 awning ticks on the side facing the concourse. Lit: 4u lamp squares at awning centres, 70% (100% during festival). Tell: crowd squares 2.5u (>= 1.5 device px) in lamp at 70%, wandering along one arm each with slow per-dot sine walks.
Contract ambiguity: `st` has no residents field. Count = `st.crowd` if Render provides a number (intended as `clamp(round(residents/5),0,6)`), else `round(st.ratio*6)` if `st.ratio` is a number, else 3; clamped 0..6 and doubled (cap 12) during festival. During festival the tell can reach 12 fillRects, above the 8-op guideline.

## menagerie (A)

Dome 70x50 at (15,14) with two R 20 arcs forming the arched top, 3x2 pane lines (x 38.3 / 61.7, y 39), glass band outline 70x10 at (15,66), three foliage dots r 3 at y 58. Lit: band interior filled in family rose at 40% only when `flags.xeno`; dark otherwise. Tell: two-hump creature (18 wide, humps r 4.5) in `rgba(4,5,10,.85)` inside the band, x = 50 + 24 sin(2 pi t/6), only when `flags.xeno`.

## refinery (A)

Hopper trapezoid (20,58)-(80,58)-(70,82)-(30,82), three 10x40 stacks at x 27/45/63, 4u hazard band as seven dark ticks along y 60..64, channel slot 40x4 at (30,69) outlined. Lit: channel filled `--warn` at 60% when `flags.converting`, 30% idle. Tell (converting and powered only): extra `--warn` layer at 0..40% on a 2s sine (net .6 -> 1); puff dot in `--ink-2` rising 14u from stack `floor(t/2)%3` over 2s, growing r 1.5 -> 3 and fading; no puffs under reduced motion.

## shipyard (A)

Gantry ring: outer rect 70x56 at (15,22), inner rect 60x43 at (20,30) (8u top beam, 5u sides), filled evenodd and stroked; empty hull outline polygon (28,52)-(60,43)-(72,52)-(60,61) with a keel line; rail posts r 2.5 at the beam ends; wrench tick (line + r 2 circle) bottom-left. Lit: lamp dot on the bottom beam (50,75.5). Tell: 8x6 trolley ping-pongs x 26..74 on the top beam over 3s per leg (easeInOutSine) with a 2u hook line to y 38; while `flags.shipAdjacent` (and powered, not reduced) `FX.sparks` is called at the hook, 1 spark per half-second bucket (2/s).
Assumption: `FX.sparks(x, y, color, n, ms)` takes CSS px; the point is converted through `g.getTransform()` and divided by `st.dpr`. Buckets are keyed per cell by the transform's rounded translation.

## observatory (B)

Upper half-disc R 30 centred (50,58), base 68x8 at (16,58), tripod (three lines from (50,66) to y 84), a central seam line (50,56)->(50,29), lens/pivot dot r 3.5 at (50,56). Lit: lamp dot at the pivot. Tell: a dark 6u slot clipped to the dome at x = 50 + 22 sin(2 pi t/30) with a family-colored telescope line from the pivot to the slot's rim point; lens glint (lamp r 2.5 at the slot top) for 0.5s every 7s.
Deviation: "slit rotates 1 rev/30s" is rendered as the slit tracking left-right across the dome face with a 30s period (an elevation reading of the half-dome), so the slit stays on the dome. The baked seam coincides with the slit at phase 0 and reads as the dome's meridian otherwise.

## gate (A)

Outer ring between R 39 and 45, inner ring between R 29 and 35 (both 6u thick), twelve dark rune ticks across the outer ring, chevron (41,13)-(50,4)-(59,13)-(50,9) at the top, lens core r 10 in `--ice-hi`. Lit: baked glow r 20 device px at .4 and the lens disc r 9, alpha .4 + .6*k where k = `flags.linerNear` (number 0..1 if provided, else boolean 0/1); whole lens scaled by the lamp power factor. Tell: a 90 deg energy arc 4u thick in family color at 55% on each ring, outer at 1 rev/12s and inner counter at 1 rev/18s; two 90 deg `--ice-hi` arcs (r 6 and 3.5) swirl in the lens at 1 rev/2s and counter 1 rev/3s.
Deviation: rings R 42/32 instead of 44/34 so the outer edge (R 45) stays inside the sprite's padding. "Rings counter-rotate" is conveyed by the moving arcs since a uniform ring has no visible rotation; the rune ticks are baked and static.

# art-mod-a.js notes (Engineer A2)

Modules: hub, dock, warehouse, solar, fuel, quarters, cantina, comms, market, rec, hydro, clinic.
All coordinates are design units (0..100 per cell). "fs" = fill 55% + stroke 2u in the family color.

Shared decisions
- The file depends only on the globals `ART`, `PAL` and `withAlpha`. Every drawing helper is local (`_A`); `PAL` falls back to the section 2 hexes and `withAlpha` to a local rgba parser, so the file is safe whatever art.js exports beyond `ART`.
- `silhouette(g, u, st)` reads `st.color`; if `st` is missing it falls back to the module's family token so the Gate 1 bake works with a bare `{color}` object.
- Module-specific status (8.1 Status column) is drawn in `lit`, not `tell`, so it survives the tell gating (< 36px cells, reduced motion, B-tell cap). Generic status overlays are left to Render.
- `lit` sets `globalAlpha = .5` when `st.powered === false` (hydro overrides to 30% per its row). `tell` freezes at phase 0 when unpowered and returns early when `st.reduced` (exceptions: hub middle ring/halo drawn frozen; dock LEDs kept via `lit`, chase frozen on the centre LED).
- Lamp dots/squares clamp to >= 2 device px using `st.cellPx`-independent math: `minU(dev) = dev / (u * st.dpr)`.

## hub (A)
- Silhouette: pointy-top hexagon R 48 (fits 2..98), ring R 42 in ice, ring R 26 in ivory, six radial seams R 26 -> 46.
- The R 34 middle ring (6 arcs, 4u gaps) is drawn only by the tell (rotating 1 rev/20s; frozen at phase 0 when reduced). It is not baked, to avoid a double ring. With tells fully disabled the hub still shows hexagon + two rings + seams.
- Lit: 6 vertex lamps at R 44, core r 6; collar state as 3 LEDs at R 38 on the open side (good free / ice docked / dim lamp approaching / none blocked); power deficit (`load > 1` or `efficiency < 1`) -> dashed warn ring at R 42.
- Tell: breath halo ring at r 8 +- 2 (3s, 2s above 90% load) instead of resizing the baked core; approach chase centre -> ends -> dark at 1 step/s.
- Not drawn: the baked radial glow sprite under the core (bake-time, Render's).

## dock (A)
- Local frame has the mouth facing +x; rotated by `st.dock.open` (e 0, s +90, w 180, n -90). Unknown/null open side defaults to east.
- Silhouette: U polygon 18..82 with 14u arms; umbilical stub 4u on the back wall (opposite the mouth); dark LED slit 4x28 across the mouth at x 74..78.
- Lit: clamp pads 10x6 ice at the arm tips, slid 6u inward when docked (state-based, no per-cell lerp); LEDs at (76,40/50/60); progress arc 2px in `--ice-hi` running 3u outside the outer edge (x=15 / y=15 / y=85, total 204u) because an ice arc on the ice stroke would be invisible; blocked: 4u hazard band (#140C00 + warn 45 deg lines) on the outer rim strips and arm tips, three 6u bad chevrons pointing inward at the centres of the top arm, back wall and bottom arm.
- Tell: approach chase; "outward" read as centre LED -> both end LEDs -> dark.
- Berth tag `02` is Render's text (8.0 step 6), not drawn here.

## warehouse (A)
- 3x3 crates 20u at 16/40/64, rrect r 2; lid highlight white 30% on the top-left crate; 2u strap on the centre crate.
- Fill order bottom row left->right, then middle, then top. Filled crates repainted at 100% family color; unfilled dimmed with void at 40% (reads ~35%).
- Stock-change flash: while `flags.stockChanged` the last filled crate (or crate 0 when empty) gets lamp at 70%. Render is expected to hold the flag ~400 ms; the art has no timer or crate identity.
- Status: ratio >= .95 -> 2u warn strokeRect round the top row (14,14,72,24) over a 4u void 80% backing stroke; warn and amber are close in hue and the bare outline vanished on the crates in the harness.

## solar (A)
- Spine 6x76, wings 30x56 at 14..44 / 56..86 with 2x4 seams in void 70%, junction box 8u.
- Lit: lamp dot on the junction box; off while `flags.flare`.
- Tell: specular band 6u sweeping both wings every 6s (clipped). Deviation: the baked wings cannot rotate, so the +-6 deg tilt is suggested by a void 35% shade strip on the trailing wing edges, width 6u * |sin(day*2pi)|.

## fuel (B)
- Cylinders 24x60 at 22..46 / 54..78 (y 20..80), r 11. Spec names one hazard band, so it sits on the right cylinder (y 35..41, 3 amber stripes on #140C00) leaving the left cylinder free for the 4x40 gauge slit (32..36, 30..70). Hose loop 3u bezier from (78,46) to (86,66).
- Lit: valve lamps at (34,20) and (66,20).
- Tell: gauge level .6 +- .05 over 8s; drip dot from the hose end falling 10u every 2s while `flags.shipAdjacent`.

## quarters (A)
- Bay 70x56 r 8; 8 slits 10x6 at x 21/37/53/69, y 36/58 as void cut-outs. Door notch 8x6 on the bottom edge (the art does not know the hub side).
- Lit: first `round(ratio*8)` slits (top row left->right first) in lamp; ratio 0 -> all eight at 20%.
- Tell: `hash01(floor(t/4), 7, 13)` picks a slit and inverts its state (t is already per-cell offset, so cells differ).

## cantina (B)
- Table disc R 22 at (50,44), six 3u seat ticks R 25..31, counter 50x8 at y 76 with a rose 2u neon line at y 77.
- Lit: lamp strip 42x3 on the counter (height clamped), door glow dot at (12,80).
- Tell: three 2u steam squares rising 12u over 1.2s from (44,38) (50,36) (56,38), phases 0/.4/.8.

## comms (A)
- Dish R 22 at (50,40), mast 6x34 from y 60 to 94, arcs R 28/34 spanning -135..-45 deg (facing up), receiver axis dot r 3.
- Lit: lamp at the mast top (50,62).
- Tell: deviation on "dish rotates about the mast top": the baked disc cannot rotate, so a feed-horn lamp dot on a 2u spoke sweeps round the dish centre at R 16, 1 rev/8s. The expanding 1px ice ring R 10 -> 40 every 1.7s is as specified. Baked arcs stay facing up.

## market (A)
- Beam 60x4 at y 34, post 6x20, foot 24x4, hanger lines to two half-disc pans R 10 at (24,48) / (76,48), ticker strip 60x6 at y 80 (void 60% fill).
- The 4 tick marks are live only (tell), so they can carry trend colors and scroll; the baked strip is empty.
- Tell: ticks 2u wide scroll left at 6u/s, spaced 15u, colored good / bad / ink-3 by `st.trends[i]`.

## rec (B)
- Court ring R 26, centre dot r 3, four 6u posts at (19,19) (81,19) (19,81) (81,81), scoreboard slit 16x2 at y 23 on the top rim.
- Lit: 4u lamp squares on the posts at 60%.
- Tell: post `floor(t/2) % 4` at 100%; 3u ball on an ellipse (14 x 9) about the centre.

## hydro (B)
- Half-ellipse dome rx 35 ry 44 centred (50,62), planter 70x6 under it, four 4u crop rows fitted inside the dome (widths 44/52/58/62), ivory 50% highlight arc, 3u leaf tick at each row's left end.
- Lit: rows in grow light `#D9B8D0` at 60%; unpowered 30% (overrides the generic 50%).
- Tell: overlay alpha `.2 * (1 - cos(2pi t/4))` (0 -> .4), so the total breathes .6 -> 1 and adds nothing at phase 0.

## clinic (A)
- Bay 64x56 r 8 with an evenodd 28x28 cross cut-out (arms 10u) at (50,44), cross outlined ivory; ECG slit 40x6 at y 80; bed ticks 8x4 at (24,64) and (68,64).
- Lit: door lamp at (50,74). Status: the cross outline turns good while `flags.alert` (the HUD's 6s alert window after pirates/outbreak; the art cannot tell the two apart).
- Tell: 6-point beat polyline (1px lamp) sweeping the clipped slit once per second; the cross outline pulses 3u wide fading over the first quarter of each beat.

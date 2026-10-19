# Waystation

A browser space-station builder. You command a way station on the edge of interstellar space:
dock freighters, trade their cargo, keep the power on, tap your modules' banks, send expeditions
to chart new sectors, and grow one docking collar into a galactic gate. Then do it again in the
next star system.

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `site.css` | The landing page |
| `play/` | The game: `index.html` (HUD shell), `css/style.css` (design system), `js/*` (below) |
| `play/js/engine/` | The world renderer on PixiJS 8 (WebGL): stage, camera, space, station, traffic, fx, post, input, facade |
| `play/js/ui/` | The HUD: sound, formatting, overlays, panels, the `UI` facade |
| `play/js/data2.js`, `meta.js` | The meta-game: sectors, timers, banks, upgrades, expeditions, missions, daily rewards, rank, collection, Antimatter |
| `play/js/store.js` | In-app purchases: sandbox provider today, Stripe Checkout through `workers/store` when connected |
| `play/dev/` | Harnesses: `engine-preview.html`, `hud2-preview.html`, `sim-test.js` (node), `pixi-check.html`, art and ship previews; screenshots in `shots/` |
| `assets/` | Production images: `hero.png` (landing), `og.png` (link previews), app icons |
| `favicon.svg`, `site.webmanifest` | The Core Hub mark as a tab icon; install metadata |
| `404.html`, `_headers`, `robots.txt` | Not-found page (self-contained), cache and security headers for Cloudflare Pages / Netlify, crawl policy |
| `serve.js` | Dependency-free local server with a subpath mode |
| `tools/` | Screenshot and icon generators (headless Chrome via puppeteer-core; `npm install` inside `tools/`) |
| `DESIGN2.md` | The canonical v2 specification: visual language, world rendering, game design, HUD, store, sound |
| `DESIGN.md` | The v1 specification; its colour tokens (2), module art (8) and ship art (9) sections still apply |

## Run it

Needs Node.js (any recent version) for the local server only. No dependencies, no build step. PixiJS and
its filter pack load from a CDN; fonts from Google Fonts; everything else is local.

```bash
node serve.js
```

Open <http://localhost:8787/> for the landing page or <http://localhost:8787/play/> for the game.

To check relative links the way a GitHub Pages project site serves them (under `/waystation/`):

```bash
node serve.js --port 8788 --base waystation
```

(In Git Bash pass the prefix without a leading slash, or MSYS rewrites `/waystation` into a Windows path.)

## How it plays

- **Commission** a station on the title screen. The world fills the screen; the glass console floats over it.
- **Build** (B): pick a module, click a bracketed cell. The first three builds are instant; after that
  modules take real time to come online (45 s to an hour by tier). Skip a wait with Antimatter.
- **Banks**: modules earn credits per real minute into a local bank. A bobbing coin means it is ready:
  click it and the credits fly to the counter. Banks fill while you are away (up to their cap).
- **Ships** dock for fuel, repairs, food and trade, and pay on departure, as before. Residents move in when
  quality of life is high. Reputation and module count unlock the five station tiers.
- **Expeditions** (E): from a Docking Bay, send a survey to any sector. It returns after 10 to 120 minutes with
  goods, charts, Antimatter and discoveries for the Registry.
- **Galaxy** (G): eight sectors, each a full station with its own world and bias. Unlock with credits, charts
  and level, or with Antimatter. Credits are one wallet across all sectors; banks fill everywhere.
- **Missions** (J), **daily rewards**, **Commander rank** and the **Registry** (R) give you reasons to come back.
- **Antimatter** is the premium currency (violet). Earned by missions, dailies and expeditions; sold in the
  **Store**, which runs in sandbox (free, local) until Stripe is connected.

Keys: Space pause, 1/2/4 speed, B Build, S Station, M Market, F Fleet, E Expeditions, G Map, J Missions,
R Registry, Esc close or cancel, arrows and +/- camera, 0 fit, F focus, ? keys.

## Design

`DESIGN2.md` is the canonical specification for everything you see and do. Section 0 is the contract between
the simulation (`sim.js`, `meta.js`), the world engine (`js/engine`), the HUD (`js/ui`) and the store. The
visual language is "Bridge, Cinematic": holographic glass with chamfered frames and glowing spines over a
GPU-rendered space scene, original in geometry, palette and type.

## Saves, economy, tuning

The profile lives in `localStorage['waystation.profile.v2']` (export and import from Settings). A v1 save is
migrated into the home sector on first load. Timers are wall-clock. The shipped pacing curve is the `slow`
preset in `data2.js` (sable on day 1 or 2, thessaly by day 4, aurelia around day 25 at three 15-minute
sessions a day); `node play/dev/sim-test.js` prints the economy and pacing tables and runs 246 checks.

## Store and payments

Sandbox is the default: purchases are free, local and clearly labelled. To sell for real, deploy the
Cloudflare Worker in `workers/store` with your Stripe keys (its README walks through test mode and live mode),
then set `<meta name="waystation-store" content='{"mode":"stripe","apiBase":"https://…workers.dev"}'>` in
`play/index.html`.

## Hosting and caching

Everything is static. GitHub Pages (current): `.github/workflows/pages.yml` runs `scripts/dist.sh` and
publishes `dist/` (this folder minus the docs, the local server, `tools/` and `play/dev/`) on every push to
`main`; GitHub sends a fixed ten-minute cache. Cloudflare Pages / Netlify: build command `bash scripts/dist.sh`,
output `dist`; they read `_headers`. Absolute URLs appear only in the `canonical`, `og:url`, `og:image` and
`twitter:image` tags of `index.html` and `play/index.html`.

## Files

| File | What it holds |
| --- | --- |
| `play/index.html` | HUD shell: status bar, command rail, panel host, notices, context bar, overlays, title |
| `play/css/style.css` | Tokens, type, glass surfaces, spines, shelves, lozenges, every component |
| `play/js/data.js` | Modules, goods, planets, companies, ship classes, events, names |
| `play/js/data2.js` | Sectors and themes, missions, collection, expeditions, daily rewards, ranks, store catalog, tuning |
| `play/js/sim.js` | Station economy: ships, trade, residents, events, levels (per sector) |
| `play/js/meta.js` | Profile, wallet, Antimatter, banks, timers, upgrades, sectors, expeditions, missions, daily, rank, collection |
| `play/js/art.js`, `art-mod-a.js`, `art-mod-b.js` | Palette, icon library, the 24 procedural module drawings (baked to textures) |
| `play/js/ships.js` | Ship hull art (baked to textures) |
| `play/js/engine/*.js` | PixiJS world: `stage`, `camera`, `space`, `world`, `traffic`, `fx`, `post`, `input`, `index` (facade) |
| `play/js/ui/*.js` | `sound`, `format`, `overlays`, `panels`, `hud` (facade) |
| `play/js/store.js` | Catalog, providers, purchase, claim, restore |
| `play/js/main.js` | Boot order, title flow, frame loop, saving |
| `workers/store/` | Cloudflare Worker for Stripe Checkout, claims, webhooks, entitlements (repository root) |

# Waystation

A browser-based space station builder. You run a small way station on the edge of
interstellar space. Shipping companies haul cargo between planets and stop at your
docks for fuel, repairs, food and trade. Grow from one docking collar into a trading
hub, then a town with permanent residents, schools and a bank, and finally a galactic
gate for long-haul liners.

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `site.css` | The landing page: wordmark, pitch, screenshot, feature cards, module roster, PLAY |
| `play/` | The game: `index.html`, `css/style.css`, `js/*.js` (see "Files" below) |
| `play/dev/*.html` | Engineers' preview pages for icons, module art, ships and the HUD chrome (not published) |
| `assets/` | Production images: `hero.png` (landing), `og.png` (link previews), app icons |
| `favicon.svg`, `site.webmanifest` | The Core Hub mark as a tab icon; install metadata for "add to home screen" |
| `404.html` | Not-found page, self-contained so it works at any depth |
| `_headers` | Cache and security headers for Cloudflare Pages / Netlify (GitHub Pages ignores it) |
| `robots.txt` | Allows crawling |
| `serve.js` | Dependency-free local server, with a subpath mode for pre-deploy checks |
| `tools/shots.js` | Regenerates `assets/` with headless Chrome (needs `npm install` inside `tools/`) |
| `DESIGN.md` | The canonical visual specification ("Bridge Console: Keel & Shelf") |

## Run it

Needs Node.js (any recent version). No dependencies, no build step.

```bash
node serve.js
```

Then open <http://localhost:8787/> for the landing page or <http://localhost:8787/play/> for the game.
The game auto-saves to your browser every few seconds.

To check relative links the way a GitHub Pages project site serves them (under `/waystation/`):

```bash
node serve.js --port 8788 --base /waystation
```

You can also open `play/index.html` directly from disk in most browsers.

## How to play

- **Build tab**: pick a module, then click a glowing cell next to the station. Right-click or Esc to stop placing.
- **Docking Bays** take ships. Each bay needs one empty side so a ship can pull up to it. A red dot on a dock means the berth is blocked.
- **Warehouses** hold cargo. Ships sell what their home world exports into your stores, and buy what it imports.
- **Power** matters. If used power exceeds produced power, everything runs worse. Solar Arrays are cheap but go dark in solar flares; Reactors do not.
- **Crews** need beds (Crew Quarters), food (Cantina, Hydroponics) and fun (Rec Deck, Promenade, Menagerie). Happy crews spend more and rate you higher.
- **Reputation** (the stars) brings more ships and unlocks higher tiers along with your module count.
- **Residents** move in once you build Residential Habitats and quality of life is above 55%. They pay rent, and with a Promenade they run businesses. An Academy doubles growth; a Med Bay stops outbreaks.
- **Companies** gain trust when their ships are served quickly. At 75 trust they open an office on the station. With a Mercantile Bank you can lend them credits at interest.
- **Market tab**: with a Trade Exchange you can turn Buy or Sell off per good. Keep Raw Ore for a Refinery, keep Xenofauna for a Menagerie.
- **Events** arrive every few days: flares, pirate raids, trade booms, refugee convoys, contracts and more.

Keys: Space pauses, 1/2/4 set speed, B opens Build, M opens Market, Esc cancels.

## Design

`DESIGN.md` is the canonical visual specification ("Bridge Console: Keel & Shelf"). Section 0 is the
contract between the renderer and the HUD; change it there first, then in code. The landing page and
the 404 page reuse its tokens, type roles, keels, shelves and lozenges from a standalone `site.css`;
the game's own stylesheet is `play/css/style.css`. The landing page's icons are an inline SVG sprite
generated from the `ICONS` library in `play/js/art.js`, so they always match the game.

## Hosting and caching

Everything is static. Fonts come from Google Fonts; every other request is a local file, so any
static host works and every link is relative (the game runs fine from a subpath).

- **GitHub Pages** (current): `.github/workflows/pages.yml` at the repository root runs `scripts/dist.sh`
  and publishes `dist/` on every push to `main`. `dist/` is this folder minus `DESIGN.md`, `README.md`,
  `serve.js`, `tools/` and `play/dev/`. GitHub Pages serves `404.html` for unknown paths and sends a fixed
  `Cache-Control: max-age=600`, so a deploy is fully visible to returning players within ten minutes.
- **Cloudflare Pages / Netlify**: build command `bash scripts/dist.sh`, output directory `dist`. Both read
  `_headers`: HTML revalidates on every visit, JS and CSS are held ten minutes, images and icons a week.
  Nothing is fingerprinted, so keep code lifetimes short; if a release ever changes `play/index.html` and a
  script together in an incompatible way, add `?v=N` to the script tags for that release.
- **Absolute URLs** appear only in the `canonical`, `og:url`, `og:image` and `twitter:image` tags of
  `index.html` and `play/index.html`. Update them when the site moves to its own domain.
- **Images**: `tools/shots.js` stages a mid-game station and renders `assets/hero.png`, `assets/og.png` and the
  icon PNGs with the system Chrome. Run `npm install` in `tools/` once, start `serve.js` in subpath mode, then
  `node tools/shots.js http://localhost:8788/waystation/ assets`.

## Files

| File | What it holds |
| --- | --- |
| `play/index.html` | Page shell: top rail, canvas, sidebar panels, title screen, modal |
| `play/css/style.css` | Design tokens, type, keel-and-shelf chrome, every component |
| `play/js/data.js` | Modules, goods, planets, companies, ship classes, events |
| `play/js/sim.js` | Simulation: economy, ships, residents, events, save/load |
| `play/js/art.js` | Palette loader, families, icon library (SVG paths), drawing helpers, `ART` registry |
| `play/js/art-mod-a.js` | Canvas art for the first 12 modules (hub through clinic) |
| `play/js/art-mod-b.js` | Canvas art for the other 12 modules (habitat through jump gate) |
| `play/js/fx.js` | Particle pool: sparks, motes, rings, exhaust |
| `play/js/ships.js` | Ship hull sprites, livery, engine bloom, nav lights, hold plates |
| `play/js/render.js` | The world: background, grid, trusses, module sprites, placement, selection, floaters |
| `play/js/ui.js` | Sidebar panels, top rail readouts, tooltips, modal, toasts, hints, onboarding |
| `play/js/main.js` | Startup, title screen, input, body state, game loop |

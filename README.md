# Waystation

A browser-based space station builder. The game, its landing page and the production assets live in
[`waystation/`](waystation/README.md); that folder is what gets published.

- `waystation/index.html` is the landing page, `waystation/play/` is the game.
- `waystation/DESIGN2.md` is the canonical specification (visuals, world engine, meta-game, HUD, store); `workers/store/` is the Stripe payment backend (Cloudflare Worker).
- `workers/push/` is the push-notification backend (Cloudflare Worker with a 1-minute cron): opt-in browser notifications when a build, upgrade, expedition or plot clearing finishes while the tab is closed. Its README walks the owner through the setup.
- `scripts/dist.sh` assembles `dist/` for a static host (drops the docs, the local server and the dev previews).
- `.github/workflows/pages.yml` publishes `dist/` to GitHub Pages on every push to `main`.

Local play: `node waystation/serve.js`, then open <http://localhost:8787/>.

Copyright © 2026. All rights reserved. The source is public so the game can be played and reviewed; it is not licensed for reuse or redistribution.

# Port Solace

A browser-based space station builder, live at <https://portsolace.com/>. The game, its landing page and the production assets live in
[`waystation/`](waystation/README.md); that folder is what gets published.

- `waystation/index.html` is the landing page, `waystation/play/` is the game.
- `waystation/DESIGN2.md` is the canonical specification (visuals, world engine, meta-game, HUD, store); `workers/store/` is the Stripe payment backend (Cloudflare Worker).
- `workers/push/` is the push-notification backend (Cloudflare Worker with a 1-minute cron): opt-in browser notifications when a build, upgrade, expedition or plot clearing finishes while the tab is closed. Its README walks the owner through the setup.
- `scripts/dist.sh` assembles `dist/` for a static host (drops the docs, the local server and the dev previews).
- `.github/workflows/pages.yml` publishes `dist/` to GitHub Pages on every push to `main`.

Local play: `node waystation/serve.js`, then open <http://localhost:8787/>.

The game was first released as Waystation. The repository (`joshanderson051/waystation`), its `waystation/` folder and the
Cloudflare Worker names and `*.workers.dev` URLs keep the old name on purpose: renaming them would break live payments,
password resets and push subscriptions.

## Domains

`portsolace.com` is registered at Cloudflare, which also runs its DNS.

- **The site.** `https://portsolace.com/` is served by GitHub Pages; the custom domain is set in this repository's
  Settings > Pages with HTTPS enforced. DNS: four apex `A` records (185.199.108.153, 185.199.109.153, 185.199.110.153,
  185.199.111.153), four apex `AAAA` records (2606:50c0:8000::153, 2606:50c0:8001::153, 2606:50c0:8002::153,
  2606:50c0:8003::153) and a `www` `CNAME` to `joshanderson051.github.io`, all DNS only (grey cloud), so GitHub can issue
  the certificate. `www.portsolace.com` redirects to the apex. The old address, `joshanderson051.github.io/waystation/`,
  redirects to `portsolace.com`.
- **The APIs.** Each Worker answers on its own subdomain through a Workers custom domain (`routes` in its `wrangler.toml`):
  `account.portsolace.com` (accounts and cloud saves), `push.portsolace.com` (notifications) and `store.portsolace.com`
  (Stripe). Cloudflare creates those DNS records itself. The `*.workers.dev` addresses keep working; Stripe's webhook stays
  on the store's `workers.dev` URL.
- **Deploy order.** The game calls those three subdomains, and they exist only once each Worker is deployed with its
  `routes` line. So: (1) `npx wrangler deploy` in `workers/account`, `workers/push` and `workers/store`; (2) check that
  `https://{account,push,store}.portsolace.com/health` each answer 200; (3) only then push the site. If the site has to
  ship first, keep the `*.workers.dev` `apiBase` values in the three `<meta name="portsolace-…">` tags of
  `waystation/play/index.html` until the subdomains answer.
- **Email.** Account mail (password resets) goes through Resend from `noreply@portsolace.com`, once the domain is verified
  in Resend (its SPF and DKIM records go into Cloudflare DNS). Until then the account Worker falls back to Resend's
  `onboarding@resend.dev`. A `_dmarc` TXT record (`v=DMARC1; p=none; ...`) is published for the domain.
- **Moving players.** Saves are kept per address, so a station saved on the old address without an account does not appear
  on the new one by itself. The game copies its pre-rebrand storage keys to the new names on load, and "Bring your station
  from the old address" (title screen and Settings) passes a save across through a small page at
  `joshanderson051.github.io/move/`. DESIGN2.md Addendum A8 has the details.

## Port Authority

Port Authority is the owner's player portal at <https://portsolace.com/admin/> (`waystation/admin/`, not indexed by
search engines). Sign in with the owner's Port Solace account: its email must be listed in `ADMIN_EMAILS` in
`workers/account/wrangler.toml` and its account id in the `ADMIN_USER_IDS` secret (an email alone admits nobody,
because sign-up does not verify addresses; `workers/account/README.md` "Port Authority" has the one-time setup, which
the lead does before the first deploy, and the rule never to delete the owner's account); if the game on the same browser is already signed in
with that account, it offers "Continue as". Anyone else gets "This account is not a Port Authority admin." The sign-in
lasts until the tab closes.

- **See who is playing.** Every game reports in (its random player id, station name, day, level, rank, credits,
  Antimatter, platform; the email only when the game is signed in to an account), so anonymous players appear too. The
  overview shows players and how many were active in the last 24 hours, 7 days and 30 days; the table searches by
  station, email or player id, filters by activity, sorts and pages, and refreshes itself every 60 seconds.
- **Give credits or Antimatter.** Open a player, fill in **Send a gift** (credits up to 10,000,000, Antimatter up to
  100,000, an optional note the player sees), confirm, and the gift reaches the player within 10 minutes of play: their
  game picks it up at its next check-in and shows a "Port Authority" message. A gift can be revoked until the game has
  applied it. Each player's gift history, store purchases and an admin log of every gift and revoke are on the page.
- **Setup.** It needs the account Worker deployed with its D1 database (`portsolace`, migrations in
  `workers/account/migrations/`) and the game update that reports presence. DESIGN2.md Addendum A9 is the specification.
  To try it against a local Worker, set `localStorage["portsolace.account.config"] = '{"apiBase":"http://localhost:<port>"}'`
  on the page's origin and add that origin to the Worker's `ALLOWED_ORIGIN`.

Copyright © 2026. All rights reserved. The source is public so the game can be played and reviewed; it is not licensed for reuse or redistribution.

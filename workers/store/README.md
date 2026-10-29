# Port Solace store backend

This folder is the small server that lets the game sell Antimatter packs, boosts, the Sector Pass and
cosmetics for real money. It runs as a **Cloudflare Worker** (free tier is plenty) and talks to **Stripe
Checkout** (Stripe's hosted payment page, so no card numbers ever touch this code or the game).

You do not need to be a developer to set it up. Each step below tells you exactly what to type or click.
Budget about 45 minutes the first time. Do everything in Stripe **test mode** first; going live is a short
repeat at the end.

Until this backend exists, the game runs in **sandbox mode**: the Store panel works, nothing is charged,
and purchases are stored in the player's browser only. The game decides which mode it is in from one line
in `waystation/play/index.html` (step 9).

> **Status (29 October 2026): live, real payments.** Steps 0 to 10 are done. The worker at
> <https://waystation-store.waystation-store-worker.workers.dev> (KV namespace
> `d3f64a0e3dda4eaa83808326a71471f2`) runs on the **live** keys of the **Prime Signal Marketing LLC** Stripe
> account (`acct_1T48AICn9alqZLnN`). That account holds the nine live products and prices (their ids are in
> `wrangler.toml`) and the live webhook destination `we_1UVxC8Cn9alqZLnNvwQepPSI`. Buyers' card statements
> show that account's statement descriptor.
>
> The test-mode setup of 19 October lives in a **different** Stripe account, the "New business" sandbox
> (`acct_1USITjFL8R957E3x`, webhook `we_1USIelFL8R957E3xfYBBXiGp`); its test price ids are in the table in
> step 1. To try changes with test cards, run the worker locally with that sandbox's `sk_test_…` key in
> `.dev.vars` and the test price ids (see "Local testing" below) instead of switching the deployed worker back.
>
> **Port Solace domain.** The game is at <https://portsolace.com/play/> and calls this worker at
> <https://store.portsolace.com> (a Cloudflare custom domain, the `routes` line in `wrangler.toml`). The
> `workers.dev` address above keeps working, and the live Stripe webhook stays pointed at it
> (`…workers.dev/webhook`): do not move it.

The old internal names (the Worker script `waystation-store`, its `waystation-store-worker` workers.dev
subdomain, the `service` that `/health` reports and the repository folders) stay on purpose: renaming them
would create a new Worker and break the live Stripe webhook.

---

## What you get

| Piece | Where | What it does |
|---|---|---|
| Worker | `src/index.js` | Six small web endpoints: `/checkout`, `/claim`, `/webhook`, `/entitlements`, `/restore`, `/health` |
| Settings | `wrangler.toml` | Names the worker, binds the KV store, lists allowed site origins and the Stripe price ids |
| Tests | `test/store.test.js` | `npm test` runs them locally with a fake Stripe; no account needed |
| Game client | `../../waystation/play/js/store.js` | The `Store` object the game uses; already written, you only flip its mode |

How a purchase works once everything is connected:

1. The player clicks Buy. The game asks the worker for a Checkout page (`POST /checkout`).
2. The worker asks Stripe to create a Checkout Session for that item and sends the page link back.
3. The player pays on Stripe's page and is sent back to the game with `?purchase=success&session_id=…`.
4. The game asks the worker to **claim** that session (`GET /claim`). The worker checks with Stripe that it
   is paid, records the grant in KV (so it can only be granted once) and tells the game what to give.
5. Independently, Stripe also calls the worker's `/webhook` when a payment completes, so the purchase is
   recorded even if the player closed the tab before step 4. "Restore purchases" in the game's Settings
   re-applies everything recorded for that player.

---

## 0. Before you start

- A computer with **Node.js 18 or newer** (<https://nodejs.org>, pick the LTS download). Check with
  `node --version` in a terminal.
- A **Stripe account**: <https://dashboard.stripe.com/register>. For test mode you do not need to finish
  business verification.
- A **Cloudflare account** (free): <https://dash.cloudflare.com/sign-up>. No domain is required; the
  worker gets a free `*.workers.dev` address. The live address `store.portsolace.com` needs the
  `portsolace.com` zone on the same Cloudflare account (it is: the domain was bought through Cloudflare).
- A terminal. On Windows use PowerShell or Git Bash; on macOS use Terminal.

Open a terminal in this folder and install the one developer tool (Cloudflare's `wrangler`):

```sh
cd workers/store
npm install
npm test
```

`npm test` should end with `fail 0`. It runs entirely on your computer.

---

## 1. Create the nine products in Stripe (test mode)

1. Open <https://dashboard.stripe.com> and make sure you are in test mode. Stripe now calls this a
   **Sandbox**: the top-left corner says "Sandbox" and a banner says "You're testing in a sandbox". If you
   see your real business name there instead, use the switch at the top right to go back to the sandbox.
2. Go to **Product catalog** (left menu) and click **Create product**. For each row below:
   - **Name** and **Description**: as in the table (the player sees them on the Stripe page).
   - **Pricing**: click **One-off** (not Recurring). **Amount**: as in the table, currency USD.
   - Click **Add product**. Then open the product from the list: the **Price ID** (`price_1…`) is shown in
     the price row and in the Events list at the bottom of the product page. Write it next to the sku.

| sku | Product name | Description | Price | Test-mode Price ID (done 19 Oct 2026) |
|---|---|---|---|---|
| `am_50` | Antimatter · 50 | A vial of violet light. | $1.99 | `price_1USIUoFL8R957E3xoCDdGRhG` |
| `am_140` | Antimatter · 140 | 125 plus 15 bonus. | $4.99 | `price_1USIVmFL8R957E3xY727d9Tq` |
| `am_320` | Antimatter · 320 | 250 plus 70 bonus. | $9.99 | `price_1USIWiFL8R957E3xHHfCmtXA` |
| `am_900` | Antimatter · 900 | 500 plus 400 bonus. | $24.99 | `price_1USIYfFL8R957E3xPbSgJbd4` |
| `credits_s` | Supply Run | Two hours of your total station rate, at least 10,000 credits. | $1.99 | `price_1USIYuFL8R957E3xAkDJSeI7` |
| `credits_l` | Trade Fleet | Eight hours of your total station rate, at least 40,000 credits. | $5.99 | `price_1USIZ9FL8R957E3x6XXal2Iw` |
| `sector_pass` | Sector Pass | Every sector unlocked for this profile. No charts needed. | $9.99 | `price_1USIZNFL8R957E3xOORrW8Kr` |
| `founder` | Founder's Livery | Ivory-amber station strip, the title Founder, and 100 Antimatter. | $4.99 | `price_1USIZcFL8R957E3xlP8au1s6` |
| `liveries` | Sector Liveries | The six sector liveries for your station strip. | $2.99 | `price_1USIZsFL8R957E3xfXhXhx1o` |

The sku on the left is fixed: it is how the game names each item. Names, descriptions and prices match
`STORE_CATALOG` in `waystation/play/js/data2.js`; if you change them in Stripe, change them there too.
The Price IDs above are **test-mode** ids; live mode gets its own set (step 10).

3. Get your **test secret key**: **Developers → API keys** (or open
   <https://dashboard.stripe.com/test/apikeys>). In the **Secret key** row click the small copy icon after
   the token; it copies the `sk_test_…` key. Keep it private; you will paste it in step 5.

---

## 2. Fill in `wrangler.toml`

Open `workers/store/wrangler.toml` in any text editor.

- In the `PRICES` block replace each `price_REPLACE_…` with the Price ID you copied. Keep the quotes and
  commas exactly as they are. The block must stay valid JSON (no trailing comma after the last line).
- `ALLOWED_ORIGIN` already contains the live site, `https://portsolace.com` and `https://www.portsolace.com`,
  and the old GitHub Pages origin `https://joshanderson051.github.io`, kept while players move over. If the
  game is served from another domain, add it; separate several origins with commas and never add a trailing
  slash or a path.

---

## 3. Log in to Cloudflare and create the KV store

In the terminal (still in `workers/store`):

```sh
npx wrangler login
```

A browser window asks you to allow Wrangler; click **Allow** straight away (the request expires after a
couple of minutes; if the terminal says "Timed out waiting for authorization code", run the command again).

On Windows PowerShell `npx` may be refused with "running scripts is disabled on this system". Type `npx.cmd`
instead of `npx` in every command in this guide; nothing else changes.

Then create the key-value namespace that stores the grants:

```sh
npx wrangler kv namespace create STORE
```

It prints a block like:

```toml
[[kv_namespaces]]
binding = "STORE"
id = "0f2a6c1e9b7d4e5f8a3c2b1d0e9f8a7b"
```

Copy the `id` value into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

---

## 4. Deploy the worker for the first time

```sh
npm run deploy
```

The last lines show the worker's address, something like
`https://waystation-store.<your-subdomain>.workers.dev`. Write it down; it is used in steps 6 and 9.

Open `https://waystation-store.<your-subdomain>.workers.dev/health` in a browser. You should see JSON
with `"stripe": "missing"` (we add the key next), `"kv": true` and `"prices": {"count": 9, …}`. If the
count is not 9, a Price ID in `wrangler.toml` is misspelled (they must start with `price_`).

The same deploy attaches the custom domain from the `routes` line in `wrangler.toml`: Cloudflare creates the
DNS record and the certificate for `store.portsolace.com` (the first time can take a few minutes). Check it
at <https://store.portsolace.com/health>. If the deploy says the zone was not found, `portsolace.com` is not
on the Cloudflare account you are logged in to (`npx wrangler whoami`). Use the `workers.dev` address for the
webhook in step 6 either way.

---

## 5. Add the Stripe secret key

```sh
npx wrangler secret put STRIPE_SECRET_KEY
```

Paste the `sk_test_…` key when asked and press Enter. Nothing is shown while you paste; that is normal.
Secrets live only in Cloudflare, never in this folder or in git. Reload `/health`: it now says
`"stripe": "test"`.

---

## 6. Tell Stripe where the webhook is

1. Stripe dashboard (sandbox) → **Developers → Webhooks** (or open
   <https://dashboard.stripe.com/test/workbench/webhooks>) → **Add destination**.
2. Leave **Your account** and **Snapshot** selected. In the event search box type `checkout.session` and tick
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`

   then click **Continue**.
3. Destination type **Webhook endpoint** → **Continue**.
4. **Endpoint URL**: `https://waystation-store.<your-subdomain>.workers.dev/webhook`. Give it a name such as
   `waystation-store` and click **Create destination**.
5. On the destination page, under **Signing secret**, click the eye icon to reveal the `whsec_…` value and
   copy it. Back in the terminal:

   ```sh
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

   Paste the `whsec_…` value. `/health` now shows `"webhookSecret": true`.

The webhook is a safety net: if a player pays and closes the tab before returning to the game, the
purchase is still recorded and "Restore purchases" will apply it.

---

## 7. Check the worker from the terminal (optional)

```sh
curl "https://waystation-store.<your-subdomain>.workers.dev/health"
curl -X POST "https://waystation-store.<your-subdomain>.workers.dev/checkout" \
     -H "content-type: application/json" \
     -d "{\"sku\":\"am_50\",\"playerId\":\"test-player-0001\",\"returnUrl\":\"https://portsolace.com/play/\"}"
```

The second command answers with `{"id":"cs_test_…","url":"https://checkout.stripe.com/…","sku":"am_50"}`.
Opening that `url` shows the Stripe test checkout page. (`returnUrl` must be on an origin listed in
`ALLOWED_ORIGIN`, otherwise you get `bad-return-url`.)

---

## 8. Test a purchase end to end (test mode)

You can do this before changing the live site by using the override the game client offers:

1. Open the game at <https://portsolace.com/play/>.
2. Open the browser console (F12 → Console) and paste, with your worker address:

   ```js
   localStorage.setItem('portsolace.store', JSON.stringify({ mode: 'stripe', apiBase: 'https://waystation-store.<your-subdomain>.workers.dev' }));
   location.reload();
   ```

3. Open the Store panel and buy an Antimatter pack. On Stripe's page use the test card
   **4242 4242 4242 4242**, any future expiry, any CVC, any postcode, any email.
4. You are sent back to the game; the Antimatter arrives and the purchase shows in Stripe under
   **Payments**.
5. Remove the override when you are done: `localStorage.removeItem('portsolace.store'); location.reload();`

The override only affects your own browser. Everyone else is still in sandbox mode until step 9.

---

## 9. Switch the game to the worker

In `waystation/play/index.html` the `<head>` holds one line that tells the game which mode to use:

```html
<meta name="portsolace-store" content='{"mode":"sandbox"}'>
```

Change it to (keep the single quotes around the JSON and the double quotes inside):

```html
<meta name="portsolace-store" content='{"mode":"stripe","apiBase":"https://store.portsolace.com"}'>
```

(The `*.workers.dev` address works there too, for example before the custom domain is attached.)

Also update the sentence under **Antimatter** on the landing page (`waystation/index.html`, the
`<p class="fine">` line) so it describes the real state of the store.

Commit and push to `main`. GitHub Pages redeploys within a minute or two. The "Test mode" ribbon in the
Store panel disappears and purchases go through Stripe. While your Stripe key is a **test** key, players
can only pay with test cards, which is exactly what you want for a final check.

---

## 10. Go live

Only when you are happy with the test run:

1. **Activate your Stripe account** (Stripe asks for business and bank details; this is Stripe's process,
   not ours). Until it is activated live payments are refused.
2. Switch the Stripe dashboard to **Live mode** (toggle off "Test mode"). Repeat **step 1**: create the same
   nine products in live mode (Stripe can also copy products from test to live from the product page).
   Live Price IDs are different from the test ones.
3. Put the live Price IDs into `PRICES` in `wrangler.toml`.
4. Repeat **step 6** in live mode to create a live webhook endpoint (same URL, same two events) and note its
   new `whsec_…` secret.
5. Replace both secrets with the live values:

   ```sh
   npx wrangler secret put STRIPE_SECRET_KEY        # paste sk_live_…
   npx wrangler secret put STRIPE_WEBHOOK_SECRET    # paste the live whsec_…
   ```

6. Deploy again: `npm run deploy`. `/health` should now say `"stripe": "live"`.

   **Switching keys without a gap.** `wrangler secret put` deploys the moment you press Enter, so for a few
   minutes the live key would meet test price ids and every purchase would fail. To switch in one step instead
   (this is how it was done on 29 October 2026), stage the secrets on a new version, then upload and deploy:

   ```sh
   npx wrangler versions secret put STRIPE_SECRET_KEY       # paste sk_live_…  (staged, not live yet)
   npx wrangler versions secret put STRIPE_WEBHOOK_SECRET   # paste the live whsec_…
   npx wrangler versions upload                             # live PRICES from wrangler.toml, keeps the staged secrets
   npx wrangler versions deploy <version id it printed>@100% -y
   ```

   Use the same commands whenever you roll a key later. On Windows PowerShell type `npx.cmd` instead of `npx`.
7. Make one small real purchase yourself and refund it from the Stripe dashboard to confirm the loop.
8. On the landing page (`waystation/index.html`) replace the "still runs in Stripe's test mode" sentence
   under **Antimatter** with one that says purchases are real, and push.

The game's `<meta>` tag does not change between test and live; only the worker's secrets and price ids do.
Keep the test-mode products and the test webhook destination: they are what you use to try changes later.

**Tax codes.** Products created in the Prime Signal account took that account's default tax code
(`txcd_20060002`, shown as "Advertising Services"). Checkout does not compute tax today (no
`automatic_tax`), so nothing is charged differently, but if you turn on Stripe Tax, first set each product's
tax code to a digital-goods or video-game code your accountant agrees with.

---

## Day-to-day

- **Logs**: `npm run tail` streams live requests, or use the Cloudflare dashboard → Workers → waystation-store → Logs.
- **Refunds**: refund in the Stripe dashboard. The game does **not** remove Antimatter or passes automatically
  after a refund; this is deliberate (the player may have spent it). Delete the KV key `grant:<session id>`
  in the Cloudflare dashboard if you want "Restore purchases" to stop re-applying that item.
- **Card statements**: every Checkout Session sends `payment_intent_data[statement_descriptor_suffix]` =
  `PORTSOLACE` (`STATEMENT_SUFFIX` in `src/index.js`), so buyers' statements read `PRIME SIGN* PORTSOLACE`
  rather than only the LLC's name, which heads off "I don't recognise this charge" disputes. `PRIME SIGN` is the
  account's shortened descriptor (Stripe dashboard → Settings → Business → Public details). Prefix, `* ` and
  suffix together may not exceed 22 characters, so the suffix stays at 10 or fewer while the prefix is 10.
- **Prices**: change the amount in Stripe (this creates a new Price ID), update `PRICES`, deploy. Also ask
  the game's maintainer to update the catalog text (`STORE_CATALOG` in `waystation/play/js/data2.js`).
- **Costs**: Cloudflare's free plan allows 100,000 requests per day; a purchase uses two or three. Stripe
  charges its usual per-transaction fee.

---

## Local testing against a worker on your own machine (for developers)

```sh
# in workers/store: secrets for the local worker (file is git-ignored)
printf 'STRIPE_SECRET_KEY=sk_test_...\nSTRIPE_WEBHOOK_SECRET=whsec_...\n' > .dev.vars
npm run dev                       # wrangler dev on http://127.0.0.1:8788
```

Add the game's local origin to `ALLOWED_ORIGIN` (for example `http://localhost:8794`) while testing, then
serve the game (`node waystation/serve.js --port 8794 --base waystation` from the repository root; in Git
Bash prefix it with `MSYS_NO_PATHCONV=1`) and set the override in the game's browser console:

```js
localStorage.setItem('portsolace.store', JSON.stringify({ mode: 'stripe', apiBase: 'http://127.0.0.1:8788' }));
```

The game's own local server also defaults to port 8787, which is Wrangler's default too; that is why
`npm run dev` uses 8788. To test the webhook locally, use the Stripe CLI:
`stripe listen --forward-to http://127.0.0.1:8788/webhook` and put the `whsec_` it prints into `.dev.vars`.

---

## Endpoint reference

All responses are JSON. Errors look like `{"error":"code","message":"what went wrong"}`.

| Method and path | Query / body | Success | Errors |
|---|---|---|---|
| `GET /health` | – | configuration summary, no secrets | – |
| `POST /checkout` | `{sku, playerId, returnUrl}` | `{id, url, sku}` | 400 `unknown-sku`, `bad-player`, `bad-return-url`, `bad-json`; 500 `config`; 502 `stripe` |
| `GET /claim` | `session_id`, `playerId` | `{sku, granted:true, grantId, playerId, duplicate}` | 400 `bad-session`/`bad-player`; 402 `unpaid`; 403 `player-mismatch`; 404 `no-session`; 409 `no-sku` |
| `POST /webhook` | Stripe event, `Stripe-Signature` header | `{received:true, granted, duplicate}` or `{received:true, ignored:true}` | 400 `bad-signature`, `bad-json`; 500 `config` |
| `GET /entitlements` | `playerId` | `{playerId, grants:[{grantId, sku, at}]}` | 400 `bad-player` |
| `GET /restore` | `email`, `playerId` | `{playerId, email, found, otherProfile, newlyGranted, grants}` | 400 `bad-email`/`bad-player`; 502 `stripe` |

KV layout: `grant:{sessionId}` → `{sku, playerId, at}`; `player:{playerId}` → `[grantId, …]`.
Grants are keyed by the Stripe Checkout Session id, so claiming, the webhook and restore can all run for the
same payment and it is still granted once.

### How "Restore purchases" works, and its limits

- Without an email the game calls `/entitlements` and re-applies every grant recorded for the player id.
  This is what a player needs after clearing their browser **if they exported and imported their profile**
  (the profile carries the player id).
- With an email the worker also asks Stripe for paid Checkout Sessions made with that email and records any
  that were never claimed **for this player id**. Stripe matches the exact email typed at checkout, and only
  the most recent 100 sessions for that email are scanned. Sessions that belong to a different player id
  are counted in `otherProfile` but never transferred: to move purchases to a new device, export the
  profile from the game's Settings panel and import it there. This keeps purchases from being claimed by
  anyone who merely knows the buyer's email.

### Security notes

- Secrets are only ever set with `wrangler secret put` (or `.dev.vars` locally, which is git-ignored).
- Browsers may call the worker only from the origins in `ALLOWED_ORIGIN` (CORS), and `returnUrl` must be on
  one of those origins, so the worker cannot be used to send players to another site.
- Webhook payloads are verified with Stripe's signature scheme (HMAC-SHA256, 5-minute replay window,
  constant-time comparison).
- The player id is a random UUID the game creates; it is not personal data. Emails are passed through to
  Stripe for `/restore` and never stored by the worker.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Store panel says "Test mode" after step 9 | The `<meta>` JSON is invalid or `apiBase` is missing. The game then falls back to sandbox. Check the quotes. |
| Browser console shows a CORS error | The game's origin is not in `ALLOWED_ORIGIN`. Add it (no trailing slash), deploy. |
| `/checkout` answers `unknown-sku` | That sku has no valid `price_…` id in `PRICES`. `/health` lists the skus it knows. |
| `/checkout` answers 502 "No such price" | A Price ID is from the wrong mode (test vs live) or mistyped. |
| Webhook shows failures in Stripe | Wrong `STRIPE_WEBHOOK_SECRET` (each endpoint has its own), or the endpoint URL is not `/webhook`. |
| Player paid but got nothing | Open **Payments** in Stripe, copy the Checkout Session id (`cs_…`) and call `/claim?session_id=…&playerId=…` with the player id from their profile export; or have them use Restore purchases. |

# Port Solace push notifications backend

This folder is the small server that tells a player **their build, upgrade, expedition or plot clearing has
finished while the game tab was closed**, and optionally reminds them of the daily reward. It runs as a
**Cloudflare Worker** (free tier is enough) with a tiny key-value store and a job that wakes up once a minute.
Notifications go through the browser's own push service (Google's for Chrome, Mozilla's for Firefox, Apple's
for Safari); this code never sees anything but a random player id, an opaque delivery address and the text of
the notification.

You do not need to be a developer to set it up. Each step says exactly what to type or click. Budget about
20 minutes.

Until this backend exists, the switch in the game's Settings panel reads **Not connected** and does nothing.
Players opt in themselves; nobody is ever asked for notification permission before they flip the switch.

**The live setup.** The game is at <https://portsolace.com/play/> and this worker answers at
<https://push.portsolace.com> (a Cloudflare custom domain, the `routes` line in `wrangler.toml`). Its
`*.workers.dev` address keeps working too and is what the first-time steps below use. `VAPID_SUBJECT` is
`https://portsolace.com/`.

The old internal names (the Worker script `waystation-push`, the `service` that `/health` reports, the
`workers.dev` address and the repository folders) stay on purpose: renaming them would create a new Worker
and drop every player's subscription.

---

## What you get

| Piece | Where | What it does |
|---|---|---|
| Worker | `src/index.js` | Five small web endpoints (`/health`, `/key`, `/subscribe`, `/schedule`, `/unsubscribe`) and the once-a-minute cron |
| Web Push | `src/webpush.js` | Encrypts and signs each notification (RFC 8291 and RFC 8292) with the browser's WebCrypto; no libraries |
| Settings | `wrangler.toml` | Names the worker, binds the KV store, lists the allowed site origins and the public key |
| Key maker | `scripts/vapid-keys.mjs` | `npm run keys` prints the key pair the push services require |
| Tests | `test/*.test.js` | `npm test` runs 60 checks locally, including the game client; no account needed |
| Game client | `../../waystation/play/js/notify.js`, `../../waystation/play/sw.js` | The `Notify` object and the service worker that shows the notification; already written, you only flip one tag |

How it works once everything is connected:

1. The player switches **Notify me when something finishes** on in Settings. The browser asks them to allow
   notifications. The game registers `play/sw.js`, subscribes to push with your public key and sends the
   subscription to the worker (`POST /subscribe`), which answers with a private token for that browser.
2. Whenever the player's pending timers change (a build placed, an expedition launched, a tab closed), the game
   sends the whole list once (`POST /schedule`): id, kind, title and the time each one finishes.
3. Every minute the worker's cron looks at what is due, encrypts a short message for each player with
   something finished and hands it to that player's push service. Timers it has announced are deleted.
4. The browser wakes `sw.js`, which shows the notification. Clicking it brings the open game tab to the front
   or opens `/play/`.

---

## 0. Before you start

- A computer with **Node.js 20 or newer** (<https://nodejs.org>, pick the LTS download). Check with
  `node --version` in a terminal.
- A **Cloudflare account** (free): <https://dash.cloudflare.com/sign-up>. If you already set up the store
  worker, you have one.
- A terminal. On Windows use PowerShell or Git Bash; on macOS use Terminal.

Open a terminal in this folder and install the one developer tool (Cloudflare's `wrangler`):

```sh
cd workers/push
npm install
npm test
```

`npm test` should end with `fail 0`. It runs entirely on your computer.

---

## 1. Make the key pair

Push services require every sender to prove who they are with a key pair ("VAPID" keys). Make yours once:

```sh
npm run keys
```

It prints a **public key** (one long line starting with `B`) and a **private key**. Open `wrangler.toml` and
replace `REPLACE_WITH_VAPID_PUBLIC_KEY` with the public key, keeping the quotes. Keep the private key in the
terminal window for step 4. Do not paste it into any file in this folder.

Treat the pair as permanent: if you ever generate a new one, every player's subscription silently stops
working until they switch notifications off and on again.

---

## 2. Log in to Cloudflare

```sh
npx wrangler login
```

A browser window asks you to allow Wrangler; click **Allow**. If you did this for the store worker on the same
computer you are already logged in and the command just says so.

---

## 3. Create the KV store

```sh
npx wrangler kv namespace create PUSH
```

It prints a block like:

```toml
[[kv_namespaces]]
binding = "PUSH"
id = "0f2a6c1e9b7d4e5f8a3c2b1d0e9f8a7b"
```

Copy the `id` value into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

---

## 4. Store the private key

```sh
npx wrangler secret put VAPID_PRIVATE_KEY
```

Paste the private key from step 1 when asked and press Enter. Nothing is shown while you paste; that is
normal. Secrets live only in Cloudflare, never in this folder or in git.

---

## 5. Deploy

```sh
npm run deploy
```

The last lines show the worker's address, something like
`https://waystation-push.<your-subdomain>.workers.dev`, and confirm the cron (`* * * * *`). Write the address
down; it is used in step 6.

Open `https://waystation-push.<your-subdomain>.workers.dev/health` in a browser. You should see JSON with
`"vapid": {"publicKey": "ok", "privateKey": "set", …}` and `"kv": true`. If `publicKey` says `missing` or
`invalid`, step 1 was not pasted completely; if `privateKey` says `missing`, repeat step 4.

The same deploy attaches the custom domain from the `routes` line in `wrangler.toml`: Cloudflare creates the
DNS record and the certificate for `push.portsolace.com` (the first time can take a few minutes). Check it at
<https://push.portsolace.com/health>. If the deploy says the zone was not found, `portsolace.com` is not on
the Cloudflare account you are logged in to (`npx wrangler whoami`).

---

## 6. Switch the game on

In `waystation/play/index.html` the `<head>` holds one line that tells the game where the backend is:

```html
<meta name="portsolace-push" content='{"apiBase":""}'>
```

Put the worker's address in it (keep the single quotes around the JSON and the double quotes inside, no
trailing slash):

```html
<meta name="portsolace-push" content='{"apiBase":"https://push.portsolace.com"}'>
```

(The `*.workers.dev` address works there too, for example before the custom domain is attached.)

Commit and push to `main`. GitHub Pages redeploys within a minute or two. The Settings switch now reads **Off**
instead of **Not connected**.

---

## 7. Try it

1. Open <https://portsolace.com/play/> in Chrome, Edge or Firefox and open **Settings**
   (the bottom button of the command rail).
2. Switch **Notify me when something finishes** on and click **Allow** in the browser's prompt. The chip next
   to the switch turns to **On** and two more rows appear.
3. Click **Send a test notification**. Within a minute a notification titled "Port Solace" arrives; clicking it
   focuses the game. (On Windows, check that Focus Assist or Do Not Disturb is not hiding notifications.)
4. Place a tier-1 module (90 seconds), close the tab, and wait. The "Docking Collar online" notification
   arrives within about a minute of the build finishing.

If you want to try before changing the live site, the game accepts a per-browser override. Open the browser
console (F12 → Console) on the live game and paste, with your worker address:

```js
localStorage.setItem('portsolace.push', JSON.stringify({ apiBase: 'https://waystation-push.<your-subdomain>.workers.dev' }));
location.reload();
```

Remove it when done: `localStorage.removeItem('portsolace.push'); location.reload();`

---

## Day-to-day

- **Logs**: `npm run tail` streams requests and cron runs, or use the Cloudflare dashboard → Workers →
  waystation-push → Logs. Every cron run logs one line like
  `push: cron {"checked":2,"sent":1,"failed":0,"pruned":0,"dropped":0,"deferred":0,"healed":false}`.
- **Costs on the Workers Free plan**: the cron uses 1,440 of the 100,000 daily requests and one KV read a
  minute (of 100,000). The limit that matters is **1,000 KV writes a day** (resets at midnight UTC): each change
  to a player's schedule is one or two writes, so budget roughly **400 schedule changes a day across all
  players**. A player placing ten builds in a session causes about twenty. If the budget runs out,
  notifications pause until midnight UTC; the game itself is unaffected. The Workers Paid plan ($5 a month)
  raises it to one million writes a month.
- **Changing the allowed site**: edit `ALLOWED_ORIGIN` in `wrangler.toml` (comma-separated, no trailing slash)
  and run `npm run deploy`. It lists `https://portsolace.com`, `https://www.portsolace.com` and the old
  GitHub Pages origin `https://joshanderson051.github.io`, kept while players move over.
- **Turning it off**: remove the address from the `<meta>` tag and push; the switch reads **Not connected**
  again and the game stops calling the worker. Existing subscriptions expire on their own.

---

## Local testing against a worker on your own machine (for developers)

```sh
# in workers/push
npm run keys -- --dev-vars        # writes .dev.vars (git-ignored) with a throwaway key pair and localhost origins
npm run dev                       # wrangler dev on http://127.0.0.1:8789 with the cron exposed at /__scheduled
```

Serve the game (`node waystation/serve.js` from the repository root, port 8787), open
<http://localhost:8787/play/>, and set the override in the browser console:

```js
localStorage.setItem('portsolace.push', JSON.stringify({ apiBase: 'http://127.0.0.1:8789' })); location.reload();
```

Chrome treats `localhost` as a secure context, so the real subscription flow works against the local worker,
and the local worker can deliver real pushes (the push services are public). The cron does not tick on its own
under `wrangler dev`; trigger a run by hand:

```sh
curl "http://127.0.0.1:8789/__scheduled?cron=*+*+*+*+*"
```

`node test/e2e-local.mjs` does the whole round trip without a browser: it starts a fake push service, invents
a browser key pair, subscribes and schedules a timer that is already due, triggers the cron and decrypts what
arrived (expects `npm run dev` to be running).

---

## Endpoint reference

All responses are JSON. Errors look like `{"error":"code","message":"what went wrong"}`.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /health` | – | configuration summary, no secrets | – |
| `GET /key` | – | `{publicKey}` | 500 `config` |
| `POST /subscribe` | `{playerId, subscription}` (the browser's `PushSubscription.toJSON()`) | `{ok, token, reused}` | 400 `bad-player`, `bad-subscription`, `bad-json`; 500 `config` |
| `POST /schedule` | `{playerId, token, station?, timers:[{id, kind, title, dueAt}]}` | `{ok, count, nextDueAt, unchanged}` | 400 `bad-timers`, `too-many`; 403 `bad-token`; 404 `no-subscription`; 413 `too-large` |
| `POST /unsubscribe` | `{playerId, token}` | `{ok, removed}` | 403 `bad-token` |

`kind` is one of `build`, `upgrade`, `expedition`, `plot`, `daily`, `test`; `title` is what the notification
says (at most 80 characters); `dueAt` is a Unix time in milliseconds. A schedule holds at most 64 timers and
**replaces** the previous one. Timers already more than ten minutes over are dropped on arrival.

KV layout: `sub:{playerId}` → the subscription and its token; `timers:{playerId}` → `{station, timers}`;
`index` → `{playerId: soonest dueAt}` so the cron needs one read a minute instead of listing keys.

### What the cron does each minute

- Reads `index`, visits every player whose soonest timer is due, and sends **one** notification per player:
  the timer's own title when one thing finished ("Comms Relay online"), or "3 things finished at Harrow Point"
  with the titles in the body when several did. Sent timers are deleted.
- Timers more than two hours overdue are forgotten, not announced (the player has been back since).
- A push service answering 404 or 410 means the browser unsubscribed: the subscription and its timers are
  deleted. 429 or a 5xx keeps the timers for the next minute. At most 40 notifications go out per run; the
  rest follow a minute later.
- Every 15 minutes it rebuilds `index` from the stored timers, so a lost update in the shared index heals
  itself.

### Security and privacy notes

- The only secret is the VAPID private key, set with `wrangler secret put` (or `.dev.vars` locally, which is
  git-ignored). The public key is public by design: browsers subscribe with it.
- Browsers may call the worker only from the origins in `ALLOWED_ORIGIN` (CORS). `/schedule` and
  `/unsubscribe` require the token handed out at `/subscribe`, so nobody can plant notifications for a player
  whose id they merely guessed.
- The worker stores a random player id (never an email or a name), the delivery address the browser's push
  service generated, two encryption keys the browser made, and the timers' titles (module names, sector
  names, "Daily reward ready"). Notification text is encrypted so the push service cannot read it. Messages
  wait at the push service for at most 24 hours.
- One device per player: a second browser that opts in with the same profile replaces the first.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The switch is greyed out and says **Not connected** | The `<meta>` tag has no `apiBase`, or its JSON is invalid. Check the quotes (step 6). |
| **Unavailable** | The browser cannot do push for a closed tab (an old browser, a private window, or Safari on iOS without the game added to the Home Screen). |
| **Blocked** | The player denied the permission. Chrome: click the icon left of the address bar → Notifications → Allow, then switch on again. |
| **Offline** | The worker could not be reached three times in a row. Check `/health` and `ALLOWED_ORIGIN` (a CORS error shows in the browser console). The game keeps retrying. |
| The test notification never arrives | `npm run tail` while clicking the button. A cron line with `"failed":1` and a 401/403 means the keys do not match (a new pair was generated: switch off and on). No cron lines at all: the cron trigger did not deploy; run `npm run deploy` again and check Workers → waystation-push → Triggers. |
| A notification arrives for something the player watched finish | The tab was open at the moment the cron ran. Timers within two minutes of finishing are left out while the tab is visible, which covers almost every case; the rest is a harmless duplicate. |
| `/health` says `"scheduledPlayers": null` | The KV namespace id in `wrangler.toml` is wrong. Repeat step 3. |

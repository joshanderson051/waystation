# Port Solace account backend

This folder is the small server behind **Sign in** in the game: email and password accounts, and one
**cloud save** per account so a player can continue on another computer. It runs as a **Cloudflare
Worker** with a KV store, exactly like the store and push backends next to it. The only outside service it
talks to is an email provider (Resend, or Brevo), for one thing: the link behind **Forgot your password?**
(step 2b, optional). The ten-word **recovery phrase** shown once at sign-up is the other way back in and
needs no email setup.

You do not need to be a developer to set it up. Budget about 20 minutes. Until this backend exists the
game says "Cloud saves are not connected yet" and keeps saving in the player's browser as before.

**The live setup.** The game is at <https://portsolace.com/play/> and this worker answers at
<https://account.portsolace.com> (a Cloudflare custom domain, the `routes` line in `wrangler.toml`). Its
`*.workers.dev` address keeps working too and is what the first-time steps below use. Reset emails go out
from `noreply@portsolace.com`, with Resend's test sender as an automatic fallback until the domain is
verified (step 2b).

The old internal names (the Worker script `waystation-account`, the `service` that `/health` reports, the
`workers.dev` address and the repository folders) stay on purpose: renaming them would create a new Worker
and break live sign-ins.

---

## What you get

| Piece | Where | What it does |
|---|---|---|
| Worker | `src/index.js` | `/signup`, `/login`, `/logout`, `/recover`, `/forgot`, `/reset`, `/me`, `/save` (GET and PUT), `/account` (DELETE), `/health` |
| Port Authority | `src/portauthority.js`, `migrations/` | Presence, gifts and the admin API behind the owner's portal, on D1 ("Port Authority" below) |
| Reset email | `src/email.js` | The "Forgot your password?" email (text and HTML) and the Resend / Brevo adapters |
| Settings | `wrangler.toml` | Names the worker, binds the KV namespace, lists the allowed site origins, names the email sender |
| Tests | `test/account.test.js`, `test/reset.test.js`, `test/client.test.js`, `test/portauthority.test.js` | `npm test` runs them locally; no account needed (D1 runs on Node's built-in SQLite, `test/d1.js`) |
| Game client | `../../waystation/play/js/account.js` | The `Account` object the game uses; already written, you only point it at the worker |

How it works once connected:

1. The player creates an account in the game's Portal. The worker stores the email, a salted hash of the
   password and a hash of the recovery phrase (never the password or the phrase themselves) and hands the
   game a sign-in token that lasts 30 days from its last use.
2. While signed in, the game uploads the player's profile a few seconds after things change, and
   immediately after important moments (a purchase, a sector switch, a claimed mission or achievement,
   closing the tab). The cloud keeps **one** save per account, with a version number.
3. On another device the player signs in; the game compares the local and cloud saves and keeps the newer
   one, asking the player when both have changed.

---

## 0. Before you start

- **Node.js 20 or newer** (<https://nodejs.org>, the LTS download). Check with `node --version`.
- A **Cloudflare account** (free): <https://dash.cloudflare.com/sign-up>. The worker gets a free
  `*.workers.dev` address; for the live address `account.portsolace.com` the `portsolace.com` zone must be
  on the same Cloudflare account (it is: the domain was bought through Cloudflare Registrar).

Open a terminal in this folder (`workers/account`) and install the one developer tool:

```sh
npm install
npm test
```

`npm test` should end with `fail 0`. It runs entirely on your computer.

---

## 1. Log in to Cloudflare and create the KV namespace

```sh
npx wrangler login
npx wrangler kv namespace create ACCOUNTS
```

The second command prints a block with an `id = "…"` line. Open `wrangler.toml` and paste that id in
place of `REPLACE_WITH_KV_NAMESPACE_ID`.

`ALLOWED_ORIGIN` in the same file already contains the live site (`https://portsolace.com` and
`https://www.portsolace.com`) and the old GitHub Pages origin (`https://joshanderson051.github.io`), kept
while players move over. If the game is served from another domain, add it (several origins separated by
commas, no trailing slash).

---

## 2. Set the PEPPER secret

The pepper is a long random string mixed into every password hash. It lives only in Cloudflare.
Generate one and store it:

```sh
npm run pepper
npx wrangler secret put PEPPER
```

Paste the value `npm run pepper` printed when asked (nothing is shown while you paste; press Enter).

**Keep a copy of the pepper somewhere safe (a password manager).** If it is ever lost, nobody can sign
in again and every account would have to be recreated. Never change it once players have accounts.

---

## 2b. Email for "Forgot your password?" (optional, about 10 minutes)

Without this step the link under the Sign in form answers "Password reset by email is not set up on this
build yet. Use your recovery phrase instead." Everything else works.

The worker sends one kind of email, the reset link, through a transactional email provider with a free
tier. Two are supported; the difference is which sender address you can use:

| | Resend (default) | Brevo |
|---|---|---|
| Free tier | 3,000 emails a month, 100 a day | 300 a day |
| Sender | `onboarding@resend.dev` until you **verify a domain you own** (a few DNS records); then any address on it | a **single email address you can read** (Brevo emails you a confirmation link); no domain needed |
| Reaches | test sender: **only the address that owns the Resend account**; verified domain: anyone | anyone |
| Where | <https://resend.com> → API Keys, Domains | <https://app.brevo.com> → Senders, then SMTP & API → API keys |

Resend is the cleaner choice when you own a domain, and the live setup uses it with `portsolace.com`;
Brevo reaches players without one. Either way:

1. Create the provider account in your browser, signed up with the address you want to test with, and
   create an **API key** there. It is shown once: copy it.
2. Store it in Cloudflare, never in a file:

   ```sh
   npx wrangler secret put EMAIL_API_KEY
   ```

   Paste the key when asked (nothing is shown while you paste; press Enter).
3. In `wrangler.toml` set `EMAIL_PROVIDER` (`"resend"` or `"brevo"`) and `EMAIL_FROM` (the sender address
   the provider has approved: an address on your verified domain, Resend's `onboarding@resend.dev`, or your
   verified Brevo sender). The live file has `EMAIL_FROM = "noreply@portsolace.com"` and
   `EMAIL_FROM_FALLBACK = "onboarding@resend.dev"`. `PLAY_URL` is the game's play address
   (`https://portsolace.com/play/`); the reset link is `PLAY_URL?reset=…`. Then `npm run deploy`.
4. Open `/health`: `"email"` shows `"configured": true`, and `"emailFrom"` / `"emailFromFallback"` show the
   two senders. In the game, Sign in → **Forgot your password?** with your own address: the email arrives
   within seconds, from "Port Solace", subject "Reset your Port Solace password".

**Verifying portsolace.com in Resend.** Resend sends from `noreply@portsolace.com` only once the domain is
verified: Resend → Domains → **Add domain** → `portsolace.com`, then add the DNS records it lists (an MX
and TXT record on a `send` subdomain and a DKIM TXT record) in Cloudflare → `portsolace.com` → DNS, as
"DNS only" (grey cloud); Resend may offer to add them through Cloudflare for you. Click
**Verify**; it usually turns green within minutes.

**The sender fallback.** Until then Resend refuses `noreply@portsolace.com` with HTTP 403 or 422 and a
message saying the domain is not verified. The worker then retries the same email once from
`EMAIL_FROM_FALLBACK` (`onboarding@resend.dev`) and logs a warning naming both senders, so reset emails to
the address that owns the Resend account keep working. Other errors are never retried, and the fallback
applies to Resend only. Once the domain is verified the fallback is simply never used; to switch it off,
remove `EMAIL_FROM_FALLBACK` from `wrangler.toml` and deploy.

Rotating the key: create a new one at the provider, run `npx wrangler secret put EMAIL_API_KEY` again,
then delete the old key at the provider. Changing the sender or the provider: edit `wrangler.toml`,
`npm run deploy`. The provider's dashboard shows every email sent and whether it was delivered.

---

## 3. Deploy and check

```sh
npm run deploy
```

The last lines show the worker's address, something like
`https://waystation-account.<your-subdomain>.workers.dev`. Open
`https://waystation-account.<your-subdomain>.workers.dev/health` in a browser: you should see
`"ok": true`, `"kv": true` and `"pepper": true` (and, after step 2b, `"email": {"configured": true, …}`).

The same deploy attaches the custom domain from the `routes` line in `wrangler.toml`: Cloudflare creates
the DNS record and the certificate for `account.portsolace.com` (the first time can take a few minutes).
Check it the same way at <https://account.portsolace.com/health>. If the deploy says the zone was not
found, `portsolace.com` is not on the Cloudflare account you are logged in to (`npx wrangler whoami`).

---

## 4. Point the game at it

In `waystation/play/index.html`, in the `<head>` next to the `portsolace-store` line, add (or edit) this
line with your worker address, keeping the single quotes outside and the double quotes inside:

```html
<meta name="portsolace-account" content='{"apiBase":"https://account.portsolace.com"}'>
```

(The `*.workers.dev` address works there too, for example before the custom domain is attached.)

Commit and push to `main`; GitHub Pages redeploys within a minute or two. The title screen now shows
**Sign in**, and Settings gets an **Account** shelf.

To test before changing the live site, open the game, press F12 → Console and paste (with your address):

```js
localStorage.setItem('portsolace.account.config', JSON.stringify({ apiBase: 'https://waystation-account.<your-subdomain>.workers.dev' }));
location.reload();
```

That override affects only your browser. Remove it with
`localStorage.removeItem('portsolace.account.config'); location.reload();`.

---

## 5. Try it

1. Create an account from the title screen. Write down the ten-word recovery phrase the game shows.
2. Play for a minute, then open the same game in a private window and sign in: the station follows you.
3. Change something in both windows, reload one: the game asks which save to keep.
4. Sign out, use **Recover** with the phrase to set a new password (you get a new phrase; the old one and
   every other signed-in device stop working).
5. With step 2b done: Sign in → **Forgot your password?** → your address. The email's button opens the
   game on **Set a new password**; after it you are signed in with a new recovery phrase, and the link is
   dead (open it again to see the "expired or already used" message with a way to ask for a new one).

---

## Day-to-day

- **Logs**: `npm run tail`, or the Cloudflare dashboard → Workers → waystation-account → Logs.
- **A player lost their password**: **Forgot your password?** on the Sign in tab emails them a link (step
  2b); the recovery phrase works too. Lost both, or no email set up: there is nothing to recover. Delete
  the account for them (Cloudflare dashboard → KV → ACCOUNTS → delete the keys `user:<email>` and
  `save:<their user id>`, the id is inside the user record) so they can sign up again; their browser still
  has the local profile, which becomes the new cloud save on sign-up.
- **Capacity and cost**: the Workers **free plan** allows 100,000 requests and **1,000 KV writes per day**
  across all your workers. Every cloud save upload is one write, and an active player uploads roughly once
  a minute while playing, so a handful of regular players exhaust the free writes. The **Workers Paid plan
  ($5/month)** raises that to 1 million writes a month and 10 million reads; switch to it before inviting
  more than a few people. KV storage is 1 GB free (a save is usually 20–300 KB).
- **Deleting an account** from the game's Settings removes the user, the save and the token immediately.
- **Changing the allowed origin**: edit `ALLOWED_ORIGIN`, `npm run deploy`.

---

## Port Authority (the owner's player portal)

Port Authority is the private page at <https://admin.portsolace.com/> where the owner sees every active
player and sends them gifts of credits or Antimatter (DESIGN2.md Addendum A9). The page is served by its own
worker, `portsolace-admin` (`workers/admin`, custom domain `admin.portsolace.com`), and nothing of it loads
before a login: that worker signs the owner in through this worker's `/login` over a service binding
(`ACCOUNT` -> `waystation-account`, forwarding the client's `CF-Connecting-IP`), keeps the account token in a
signed `HttpOnly` cookie, refuses (and revokes) any account that this worker answers 403 `not-admin`, and proxies
the portal's `/api/admin/*` calls here as `/admin/*` with that token (DESIGN2.md A9.7, `workers/admin/README.md`).
The old address `https://portsolace.com/admin/` only redirects there. This worker is its backend:
the code is `src/portauthority.js`, the storage a **D1 database** called `portsolace` (binding `DB`).

**Who shows up.** Every running game reports **presence** every 10 minutes, keyed by its random player id
(most players never make an account). Presence stores the station summary (name, day, level, rank,
credits, Antimatter, sectors), the platform (`phone` or `desktop`), the game version, first and last seen
and a session count (a new session when the game was silent for more than 30 minutes). When the game is
signed in, the row is also linked to the account id and email. Nothing else personal is stored.

**Gifts.** A gift sent from the portal waits in D1. The player's next presence call hands it to the game
(within 10 minutes while they play); the game applies it once (its entitlement history guards against
doubles) and confirms with `/gifts/ack`. A gift can be revoked until the game has confirmed it. Every gift
and every revoke is written to the admin log.

| Method and path | Who | What it does |
|---|---|---|
| `POST /presence` | the game | `{playerId, summary, platform, version}`, optional Bearer. Upserts the player and answers `{ok, gifts:[{id, credits, am, note, createdAt}]}` (every gift not yet confirmed or revoked). An invalid token is ignored. |
| `POST /gifts/ack` | the game | `{playerId, ids}`: marks those gifts applied (only this player's, only once). Answers `{ok, acked:[ids]}`. |
| `GET /admin/stats` | admin | Players, active in 24 h / 7 d / 30 d, accounts, gifts by status |
| `GET /admin/players` | admin | `?q=&active=all\|24h\|7d\|30d&sort=last_seen\|first_seen\|level\|credits\|am&dir=asc\|desc&limit=50&offset=0`: `{total, players}`. `q` searches station name, email and player id. |
| `GET /admin/players/:playerId` | admin | `{player, gifts, purchases, purchasesAvailable}`; purchases are read from the store worker's KV (binding `STORE`, read only) |
| `POST /admin/gifts` | admin | `{playerId, credits, am, note, requestId}`: credits 0 to 10,000,000, Antimatter 0 to 100,000, at least one above 0, note up to 140 characters (shown to the player); the player must have reported presence. `requestId` (optional, 8-64 `[A-Za-z0-9_-]`, one per reviewed gift) makes it idempotent: a repeat returns the first gift with `duplicate: true` (409 `request-reused` if it named another gift) |
| `POST /admin/gifts/:id/revoke` | admin | Cancels a gift the game has not confirmed (409 `already-applied` after) |
| `GET /admin/log` | admin | `?limit=50`: the most recent admin actions |

**Who is an admin.** An account is an admin only when it is on both lists: its email in `ADMIN_EMAILS`
in `wrangler.toml` (`[vars]`, comma-separated; case and spaces do not matter) and its account id (`u_…`)
in the secret `ADMIN_USER_IDS` (comma-separated). The id matters because `/signup` does not verify email
addresses: whoever registers an address first owns it, and anyone could register the owner's address
after the owner deleted the account. A new account always gets a new id, so it is never an admin. An admin
signs in to the portal with their normal game account (email and password). No token or a bad one answers
401, any other account 403 `not-admin`. An admin's calls count against 300 calls per 10 minutes per
account. Failed calls that carry a well-formed token (401/403) count against 10 per 10 minutes per IP;
after that, such failures answer 429 for the rest of the window. Calls without a token are never counted,
and a valid admin token is never blocked, so a shared IP (a phone behind carrier NAT) cannot lock the
owner out. `/health` shows how many admins are configured (`admins` for the emails, `adminIds` for the
ids), never who.

**Before the first deploy (the lead).** Set `ADMIN_USER_IDS` to the owner's account id:

1. The owner signs in to the game (or the portal) once with `joshanderson051@gmail.com`, so that account
   exists and is the owner's. If no account exists for that address yet, create it now, before deploying.
2. Read its id: in the game's browser console run
   `fetch('https://account.portsolace.com/me',{headers:{authorization:'Bearer '+JSON.parse(localStorage['portsolace.account']).token}}).then(r=>r.json()).then(d=>console.log(d.user.id))`.
3. `npx wrangler secret put ADMIN_USER_IDS` and paste the id (several ids: comma-separated).
   `/health` then shows `"adminIds": 1`.

Never delete the owner's account: a new account for the same email gets a new id and is not an admin
until `ADMIN_USER_IDS` is updated. To add or remove an admin, change both lists, then `npm run deploy`
(the secret applies on `secret put`).

**Setting up D1 (once).** The database already exists (its id is in `wrangler.toml`). Create the tables
with the migrations in `migrations/` (`0001` the tables, `0002` the gift `request_id` that makes sending a
gift idempotent), set `ADMIN_USER_IDS` as above, then deploy:

```sh
npx wrangler d1 migrations apply portsolace --remote
npm run deploy
```

`/health` then shows `"presence": true, "d1": true, "admins": 1, "adminIds": 1, "storeKv": true`. Later schema changes go
in new numbered files in `migrations/` and are applied the same way (`npx wrangler d1 migrations list
portsolace --remote` shows what is pending). To try it on your own machine, use `--local` instead of
`--remote` and `npm run dev`.

**Capacity.** D1's free plan allows 5 million row reads and 100,000 row writes a day; one presence call
writes one or two rows. The rate limits still live in KV (one KV write per presence call and per admin
call), on top of the cloud saves: see **Capacity and cost** above.

---

## Local testing against a worker on your own machine (for developers)

```sh
printf 'PEPPER=%s\n' "$(npm run -s pepper)" > .dev.vars     # git-ignored; local secret for wrangler dev
npm run dev                                                 # wrangler dev on http://127.0.0.1:8790
```

Add an `EMAIL_API_KEY=…` line to `.dev.vars` to send real reset emails from the local worker (with
`--var PLAY_URL:http://localhost:8794/waystation/play/` so the link opens the local game); without it
`/forgot` answers 503 locally.

To try Port Authority locally, apply the migrations with `--local`, sign up a local admin account, read its
id from `/me`, and start the worker with both lists, for example
`npx wrangler dev --port 8790 --var ADMIN_EMAILS:admin@example.test --var ADMIN_USER_IDS:u_…` (or put
`ADMIN_USER_IDS=u_…` in `.dev.vars`). The portal no longer takes an API override: run the admin worker locally
against this one as `workers/admin/README.md` describes.

Add the game's local origin (for example `http://localhost:8794`) to `ALLOWED_ORIGIN` while testing, serve
the game from the repository root with `node waystation/serve.js --port 8794 --base waystation` (in Git
Bash prefix it with `MSYS_NO_PATHCONV=1`), and set the override in the game's console:

```js
localStorage.setItem('portsolace.account.config', JSON.stringify({ apiBase: 'http://127.0.0.1:8790' }));
```

Ports: the game's server defaults to 8787 (Wrangler's default too), the store worker uses 8788, push 8789,
this one 8790.

---

## Endpoint reference

All responses are JSON with `cache-control: no-store`. Errors look like `{"error":"code","message":"…"}`.
Authenticated calls send `Authorization: Bearer <token>`.

| Method and path | Body / query | Success | Errors |
|---|---|---|---|
| `GET /health` | – | configuration summary, no secrets | – |
| `POST /signup` | `{email, password}` | `201 {token, user:{id,email}, recovery}` | 400 `bad-email` / `weak-password` / `bad-json`; 409 `email-taken`; 429 `rate-limited` |
| `POST /login` | `{email, password}` | `{token, user}` | 400; 401 `bad-credentials`; 429 |
| `POST /logout` | – (Bearer) | `{ok:true}` | 401 `unauthorised` |
| `POST /recover` | `{email, recovery, newPassword}` | `{token, user, recovery}` (new phrase; older tokens revoked) | 400 `bad-recovery` / `weak-password`; 401 `bad-recovery`; 429 |
| `POST /forgot` | `{email}` | `{ok:true}` always; an email with a 30-minute reset link goes out only when the address has an account | 400 `bad-email` / `bad-json`; 429; 503 `email-not-configured` |
| `POST /reset` | `{token, newPassword}` | `{token, user, recovery}` (new phrase; older tokens revoked; the link is single-use) | 400 `bad-token` / `weak-password`; 401 `bad-token` (expired, used or superseded); 429 |
| `GET /me` | – (Bearer) | `{user, save:{version, updatedAt, size, summary}|null}` | 401 |
| `GET /save` | – (Bearer) | `{version, updatedAt, size, summary, profile}` | 401; 404 `no-save` |
| `PUT /save` | `{profile, baseVersion}` (Bearer; plain JSON or gzip) | `{version, updatedAt, size, summary}` | 400 `bad-profile` / `bad-version`; 401; 409 `conflict` `{server:{version, updatedAt, summary}}`; 413 `too-large` |
| `DELETE /account` | `{password}` (Bearer) | `{ok:true}` | 400; 401 `bad-credentials` / `unauthorised` |
| `POST /presence` | `{playerId, summary, platform, version}` (optional Bearer) | `{ok:true, gifts:[{id, credits, am, note, createdAt}]}` | 400 `bad-player` / `bad-json`; 429; 500 `config` (no DB) |
| `POST /gifts/ack` | `{playerId, ids}` | `{ok:true, acked:[ids]}` | 400 `bad-player` / `bad-ids`; 429 |
| `GET /admin/stats` | – (admin Bearer) | `{players, active24h, active7d, active30d, accounts, giftsPending, giftsDelivered, giftsApplied, giftsRevoked}` | 401; 403 `not-admin`; 429 |
| `GET /admin/players` | `?q&active&sort&dir&limit&offset` (admin) | `{total, players:[row + {pendingGifts}]}` | 401; 403; 429 |
| `GET /admin/players/:playerId` | – (admin) | `{player, gifts:[row + {status}], purchases:[{grantId, sku, at}], purchasesAvailable}` | 400 `bad-player`; 404 `unknown-player` |
| `POST /admin/gifts` | `{playerId, credits, am, note}` (admin) | `{gift}` | 400 `bad-player` / `bad-credits` / `bad-am` / `empty-gift` / `bad-note`; 404 `unknown-player` |
| `POST /admin/gifts/:id/revoke` | – (admin) | `{gift}` (again: the same gift, not logged twice) | 400 `bad-gift`; 404 `unknown-gift`; 409 `already-applied` |
| `GET /admin/log` | `?limit=50` (admin) | `{entries:[{id, at, admin, action, target, detail}]}` | 401; 403 |

Rate limits per IP: 10 sign-ups per hour, 20 logins per 10 minutes, 5 recoveries per hour, 3 reset emails
per hour (and 3 per hour per address, whatever the IP), 10 reset attempts per hour, 120 presence reports and
120 gift confirmations per 10 minutes, 300 admin calls per 10 minutes (10 failed ones); a 429 carries
`retryAfter` (seconds) in the body and a `Retry-After` header.

KV layout: `user:{email}` → `{id, email, pw:{salt,hash,iter}, rec:{salt,hash,iter}, tokenGen, createdAt}`;
`tok:{sha256(token)}` → `{userId, email, gen, createdAt, refreshedAt}` (30-day TTL, slid at most every
6 hours); `reset:{sha256(token)}` → `{userId, email, gen, createdAt}` (30-minute TTL, deleted on use);
`save:{userId}` → `{version, updatedAt, size, summary:{name, day, level, credits, am, sectors,
rank}, profile}`; `rl:{bucket}:{ip}` and `rl:forgotEmail:{email}` → `{count, resetAt}`.

### Security notes

- Passwords and recovery phrases are hashed with PBKDF2-SHA256 (100,000 iterations, the most the Workers
  runtime allows, a random 16-byte salt per secret, plus the server-side pepper). Nothing reversible is stored.
- Sign-in tokens are 32 random bytes; KV holds only their SHA-256. A recovery or a reset bumps the account's
  token generation, which invalidates every token issued before it.
- Reset links are 32 random bytes too; KV holds only their SHA-256, for 30 minutes, and deletes the record
  when the link is used. The record carries the token generation, so a reset or recovery also kills every
  older link. `/forgot` answers the same way whether or not the address has an account, and the email goes
  out after the response, so neither the answer nor its timing says whether an account exists.
- Browsers may call the worker only from the origins in `ALLOWED_ORIGIN` (CORS).
- The cloud save is the player's game profile (station layout, credits, Antimatter, purchases); it holds no
  payment data. The email address is the only personal data stored.
- Two sign-ups for the same email in the same instant can both succeed (KV has no transactions); the second
  write wins. In practice this does not happen outside a deliberate race.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Title screen shows no Sign in button | The `<meta name="portsolace-account">` tag is missing or its JSON is invalid; the game then treats cloud saves as not connected. |
| Console shows a CORS error | The game's origin is not in `ALLOWED_ORIGIN`. Add it (no trailing slash), deploy. |
| `/health` says `"pepper": false` | Run `npx wrangler secret put PEPPER` again, then `npm run deploy`. |
| Sign-up answers 500 `config` | Same as above, or the KV id in `wrangler.toml` is still the placeholder. |
| Players report "signed out" unexpectedly | Tokens expire 30 days after their last use, and a recovery or a password reset signs out every other device by design. |
| Forgot your password? says "not set up on this build yet" | `EMAIL_API_KEY` is not set, or `EMAIL_FROM` / `PLAY_URL` is empty: `/health` lists what is `missing` under `email`. |
| The reset email never arrives | Run `npm run tail` and ask for a link: a "reset email not sent" line quotes the provider's answer. Resend's test sender delivers only to the address that owns the Resend account (verify a domain for players); the limit is 3 emails per hour per address; check the spam folder. |
| Logs say "noreply@portsolace.com is not verified … went out from onboarding@resend.dev" | `portsolace.com` is not (yet) verified in Resend, so the worker used `EMAIL_FROM_FALLBACK`; only the Resend account owner receives those. Verify the domain (step 2b). |
| Saves stop uploading late in the day | The free plan's 1,000 KV writes per day are used up (the dashboard shows it). Upgrade to Workers Paid. |

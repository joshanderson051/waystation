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
| Reset email | `src/email.js` | The "Forgot your password?" email (text and HTML) and the Resend / Brevo adapters |
| Settings | `wrangler.toml` | Names the worker, binds the KV namespace, lists the allowed site origins, names the email sender |
| Tests | `test/account.test.js`, `test/reset.test.js`, `test/client.test.js` | `npm test` runs them locally; no account needed |
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

## Local testing against a worker on your own machine (for developers)

```sh
printf 'PEPPER=%s\n' "$(npm run -s pepper)" > .dev.vars     # git-ignored; local secret for wrangler dev
npm run dev                                                 # wrangler dev on http://127.0.0.1:8790
```

Add an `EMAIL_API_KEY=…` line to `.dev.vars` to send real reset emails from the local worker (with
`--var PLAY_URL:http://localhost:8794/waystation/play/` so the link opens the local game); without it
`/forgot` answers 503 locally.

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

Rate limits per IP: 10 sign-ups per hour, 20 logins per 10 minutes, 5 recoveries per hour, 3 reset emails
per hour (and 3 per hour per address, whatever the IP), 10 reset attempts per hour; a 429 carries
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

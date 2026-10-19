# Waystation account backend

This folder is the small server behind **Sign in** in the game: email and password accounts, and one
**cloud save** per account so a player can continue on another computer. It runs as a **Cloudflare
Worker** with a KV store, exactly like the store and push backends next to it. It does not send email
and does not talk to any third party: if a player forgets their password, the ten-word **recovery
phrase** shown once at sign-up is the only way back in.

You do not need to be a developer to set it up. Budget about 20 minutes. Until this backend exists the
game says "Cloud saves are not connected yet" and keeps saving in the player's browser as before.

---

## What you get

| Piece | Where | What it does |
|---|---|---|
| Worker | `src/index.js` | `/signup`, `/login`, `/logout`, `/recover`, `/me`, `/save` (GET and PUT), `/account` (DELETE), `/health` |
| Settings | `wrangler.toml` | Names the worker, binds the KV namespace, lists the allowed site origins |
| Tests | `test/account.test.js`, `test/client.test.js` | `npm test` runs them locally; no account needed |
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
- A **Cloudflare account** (free): <https://dash.cloudflare.com/sign-up>. No domain needed; the worker
  gets a free `*.workers.dev` address.

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

`ALLOWED_ORIGIN` in the same file already contains the GitHub Pages site. If the game is served from
another domain, put that there instead (several origins separated by commas, no trailing slash).

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

## 3. Deploy and check

```sh
npm run deploy
```

The last lines show the worker's address, something like
`https://waystation-account.<your-subdomain>.workers.dev`. Open
`https://waystation-account.<your-subdomain>.workers.dev/health` in a browser: you should see
`"ok": true`, `"kv": true` and `"pepper": true`.

---

## 4. Point the game at it

In `waystation/play/index.html`, in the `<head>` next to the `waystation-store` line, add (or edit) this
line with your worker address, keeping the single quotes outside and the double quotes inside:

```html
<meta name="waystation-account" content='{"apiBase":"https://waystation-account.<your-subdomain>.workers.dev"}'>
```

Commit and push to `main`; GitHub Pages redeploys within a minute or two. The title screen now shows
**Sign in**, and Settings gets an **Account** shelf.

To test before changing the live site, open the game, press F12 → Console and paste (with your address):

```js
localStorage.setItem('waystation.account.config', JSON.stringify({ apiBase: 'https://waystation-account.<your-subdomain>.workers.dev' }));
location.reload();
```

That override affects only your browser. Remove it with
`localStorage.removeItem('waystation.account.config'); location.reload();`.

---

## 5. Try it

1. Create an account from the title screen. Write down the ten-word recovery phrase the game shows.
2. Play for a minute, then open the same game in a private window and sign in: the station follows you.
3. Change something in both windows, reload one: the game asks which save to keep.
4. Sign out, use **Recover** with the phrase to set a new password (you get a new phrase; the old one and
   every other signed-in device stop working).

---

## Day-to-day

- **Logs**: `npm run tail`, or the Cloudflare dashboard → Workers → waystation-account → Logs.
- **A player lost their password and their phrase**: there is nothing to recover. Delete the account for
  them (Cloudflare dashboard → KV → ACCOUNTS → delete the keys `user:<email>` and `save:<their user id>`,
  the id is inside the user record) so they can sign up again; their browser still has the local profile,
  which becomes the new cloud save on sign-up. Email-based reset is a later step that needs an email
  provider (Resend, Postmark, …); the worker is laid out so `/recover` can gain a second route for it.
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

Add the game's local origin (for example `http://localhost:8794`) to `ALLOWED_ORIGIN` while testing, serve
the game from the repository root with `node waystation/serve.js --port 8794 --base waystation` (in Git
Bash prefix it with `MSYS_NO_PATHCONV=1`), and set the override in the game's console:

```js
localStorage.setItem('waystation.account.config', JSON.stringify({ apiBase: 'http://127.0.0.1:8790' }));
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
| `GET /me` | – (Bearer) | `{user, save:{version, updatedAt, size, summary}|null}` | 401 |
| `GET /save` | – (Bearer) | `{version, updatedAt, size, summary, profile}` | 401; 404 `no-save` |
| `PUT /save` | `{profile, baseVersion}` (Bearer; plain JSON or gzip) | `{version, updatedAt, size, summary}` | 400 `bad-profile` / `bad-version`; 401; 409 `conflict` `{server:{version, updatedAt, summary}}`; 413 `too-large` |
| `DELETE /account` | `{password}` (Bearer) | `{ok:true}` | 400; 401 `bad-credentials` / `unauthorised` |

Rate limits per IP: 10 sign-ups per hour, 20 logins per 10 minutes, 5 recoveries per hour; a 429 carries
`retryAfter` (seconds) in the body and a `Retry-After` header.

KV layout: `user:{email}` → `{id, email, pw:{salt,hash,iter}, rec:{salt,hash,iter}, tokenGen, createdAt}`;
`tok:{sha256(token)}` → `{userId, email, gen, createdAt, refreshedAt}` (30-day TTL, slid at most every
6 hours); `save:{userId}` → `{version, updatedAt, size, summary:{name, day, level, credits, am, sectors,
rank}, profile}`; `rl:{bucket}:{ip}` → `{count, resetAt}`.

### Security notes

- Passwords and recovery phrases are hashed with PBKDF2-SHA256 (210,000 iterations, a random 16-byte salt
  per secret, plus the server-side pepper). Nothing reversible is stored.
- Sign-in tokens are 32 random bytes; KV holds only their SHA-256. A recovery bumps the account's token
  generation, which invalidates every token issued before it.
- Browsers may call the worker only from the origins in `ALLOWED_ORIGIN` (CORS).
- The cloud save is the player's game profile (station layout, credits, Antimatter, purchases); it holds no
  payment data. The email address is the only personal data stored.
- Two sign-ups for the same email in the same instant can both succeed (KV has no transactions); the second
  write wins. In practice this does not happen outside a deliberate race.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Title screen shows no Sign in button | The `<meta name="waystation-account">` tag is missing or its JSON is invalid; the game then treats cloud saves as not connected. |
| Console shows a CORS error | The game's origin is not in `ALLOWED_ORIGIN`. Add it (no trailing slash), deploy. |
| `/health` says `"pepper": false` | Run `npx wrangler secret put PEPPER` again, then `npm run deploy`. |
| Sign-up answers 500 `config` | Same as above, or the KV id in `wrangler.toml` is still the placeholder. |
| Players report "signed out" unexpectedly | Tokens expire 30 days after their last use, and a recovery signs out every other device by design. |
| Saves stop uploading late in the day | The free plan's 1,000 KV writes per day are used up (the dashboard shows it). Upgrade to Workers Paid. |

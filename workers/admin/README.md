# Port Authority front door (`workers/admin`)

Port Authority, the owner's player portal, lives at **<https://admin.portsolace.com/>** and nowhere else.
This Cloudflare Worker (script `portsolace-admin`) serves it: nothing but the sign-in page loads until you sign
in with your Port Solace account, and only an account the account Worker lists as an admin gets in
(`ADMIN_EMAILS` plus the `ADMIN_USER_IDS` secret, see `workers/account/README.md` "Port Authority").
DESIGN2.md Addendum A9.7 is the design.

| Piece | Where | What it is |
|---|---|---|
| Worker | `src/index.js`, `src/lib.js` | Sign-in, the session cookie, security headers, the gate in front of the files, the proxy to the account Worker |
| Portal | `public/index.html`, `admin.css`, `admin.js` | The console itself (moved here from `waystation/admin/`) |
| Sign-in page | `public/login.html`, `login.css`, `login.js` | The only page served without a session |
| Settings | `wrangler.toml` | Name, custom domain, static files, the service binding to the account Worker |
| Tests | `test/admin.test.js` | `npm test` (Node 20+, no install needed); the account Worker and the files are fakes |

The old address `https://portsolace.com/admin/` is now a plain redirect page to this one.

## How it works

1. You open <https://admin.portsolace.com/>. Without a session every page load is sent to `/login`; any
   other request (a script, a stylesheet, an API call) gets `401 login-required`.
2. You sign in with your Port Solace email and password. The Worker passes them to the account Worker's
   `/login` over a **service binding** (Worker to Worker inside Cloudflare, with your real IP in
   `CF-Connecting-IP`, so the account Worker's rate limits apply to you, not to this Worker), then asks
   `/admin/stats` with the new token whether the account is an admin. Not an admin: the token is revoked
   at once and the page says "This account is not a Port Authority admin."
3. An admin gets a **session cookie** and the console loads. The browser never sees the account token.
4. The console calls `/api/admin/...` on the same origin; the Worker adds the token and forwards the
   call to the account Worker's `/admin/...`. The account Worker still checks admin rights on every call.
5. **Sign out** (or 12 hours) ends the session; signing out also revokes the account token.

## Routes

| Method and path | Session | What it does |
|---|---|---|
| `GET /login` | no | The sign-in page; with a valid session it redirects to `/` |
| `GET /login.js`, `/login.css`, `/favicon.svg`, `/robots.txt` | no | Public files; `robots.txt` disallows everything |
| `POST /login` | no | `{email, password}` (JSON or form). `200 {ok, email}` + cookie; `401 bad-credentials`; `403 not-admin`; `429 rate-limited {retryAfter}`; `502 account-unavailable`. Origin must be `SITE_ORIGIN`; body at most 4 KB |
| `POST /logout` | either | Revokes the account token, clears the cookie, `200 {ok}`. Origin checked. `GET /logout` is 405 |
| `GET /api/session` | yes | `{email}` |
| `* /api/admin/...` | yes | Proxied to the account Worker at `/admin/...` with method, query and body (at most 64 KB). Adds `Authorization: Bearer <token>` and `CF-Connecting-IP`; never forwards the browser's `Cookie` or `Authorization`. Anything other than GET needs Origin `SITE_ORIGIN`. Other `/api/...` paths are 404. An upstream 401 (or 403 `not-admin`, which also revokes the token) clears the cookie |
| `GET` anything else | yes | The portal's files from `public/` |

Other methods on file paths answer 405. Every response carries `Content-Security-Policy` (scripts, styles,
images and connections from this origin only, plus Google Fonts; `frame-ancestors 'none'`),
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Robots-Tag: noindex, nofollow`, `Strict-Transport-Security: max-age=31536000` and a
`Permissions-Policy`. Pages, `/login` and `/api` answers are `Cache-Control: no-store`; the portal's other
files are `private, no-cache`.

## The session cookie

`__Host-ps_admin` = base64url(JSON `{t, e, iat, exp}`) + `.` + base64url(HMAC-SHA256 with `SESSION_SECRET`),
where `t` is the account Worker's sign-in token and `e` your email. Attributes: `HttpOnly; Secure;
SameSite=Strict; Path=/; Max-Age=43200`. It lasts 12 hours from sign-in and is never extended. The
signature is compared in constant time; a malformed, tampered or expired cookie counts as no session and
is cleared. Changing `SESSION_SECRET` signs everyone out.

The cookie is signed, not encrypted: anyone who copies a cookie value can decode `t` and use that token
directly against `https://account.portsolace.com/admin/*` for the token's own life (30 days, sliding),
not just the 12 hours. The 12-hour limit is enforced at this front door only. **Sign out** is what
revokes the token; letting the cookie expire does not. Sign out when you are done, especially on a shared
machine.

## The secret

`SESSION_SECRET` signs the cookie: at least 32 random bytes. **Until it is set, every request answers
`503 not-configured`** (the Worker fails closed rather than run with a weak or missing key). It is a
Worker secret, never a `[vars]` entry and never committed.

## Deploy (the lead)

From this folder, with the account Worker (`waystation-account`) already deployed:

```sh
npx wrangler deploy                          # creates the Worker and the custom domain admin.portsolace.com
npm run -s secret                            # prints 32 random bytes, base64url
npx wrangler secret put SESSION_SECRET       # paste that value
```

This folder has no `node_modules`; either run `npm install` here first or use the copy of Wrangler in
`../account/node_modules` (`../account/node_modules/.bin/wrangler deploy`). Cloudflare creates the
`admin.portsolace.com` DNS record and certificate on the first deploy (the `portsolace.com` zone is on the
same account). There is no `*.workers.dev` address (`workers_dev = false`) and no per-version preview
address (`preview_urls = false`), so the custom domain is the only way in. Check it: <https://admin.portsolace.com/robots.txt> answers `Disallow: /`,
<https://admin.portsolace.com/> redirects to `/login`, and signing in with the owner's account opens the
console.

The account Worker needs no change for this: the service binding reaches it directly and its CORS list
does not apply to Worker-to-Worker calls.

## Local testing

```sh
npm test                                     # fakes only; ends with "fail 0"
```

To click through it for real, run this Worker and the account Worker in one `wrangler dev`, so the service
binding resolves locally. Everything stays local (`--local`, never `--remote`). In this order:

1. In `workers/account`, apply the migrations locally:
   `npx wrangler d1 migrations apply portsolace --local`.
2. Still in `workers/account`, run the account Worker alone once (`npx wrangler dev`, see
   `workers/account/README.md`), `POST /signup` a test admin account, read its id from `/me`, and stop it.
3. Put `ADMIN_USER_IDS=<that id>` (and `ADMIN_EMAILS=<its email>` if it is not the owner's) in
   `workers/account/.dev.vars`, next to `PEPPER`. `--var` reaches only the first Worker, so the account
   Worker takes its local secrets from its own `.dev.vars`.
4. Back in this folder, start both:

```sh
../account/node_modules/.bin/wrangler dev -c wrangler.toml -c ../account/wrangler.toml --port 8796 \
  --persist-to ../account/.wrangler/state \
  --var SESSION_SECRET:<32+ characters> --var SITE_ORIGIN:http://account.portsolace.com
```

Open <http://localhost:8796/> and sign in with the test admin; Sign out returns to `/login`. Two local
quirks (checked with Wrangler 4.151):

- A multi-config `wrangler dev` keeps every Worker's local state under the first config's folder, so
  `--persist-to` points it at the account Worker's state, where steps 1 and 2 wrote the tables and the
  test account. Without it, sign-in reads an empty database and fails.
- `wrangler dev` rewrites a same-origin `Origin` header (one whose host is the dev server's own, such as
  `http://localhost:8796`) to `http://` plus a custom-domain host before the Worker sees it. Run alone,
  this Worker gets `http://admin.portsolace.com`. In the two-config run above it gets the last config's
  host, `http://account.portsolace.com`, which is why `SITE_ORIGIN` takes that odd value. If Sign in says
  "Refused", `POST /login` answered `403 bad-origin`. A different Wrangler version may rewrite it
  differently, so make `SITE_ORIGIN` match whatever `Origin` actually reaches the Worker.

Do not run the two Workers as two separate `wrangler dev` processes. The service binding then goes through
the local dev registry and can reach any other `waystation-account` dev session running on the machine.

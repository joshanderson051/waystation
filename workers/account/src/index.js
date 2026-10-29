// ============================================================
// PORT SOLACE — account backend: Cloudflare module Worker (DESIGN2.md Addendum A2.1)
// Email + password accounts and one cloud save per account. WebCrypto only; no SDK, no npm runtime
// dependencies. Same house style as workers/store. Constants and pure helpers live in lib.js (a Worker's
// main module may only export handlers and functions).
//
// Endpoints (JSON in, JSON out; CORS for ALLOWED_ORIGIN only; cache-control: no-store)
//   POST   /signup    {email, password}                   -> 201 {token, user:{id,email}, recovery}
//   POST   /login     {email, password}                   -> {token, user}
//   POST   /logout    (Bearer)                            -> {ok}
//   POST   /recover   {email, recovery, newPassword}      -> {token, user, recovery}   (new phrase; older tokens revoked)
//   POST   /forgot    {email}                             -> {ok} always (emails a reset link when the account exists)
//   POST   /reset     {token, newPassword}                -> {token, user, recovery}   (new phrase; older tokens revoked)
//   GET    /me        (Bearer)                            -> {user, save:{version, updatedAt, size, summary}|null}
//   GET    /save      (Bearer)                            -> {version, updatedAt, size, summary, profile}
//   PUT    /save      (Bearer) {profile, baseVersion}     -> {version, updatedAt, size, summary}
//                                                            409 {error:'conflict', server:{version, updatedAt, summary}}
//   DELETE /account   (Bearer) {password}                 -> {ok}
//   GET    /health                                        -> configuration summary (no secrets)
//
// Passwords and recovery phrases: PBKDF2-SHA256, 100,000 iterations (the Workers maximum), 16-byte salt, PEPPER appended to the
// secret. Tokens: 32 random bytes base64url, stored by their SHA-256 with a sliding 30-day TTL and the
// user's tokenGen (bumped by /recover and /reset to revoke every older token).
//
// Password reset by email: /forgot stores a single-use 32-byte token by its SHA-256 for 30 minutes and emails
// PLAY_URL?reset=<token> through the provider in email.js; /reset trades it for a new password. The reset
// record carries the user's tokenGen, so a reset (or a recovery) kills every older reset link as well.
//
// KV (binding ACCOUNTS)
//   user:{email}          -> {id, email, pw:{salt,hash,iter}, rec:{salt,hash,iter}, tokenGen, createdAt}
//   tok:{sha256(token)}   -> {userId, email, gen, createdAt, refreshedAt}     (expirationTtl 30 days, slid on use)
//   reset:{sha256(token)} -> {userId, email, gen, createdAt}                  (expirationTtl 30 minutes, deleted on use)
//   save:{userId}         -> {version, updatedAt, size, summary:{name, day, level, credits, am, sectors, rank}, profile}
//   rl:{bucket}:{ip}      -> {count, resetAt}                                 (expires with the window)
//   rl:forgotEmail:{email}-> {count, resetAt}                                 (the per-address limit on /forgot)
//
// Environment (wrangler.toml [vars] / `wrangler secret put`)
//   ALLOWED_ORIGIN   comma-separated list of site origins allowed to call this worker
//   PEPPER           secret; a long random string appended to every password and phrase before hashing
//   EMAIL_PROVIDER, EMAIL_FROM, EMAIL_FROM_FALLBACK, PLAY_URL and the secret EMAIL_API_KEY: see email.js
// ============================================================
import {
  HttpError, LIMITS, WORDS, PBKDF2_ITER, TOKEN_BYTES, TOKEN_TTL_S, TOKEN_REFRESH_MS, RESET_TOKEN_TTL_S, SAVE_MAX_BYTES, BODY_MAX_BYTES, PASSWORD_MAX, PHRASE_WORDS, TOKEN_RE,
  b64u, randomBytes, decodeUtf8, utf8Length, sha256Hex, hashSecret, verifySecret, makePhrase, normalisePhrase, newId,
  readBodyBytes, requireEmail, requirePassword, summarise,
} from './lib.js';
import { emailConfig, resetEmail, resetLink, sendEmail, RESET_MINUTES } from './email.js';

const ROUTES = {
  '/health':  { GET: health },
  '/signup':  { POST: signup },
  '/login':   { POST: login },
  '/logout':  { POST: logout },
  '/recover': { POST: recover },
  '/forgot':  { POST: forgot },
  '/reset':   { POST: reset },
  '/me':      { GET: me },
  '/save':    { GET: getSave, PUT: putSave },
  '/account': { DELETE: deleteAccount },
};

export default {
  fetch(request, env, ectx) {
    return handle(request, env, { waitUntil: ectx && typeof ectx.waitUntil === 'function' ? p => ectx.waitUntil(p) : null });
  },
};

// ---------------------------------------------------------- dispatch
// opts.now (ms clock), opts.fetch (the provider call) and opts.waitUntil (background work after the response;
// without it the work is awaited inline) are injectable for the tests; everything else comes from the request.
export async function handle(request, env, opts = {}) {
  const url = new URL(request.url);
  const cors = corsHeaders(request.headers.get('Origin'), env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ctx = {
    now: typeof opts.now === 'function' ? opts.now : Date.now, ip: clientIp(request),
    fetch: typeof opts.fetch === 'function' ? opts.fetch : undefined,
    waitUntil: typeof opts.waitUntil === 'function' ? opts.waitUntil : null,
  };
  try {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const route = ROUTES[path];
    if (!route) throw new HttpError(404, 'not-found', `No route for ${path}.`);
    const fn = route[request.method];
    if (!fn) throw new HttpError(405, 'method-not-allowed', `${request.method} is not allowed on ${path}.`, { allow: Object.keys(route) });
    const result = await fn(request, url, env, ctx);
    return json(result.status || 200, result.data, cors);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message, ...err.extra }, { ...cors, ...err.headers });
    console.error('account: unhandled error', err && err.message);
    return json(500, { error: 'internal', message: 'The account backend hit an unexpected error.' }, cors);
  }
}

function json(status, data, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = request.headers.get('X-Forwarded-For');
  return xff ? xff.split(',')[0].trim() : 'unknown';
}

// ---------------------------------------------------------- CORS (the site origin only)
export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '').split(',').map(normaliseOrigin).filter(Boolean);
}
const normaliseOrigin = o => String(o || '').trim().replace(/\/+$/, '').toLowerCase();

export function corsHeaders(origin, env) {
  if (!origin || !allowedOrigins(env).includes(normaliseOrigin(origin))) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

// ---------------------------------------------------------- config and bodies
function kv(env) {
  if (!env.ACCOUNTS || typeof env.ACCOUNTS.get !== 'function') throw new HttpError(500, 'config', 'The ACCOUNTS KV namespace is not bound. Check wrangler.toml.');
  return env.ACCOUNTS;
}
function pepper(env) {
  if (!env.PEPPER || String(env.PEPPER).length < 16) throw new HttpError(500, 'config', 'PEPPER is not set. Run `wrangler secret put PEPPER` with a long random string.');
  return String(env.PEPPER);
}
async function readJsonBody(request) {
  const bytes = await readBodyBytes(request, BODY_MAX_BYTES);
  let body;
  try { body = JSON.parse(decodeUtf8(bytes)); } catch (e) { throw new HttpError(400, 'bad-json', 'The request body must be JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad-json', 'The request body must be a JSON object.');
  return body;
}

// ---------------------------------------------------------- rate limits (A2.1): per IP (or per `who`), in KV
async function rateLimit(env, ctx, bucket, who = ctx.ip) {
  const L = LIMITS[bucket], key = `rl:${bucket}:${who}`, now = ctx.now();
  const rec = await kv(env).get(key, 'json');
  const live = rec && rec.resetAt > now ? rec : { count: 0, resetAt: now + L.windowS * 1000 };
  live.count++;
  const retryAfter = Math.max(1, Math.ceil((live.resetAt - now) / 1000));
  if (live.count > L.max) {
    throw new HttpError(429, 'rate-limited', `Too many attempts. Try again in ${describeWait(retryAfter)}.`, { retryAfter }, { 'retry-after': String(retryAfter) });
  }
  await kv(env).put(key, JSON.stringify(live), { expirationTtl: Math.max(60, retryAfter) });
}
const describeWait = s => (s >= 120 ? `${Math.ceil(s / 60)} minutes` : s >= 60 ? 'a minute or two' : `${s} seconds`);

// ---------------------------------------------------------- users and tokens
const userKey = email => `user:${email}`;
const saveKey = userId => `save:${userId}`;
const tokenKey = async token => `tok:${await sha256Hex(token)}`;
const resetKey = async token => `reset:${await sha256Hex(token)}`;
const publicUser = u => ({ id: u.id, email: u.email });

async function issueToken(env, user, now) {
  const token = b64u(randomBytes(TOKEN_BYTES));
  const rec = { userId: user.id, email: user.email, gen: user.tokenGen || 1, createdAt: now, refreshedAt: now };
  await kv(env).put(await tokenKey(token), JSON.stringify(rec), { expirationTtl: TOKEN_TTL_S });
  return token;
}

// Bearer auth. Slides the token's TTL when it was last refreshed more than TOKEN_REFRESH_MS ago.
export async function authenticate(request, env, ctx) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!m || !TOKEN_RE.test(m[1])) throw new HttpError(401, 'unauthorised', 'Sign in to continue.');
  const key = await tokenKey(m[1]);
  const rec = await kv(env).get(key, 'json');
  if (!rec) throw new HttpError(401, 'unauthorised', 'This sign-in has expired. Sign in again.');
  const user = await kv(env).get(userKey(rec.email), 'json');
  if (!user || user.id !== rec.userId || (user.tokenGen || 1) !== rec.gen) {
    await kv(env).delete(key);
    throw new HttpError(401, 'unauthorised', 'This sign-in is no longer valid. Sign in again.');
  }
  const now = ctx.now();
  if (now - (rec.refreshedAt || rec.createdAt || 0) > TOKEN_REFRESH_MS) {
    rec.refreshedAt = now;
    await kv(env).put(key, JSON.stringify(rec), { expirationTtl: TOKEN_TTL_S });
  }
  return { user, tokenKey: key };
}

const saveMeta = rec => (rec ? { version: rec.version, updatedAt: rec.updatedAt, size: rec.size, summary: rec.summary } : null);

// ---------------------------------------------------------- GET /health
async function health(request, url, env) {
  const mail = emailConfig(env);
  return {
    data: {
      ok: true,
      service: 'waystation-account',
      kv: Boolean(env.ACCOUNTS && typeof env.ACCOUNTS.get === 'function'),
      pepper: Boolean(env.PEPPER && String(env.PEPPER).length >= 16),
      emailFrom: mail.from,
      emailFromFallback: mail.fallback || null,
      email: { provider: mail.provider, from: mail.from, fromFallback: mail.fallback || null, playUrl: mail.playUrl, configured: mail.configured, missing: mail.missing, resetMinutes: RESET_MINUTES },
      allowedOrigins: allowedOrigins(env),
      limits: LIMITS,
      tokenTtlDays: TOKEN_TTL_S / 86400,
      saveMaxBytes: SAVE_MAX_BYTES,
      pbkdf2Iterations: PBKDF2_ITER,
      words: WORDS.length,
    },
  };
}

// ---------------------------------------------------------- POST /signup
async function signup(request, url, env, ctx) {
  const body = await readJsonBody(request);
  const email = requireEmail(body.email);
  const password = requirePassword(body.password);
  const pep = pepper(env);
  await rateLimit(env, ctx, 'signup');
  if (await kv(env).get(userKey(email))) throw new HttpError(409, 'email-taken', 'An account with that email already exists. Sign in instead.');
  const now = ctx.now();
  const phrase = makePhrase();
  const user = { id: newId(), email, pw: await hashSecret(password, pep), rec: await hashSecret(normalisePhrase(phrase), pep), tokenGen: 1, createdAt: now };
  await kv(env).put(userKey(email), JSON.stringify(user));
  const token = await issueToken(env, user, now);
  return { status: 201, data: { token, user: publicUser(user), recovery: phrase } };
}

// ---------------------------------------------------------- POST /login
async function login(request, url, env, ctx) {
  const body = await readJsonBody(request);
  const email = requireEmail(body.email);
  if (typeof body.password !== 'string' || !body.password) throw new HttpError(400, 'bad-password', 'Enter your password.');
  const pep = pepper(env);
  await rateLimit(env, ctx, 'login');
  const user = await kv(env).get(userKey(email), 'json');
  const ok = user ? await verifySecret(body.password.slice(0, PASSWORD_MAX), pep, user.pw) : false;
  if (!ok) throw new HttpError(401, 'bad-credentials', 'That email and password do not match.');
  const token = await issueToken(env, user, ctx.now());
  return { data: { token, user: publicUser(user) } };
}

// ---------------------------------------------------------- POST /logout
async function logout(request, url, env, ctx) {
  const auth = await authenticate(request, env, ctx);
  await kv(env).delete(auth.tokenKey);
  return { data: { ok: true } };
}

// ---------------------------------------------------------- POST /recover (new password + new phrase; revokes every token)
async function recover(request, url, env, ctx) {
  const body = await readJsonBody(request);
  const email = requireEmail(body.email);
  const phrase = normalisePhrase(body.recovery);
  if (phrase.split(' ').length < PHRASE_WORDS) throw new HttpError(400, 'bad-recovery', `Enter all ${PHRASE_WORDS} words of your recovery phrase.`);
  const newPassword = requirePassword(body.newPassword, 'new password');
  const pep = pepper(env);
  await rateLimit(env, ctx, 'recover');
  const user = await kv(env).get(userKey(email), 'json');
  const ok = user ? await verifySecret(phrase, pep, user.rec) : false;
  if (!ok) throw new HttpError(401, 'bad-recovery', 'That email and recovery phrase do not match.');
  const now = ctx.now();
  const fresh = makePhrase();
  user.pw = await hashSecret(newPassword, pep);
  user.rec = await hashSecret(normalisePhrase(fresh), pep);
  user.tokenGen = (user.tokenGen || 1) + 1;
  user.recoveredAt = now;
  await kv(env).put(userKey(email), JSON.stringify(user));
  const token = await issueToken(env, user, now);
  return { data: { token, user: publicUser(user), recovery: fresh } };
}

// ---------------------------------------------------------- POST /forgot (always {ok:true}: never says whether the address has an account)
async function forgot(request, url, env, ctx) {
  const body = await readJsonBody(request);
  const email = requireEmail(body.email);
  const mail = emailConfig(env);
  if (!mail.configured) throw new HttpError(503, 'email-not-configured', 'Password reset by email is not set up on this build yet. Use your recovery phrase instead.', { missing: mail.missing });
  await rateLimit(env, ctx, 'forgot');
  await rateLimit(env, ctx, 'forgotEmail', email);
  const user = await kv(env).get(userKey(email), 'json');
  if (user) {
    const now = ctx.now();
    const token = b64u(randomBytes(TOKEN_BYTES));
    await kv(env).put(await resetKey(token), JSON.stringify({ userId: user.id, email, gen: user.tokenGen || 1, createdAt: now }), { expirationTtl: RESET_TOKEN_TTL_S });
    const link = resetLink(mail.playUrl, token);
    const message = resetEmail({ email, link, playUrl: mail.playUrl, minutes: RESET_MINUTES });
    // the send runs after the response when the runtime allows it, so the answer takes the same time either way
    const job = sendEmail(env, { to: email, ...message }, ctx.fetch).then(r => {
      if (!r.ok) console.error('account: reset email not sent', r.error);
      else if (r.from && r.from !== mail.from) console.warn(`account: ${mail.from} is not verified with the email provider; the reset email went out from ${r.from}`);
      return r;
    });
    if (ctx.waitUntil) ctx.waitUntil(job); else await job;
  }
  return { data: { ok: true } };
}

// ---------------------------------------------------------- POST /reset (a link from /forgot -> new password + new phrase; revokes every token)
async function reset(request, url, env, ctx) {
  const body = await readJsonBody(request);
  if (typeof body.token !== 'string' || !TOKEN_RE.test(body.token)) throw new HttpError(400, 'bad-token', 'This reset link is not valid. Ask for a new one.');
  const newPassword = requirePassword(body.newPassword, 'new password');
  const pep = pepper(env);
  await rateLimit(env, ctx, 'reset');
  const key = await resetKey(body.token);
  const store = kv(env);
  const rec = await store.get(key, 'json');
  const dead = new HttpError(401, 'bad-token', 'This reset link has expired or was already used. Ask for a new one.');
  if (!rec) throw dead;
  const user = await store.get(userKey(rec.email), 'json');
  if (!user || user.id !== rec.userId || (user.tokenGen || 1) !== rec.gen) { await store.delete(key); throw dead; }
  await store.delete(key);                                   // single use
  const now = ctx.now();
  const fresh = makePhrase();
  user.pw = await hashSecret(newPassword, pep);
  user.rec = await hashSecret(normalisePhrase(fresh), pep);
  user.tokenGen = (user.tokenGen || 1) + 1;
  user.resetAt = now;
  await store.put(userKey(rec.email), JSON.stringify(user));
  const token = await issueToken(env, user, now);
  return { data: { token, user: publicUser(user), recovery: fresh } };
}

// ---------------------------------------------------------- GET /me
async function me(request, url, env, ctx) {
  const { user } = await authenticate(request, env, ctx);
  const rec = await kv(env).get(saveKey(user.id), 'json');
  return { data: { user: publicUser(user), save: saveMeta(rec) } };
}

// ---------------------------------------------------------- GET /save
async function getSave(request, url, env, ctx) {
  const { user } = await authenticate(request, env, ctx);
  const rec = await kv(env).get(saveKey(user.id), 'json');
  if (!rec) throw new HttpError(404, 'no-save', 'There is no cloud save for this account yet.');
  return { data: { ...saveMeta(rec), profile: rec.profile } };
}

// ---------------------------------------------------------- PUT /save (optimistic concurrency on baseVersion)
async function putSave(request, url, env, ctx) {
  const { user } = await authenticate(request, env, ctx);
  const body = await readJsonBody(request);
  const profile = body.profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new HttpError(400, 'bad-profile', 'The body must carry a profile object.');
  const base = body.baseVersion == null ? 0 : Number(body.baseVersion);
  if (!Number.isInteger(base) || base < 0) throw new HttpError(400, 'bad-version', 'baseVersion must be a non-negative integer (0 when there is no cloud save yet).');
  const size = utf8Length(JSON.stringify(profile));
  if (size > SAVE_MAX_BYTES) throw new HttpError(413, 'too-large', `The profile is ${size} bytes; the cloud save limit is ${SAVE_MAX_BYTES} bytes.`, { max: SAVE_MAX_BYTES, size });
  if (profile.v !== 2 || !profile.sectors || typeof profile.sectors !== 'object') throw new HttpError(400, 'bad-profile', 'Not a Port Solace v2 profile.');

  const key = saveKey(user.id);
  const existing = await kv(env).get(key, 'json');
  const current = existing ? existing.version : 0;
  if (base !== current) {
    throw new HttpError(409, 'conflict', 'The cloud save changed since this device last synced.', {
      server: existing ? { version: existing.version, updatedAt: existing.updatedAt, summary: existing.summary } : { version: 0, updatedAt: null, summary: null },
    });
  }
  const rec = { version: current + 1, updatedAt: new Date(ctx.now()).toISOString(), size, summary: summarise(profile), profile };
  await kv(env).put(key, JSON.stringify(rec));
  return { data: saveMeta(rec) };
}

// ---------------------------------------------------------- DELETE /account
async function deleteAccount(request, url, env, ctx) {
  const auth = await authenticate(request, env, ctx);
  const body = await readJsonBody(request);
  if (typeof body.password !== 'string' || !body.password) throw new HttpError(400, 'bad-password', 'Enter your password to delete the account.');
  if (!(await verifySecret(body.password.slice(0, PASSWORD_MAX), pepper(env), auth.user.pw))) throw new HttpError(401, 'bad-credentials', 'That password is not right.');
  const store = kv(env);
  await store.delete(saveKey(auth.user.id));
  await store.delete(userKey(auth.user.email));
  await store.delete(auth.tokenKey);          // other tokens die on their next use (their user is gone) or at their TTL
  return { data: { ok: true } };
}

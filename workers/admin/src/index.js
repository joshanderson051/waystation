// ============================================================
// PORT SOLACE — Port Authority front door: Cloudflare module Worker (DESIGN2.md Addendum A9.7)
// Serves the owner's player portal at https://admin.portsolace.com/ and nowhere else (custom domain only,
// workers_dev off). Nothing but the sign-in page loads without a signed session cookie. WebCrypto only; no SDK,
// no npm runtime dependencies. Same house style as workers/account and workers/store.
//
// Routes (every response carries the security headers below; HTML, /login and /api answers are no-store)
//   GET  /login                 the sign-in page (public/login.html); 302 to / when already signed in
//   GET  /login.js, /login.css, /favicon.svg, /robots.txt      public, no session needed
//   POST /login   {email, password} (JSON or form)  -> {ok, email} + Set-Cookie   (Origin must be SITE_ORIGIN)
//                 401 bad-credentials | 403 not-admin | 429 rate-limited {retryAfter} | 502 account-unavailable
//   POST /logout                                     -> {ok}, account token revoked, cookie cleared (Origin checked)
//   GET  /api/session                                -> {email}
//   *    /api/admin/...         proxied to the account Worker at /admin/... with the session's Bearer token
//   GET  anything else          the portal's static files (public/), session required:
//                               a page load without one -> 302 /login, any other request -> 401 login-required
//
// Session cookie "__Host-ps_admin" = base64url(JSON {t, e, iat, exp}) + "." + base64url(HMAC-SHA256(SESSION_SECRET))
//   t is the account Worker's sign-in token, e the admin's email; 12 hours absolute (no sliding).
//   HttpOnly; Secure; SameSite=Strict; Path=/. A malformed, tampered or expired cookie counts as no session and
//   is cleared. The account Worker still decides who is an admin (ADMIN_EMAILS + ADMIN_USER_IDS) on every call.
//
// Bindings and environment (wrangler.toml / `wrangler secret put`)
//   ACCOUNT          service binding to the account Worker (script "waystation-account")
//   ASSETS           the static files in public/ (run_worker_first, so every request passes through here)
//   SITE_ORIGIN      "https://admin.portsolace.com"; state-changing requests must carry this Origin
//   SESSION_SECRET   secret, at least 32 random bytes; without it every request answers 503 (fail closed)
// ============================================================

import {
  COOKIE, SESSION_TTL_S, LOGIN_BODY_MAX, PROXY_BODY_MAX, SECRET_MIN, CLOCK_SKEW_S, ACCOUNT_BASE, TOKEN_RE, COOKIE_RE,
  PUBLIC_ASSETS, PROXY_METHODS, ROBOTS, SECURITY_HEADERS,
} from './lib.js';

export default {
  fetch(request, env, ectx) {
    return handle(request, env, { waitUntil: ectx && typeof ectx.waitUntil === 'function' ? p => ectx.waitUntil(p) : null });
  },
};

class HttpError extends Error {
  constructor(status, code, message, extra, headers) { super(message); this.status = status; this.code = code; this.extra = extra || {}; this.headers = headers || {}; }
}

// ---------------------------------------------------------- dispatch
// opts.now (ms clock) is injectable for the tests.
export async function handle(request, env, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const ctx = { now, clear: false };
  try {
    const cfg = config(env);
    if (!cfg) return finish(json(503, { error: 'not-configured', message: 'Port Authority is not configured yet.' }), ctx);
    ctx.cfg = cfg;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    ctx.session = await readSession(request, cfg, ctx);

    let res;
    if (path === '/login') res = await loginRoute(request, method, env, ctx);
    else if (path === '/logout') res = await logoutRoute(request, method, env, ctx);
    else if (path === '/robots.txt') res = staticOnly(method) || text(200, ROBOTS);
    else if (PUBLIC_ASSETS.has(path)) res = staticOnly(method) || await asset(env, request, false);
    else if (path === '/api' || path.startsWith('/api/')) res = await apiRoute(request, method, url, env, ctx);
    else res = staticOnly(method) || (ctx.session ? await asset(env, request, true) : loginRequired(request, method, path));
    return finish(res, ctx);
  } catch (err) {
    if (err instanceof HttpError) return finish(json(err.status, { error: err.code, message: err.message, ...err.extra }, err.headers), ctx);
    console.error('admin: unhandled error', err && err.message);
    return finish(json(500, { error: 'internal', message: 'Port Authority hit an unexpected error.' }), ctx);
  }
}

function config(env) {
  const secret = typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET : '';
  const origin = normaliseOrigin(env.SITE_ORIGIN);
  if (secret.length < SECRET_MIN || !origin) return null;
  if (!env.ACCOUNT || typeof env.ACCOUNT.fetch !== 'function') return null;
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  return { secret, origin };
}
const normaliseOrigin = o => String(o || '').trim().replace(/\/+$/, '').toLowerCase();

// ---------------------------------------------------------- responses
function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
function text(status, body) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
function redirect(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}
function methodNotAllowed(allow) {
  return json(405, { error: 'method-not-allowed', message: 'That method is not allowed here.' }, { allow: allow.join(', ') });
}
const staticOnly = method => (method === 'GET' || method === 'HEAD' ? null : methodNotAllowed(['GET', 'HEAD']));

// Every response leaves through here: a fresh Response (so headers are mutable) with the security headers, and the
// session cookie cleared when this request carried a bad one or the route asked for it.
function finish(res, ctx) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  const type = out.headers.get('content-type') || '';
  if (/^text\/html/i.test(type)) out.headers.set('cache-control', 'no-store');
  if (ctx.clear) out.headers.append('set-cookie', clearCookie());
  return out;
}

// Static files: the portal's (session) ones are private to the browser; HTML is never stored.
async function asset(env, request, privateFile) {
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  if (privateFile) out.headers.set('cache-control', 'private, no-cache');
  return out;
}

function loginRequired(request, method, path) {
  const accept = request.headers.get('accept') || '';
  const navigation = (method === 'GET' || method === 'HEAD') && (/text\/html/i.test(accept) || path.endsWith('/') || path.endsWith('.html'));
  return navigation ? redirect('/login') : json(401, { error: 'login-required', message: 'Sign in to Port Authority first.' });
}

function requireOrigin(request, ctx) {
  const origin = request.headers.get('origin');
  if (!origin || normaliseOrigin(origin) !== ctx.cfg.origin) throw new HttpError(403, 'bad-origin', 'This request did not come from Port Authority.');
}

// ---------------------------------------------------------- base64url and HMAC
const enc = new TextEncoder();
const dec = new TextDecoder();
function b64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
let keyCache = { secret: null, key: null };
async function hmacKey(secret) {
  if (keyCache.secret !== secret) {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache = { secret, key };
  }
  return keyCache.key;
}
async function sign(secret, payload) {
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload))));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------------------------------------------------------- the session cookie
const COOKIE_ATTRS = 'HttpOnly; Secure; SameSite=Strict; Path=/';
const clearCookie = () => `${COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;

export async function makeSessionCookie(secret, token, email, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const payload = b64u(enc.encode(JSON.stringify({ t: token, e: email, iat, exp: iat + SESSION_TTL_S })));
  return `${COOKIE}=${payload}.${await sign(secret, payload)}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_S}`;
}

function cookieValue(request) {
  const raw = request.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

// -> {token, email, exp} or null. A present but unusable cookie marks the response to clear it.
async function readSession(request, cfg, ctx) {
  const value = cookieValue(request);
  if (value === null) return null;
  const session = await verifySession(value, cfg.secret, ctx.now());
  if (!session) ctx.clear = true;
  return session;
}
export async function verifySession(value, secret, nowMs) {
  if (typeof value !== 'string' || !COOKIE_RE.test(value)) return null;
  const dot = value.indexOf('.');
  const payload = value.slice(0, dot), sig = value.slice(dot + 1);
  if (!safeEqual(sig, await sign(secret, payload))) return null;
  let data;
  try { data = JSON.parse(dec.decode(unb64u(payload))); } catch (e) { return null; }
  if (!data || typeof data !== 'object') return null;
  const { t, e, iat, exp } = data;
  const now = Math.floor(nowMs / 1000);
  if (typeof t !== 'string' || !TOKEN_RE.test(t) || typeof e !== 'string' || e.length > 254) return null;
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return null;
  if (exp <= now || exp - iat > SESSION_TTL_S || iat > now + CLOCK_SKEW_S) return null;
  return { token: t, email: e, exp };
}

// ---------------------------------------------------------- bodies
async function readBody(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, 'too-large', 'The request body is too large.');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch (e) { /* already closed */ } throw new HttpError(413, 'too-large', 'The request body is too large.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
async function readCredentials(request) {
  const raw = dec.decode(await readBody(request, LOGIN_BODY_MAX));
  const type = (request.headers.get('content-type') || '').toLowerCase();
  let email, password;
  if (type.startsWith('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(raw);
    email = form.get('email'); password = form.get('password');
  } else {
    let body;
    try { body = JSON.parse(raw); } catch (e) { throw new HttpError(400, 'bad-request', 'Enter your email and password.'); }
    if (body && typeof body === 'object') { email = body.email; password = body.password; }
  }
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    throw new HttpError(400, 'bad-request', 'Enter your email and password.');
  }
  return { email: email.trim().toLowerCase(), password };
}

// ---------------------------------------------------------- the account Worker (service binding ACCOUNT)
function upstreamHeaders(request, token, extra = {}) {
  const h = new Headers(extra);
  if (token) h.set('authorization', `Bearer ${token}`);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) h.set('cf-connecting-ip', ip);
  return h;
}
async function account(env, request, path, init, token) {
  try {
    return await env.ACCOUNT.fetch(new Request(ACCOUNT_BASE + path, { ...init, headers: upstreamHeaders(request, token, init.headers) }));
  } catch (err) {
    console.error('admin: account worker unreachable', err && err.message);
    return null;
  }
}
async function readJson(res) {
  try { return await res.json(); } catch (e) { return null; }
}
async function revoke(env, request, token) {
  const res = await account(env, request, '/logout', { method: 'POST' }, token);
  if (res && res.body) { try { await res.body.cancel(); } catch (e) { /* ignore */ } }
}
async function retryAfterOf(res) {
  const data = await readJson(res);
  const n = Number((data && data.retryAfter) || res.headers.get('retry-after'));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60;
}
function rateLimited(retryAfter) {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  return json(429, { error: 'rate-limited', retryAfter, message: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` }, { 'retry-after': String(retryAfter) });
}
const unavailable = () => json(502, { error: 'account-unavailable', message: 'The Port Solace account service is unavailable. Try again in a minute.' });

// ---------------------------------------------------------- /login
async function loginRoute(request, method, env, ctx) {
  if (method === 'GET' || method === 'HEAD') {
    if (ctx.session) return redirect('/');
    const page = await env.ASSETS.fetch(new Request(new URL('/login', request.url).toString(), { method, headers: { accept: 'text/html' } }));
    const out = new Response(page.body, page);
    out.headers.set('cache-control', 'no-store');
    return out;
  }
  if (method !== 'POST') return methodNotAllowed(['GET', 'HEAD', 'POST']);
  requireOrigin(request, ctx);
  const creds = await readCredentials(request);

  const res = await account(env, request, '/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds),
  });
  if (!res) return unavailable();
  if (res.status === 401 || res.status === 400) return json(401, { error: 'bad-credentials', message: 'That email and password do not match.' });
  if (res.status === 429) return rateLimited(await retryAfterOf(res));
  if (res.status !== 200) return unavailable();
  const data = await readJson(res);
  const token = data && data.token;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return unavailable();
  const userEmail = data.user && typeof data.user.email === 'string' && data.user.email ? data.user.email.toLowerCase() : creds.email;

  // The account Worker decides who is an admin: an admin-only call tells us.
  const check = await account(env, request, '/admin/stats', { method: 'GET' }, token);
  const status = check ? check.status : 0;
  if (check && check.body) { try { await check.body.cancel(); } catch (e) { /* ignore */ } }
  if (status === 200) {
    if (ctx.session && ctx.session.token !== token) await revoke(env, request, ctx.session.token);   // signing in again replaces the old session
    ctx.clear = false;
    return json(200, { ok: true, email: userEmail }, { 'set-cookie': await makeSessionCookie(ctx.cfg.secret, token, userEmail, ctx.now()) });
  }
  await revoke(env, request, token);
  if (status === 403) return json(403, { error: 'not-admin', message: 'This account is not a Port Authority admin.' });
  if (status === 429) return rateLimited(await retryAfterOf(check));
  return unavailable();
}

// ---------------------------------------------------------- /logout
async function logoutRoute(request, method, env, ctx) {
  if (method !== 'POST') return methodNotAllowed(['POST']);
  requireOrigin(request, ctx);
  if (ctx.session) await revoke(env, request, ctx.session.token);
  ctx.clear = true;
  return json(200, { ok: true });
}

// ---------------------------------------------------------- /api
async function apiRoute(request, method, url, env, ctx) {
  const path = url.pathname;
  if (path === '/api/session') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(['GET', 'HEAD']);
    if (!ctx.session) return json(401, { error: 'login-required', message: 'Sign in to Port Authority first.' });
    return json(200, { email: ctx.session.email });
  }
  if (!ctx.session) return json(401, { error: 'login-required', message: 'Sign in to Port Authority first.' });
  // Only the account Worker's admin API is reachable, and only by a plain path (no encoded slashes or backslashes).
  if (!path.startsWith('/api/admin/') || path.length <= '/api/admin/'.length || /%2f|%5c|\\|\/\//i.test(path)) {
    return json(404, { error: 'not-found', message: 'No such Port Authority route.' });
  }
  if (!PROXY_METHODS.has(method)) return methodNotAllowed([...PROXY_METHODS]);
  if (method !== 'GET') requireOrigin(request, ctx);

  const init = { method, headers: {} };
  const type = request.headers.get('content-type');
  if (type) init.headers['content-type'] = type;
  init.headers.accept = 'application/json';
  if (method !== 'GET') {
    const body = await readBody(request, PROXY_BODY_MAX);
    if (body.byteLength) init.body = body;
  }
  const res = await account(env, request, path.slice('/api'.length) + url.search, init, ctx.session.token);
  if (!res) return unavailable();
  const headers = { 'content-type': res.headers.get('content-type') || 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const retry = res.headers.get('retry-after');
  if (retry) headers['retry-after'] = retry;
  if (res.status === 401) ctx.clear = true;                              // the account token is gone: so is the session
  if (res.status === 403) {                                              // no longer an admin: end the session too
    const body = await res.text();
    let data = null;
    try { data = JSON.parse(body); } catch (e) { /* not JSON */ }
    if (data && data.error === 'not-admin') {
      ctx.clear = true;
      await revoke(env, request, ctx.session.token);
    }
    return new Response(body, { status: 403, headers });
  }
  return new Response(res.body, { status: res.status, headers });
}

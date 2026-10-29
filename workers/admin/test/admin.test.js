// PORT SOLACE — Port Authority front door (workers/admin) tests. node:test, no dependencies.
// The account Worker (service binding ACCOUNT) and the static files (ASSETS) are fakes that record every request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, makeSessionCookie } from '../src/index.js';
import { COOKIE, SECURITY_HEADERS, SESSION_TTL_S } from '../src/lib.js';

const ORIGIN = 'https://admin.portsolace.com';
const SECRET = 'test-secret-0123456789-abcdefghijklmnop';
const TOKEN = 'tok_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const EMAIL = 'owner@example.test';
const IP = '203.0.113.7';
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);

const jsonRes = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

// ---------------------------------------------------------- fakes
function fakeAccount(overrides = {}) {
  const calls = [];
  const script = {
    'POST /login': () => jsonRes(200, { token: TOKEN, user: { id: 'u_owner', email: EMAIL } }),
    'GET /admin/stats': () => jsonRes(200, { players: 3 }),
    'POST /logout': () => jsonRes(200, { ok: true }),
    ...overrides,
  };
  return {
    calls,
    async fetch(input, init) {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
      const call = { method: req.method, url: req.url, host: url.host, path: url.pathname, search: url.search, headers: Object.fromEntries(req.headers), body };
      calls.push(call);
      const fn = script[`${req.method} ${url.pathname}`] || script['*'];
      if (fn) return fn(call);
      return jsonRes(200, { echoed: true, path: url.pathname });
    },
  };
}
function fakeAssets() {
  const files = {
    '/': ['<!doctype html><title>Port Authority</title>', 'text/html; charset=utf-8'],
    '/admin.js': ['/* admin */', 'text/javascript'],
    '/admin.css': ['/* css */', 'text/css'],
    '/login': ['<!doctype html><title>Sign in</title>', 'text/html; charset=utf-8'],
    '/login.js': ['/* login */', 'text/javascript'],
    '/login.css': ['/* login css */', 'text/css'],
    '/favicon.svg': ['<svg/>', 'image/svg+xml'],
  };
  const calls = [];
  return {
    calls,
    async fetch(input) {
      const req = input instanceof Request ? input : new Request(input);
      const path = new URL(req.url).pathname;
      calls.push({ method: req.method, path });
      const f = files[path];
      if (!f) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(req.method === 'HEAD' ? null : f[0], { status: 200, headers: { 'content-type': f[1], 'cache-control': 'public, max-age=0, must-revalidate', etag: '"x"' } });
    },
  };
}
function setup(o = {}) {
  const ACCOUNT = fakeAccount(o.account);
  const ASSETS = fakeAssets();
  const env = { SESSION_SECRET: SECRET, SITE_ORIGIN: ORIGIN, ACCOUNT, ASSETS, ...(o.env || {}) };
  let now = o.now || T0;
  const call = (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.origin) headers.set('origin', init.origin);
    if (!headers.has('cf-connecting-ip') && init.ip !== false) headers.set('cf-connecting-ip', IP);
    const req = new Request(ORIGIN + path, { method: init.method || 'GET', headers, body: init.body });
    return handle(req, env, { now: () => now });
  };
  return { env, ACCOUNT, ASSETS, call, setNow: t => { now = t; } };
}
async function login(t, creds = { email: EMAIL, password: 'hunter2hunter2' }) {
  const res = await t.call('/login', { method: 'POST', origin: ORIGIN, headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) });
  const set = res.headers.get('set-cookie') || '';
  return { res, set, cookie: set.split(';')[0] };
}
const cookiePair = set => set.split(';')[0];
function assertSecurityHeaders(res, label) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(k), v, `${label}: ${k}`);
}
function assertCleared(res, label) {
  const set = res.headers.get('set-cookie') || '';
  assert.match(set, new RegExp(`^${COOKIE}=;`), `${label}: clears the cookie`);
  assert.match(set, /Max-Age=0/, `${label}: Max-Age=0`);
  assert.match(set, /HttpOnly/); assert.match(set, /Secure/); assert.match(set, /SameSite=Strict/); assert.match(set, /Path=\//);
}

// ---------------------------------------------------------- public routes
test('public routes are reachable without a session', async () => {
  const t = setup();
  const page = await t.call('/login', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  for (const p of ['/login.js', '/login.css', '/favicon.svg']) {
    const r = await t.call(p);
    assert.equal(r.status, 200, p);
  }
  const robots = await t.call('/robots.txt');
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
  assert.deepEqual(t.ACCOUNT.calls, []);
});

test('the portal is not served without a session: page loads redirect, other requests get 401', async () => {
  const t = setup();
  for (const [path, accept] of [['/', 'text/html,application/xhtml+xml'], ['/', '*/*'], ['/index.html', '*/*'], ['/some/dir/', '']]) {
    const r = await t.call(path, { headers: accept ? { accept } : {} });
    assert.equal(r.status, 302, path);
    assert.equal(r.headers.get('location'), '/login');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  const head = await t.call('/', { method: 'HEAD', headers: { accept: 'text/html' } });
  assert.equal(head.status, 302);
  for (const path of ['/admin.js', '/admin.css']) {
    const r = await t.call(path, { headers: { accept: '*/*' } });
    assert.equal(r.status, 401, path);
    assert.deepEqual(await r.json(), { error: 'login-required', message: 'Sign in to Port Authority first.' });
  }
  assert.equal((await t.call('/api/session')).status, 401);
  assert.equal((await t.call('/api/admin/stats')).status, 401);
  assert.deepEqual(t.ASSETS.calls, []);
  assert.deepEqual(t.ACCOUNT.calls, []);
});

// ---------------------------------------------------------- POST /login
test('login success sets the session cookie with every attribute and returns no token', async () => {
  const t = setup();
  const { res, set } = await login(t);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ok: true, email: EMAIL });
  assert.ok(!text.includes(TOKEN), 'no token in the body');
  assert.ok(!text.includes('hunter2'), 'no password in the body');
  assert.match(set, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}; `));
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_TTL_S}`]) assert.ok(set.split('; ').includes(attr), attr);
  assert.equal(SESSION_TTL_S, 43200);
  assert.ok(!/Domain=/i.test(set), 'a __Host- cookie has no Domain');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const [loginCall, statsCall] = t.ACCOUNT.calls;
  assert.equal(loginCall.method, 'POST');
  assert.equal(loginCall.url, 'https://account.internal/login');
  assert.equal(loginCall.headers['cf-connecting-ip'], IP);
  assert.equal(loginCall.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(loginCall.body), { email: EMAIL, password: 'hunter2hunter2' });
  assert.equal(statsCall.method, 'GET');
  assert.equal(statsCall.path, '/admin/stats');
  assert.equal(statsCall.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(statsCall.headers['cf-connecting-ip'], IP);
  assert.equal(t.ACCOUNT.calls.length, 2);

  // and the cookie works
  const who = await t.call('/api/session', { cookie: cookiePair(set) });
  assert.equal(who.status, 200);
  assert.deepEqual(await who.json(), { email: EMAIL });
  assert.equal(who.headers.get('cache-control'), 'no-store');
});

test('login accepts a form-encoded body and lowercases the email', async () => {
  const t = setup();
  const res = await t.call('/login', { method: 'POST', origin: ORIGIN, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=Owner%40Example.test&password=hunter2hunter2' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(t.ACCOUNT.calls[0].body), { email: EMAIL, password: 'hunter2hunter2' });
});

test('login with missing fields is a 400 and never reaches the account worker', async () => {
  const t = setup();
  for (const body of ['{}', '{"email":"a@b.cd"}', 'not json', '[]']) {
    const r = await t.call('/login', { method: 'POST', origin: ORIGIN, headers: { 'content-type': 'application/json' }, body });
    assert.equal(r.status, 400, body);
  }
  assert.equal(t.ACCOUNT.calls.length, 0);
});

test('bad credentials answer 401 bad-credentials and set no cookie', async () => {
  const t = setup({ account: { 'POST /login': () => jsonRes(401, { error: 'bad-credentials', message: 'That email and password do not match.' }) } });
  const { res, set } = await login(t);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'bad-credentials');
  assert.equal(set, '');
  assert.equal(t.ACCOUNT.calls.length, 1);
});

test('a non-admin account gets 403 not-admin and its token is revoked', async () => {
  const t = setup({ account: { 'GET /admin/stats': () => jsonRes(403, { error: 'not-admin' }) } });
  const { res, set } = await login(t);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'not-admin', message: 'This account is not a Port Authority admin.' });
  assert.equal(set, '');
  const revoke = t.ACCOUNT.calls.find(c => c.path === '/logout');
  assert.ok(revoke, 'revoked');
  assert.equal(revoke.method, 'POST');
  assert.equal(revoke.headers.authorization, `Bearer ${TOKEN}`);
});

test('429 from the account worker passes through with retryAfter', async () => {
  const t = setup({ account: { 'POST /login': () => jsonRes(429, { error: 'rate-limited', retryAfter: 300 }, { 'retry-after': '300' }) } });
  const { res, set } = await login(t);
  assert.equal(res.status, 429);
  const data = await res.json();
  assert.equal(data.error, 'rate-limited');
  assert.equal(data.retryAfter, 300);
  assert.match(data.message, /5 minutes/);
  assert.equal(res.headers.get('retry-after'), '300');
  assert.equal(set, '');
});

test('account trouble answers 502 account-unavailable (and revokes a token it already got)', async () => {
  let t = setup({ account: { 'POST /login': () => jsonRes(500, { error: 'internal' }) } });
  let r = (await login(t)).res;
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'account-unavailable');

  t = setup({ account: { 'POST /login': () => { throw new Error('down'); } } });
  assert.equal((await login(t)).res.status, 502);

  t = setup({ account: { 'POST /login': () => jsonRes(200, { user: {} }) } });         // no token
  assert.equal((await login(t)).res.status, 502);

  t = setup({ account: { 'GET /admin/stats': () => jsonRes(500, {}) } });
  const out = await login(t);
  assert.equal(out.res.status, 502);
  assert.equal(out.set, '');
  assert.ok(t.ACCOUNT.calls.find(c => c.path === '/logout' && c.headers.authorization === `Bearer ${TOKEN}`));
});

test('login body is capped at 4 KB', async () => {
  const t = setup();
  const r = await t.call('/login', { method: 'POST', origin: ORIGIN, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: 'x'.repeat(5000) }) });
  assert.equal(r.status, 413);
  assert.equal(t.ACCOUNT.calls.length, 0);
});

test('GET /login with a valid session redirects to the console', async () => {
  const t = setup();
  const { cookie } = await login(t);
  const r = await t.call('/login', { cookie, headers: { accept: 'text/html' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
});

// ---------------------------------------------------------- Origin enforcement
test('Origin is enforced on POST /login, POST /logout and non-GET /api', async () => {
  const t = setup();
  for (const origin of [undefined, 'https://evil.example', 'https://portsolace.com', 'null']) {
    const r = await t.call('/login', { method: 'POST', origin, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: 'pw' }) });
    assert.equal(r.status, 403, `login from ${origin}`);
    assert.equal((await r.json()).error, 'bad-origin');
  }
  assert.equal(t.ACCOUNT.calls.length, 0);

  const { cookie } = await login(t);
  t.ACCOUNT.calls.length = 0;
  const out = await t.call('/logout', { method: 'POST', cookie, origin: 'https://evil.example' });
  assert.equal(out.status, 403);
  const gift = await t.call('/api/admin/gifts', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: '{"playerId":"p1234567","credits":1}' });
  assert.equal(gift.status, 403);
  const gift2 = await t.call('/api/admin/gifts', { method: 'POST', cookie, origin: 'https://evil.example', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(gift2.status, 403);
  assert.equal(t.ACCOUNT.calls.length, 0, 'nothing reached the account worker');
  const stats = await t.call('/api/admin/stats', { cookie });                       // GET needs no Origin
  assert.equal(stats.status, 200);
});

// ---------------------------------------------------------- cookies
test('tampered, expired, foreign and malformed cookies are rejected and cleared', async () => {
  const t = setup();
  const { cookie } = await login(t);
  const value = cookie.slice(COOKIE.length + 1);
  const [payload, sig] = value.split('.');
  const flip = s => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  const forged = Buffer.from(JSON.stringify({ t: TOKEN, e: 'mallory@example.test', iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 3600 })).toString('base64url');
  const other = (await makeSessionCookie('another-secret-0123456789-abcdefghijk', TOKEN, EMAIL, T0)).split(';')[0];
  const old = (await makeSessionCookie(SECRET, TOKEN, EMAIL, T0 - (SESSION_TTL_S + 1) * 1000)).split(';')[0];
  const bad = [
    `${COOKIE}=${flip(payload)}.${sig}`,
    `${COOKIE}=${payload}.${flip(sig)}`,
    `${COOKIE}=${forged}.${sig}`,
    other,
    old,
    `${COOKIE}=garbage`,
    `${COOKIE}=a.b`,
    `${COOKIE}=`,
    `${COOKIE}=${payload}`,
    `${COOKIE}=${'A'.repeat(3000)}.${sig}`,
  ];
  for (const c of bad) {
    const nav = await t.call('/', { cookie: c, headers: { accept: 'text/html' } });
    assert.equal(nav.status, 302, c.slice(0, 60));
    assertCleared(nav, c.slice(0, 40));
    const api = await t.call('/api/session', { cookie: c });
    assert.equal(api.status, 401);
    assertCleared(api, 'api');
  }
  // a cookie for some other name is simply absent: no clearing
  const none = await t.call('/api/session', { cookie: 'other=1' });
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('set-cookie'), null);
});

test('the session is absolute: 12 hours after sign-in it is gone', async () => {
  const t = setup();
  const { cookie } = await login(t);
  t.setNow(T0 + (SESSION_TTL_S - 1) * 1000);
  assert.equal((await t.call('/api/session', { cookie })).status, 200);
  t.setNow(T0 + SESSION_TTL_S * 1000);
  const r = await t.call('/api/session', { cookie });
  assert.equal(r.status, 401);
  assertCleared(r, 'expired');
});

test('a cookie with a forged long lifetime is rejected even when correctly signed', async () => {
  // payload signed with the real secret but exp - iat > 12 h: only a leaked secret could produce it, still refused
  const { createHmac } = await import('node:crypto');
  const iat = Math.floor(T0 / 1000);
  const payload = Buffer.from(JSON.stringify({ t: TOKEN, e: EMAIL, iat, exp: iat + 30 * 86400 })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const t = setup();
  assert.equal((await t.call('/api/session', { cookie: `${COOKIE}=${payload}.${sig}` })).status, 401);
  // the same construction with a 12 h lifetime is accepted (the format is what the worker signs)
  const ok = Buffer.from(JSON.stringify({ t: TOKEN, e: EMAIL, iat, exp: iat + SESSION_TTL_S })).toString('base64url');
  const okSig = createHmac('sha256', SECRET).update(ok).digest('base64url');
  assert.equal((await t.call('/api/session', { cookie: `${COOKIE}=${ok}.${okSig}` })).status, 200);
});

// ---------------------------------------------------------- the proxy
test('the proxy rewrites the path, keeps query and body, adds the Bearer and CF-Connecting-IP, strips Cookie and Authorization', async () => {
  const t = setup();
  const { cookie } = await login(t);
  t.ACCOUNT.calls.length = 0;

  const list = await t.call('/api/admin/players?q=ab%20c&active=7d&limit=5', { cookie: `${cookie}; other=1`, headers: { authorization: 'Bearer evil-browser-token-xxxxxxxxxxxxxxxxxxxxxx', accept: 'application/json' } });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const get = t.ACCOUNT.calls[0];
  assert.equal(get.method, 'GET');
  assert.equal(get.host, 'account.internal');
  assert.equal(get.path, '/admin/players');
  assert.equal(get.search, '?q=ab%20c&active=7d&limit=5');
  assert.equal(get.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(get.headers['cf-connecting-ip'], IP);
  assert.equal(get.headers.cookie, undefined);
  assert.equal(get.headers.origin, undefined);

  const body = JSON.stringify({ playerId: 'player-0001', credits: 10000, am: 0, note: 'Thanks', requestId: 'req_12345678' });
  const post = await t.call('/api/admin/gifts', { method: 'POST', cookie, origin: ORIGIN, headers: { 'content-type': 'application/json', authorization: 'Basic Zm9vOmJhcg==' }, body });
  assert.equal(post.status, 200);
  const p = t.ACCOUNT.calls[1];
  assert.equal(p.method, 'POST');
  assert.equal(p.path, '/admin/gifts');
  assert.equal(p.body, body);
  assert.equal(p.headers['content-type'], 'application/json');
  assert.equal(p.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(p.headers.cookie, undefined);

  const revoke = await t.call('/api/admin/gifts/gft_abc/revoke', { method: 'POST', cookie, origin: ORIGIN, headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(revoke.status, 200);
  assert.equal(t.ACCOUNT.calls[2].path, '/admin/gifts/gft_abc/revoke');
});

test('the proxy passes the account worker answer through (status, JSON, retry-after) without its other headers', async () => {
  const t = setup({ account: { 'GET /admin/log': () => jsonRes(429, { error: 'rate-limited', retryAfter: 42 }, { 'retry-after': '42', 'access-control-allow-origin': '*', 'set-cookie': 'x=1' }) } });
  const { cookie } = await login(t);
  const r = await t.call('/api/admin/log?limit=50', { cookie });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '42');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal((await r.json()).retryAfter, 42);
});

test('the proxy refuses paths outside /api/admin/', async () => {
  const t = setup();
  const { cookie } = await login(t);
  t.ACCOUNT.calls.length = 0;
  for (const path of ['/api/me', '/api/login', '/api/admin', '/api/admin/', '/api/save', '/api/admin/..%2Fme', '/api/admin/%5c..%5cme', '/api/admin//x', '/api', '/api/admin/../me']) {
    const r = await t.call(path, { cookie });
    assert.equal(r.status, 404, path);
  }
  assert.equal(t.ACCOUNT.calls.length, 0);
});

test('the proxy caps bodies at 64 KB', async () => {
  const t = setup();
  const { cookie } = await login(t);
  t.ACCOUNT.calls.length = 0;
  const r = await t.call('/api/admin/gifts', { method: 'POST', cookie, origin: ORIGIN, headers: { 'content-type': 'application/json' }, body: 'x'.repeat(65 * 1024) });
  assert.equal(r.status, 413);
  assert.equal(t.ACCOUNT.calls.length, 0);
});

test('an upstream 401 clears the cookie; an upstream 403 not-admin clears it and revokes the token', async () => {
  let t = setup({ account: { 'GET /admin/players': () => jsonRes(401, { error: 'unauthorised' }) } });
  let { cookie } = await login(t);
  const r = await t.call('/api/admin/players', { cookie });
  assert.equal(r.status, 401);
  assertCleared(r, 'upstream 401');

  t = setup({ account: { 'GET /admin/log': () => jsonRes(403, { error: 'not-admin' }) } });
  ({ cookie } = await login(t));
  t.ACCOUNT.calls.length = 0;
  const f = await t.call('/api/admin/log', { cookie });
  assert.equal(f.status, 403);
  assert.equal((await f.json()).error, 'not-admin');
  assertCleared(f, 'upstream 403');
  assert.ok(t.ACCOUNT.calls.find(c => c.path === '/logout' && c.headers.authorization === `Bearer ${TOKEN}`));
});

test('the proxy answers 502 when the account worker is unreachable', async () => {
  const t = setup({ account: { 'GET /admin/players': () => { throw new Error('down'); } } });
  const { cookie } = await login(t);
  const r = await t.call('/api/admin/players', { cookie });
  assert.equal(r.status, 502);
});

// ---------------------------------------------------------- logout
test('logout revokes the account token and clears the cookie; GET /logout is not allowed', async () => {
  const t = setup();
  const { cookie } = await login(t);
  t.ACCOUNT.calls.length = 0;
  const r = await t.call('/logout', { method: 'POST', cookie, origin: ORIGIN });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assertCleared(r, 'logout');
  assert.equal(t.ACCOUNT.calls.length, 1);
  assert.equal(t.ACCOUNT.calls[0].method, 'POST');
  assert.equal(t.ACCOUNT.calls[0].path, '/logout');
  assert.equal(t.ACCOUNT.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(t.ACCOUNT.calls[0].headers['cf-connecting-ip'], IP);

  const g = await t.call('/logout', { cookie });
  assert.equal(g.status, 405);
  assert.equal(g.headers.get('allow'), 'POST');

  // logout without a session still clears and succeeds; a failing revoke is ignored
  const t2 = setup({ account: { 'POST /logout': () => { throw new Error('down'); } } });
  const { cookie: c2 } = await login(t2);
  const r2 = await t2.call('/logout', { method: 'POST', cookie: c2, origin: ORIGIN });
  assert.equal(r2.status, 200);
  const r3 = await t2.call('/logout', { method: 'POST', origin: ORIGIN });
  assert.equal(r3.status, 200);
  assertCleared(r3, 'no session');
});

// ---------------------------------------------------------- static files with a session
test('with a session the portal files come from ASSETS; other methods on static paths are refused', async () => {
  const t = setup();
  const { cookie } = await login(t);
  const page = await t.call('/', { cookie, headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Port Authority/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const js = await t.call('/admin.js', { cookie });
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('cache-control'), 'private, no-cache');
  const missing = await t.call('/nope.txt', { cookie });
  assert.equal(missing.status, 404);
  for (const [method, path] of [['POST', '/'], ['PUT', '/admin.js'], ['DELETE', '/login.js'], ['POST', '/robots.txt'], ['POST', '/favicon.svg'], ['PUT', '/login'], ['DELETE', '/api/session']]) {
    const r = await t.call(path, { method, cookie, origin: ORIGIN });
    assert.equal(r.status, 405, `${method} ${path}`);
  }
  const anon = await t.call('/admin.js', { method: 'POST', origin: ORIGIN });
  assert.equal(anon.status, 405);
  assert.ok(t.ASSETS.calls.every(c => c.method === 'GET' || c.method === 'HEAD'));
});

// ---------------------------------------------------------- headers everywhere
test('every response carries the security headers', async () => {
  const t = setup({ account: { 'GET /admin/log': () => jsonRes(401, {}) } });
  const { res, cookie } = await login(t);
  const responses = [
    ['login POST', res],
    ['login page', await t.call('/login')],
    ['login.js', await t.call('/login.js')],
    ['favicon', await t.call('/favicon.svg')],
    ['robots', await t.call('/robots.txt')],
    ['302', await t.call('/', { headers: { accept: 'text/html' } })],
    ['401', await t.call('/admin.js')],
    ['405', await t.call('/logout')],
    ['403', await t.call('/login', { method: 'POST', body: '{}' })],
    ['portal', await t.call('/', { cookie })],
    ['asset', await t.call('/admin.css', { cookie })],
    ['404 asset', await t.call('/missing.png', { cookie })],
    ['session', await t.call('/api/session', { cookie })],
    ['proxy', await t.call('/api/admin/stats', { cookie })],
    ['proxy 404', await t.call('/api/me', { cookie })],
    ['proxy 401', await t.call('/api/admin/log', { cookie })],
    ['logout', await t.call('/logout', { method: 'POST', cookie, origin: ORIGIN })],
  ];
  for (const [label, r] of responses) assertSecurityHeaders(r, label);
  const unconfigured = setup({ env: { SESSION_SECRET: undefined } });
  assertSecurityHeaders(await unconfigured.call('/login'), '503');
});

// ---------------------------------------------------------- fail closed
test('without SESSION_SECRET (or with a short one) every request answers 503', async () => {
  for (const env of [{ SESSION_SECRET: undefined }, { SESSION_SECRET: '' }, { SESSION_SECRET: 'x'.repeat(31) }, { SITE_ORIGIN: '' }, { ACCOUNT: undefined }, { ASSETS: undefined }]) {
    const t = setup({ env });
    const cookie = (await makeSessionCookie(SECRET, TOKEN, EMAIL, T0)).split(';')[0];
    const reqs = [
      ['/login', {}], ['/login.js', {}], ['/favicon.svg', {}], ['/robots.txt', {}], ['/', { cookie }], ['/admin.js', { cookie }],
      ['/login', { method: 'POST', origin: ORIGIN, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: 'pw' }) }],
      ['/logout', { method: 'POST', origin: ORIGIN, cookie }], ['/api/session', { cookie }], ['/api/admin/stats', { cookie }],
    ];
    for (const [path, init] of reqs) {
      const r = await t.call(path, init);
      assert.equal(r.status, 503, `${JSON.stringify(Object.keys(env))} ${path}`);
      assert.equal((await r.json()).error, 'not-configured');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    if (t.ACCOUNT) assert.equal(t.ACCOUNT.calls.length, 0);
    if (t.ASSETS) assert.equal(t.ASSETS.calls.length, 0);
  }
});

// ---------------------------------------------------------- the Workers runtime's rule for a main module
test('src/index.js exports only handlers and functions (workerd refuses anything else)', async () => {
  const mod = await import('../src/index.js');
  for (const [name, value] of Object.entries(mod)) {
    if (name === 'default') assert.equal(typeof value.fetch, 'function');
    else assert.equal(typeof value, 'function', `export ${name}`);
  }
});

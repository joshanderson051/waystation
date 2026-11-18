// ============================================================
// Port Solace on the Build the Ages hub (waystation/play/js/account.js in a node:vm). With <meta name="bta-hub"> (the
// bta-space Worker adds it at space.buildtheages.com) and authBase set, a login made on the hub or in another world carries
// into Port Solace through one quiet /authorize?prompt=none visit and /handoff/exchange. Without the tag (portsolace.com)
// nothing of this runs.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

import { summarise } from '../src/lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(here, '../../../waystation/play/js/account.js'), 'utf8');
const API = 'https://account.portsolace.com';
const AUTH = 'https://accounts.buildtheages.com';
const PAGE = 'https://space.buildtheages.com/play/';
const USER = { id: 'u_abc123def456ghij', email: 'player@example.com' };
const TOKEN = 'a'.repeat(43), CODE = 'c'.repeat(43), RESET = 'r'.repeat(43);
const T0 = Date.UTC(2026, 10, 18, 12);
const plain = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const nextTurn = () => new Promise(r => setTimeout(r, 0));

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
}
const profile = (over = {}) => ({
  v: 2, playerId: 'p1', savedAt: T0, credits: 5, am: 1, rank: { level: 1 }, activeSector: 'home', unlocked: ['home'],
  sectors: { home: { name: 'Solace', day: 9, level: 2 } }, stats: { buildsPlaced: 4 }, cloud: null, ...over,
});
function fakeMeta(p) {
  return {
    profile: p, saves: 0, imports: 0,
    export() { return JSON.stringify(this.profile); },
    import(json) { this.profile = typeof json === 'string' ? JSON.parse(json) : json; this.imports++; return { ok: true }; },
    save(now = Date.now()) { this.profile.savedAt = now; this.saves++; return true; },
  };
}
const jsonRes = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function fakeFetch(handlers = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url), key = `${init.method || 'GET'} ${u.pathname}`;
    const call = { key, url: String(url), origin: u.origin, query: u.search, headers: init.headers || {}, signal: init.signal, body: typeof init.body === 'string' ? JSON.parse(init.body) : null };
    calls.push(call);
    const h = handlers[key];
    if (!h) return jsonRes(404, { error: 'not-found', message: `unmocked ${key}` });
    const out = typeof h === 'function' ? await h(call) : h;
    return out instanceof Response ? out : jsonRes(out.status || 200, out.data || out);
  };
  fn.calls = calls;
  fn.of = key => calls.filter(c => c.key === key);
  return fn;
}
const backend = (over = {}) => fakeFetch({
  'GET /health': { ok: true, games: ['portsolace', 'greece'] },
  'POST /handoff/exchange': { token: TOKEN, user: USER },
  'GET /me': { user: USER, save: null },
  'PUT /save': { version: 1, updatedAt: new Date(T0).toISOString(), size: 10, summary: summarise(profile()) },
  'POST /logout': { ok: true },
  ...over,
});

function load({ hub = true, authBase = AUTH, href = PAGE, local = fakeStorage(), session = fakeStorage(), fetch = backend(), meta = fakeMeta(profile()), top, navigator, noSession } = {}) {
  const u = new URL(href);
  const assigned = [], replaced = [];
  const tag = { apiBase: API, ...(authBase ? { authBase } : {}) };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextEncoder, TextDecoder, JSON, Promise, Date, Math, Object, Array, Number, String, Boolean, Set, Map, Error, Uint8Array, ArrayBuffer,
    AbortController, Response, crypto,
    localStorage: local, fetch, Meta: meta,
    document: {
      readyState: 'complete', hidden: false, addEventListener() {},
      querySelector: sel => (sel.includes('portsolace-account') ? { getAttribute: n => (n === 'content' ? JSON.stringify(tag) : null) }
        : sel.includes('bta-hub') && hub ? { getAttribute: n => (n === 'content' ? 'https://buildtheages.com/' : null) } : null),
    },
    location: { href: u.href, search: u.search, pathname: u.pathname, hash: u.hash, assign(url) { assigned.push(url); } },
    Sim: { on() {}, emit() {} },
    addEventListener() {},
  };
  if (!noSession) ctx.sessionStorage = session;
  if (navigator) ctx.navigator = navigator;
  ctx.window = ctx;
  ctx.top = top === undefined ? ctx : top;
  ctx.history = { state: null, replaceState(s, t, url) { replaced.push(url); const n = new URL(url, u.href); ctx.location.href = n.href; ctx.location.search = n.search; ctx.location.hash = n.hash; } };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'account.js' });
  const Account = vm.runInContext('Account', ctx);
  Account.configure({ debounceMs: 30, intervalMs: 0 });
  return { Account, ctx, local, session, fetch, meta, assigned, replaced };
}
const STATE_KEY = 'portsolace.account.state', TRIED = 'portsolace.account.silent', SESSION = 'portsolace.account', OUT = 'portsolace.account.signedOut';
// boot() waits a few seconds after starting to leave, as a real browser would have gone by then; these look only at the start.
// The promise is not returned: once leaving, boot() waits on an unref'd timer that would let the event loop end first.
const bootStart = async t => { t.Account.boot(); for (let i = 0; i < 8; i++) await nextTurn(); };

describe('portsolace.com (no hub tag) and a page without authBase: nothing changes', () => {
  for (const [name, opts] of [['no hub tag', { hub: false }], ['no authBase', { authBase: '' }]]) {
    test(`${name}: boot with no token makes no request and never leaves`, async () => {
      const t = load(opts);
      assert.deepEqual(plain(await t.Account.boot()), { status: 'none' });
      assert.deepEqual(t.assigned, []);
      assert.equal(t.fetch.calls.length, 0);
      assert.equal(t.session.map.size, 0);
    });
    test(`${name}: ?code, ?state and ?sso stay in the address and are never exchanged`, async () => {
      const t = load({ ...opts, href: `${PAGE}?code=${CODE}&state=abc&sso=1`, session: fakeStorage({ [STATE_KEY]: 'abc' }) });
      await t.Account.boot();
      assert.deepEqual(t.replaced, []);
      assert.equal(t.fetch.of('POST /handoff/exchange').length, 0);
    });
    test(`${name}: signing out leaves no flag`, async () => {
      const t = load({ ...opts, local: fakeStorage({ [SESSION]: { token: TOKEN, email: USER.email } }) });
      await t.Account.boot();
      await t.Account.logout();
      assert.equal(t.local.map.has(OUT), false);
    });
  }
  test('signIn still declines, so the HUD opens its own form', () => {
    assert.equal(load().Account.signIn, undefined);
  });
});

describe('the quiet visit on space.buildtheages.com', () => {
  test('/health on the accounts host first, then prompt=none for portsolace back to this page', async () => {
    const t = load();
    await bootStart(t);
    assert.equal(t.fetch.of('GET /health').length, 1);
    assert.equal(t.fetch.of('GET /health')[0].origin, AUTH);
    assert.equal(t.assigned.length, 1);
    const go = new URL(t.assigned[0]);
    assert.equal(go.origin + go.pathname, `${AUTH}/authorize`);
    assert.equal(go.searchParams.get('prompt'), 'none');
    assert.equal(go.searchParams.get('game'), 'portsolace');
    assert.equal(go.searchParams.get('return'), PAGE);
    assert.equal(t.session.map.get(TRIED), '1');
    assert.equal(t.session.map.get(STATE_KEY), go.searchParams.get('state'));
  });

  test('it finds the hub\'s login: the code is swapped on the accounts host and the game signs in', async () => {
    const session = fakeStorage();
    await bootStart(load({ session }));
    const state = session.map.get(STATE_KEY);
    const back = load({ session, href: `${PAGE}?code=${CODE}&state=${state}` });
    assert.deepEqual(back.replaced, ['/play/'], 'the code leaves the address bar at once');
    const r = await back.Account.boot();
    const ex = back.fetch.of('POST /handoff/exchange');
    assert.equal(ex.length, 1);
    assert.equal(ex[0].origin, AUTH);
    assert.deepEqual(ex[0].body, { code: CODE, game: 'portsolace' });
    assert.equal(ex[0].headers.authorization, undefined);
    assert.deepEqual(JSON.parse(back.local.map.get(SESSION)), { token: TOKEN, email: USER.email });
    assert.equal(back.Account.state.signedIn, true);
    assert.equal(back.fetch.of('GET /me')[0].origin, API, 'the saves stay on the game\'s own API');
    assert.equal(back.fetch.of('GET /me')[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(r.status, 'local');
    assert.deepEqual(back.assigned, []);
  });

  test('a wrong or missing state is never exchanged', async () => {
    for (const session of [fakeStorage({ [STATE_KEY]: 'other' }), fakeStorage()]) {
      const t = load({ href: `${PAGE}?code=${CODE}&state=abc`, session });
      await bootStart(t);
      assert.equal(t.fetch.of('POST /handoff/exchange').length, 0);
      assert.equal(t.Account.state.signedIn, false);
    }
  });

  test('a dead code is reported to the HUD and the game plays on, with no second trip', async () => {
    const t = load({ href: `${PAGE}?code=${CODE}&state=abc`, session: fakeStorage({ [STATE_KEY]: 'abc', [TRIED]: '1' }), fetch: backend({ 'POST /handoff/exchange': { status: 400, data: { error: 'bad-code', message: 'expired' } } }) });
    assert.deepEqual(plain(await t.Account.boot()), { status: 'none' });
    assert.equal(t.Account.state.signedIn, false);
    assert.deepEqual(plain(t.Account.takeHandoffError()), { code: 'bad-code', status: 400 });
    assert.deepEqual(t.assigned, []);
  });

  test('can never loop: after ?error=login_required and on a reload in the same browser session, nothing happens', async () => {
    const session = fakeStorage();
    await bootStart(load({ session }));
    const state = session.map.get(STATE_KEY);
    const answered = load({ session, href: `${PAGE}?error=login_required&state=${state}` });
    assert.deepEqual(plain(await answered.Account.boot()), { status: 'none' });
    assert.equal(answered.ctx.location.search, '');
    assert.deepEqual(answered.assigned, []);
    const reload = load({ session });
    await reload.Account.boot();
    assert.deepEqual(reload.assigned, []);
    assert.equal(reload.fetch.calls.length, 0);
  });

  const stays = (name, opts) => test(`stays put ${name}`, async () => {
    const t = load(opts);
    await bootStart(t);
    assert.deepEqual(t.assigned, []);
  });
  stays('when sessionStorage is missing', { noSession: true });
  stays('on a checkout\'s return', { href: `${PAGE}?purchase=success&session_id=cs_test_1` });
  stays('on an address with a query of the game\'s own', { href: `${PAGE}?seed=4` });
  stays('with a reset link', { href: `${PAGE}?reset=${RESET}` });
  stays('inside a frame', { top: {} });
  stays('under automation', { navigator: { webdriver: true } });
  stays('when offline', { navigator: { onLine: false } });
  stays('after this player signed out here', { local: fakeStorage({ [OUT]: 'true' }) });
  stays('when the accounts host is down', { fetch: backend({ 'GET /health': () => { throw new Error('network'); } }) });
  stays('when the accounts host does not know Port Solace', { fetch: backend({ 'GET /health': { ok: true, games: ['greece'] } }) });

  test('goes with harmless parameters (an ad\'s utm_ tags, the store app\'s ?app=) and keeps them on the way back', async () => {
    const t = load({ href: `${PAGE}?utm_source=ad&app=android` });
    await bootStart(t);
    assert.equal(t.assigned.length, 1);
    assert.equal(new URL(t.assigned[0]).searchParams.get('return'), `${PAGE}?utm_source=ad&app=android`);
  });

  test('stays put with a good token: the existing boot runs', async () => {
    const t = load({ local: fakeStorage({ [SESSION]: { token: TOKEN, email: USER.email } }) });
    await t.Account.boot();
    assert.deepEqual(t.assigned, []);
    assert.equal(t.fetch.of('GET /health').length, 0);
    assert.equal(t.Account.state.signedIn, true);
  });
});

describe('the hub says it has just signed in (?sso=1)', () => {
  test('the hint leaves the address bar and is not sent back', async () => {
    const t = load({ href: `${PAGE}?sso=1` });
    assert.deepEqual(t.replaced, ['/play/']);
    await bootStart(t);
    assert.equal(new URL(t.assigned[0]).searchParams.get('return'), PAGE);
  });

  test('looks again although this browser session already looked (game opened before the hub sign-in)', async () => {
    const session = fakeStorage({ [TRIED]: '1' });
    const plainLoad = load({ session });
    await bootStart(plainLoad);
    assert.deepEqual(plainLoad.assigned, [], 'without the hint: once per browser session, as before');
    const hinted = load({ session, href: `${PAGE}?sso=1` });
    await bootStart(hinted);
    assert.equal(hinted.assigned.length, 1);
  });

  test('looks again after this player signed out here, and a sign-in lifts the flag', async () => {
    const local = fakeStorage({ [OUT]: 'true' });
    const session = fakeStorage();
    const t = load({ local, session, href: `${PAGE}?sso=1` });
    await bootStart(t);
    assert.equal(t.assigned.length, 1);
    const back = load({ local, session, href: `${PAGE}?code=${CODE}&state=${session.map.get(STATE_KEY)}` });
    await back.Account.boot();
    assert.equal(back.Account.state.signedIn, true);
    assert.equal(local.map.has(OUT), false);
  });

  test('cannot loop either: the answer comes back without the hint', async () => {
    const session = fakeStorage();
    await bootStart(load({ session, href: `${PAGE}?sso=1` }));
    const answered = load({ session, href: `${PAGE}?error=login_required&state=${session.map.get(STATE_KEY)}` });
    await bootStart(answered);
    assert.deepEqual(answered.assigned, []);
  });
});

describe('a token kept here that has expired', () => {
  test('signs out as before, then looks for the hub\'s login even if this browser session already looked', async () => {
    const t = load({ local: fakeStorage({ [SESSION]: { token: TOKEN, email: USER.email } }), session: fakeStorage({ [TRIED]: '1' }), fetch: backend({ 'GET /me': { status: 401, data: { error: 'unauthorised' } } }) });
    await bootStart(t);
    assert.equal(t.Account.state.signedIn, false);
    assert.equal(t.local.map.has(SESSION), false);
    assert.equal(t.assigned.length, 1);
    assert.equal(new URL(t.assigned[0]).searchParams.get('prompt'), 'none');
  });

  test('a cloud that is only unreachable does not leave', async () => {
    const t = load({ local: fakeStorage({ [SESSION]: { token: TOKEN, email: USER.email } }), fetch: backend({ 'GET /me': () => { throw new Error('network'); } }) });
    await bootStart(t);
    assert.deepEqual(t.assigned, []);
  });
});

describe('signing out of Port Solace on the hub\'s address', () => {
  test('stops the quiet sign-in back in the next browser session', async () => {
    const local = fakeStorage({ [SESSION]: { token: TOKEN, email: USER.email } });
    const t = load({ local });
    await t.Account.boot();
    await t.Account.logout();
    assert.equal(local.map.get(OUT), 'true');
    const later = load({ local });
    await bootStart(later);
    assert.deepEqual(later.assigned, []);
  });
});

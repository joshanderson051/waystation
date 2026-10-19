// ============================================================
// WAYSTATION — account client tests (play/js/account.js in a node:vm, DESIGN2.md A2.1)
// A fake document / localStorage / fetch / Sim / Meta / UI; real timers with short debounce and interval
// settings passed through Account.configure. Run with `npm test` in workers/account.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

import { readBodyBytes, summarise as serverSummarise } from '../src/lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(here, '../../../waystation/play/js/account.js'), 'utf8');
const API = 'https://waystation-account.example.workers.dev';
const META = JSON.stringify({ apiBase: API + '/' });
const USER = { id: 'u_abc123def456ghij', email: 'commander@example.com' };
const TOKEN = 'tok_' + 'a'.repeat(39);
const NOT = 'Cloud saves are not connected yet';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const plain = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const same = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
const iso = ms => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

// ---------------------------------------------------------- fakes
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
}
function makeProfile(over = {}) {
  return {
    v: 2, playerId: 'p1', createdAt: T0 - 86400e3, savedAt: T0, credits: 5000, am: 20, rank: { xp: 0, level: 1 },
    activeSector: 'home', unlocked: ['home'], sectors: { home: { name: 'Lantern Reach', day: 9, level: 2, credits: 0, grid: [[null, { id: 'hub' }]] } },
    stats: { buildsPlaced: 4, servedTotal: 3, collects: 2, missionsClaimed: 0 }, cloud: null, ...over,
  };
}
function fakeMeta(profile, Sim) {
  const m = {
    profile, saves: [], imports: [],
    now: () => Date.now(),
    export() { return JSON.stringify(this.profile); },
    import(json) {
      const p = typeof json === 'string' ? JSON.parse(json) : json;
      if (!p || p.v !== 2) return { ok: false, why: 'Not a Waystation v2 profile' };
      this.profile = p; this.imports.push(p);
      this.profile.savedAt = Date.now();
      if (Sim) { Sim.emit('sector', { id: p.activeSector, state: 'switched' }); Sim.emit('change'); }
      return { ok: true };
    },
    save(now = Date.now()) { this.profile.savedAt = now; this.saves.push(now); return true; },
  };
  return m;
}
const jsonRes = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// A scripted backend: handlers by "METHOD /path"; every call is recorded with its parsed body.
function fakeFetch(handlers = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    let body = null;
    if (init.body !== undefined && init.body !== null) {
      const bytes = typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body);
      body = JSON.parse(new TextDecoder().decode(await readBodyBytes(new Request('https://x/', { method: 'POST', body: bytes }), 4 * 1024 * 1024)));
    }
    const call = { key, url: String(url), headers: init.headers || {}, body, keepalive: !!init.keepalive, raw: init.body };
    calls.push(call);
    const h = handlers[key];
    if (!h) return jsonRes(404, { error: 'not-found', message: `unmocked ${key}` });
    const out = typeof h === 'function' ? await h(call) : h;
    return out instanceof Response ? out : jsonRes(out.status || 200, out.data || out);
  };
  fn.calls = calls;
  fn.handlers = handlers;
  fn.of = key => calls.filter(c => c.key === key);
  return fn;
}

// location: an href string gives the vm a window.location (with .search) and a recording window.history.replaceState
function load({ meta = META, storage = fakeStorage(), fetch, profile, Meta: metaOverride, gzip = false, UI, config, location } = {}) {
  const simEvents = [];
  const Sim = { listeners: {}, on(e, f) { (this.listeners[e] ||= []).push(f); }, emit(e, d) { simEvents.push([e, d]); (this.listeners[e] || []).forEach(f => f(d)); } };
  const Meta = metaOverride === null ? undefined : metaOverride || fakeMeta(profile || makeProfile(), Sim);
  const pagehide = [], visibility = [];
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextEncoder, TextDecoder, JSON, Promise, Date, Math, Object, Array, Number, String, Boolean, Set, Map, Error, Uint8Array, ArrayBuffer,
    AbortController, Response,
    localStorage: storage,
    document: {
      readyState: 'complete', hidden: false,
      addEventListener(evt, fn) { if (evt === 'visibilitychange') visibility.push(fn); },
      querySelector(sel) { return meta != null && sel.includes('waystation-account') ? { getAttribute: n => (n === 'content' ? meta : null) } : null; },   // meta: null = no tag
    },
    Sim,
  };
  if (Meta) ctx.Meta = Meta;
  if (fetch) ctx.fetch = fetch;
  if (UI) ctx.UI = UI;
  if (gzip) { ctx.CompressionStream = CompressionStream; ctx.Blob = Blob; }
  ctx.window = ctx;
  ctx.addEventListener = (evt, fn) => { if (evt === 'pagehide') pagehide.push(fn); };
  const replaced = [];
  if (location) {
    const u = new URL(location);
    ctx.location = { href: u.href, search: u.search, pathname: u.pathname, hash: u.hash };
    ctx.history = { state: null, replaceState(state, title, url) { replaced.push(url); ctx.location.href = new URL(url, u.href).href; ctx.location.search = new URL(url, u.href).search; } };
  }
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'account.js' });
  const Account = vm.runInContext('Account', ctx);
  if (config) Account.configure(config);
  const accountEvents = simEvents.filter(e => e[0] === 'account').map(e => e[1]);
  return { Account, ctx, Sim, Meta, storage, simEvents, pagehide, visibility, fetch, replaced, events: () => simEvents.filter(e => e[0] === 'account').map(e => e[1]), accountEvents };
}
const FAST = { debounceMs: 30, intervalMs: 0, graceMs: 5000 };

// The backend's usual answers for a signed-in user with no cloud save, then one after the first push.
function backend({ save = null, profileOnServer = null, failPut = null } = {}) {
  let version = save ? save.version : 0;
  let stored = profileOnServer;
  let updatedAt = save ? save.updatedAt : null;
  const summaryOf = p => serverSummarise(p);
  const h = {
    'POST /signup': c => ({ status: 201, data: { token: TOKEN, user: { id: USER.id, email: c.body.email }, recovery: 'orbit comet nova pulsar quasar nebula planet rocket lunar solar' } }),
    'POST /login': c => (c.body.password === 'orbital-mechanics-42' ? { token: TOKEN, user: USER } : { status: 401, data: { error: 'bad-credentials', message: 'That email and password do not match.' } }),
    'POST /logout': { ok: true },
    'POST /recover': { token: TOKEN + 'r', user: USER, recovery: 'anchor harbor beacon bridge cargo deck dock engine flight gate' },
    'DELETE /account': c => (c.body.password === 'orbital-mechanics-42' ? { ok: true } : { status: 401, data: { error: 'bad-credentials', message: 'That password is not right.' } }),
    'GET /me': c => (c.headers.authorization === `Bearer ${TOKEN}` || c.headers.authorization === `Bearer ${TOKEN}r`
      ? { user: USER, save: version ? { version, updatedAt, size: 1234, summary: summaryOf(stored) } : null }
      : { status: 401, data: { error: 'unauthorised', message: 'Sign in to continue.' } }),
    'GET /save': () => (version ? { version, updatedAt, size: 1234, summary: summaryOf(stored), profile: stored } : { status: 404, data: { error: 'no-save', message: 'none' } }),
    'PUT /save': c => {
      if (failPut) { const f = failPut; failPut = null; return f; }
      if ((c.body.baseVersion || 0) !== version) return { status: 409, data: { error: 'conflict', message: 'changed', server: { version, updatedAt, summary: summaryOf(stored) } } };
      version++; stored = c.body.profile; updatedAt = iso(Date.now());
      return { version, updatedAt, size: JSON.stringify(stored).length, summary: summaryOf(stored) };
    },
  };
  const f = fakeFetch(h);
  f.state = () => ({ version, stored, updatedAt });
  f.set = (v, p, at) => { version = v; stored = p; updatedAt = at; };
  f.failNextPut = r => { failPut = r; };
  return f;
}

// ============================================================ configuration
describe('client: configuration', () => {
  test('without the meta tag nothing is available and every method says so', async () => {
    const { Account, simEvents } = load({ meta: null });
    assert.equal(Account.available, false);
    assert.equal(Account.state.available, false);
    same(await Account.boot(), { status: 'none', why: NOT });
    for (const call of [() => Account.signup('a@b.co', 'long-enough-pw'), () => Account.login('a@b.co', 'x'), () => Account.logout(), () => Account.recover('a@b.co', 'a b c d e f g h i j', 'long-enough-pw'), () => Account.deleteAccount('x'), () => Account.syncNow(), () => Account.pull(), () => Account.push()]) {
      const r = await call();
      assert.equal(r.ok, false); assert.equal(r.why, NOT);
    }
    assert.equal(simEvents.length, 0);
    same(Object.keys(Account.state).sort(), ['available', 'cloud', 'conflict', 'dirty', 'lastError', 'lastSyncAt', 'offline', 'signedIn', 'syncing', 'user']);
  });

  test('reads apiBase from the meta tag (trailing slash stripped), honours the localStorage override, accepts an empty apiBase', () => {
    const a = load();
    assert.equal(a.Account.available, true); assert.equal(a.Account.config.apiBase, API);
    const b = load({ meta: '{"apiBase":""}' });
    assert.equal(b.Account.available, false);
    const c = load({ meta: '{"apiBase":""}', storage: fakeStorage({ 'waystation.account.config': { apiBase: 'http://127.0.0.1:8790/' } }) });
    assert.equal(c.Account.available, true); assert.equal(c.Account.config.apiBase, 'http://127.0.0.1:8790');
    const d = load({ meta: 'not json' });
    assert.equal(d.Account.available, false);
    const s = a.Account.summary(makeProfile());
    same(s, serverSummarise(makeProfile()), 'client and server summaries agree');
  });
});

// ============================================================ sign-up and login
describe('client: signup and login', () => {
  test('signup validates, posts, stores the session, signs in and pushes the local profile as the first cloud save', async () => {
    const fetch = backend();
    const { Account, Meta, storage, events } = load({ fetch, config: FAST });
    same(await Account.signup('nope', 'long-enough-pw'), { ok: false, why: 'Enter a valid email address', code: 'bad-email' });
    same(await Account.signup('a@b.co', 'short'), { ok: false, why: 'Use a password of at least 10 characters', code: 'weak-password' });
    assert.equal(fetch.calls.length, 0);

    const r = await Account.signup(' Commander@Example.com ', 'orbital-mechanics-42');
    assert.equal(r.ok, true); assert.equal(r.status, 'local');
    assert.equal(r.recovery.split(' ').length, 10);
    same(fetch.of('POST /signup')[0].body, { email: 'commander@example.com', password: 'orbital-mechanics-42' });
    assert.equal(fetch.of('POST /signup')[0].headers.authorization, undefined);
    const put = fetch.of('PUT /save');
    assert.equal(put.length, 1);
    assert.equal(put[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(put[0].body.baseVersion, 0);
    assert.equal(put[0].body.profile.sectors.home.name, 'Lantern Reach');
    assert.equal('cloud' in put[0].body.profile, false, 'the marker is not uploaded');
    same(JSON.parse(storage.getItem('waystation.account')), { token: TOKEN, email: 'commander@example.com' });
    const st = Account.state;
    assert.equal(st.signedIn, true); same(st.user, { id: USER.id, email: 'commander@example.com' }); assert.equal(st.dirty, false);
    assert.equal(st.cloud.version, 1); assert.equal(st.conflict, false); assert.ok(st.lastSyncAt);
    assert.equal(Meta.profile.cloud.version, 1); assert.equal(Meta.profile.cloud.userId, USER.id);
    assert.equal(Meta.profile.savedAt, Meta.profile.cloud.syncedAt, 'save(syncedAt) keeps savedAt and syncedAt equal');
    same(events().map(e => e.state), ['signed-in', 'synced']);
    assert.equal(events()[1].direction, 'push'); assert.equal(events()[1].version, 1);
  });

  test('login with a played local profile and an existing cloud save runs the chooser; each answer is honoured', async () => {
    const cloudProfile = makeProfile({ am: 999, sectors: { home: { name: 'Cloud Nine', day: 30, level: 3 } } });
    for (const choice of ['cloud', 'local']) {
      const fetch = backend({ save: { version: 3, updatedAt: iso(T0 + 3600e3) }, profileOnServer: cloudProfile });
      const { Account, Meta, events } = load({ fetch, config: FAST });
      const asked = [];
      Account.ui.choose = async o => { asked.push(o); return choice; };
      const bad = await Account.login('commander@example.com', 'wrong');
      assert.equal(bad.ok, false); assert.equal(bad.code, 'bad-credentials'); assert.equal(Account.state.signedIn, false);
      const r = await Account.login('commander@example.com', 'orbital-mechanics-42');
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(asked.length, 1);
      same(asked[0].local.summary, serverSummarise(makeProfile())); assert.equal(asked[0].local.fresh, false); assert.equal(asked[0].local.savedAt, T0);
      same(asked[0].cloud, { version: 3, updatedAt: iso(T0 + 3600e3), summary: serverSummarise(cloudProfile), size: 1234 });
      assert.equal(r.choice, choice);
      if (choice === 'cloud') {
        assert.equal(r.status, 'cloud');
        assert.equal(Meta.imports.length, 1); assert.equal(Meta.profile.am, 999);
        assert.equal(Meta.profile.cloud.version, 3);
        assert.equal(fetch.of('PUT /save').length, 0);
        assert.equal(events().some(e => e.state === 'synced' && e.direction === 'pull'), true);
      } else {
        assert.equal(r.status, 'local');
        assert.equal(Meta.imports.length, 0);
        const put = fetch.of('PUT /save');
        assert.equal(put.length, 1); assert.equal(put[0].body.baseVersion, 3); assert.equal(put[0].body.profile.am, 20);
        assert.equal(fetch.state().version, 4); assert.equal(Meta.profile.cloud.version, 4);
      }
      assert.equal(events().filter(e => e.state === 'conflict').length, 1);
    }
  });

  test('login on a fresh, never-played profile pulls the cloud save without asking', async () => {
    const cloudProfile = makeProfile({ am: 77 });
    const fetch = backend({ save: { version: 1, updatedAt: iso(T0 - 60e3) }, profileOnServer: cloudProfile });
    const fresh = makeProfile({ savedAt: Date.now(), stats: { buildsPlaced: 0, servedTotal: 0, collects: 0 } });
    const { Account, Meta } = load({ fetch, profile: fresh, config: FAST });
    let asked = 0; Account.ui.choose = async () => { asked++; return 'local'; };
    const r = await Account.login('commander@example.com', 'orbital-mechanics-42');
    assert.equal(r.status, 'cloud'); assert.equal(asked, 0); assert.equal(Meta.profile.am, 77);
    assert.equal(fetch.of('PUT /save').length, 0, 'a fresh profile never overwrites a cloud save');
  });

  test('recover signs in with the new token and returns the new phrase; logout clears the session', async () => {
    const fetch = backend();
    const { Account, storage, events } = load({ fetch, config: FAST });
    same(await Account.recover('commander@example.com', 'too few words', 'a-new-long-password'), { ok: false, why: 'Enter all ten words of your recovery phrase', code: 'bad-recovery' });
    const r = await Account.recover('commander@example.com', 'orbit comet nova pulsar quasar nebula planet rocket lunar solar', 'a-new-long-password');
    assert.equal(r.ok, true); assert.equal(r.recovery.split(' ').length, 10); assert.equal(r.status, 'local');
    same(fetch.of('POST /recover')[0].body, { email: 'commander@example.com', recovery: 'orbit comet nova pulsar quasar nebula planet rocket lunar solar', newPassword: 'a-new-long-password' });
    assert.equal(JSON.parse(storage.getItem('waystation.account')).token, TOKEN + 'r');
    same(await Account.logout(), { ok: true });
    assert.equal(fetch.of('POST /logout')[0].headers.authorization, `Bearer ${TOKEN}r`);
    assert.equal(storage.getItem('waystation.account'), null);
    assert.equal(Account.state.signedIn, false); assert.equal(Account.state.cloud, null);
    assert.equal(events().at(-1).state, 'signed-out'); assert.equal(events().at(-1).reason, 'user');
  });

  test('deleteAccount needs the password, then signs out and clears the marker', async () => {
    const fetch = backend();
    const { Account, Meta, storage, events } = load({ fetch, config: FAST });
    await Account.signup('commander@example.com', 'orbital-mechanics-42');
    assert.ok(Meta.profile.cloud);
    const bad = await Account.deleteAccount('wrong-password');
    assert.equal(bad.ok, false); assert.equal(bad.code, 'bad-credentials'); assert.equal(Account.state.signedIn, true);
    same(await Account.deleteAccount('orbital-mechanics-42'), { ok: true });
    same(fetch.of('DELETE /account').at(-1).body, { password: 'orbital-mechanics-42' });
    assert.equal(Account.state.signedIn, false); assert.equal(Meta.profile.cloud, null); assert.equal(storage.getItem('waystation.account'), null);
    assert.equal(events().at(-1).reason, 'deleted');
  });
});

// ============================================================ password reset by email
describe('client: forgot and reset', () => {
  const RESET_TOKEN = 'r'.repeat(43);
  const PLAY = 'https://joshanderson051.github.io/waystation/play/';

  test('forgot validates the address, posts it lower-cased without auth and reports the backend plainly', async () => {
    const answers = [{ ok: true }];
    const fetch = fakeFetch({ 'POST /forgot': () => answers.shift() || { ok: true } });
    const { Account, storage } = load({ fetch, storage: fakeStorage({ 'waystation.account': { token: TOKEN, email: 'x@example.com' } }), config: FAST });
    same(await Account.forgot('nope'), { ok: false, why: 'Enter a valid email address', code: 'bad-email' });
    same(await Account.forgot(' Commander@Example.com '), { ok: true });
    const c = fetch.of('POST /forgot')[0];
    same(c.body, { email: 'commander@example.com' });
    assert.equal(c.headers.authorization, undefined, 'no bearer on a public call');
    answers.push({ status: 429, data: { error: 'rate-limited', message: 'Too many attempts. Try again in 59 minutes.', retryAfter: 3540 } });
    const limited = await Account.forgot('commander@example.com');
    assert.equal(limited.ok, false); assert.equal(limited.code, 'rate-limited'); assert.equal(limited.retryAfter, 3540); assert.match(limited.why, /Too many attempts/);
    answers.push({ status: 503, data: { error: 'email-not-configured', message: 'Password reset by email is not set up on this build yet. Use your recovery phrase instead.' } });
    const off = await Account.forgot('commander@example.com');
    assert.equal(off.ok, false); assert.equal(off.code, 'email-not-configured'); assert.match(off.why, /recovery phrase/);
    assert.equal(JSON.parse(storage.getItem('waystation.account')).token, TOKEN, 'asking for a link touches no session');
    const none = load({ meta: null }).Account;
    same(await none.forgot('commander@example.com'), { ok: false, why: NOT, code: 'unavailable' });
  });

  test('?reset=<token> is captured at load and taken out of the address bar; other queries and hashes survive', () => {
    const t = load({ location: `${PLAY}?lang=en&reset=${RESET_TOKEN}#top` });
    assert.equal(t.Account.resetToken, RESET_TOKEN);
    assert.deepEqual(t.replaced, ['/waystation/play/?lang=en#top']);
    assert.equal(t.ctx.location.search, '?lang=en');
    const plain = load({ location: PLAY });
    assert.equal(plain.Account.resetToken, null); assert.deepEqual(plain.replaced, []);
    const junk = load({ location: `${PLAY}?reset=not%20a%20token` });
    assert.equal(junk.Account.resetToken, null, 'a malformed token is dropped');
    assert.deepEqual(junk.replaced, ['/waystation/play/'], 'but still removed from the URL');
    const noLoc = load();
    assert.equal(noLoc.Account.resetToken, null);
    t.Account.clearResetToken();
    assert.equal(t.Account.resetToken, null);
  });

  test('reset validates, posts {token, newPassword}, signs in with the fresh token, reconciles and returns the new phrase', async () => {
    const fetch = backend();
    fetch.handlers['POST /reset'] = c => (c.body.token === RESET_TOKEN
      ? { token: TOKEN + 'r', user: USER, recovery: 'anchor harbor beacon bridge cargo deck dock engine flight gate' }
      : { status: 401, data: { error: 'bad-token', message: 'This reset link has expired or was already used. Ask for a new one.' } });
    const t = load({ fetch, config: FAST, location: `${PLAY}?reset=${RESET_TOKEN}` });
    const { Account, storage, events } = t;
    same(await Account.reset('bad token', 'a-new-long-password'), { ok: false, why: 'This reset link is not valid. Ask for a new one.', code: 'bad-token' });
    same(await Account.reset(RESET_TOKEN, 'short'), { ok: false, why: 'Use a new password of at least 10 characters', code: 'weak-password' });
    assert.equal(fetch.of('POST /reset').length, 0, 'nothing sent until the input is right');
    const dead = await Account.reset('x'.repeat(43), 'a-new-long-password');
    assert.equal(dead.ok, false); assert.equal(dead.code, 'bad-token'); assert.equal(dead.status, 401);
    assert.equal(Account.state.signedIn, false); assert.equal(Account.resetToken, RESET_TOKEN, 'a failed attempt keeps the pending token');
    const r = await Account.reset(Account.resetToken, 'a-new-long-password');
    assert.equal(r.ok, true); assert.equal(r.recovery.split(' ').length, 10); assert.equal(r.status, 'local'); same(r.user, USER);
    same(fetch.of('POST /reset').at(-1).body, { token: RESET_TOKEN, newPassword: 'a-new-long-password' });
    assert.equal(fetch.of('POST /reset').at(-1).headers.authorization, undefined);
    assert.equal(Account.resetToken, null, 'used');
    assert.equal(JSON.parse(storage.getItem('waystation.account')).token, TOKEN + 'r');
    assert.equal(Account.state.signedIn, true);
    assert.equal(fetch.of('GET /me').length, 1, 'reconciled after signing in');
    assert.equal(fetch.of('GET /me')[0].headers.authorization, `Bearer ${TOKEN}r`);
    assert.equal(fetch.of('PUT /save').length, 1, 'the local profile became the first cloud save');
    assert.equal(events()[0].state, 'signed-in');
    const none = load({ meta: null }).Account;
    same(await none.reset(RESET_TOKEN, 'a-new-long-password'), { ok: false, why: NOT, code: 'unavailable' });
  });
});

// ============================================================ boot
describe('client: boot', () => {
  const session = () => fakeStorage({ 'waystation.account': { token: TOKEN, email: USER.email } });
  const marker = (version, syncedAt) => ({ version, syncedAt, userId: USER.id });

  test('no stored session -> none; expired token -> none + signed-out; offline -> offline and a later retry', async () => {
    same(await load({ fetch: backend(), config: FAST }).Account.boot(), { status: 'none' });

    const expired = load({ fetch: backend(), storage: fakeStorage({ 'waystation.account': { token: 'stale', email: USER.email } }), config: FAST });
    same(await expired.Account.boot(), { status: 'none', why: 'expired' });
    assert.equal(expired.storage.getItem('waystation.account'), null);
    same(expired.events(), [{ state: 'signed-out', reason: 'expired' }]);

    let down = true;
    const good = backend();
    const flaky = fakeFetch({});
    const fetch = async (url, init) => { if (down) throw new TypeError('Failed to fetch'); return good(url, init); };
    const off = load({ fetch, storage: session(), config: { ...FAST, intervalMs: 40 } });
    const r = await off.Account.boot();
    assert.equal(r.status, 'offline');
    assert.equal(off.Account.state.offline, true); assert.equal(off.Account.state.signedIn, false);
    assert.equal(off.events()[0].state, 'offline');
    down = false;
    await sleep(120);
    assert.equal(off.Account.state.signedIn, false, 'the interval only starts once signed in; boot retries by the player or the next load');
    same(await off.Account.boot(), { status: 'local', pushed: true });
    assert.equal(off.Account.state.offline, false);
    void flaky;
  });

  test('cloud ahead and local unchanged since the last sync -> pull', async () => {
    const cloudProfile = makeProfile({ am: 555 });
    const fetch = backend({ save: { version: 2, updatedAt: iso(T0 + 100e3) }, profileOnServer: cloudProfile });
    const local = makeProfile({ savedAt: T0 + 1000, cloud: marker(1, T0) });
    const { Account, Meta, events } = load({ fetch, profile: local, storage: session(), config: FAST });
    same(await Account.boot(), { status: 'cloud' });
    assert.equal(Meta.imports.length, 1); assert.equal(Meta.profile.am, 555); assert.equal(Meta.profile.cloud.version, 2);
    assert.equal(fetch.of('PUT /save').length, 0);
    same(events().map(e => e.state), ['signed-in', 'synced']);
    assert.equal(Account.state.user.email, USER.email);
  });

  test('local ahead and cloud unchanged -> push with the cloud version as base', async () => {
    const fetch = backend({ save: { version: 4, updatedAt: iso(T0) }, profileOnServer: makeProfile() });
    const local = makeProfile({ am: 31, savedAt: T0 + 60e3, cloud: marker(4, T0) });
    const { Account, Meta } = load({ fetch, profile: local, storage: session(), config: FAST });
    same(await Account.boot(), { status: 'local' });
    const put = fetch.of('PUT /save');
    assert.equal(put.length, 1); assert.equal(put[0].body.baseVersion, 4); assert.equal(put[0].body.profile.am, 31);
    assert.equal(Meta.profile.cloud.version, 5); assert.equal(Meta.imports.length, 0);
  });

  test('nothing moved -> local, no transfer; savedAt within the grace window counts as unchanged', async () => {
    const fetch = backend({ save: { version: 4, updatedAt: iso(T0) }, profileOnServer: makeProfile() });
    const local = makeProfile({ savedAt: T0 + 3000, cloud: marker(4, T0) });
    const { Account } = load({ fetch, profile: local, storage: session(), config: FAST });
    same(await Account.boot(), { status: 'local', inSync: true });
    assert.equal(fetch.of('PUT /save').length, 0); assert.equal(fetch.of('GET /save').length, 0);
  });

  test('both moved -> conflict: default picks the newest; the hook can pick local, or leave it unresolved', async () => {
    const cloudProfile = makeProfile({ am: 1000 });
    const mk = () => ({ save: { version: 2, updatedAt: iso(T0 + 600e3) }, profileOnServer: cloudProfile });
    const local = () => makeProfile({ am: 1, savedAt: T0 + 60e3, cloud: marker(1, T0) });

    const newest = load({ fetch: backend(mk()), profile: local(), storage: session(), config: FAST });
    const r1 = await newest.Account.boot();
    same(r1, { status: 'cloud', choice: 'cloud', conflict: true });
    assert.equal(newest.Meta.profile.am, 1000);
    assert.equal(newest.events().filter(e => e.state === 'conflict').length, 1);
    const c = newest.events().find(e => e.state === 'conflict');
    assert.equal(c.local.savedAt, T0 + 60e3); assert.equal(c.cloud.version, 2);

    const older = backend({ save: { version: 2, updatedAt: iso(T0 - 600e3) }, profileOnServer: cloudProfile });
    const keepLocal = load({ fetch: older, profile: local(), storage: session(), config: FAST });
    same(await keepLocal.Account.boot(), { status: 'local', choice: 'local', conflict: true });
    assert.equal(older.of('PUT /save')[0].body.baseVersion, 2); assert.equal(keepLocal.Meta.profile.am, 1);

    const hookFetch = backend(mk());
    const hooked = load({ fetch: hookFetch, profile: local(), storage: session(), config: FAST });
    hooked.Account.ui.choose = async () => 'local';
    same(await hooked.Account.boot(), { status: 'local', choice: 'local', conflict: true });
    assert.equal(hookFetch.of('PUT /save').length, 1);

    const laterFetch = backend(mk());
    const later = load({ fetch: laterFetch, profile: local(), storage: session(), config: FAST });
    later.Account.ui.choose = async () => 'later';
    const r4 = await later.Account.boot();
    assert.equal(r4.status, 'conflict'); assert.equal(later.Account.state.conflict, true);
    later.Sim.emit('change'); later.Sim.emit('mission', { id: 'm1', state: 'claimed' });
    await sleep(60);
    assert.equal(laterFetch.of('PUT /save').length, 0, 'no automatic pushes while a conflict is pending');
    const forced = await later.Account.push();
    assert.equal(forced.ok, true); assert.equal(laterFetch.of('PUT /save')[0].body.baseVersion, 2);
    assert.equal(later.Account.state.conflict, false);
  });
});

// ============================================================ push policy
describe('client: push policy', () => {
  async function signedIn(extra = {}) {
    const fetch = backend();
    const t = load({ fetch, config: { ...FAST, ...extra.config }, UI: extra.UI, gzip: extra.gzip });
    await t.Account.signup('commander@example.com', 'orbital-mechanics-42');
    assert.equal(fetch.of('PUT /save').length, 1);
    return { ...t, fetch, puts: () => fetch.of('PUT /save').length - 1 };
  }

  test('change events are debounced into one push; the immediate beats push at once', async () => {
    const t = await signedIn();
    t.Sim.emit('change'); t.Sim.emit('change'); t.Sim.emit('change');
    assert.equal(t.Account.state.dirty, true);
    await sleep(10);
    assert.equal(t.puts(), 0, 'nothing before the debounce elapses');
    await sleep(60);
    assert.equal(t.puts(), 1); assert.equal(t.Account.state.dirty, false);
    assert.equal(t.fetch.of('PUT /save').at(-1).body.baseVersion, 1); assert.equal(t.Meta.profile.cloud.version, 2);

    for (const [evt, data] of [['sector', { id: 'sable', state: 'switched' }], ['purchase', { sku: 'am_50', granted: { am: 50 } }], ['mission', { id: 'm', state: 'claimed' }], ['achievement', { id: 'a', tier: 1, state: 'claimed' }]]) {
      const before = t.puts();
      t.Sim.emit(evt, data);
      await sleep(5);
      assert.equal(t.puts(), before + 1, `${evt} pushes immediately`);
    }
    t.Sim.emit('mission', { id: 'm', state: 'progress' }); t.Sim.emit('sector', { id: 'sable', state: 'unlocked' });
    await sleep(5);
    assert.equal(t.puts(), 5, 'other states of those events do not push');
    assert.equal(t.Account.state.dirty, false, 'nor do they mark dirty: Meta emits change alongside real changes');
  });

  test('never more than one push in flight; a change during a push is pushed afterwards', async () => {
    const t = await signedIn();
    let release; const gate = new Promise(r => { release = r; });
    const original = t.fetch.handlers['PUT /save'];
    t.fetch.handlers['PUT /save'] = async c => { await gate; return original(c); };
    const p1 = t.Account.push();
    await sleep(5);
    assert.equal(t.Account.state.syncing, true);
    const p2 = t.Account.push();
    t.Sim.emit('change');
    assert.equal(t.puts(), 1, 'only one PUT in flight');
    release();
    await p1; await p2;
    assert.equal(t.Account.state.dirty, true, 'the change during the flight is remembered');
    await sleep(60);
    assert.equal(t.puts(), 2, 'and pushed by the debounce afterwards');
    assert.equal(t.Account.state.dirty, false);
  });

  test('the interval pushes while dirty when the debounce has not fired', async () => {
    const t = await signedIn({ config: { debounceMs: 10000, intervalMs: 40 } });
    t.Sim.emit('change');
    await sleep(15);
    assert.equal(t.puts(), 0);
    await sleep(80);
    assert.ok(t.puts() >= 1, 'the 60 s (here 40 ms) interval pushed');
    assert.equal(t.Account.state.dirty, false);
  });

  test('pagehide pushes with keepalive when dirty', async () => {
    const t = await signedIn({ config: { debounceMs: 10000, intervalMs: 0 } });
    t.pagehide.forEach(fn => fn());
    await sleep(5);
    assert.equal(t.puts(), 0, 'clean: nothing to flush');
    t.Sim.emit('change');
    t.pagehide.forEach(fn => fn());
    await sleep(10);
    assert.equal(t.puts(), 1);
    assert.equal(t.fetch.of('PUT /save').at(-1).keepalive, true);
    t.Sim.emit('change');
    t.ctx.document.hidden = true; t.visibility.forEach(fn => fn());
    await sleep(10);
    assert.equal(t.puts(), 2, 'hiding the tab flushes too');
  });

  test('401 during a push signs out (with a toast when UI exists); 409 refreshes cloud and runs the chooser', async () => {
    const toasts = [];
    const t = await signedIn({ UI: { toast: (msg, kind) => toasts.push([msg, kind]) } });
    t.fetch.failNextPut({ status: 401, data: { error: 'unauthorised', message: 'expired' } });
    const r = await t.Account.push();
    assert.equal(r.ok, false); assert.equal(r.code, 'signed-out');
    assert.equal(t.Account.state.signedIn, false); assert.equal(t.storage.getItem('waystation.account'), null);
    assert.equal(toasts.length, 1); assert.equal(toasts[0][1], 'warn');
    assert.equal(t.events().at(-1).state, 'signed-out'); assert.equal(t.events().at(-1).reason, 'expired');
    t.Sim.emit('change'); await sleep(50);
    assert.equal(t.puts(), 1, 'signed out: no more pushes');

    const u = await signedIn();
    const other = makeProfile({ am: 4242 });
    u.fetch.set(7, other, iso(Date.now() + 5000));       // another device moved the cloud save to version 7
    const asked = [];
    u.Account.ui.choose = async o => { asked.push(o); return 'local'; };
    u.Sim.emit('change'); await sleep(60);
    assert.equal(asked.length, 1); assert.equal(asked[0].cloud.version, 7); assert.equal(asked[0].cloud.summary.am, 4242);
    assert.equal(u.events().some(e => e.state === 'conflict'), true);
    const puts = u.fetch.of('PUT /save');
    assert.equal(puts.at(-1).body.baseVersion, 7, 'the retry uses the server version'); assert.equal(u.fetch.state().version, 8);
    assert.equal(u.Account.state.conflict, false); assert.equal(u.Meta.profile.cloud.version, 8);

    u.fetch.set(9, other, iso(Date.now() + 9000));
    u.Account.ui.choose = async () => 'cloud';
    const r2 = await u.Account.push();
    assert.equal(r2.ok, true); assert.equal(r2.direction, 'pull'); assert.equal(u.Meta.profile.am, 4242);
  });

  test('offline pushes keep the profile dirty and report offline; syncNow reconciles once the service is back', async () => {
    const t = await signedIn();
    let down = true;
    const good = t.fetch;
    t.ctx.fetch = async (url, init) => { if (down) throw new TypeError('Failed to fetch'); return good(url, init); };
    t.Sim.emit('purchase', { sku: 'am_50', granted: { am: 50 } });
    await sleep(10);
    assert.equal(t.Account.state.offline, true); assert.equal(t.Account.state.dirty, true);
    assert.equal(t.events().at(-1).state, 'offline');
    down = false;
    const r = await t.Account.syncNow();
    assert.equal(r.ok, true); assert.equal(r.status, 'local');
    assert.equal(t.Account.state.offline, false); assert.equal(t.Account.state.dirty, false);
  });

  test('large bodies are gzip-compressed when CompressionStream exists and still decode on the server side', async () => {
    const big = makeProfile({ notes: 'x'.repeat(50000) });
    const fetch = backend();
    const { Account } = load({ fetch, profile: big, config: FAST, gzip: true });
    await Account.signup('commander@example.com', 'orbital-mechanics-42');
    const put = fetch.of('PUT /save')[0];
    assert.equal(put.headers['content-type'], 'application/gzip');
    assert.ok(put.raw instanceof ArrayBuffer && put.raw.byteLength < 5000, `compressed to ${put.raw.byteLength} bytes`);
    assert.equal(put.body.profile.notes.length, 50000, 'the worker-side decoder recovered the JSON');
    assert.equal(fetch.of('POST /signup')[0].headers['content-type'], 'application/json', 'small bodies stay plain');
  });

  test('pull replaces the local profile without triggering a push of its own', async () => {
    const t = await signedIn();
    t.fetch.set(3, makeProfile({ am: 303 }), iso(Date.now()));
    const r = await t.Account.pull();
    assert.equal(r.ok, true); assert.equal(t.Meta.profile.am, 303); assert.equal(t.Meta.profile.cloud.version, 3);
    await sleep(60);
    assert.equal(t.puts(), 0, 'the change/sector events emitted by Meta.import are not ours');
    assert.equal(t.Account.state.dirty, false);
  });
});

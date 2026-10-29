// ============================================================
// PORT SOLACE — push worker tests, part 2: the handlers and the cron (src/index.js)
// Run with `npm test` in workers/push. Exercises handle(request, env) and runCron(env, now) with an
// in-memory KV stub (get/put/delete/list with op counters) and a scripted push service behind fetchImpl.
// Notification bodies are decrypted with the fake browser's keys to check what a player would see.
// ============================================================
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  handle, runCron, rebuildIndex, composeNotification, normaliseTimers, requireSubscription, timingSafeEqual, HttpError,
} from '../src/index.js';
import { MAX_TIMERS, STALE_MS, PAST_GRACE_MS, MAX_SENDS_PER_RUN, HEAL_EVERY_MIN, KEY_INDEX } from '../src/config.js';
import { generateVapidKeys, decrypt, b64u } from '../src/webpush.js';
import { browserKeys } from './helpers.js';

const ORIGIN = 'https://portsolace.com';
const PLAYER = 'pm2k4f9a1xyz';
const OTHER = '7f0c1c2e-6d4a-4a7b-9b7e-1f2d3c4b5a69';
const MIN = 60e3, HOUR = 3600e3;
// a fixed "now" seven minutes past a heal minute (so a plain run never rebuilds the index), anchored to the real
// clock within eight minutes so /schedule's grace for just-finished timers still applies to "NOW - 90 s"
const BASE_MIN = Math.floor(Date.now() / MIN);
const NOW = (BASE_MIN - (BASE_MIN % HEAL_EVERY_MIN) + 7) * MIN;
assert.equal(Math.floor(NOW / MIN) % HEAL_EVERY_MIN, 7);
assert.ok(Math.abs(NOW - Date.now()) < 9 * MIN);

let VAPID;
before(async () => { VAPID = await generateVapidKeys(); });

// ---------------------------------------------------------- stubs
function kvStub() {
  const map = new Map(), ops = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    map, ops,
    async get(key, type) { ops.get++; const v = map.has(key) ? map.get(key) : null; return v !== null && type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { ops.put++; map.set(key, String(value)); },
    async delete(key) { ops.delete++; map.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      ops.list++;
      const keys = [...map.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name }));
      const start = cursor ? Number(cursor) : 0, page = keys.slice(start, start + limit), done = start + limit >= keys.length;
      return { keys: page, list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
    json(key) { return map.has(key) ? JSON.parse(map.get(key)) : null; },
  };
}
function makeEnv(overrides = {}) {
  return {
    PUSH: kvStub(),
    ALLOWED_ORIGIN: `${ORIGIN}, http://localhost:8787`,
    VAPID_PUBLIC_KEY: VAPID.publicKey,
    VAPID_PRIVATE_KEY: VAPID.privateKey,
    VAPID_SUBJECT: 'mailto:owner@example.com',
    ...overrides,
  };
}
const req = (path, { method = 'GET', body, headers = {}, origin = ORIGIN } = {}) => new Request(`https://waystation-push.example.workers.dev${path}`, {
  method,
  headers: { ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const post = (path, body, o) => req(path, { method: 'POST', body, ...o });
const readJson = async res => ({ status: res.status, headers: res.headers, data: await res.json() });

// a fake browser: PushSubscription JSON plus the private side to decrypt what the worker sends
let seq = 0;
async function fakeBrowser(host = 'push.example.com') {
  const ua = await browserKeys();
  const endpoint = `https://${host}/send/${++seq}-${b64u.encode(crypto.getRandomValues(new Uint8Array(6)))}`;
  return { ua, subscription: { endpoint, expirationTime: null, keys: { p256dh: ua.p256dh, auth: ua.auth } } };
}
async function subscribed(env, playerId = PLAYER) {
  const browser = await fakeBrowser();
  const { status, data } = await readJson(await handle(post('/subscribe', { playerId, subscription: browser.subscription }), env));
  assert.equal(status, 200, JSON.stringify(data));
  return { ...browser, token: data.token, playerId };
}
const timer = (id, dueAt, kind = 'build', title = `${id} online`) => ({ id, kind, title, dueAt });

// a scripted push service: answers by endpoint, records every call, decrypts for the test
function pushService(browsers, statusFor = () => 201) {
  const calls = [];
  const byEndpoint = new Map(browsers.map(b => [b.subscription.endpoint, b]));
  const fetchImpl = async (url, init) => {
    const b = byEndpoint.get(url);
    const call = { url, init, status: statusFor(url, b), payload: null };
    if (b) call.payload = JSON.parse(new TextDecoder().decode(await decrypt(init.body, b.ua.privateKey, b.ua.publicRaw, b.ua.auth)));
    calls.push(call);
    return new Response('', { status: call.status });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ============================================================ configuration and CORS
describe('worker: configuration and CORS', () => {
  test('/health summarises the configuration without secrets', async () => {
    const env = makeEnv();
    const { status, data } = await readJson(await worker.fetch(req('/health'), env));
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.service, 'waystation-push');
    assert.deepEqual(data.vapid, { publicKey: 'ok', privateKey: 'set', subject: 'mailto:owner@example.com' });
    assert.equal(data.kv, true);
    assert.equal(data.scheduledPlayers, 0);
    assert.deepEqual(data.allowedOrigins, [ORIGIN.toLowerCase(), 'http://localhost:8787']);
    assert.doesNotMatch(JSON.stringify(data), new RegExp(VAPID.privateKey));
  });
  test('/health reports a missing or invalid key and a missing namespace', async () => {
    let { data } = await readJson(await handle(req('/health'), makeEnv({ VAPID_PUBLIC_KEY: 'REPLACE_WITH_VAPID_PUBLIC_KEY', VAPID_PRIVATE_KEY: '', PUSH: undefined })));
    assert.deepEqual(data.vapid, { publicKey: 'missing', privateKey: 'missing', subject: 'mailto:owner@example.com' });
    assert.equal(data.kv, false);
    assert.equal(data.scheduledPlayers, null);
    ({ data } = await readJson(await handle(req('/health'), makeEnv({ VAPID_PUBLIC_KEY: 'AQID', VAPID_SUBJECT: 'owner@example.com' }))));
    assert.equal(data.vapid.publicKey, 'invalid');
    assert.equal(data.vapid.subject, 'https://portsolace.com/', 'an invalid subject falls back to the site');
  });
  test('/key hands out the VAPID public key, normalised', async () => {
    const { data } = await readJson(await handle(req('/key'), makeEnv({ VAPID_PUBLIC_KEY: VAPID.publicKey + '=' })));
    assert.deepEqual(data, { publicKey: VAPID.publicKey });
    const bad = await readJson(await handle(req('/key'), makeEnv({ VAPID_PUBLIC_KEY: '' })));
    assert.equal(bad.status, 500);
    assert.equal(bad.data.error, 'config');
  });
  test('CORS headers only for allowed origins; unknown routes and methods answer JSON errors', async () => {
    const env = makeEnv();
    const ok = await handle(req('/health', { origin: ORIGIN }), env);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(ok.headers.get('vary'), 'Origin');
    const local = await handle(req('/health', { origin: 'http://localhost:8787' }), env);
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:8787');
    const evil = await handle(req('/health', { origin: 'https://evil.example' }), env);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const pre = await handle(req('/schedule', { method: 'OPTIONS', origin: ORIGIN }), env);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    const nf = await readJson(await handle(req('/nope'), env));
    assert.equal(nf.status, 404); assert.equal(nf.data.error, 'not-found');
    const mna = await readJson(await handle(req('/schedule'), env));
    assert.equal(mna.status, 405); assert.deepEqual(mna.data.allow, ['POST']);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
  });
  test('bodies must be JSON objects of a sane size', async () => {
    const env = makeEnv();
    assert.equal((await readJson(await handle(post('/subscribe', '{nope'), env))).data.error, 'bad-json');
    assert.equal((await readJson(await handle(post('/subscribe', [1, 2]), env))).data.error, 'bad-json');
    const big = await readJson(await handle(post('/schedule', { playerId: PLAYER, pad: 'x'.repeat(40 * 1024) }), env));
    assert.equal(big.status, 413); assert.equal(big.data.error, 'too-large');
  });
});

// ============================================================ /subscribe
describe('POST /subscribe', () => {
  test('validates the player id and the PushSubscription shape', async () => {
    const env = makeEnv();
    const { subscription } = await fakeBrowser();
    const code = async body => (await readJson(await handle(post('/subscribe', body), env))).data.error;
    assert.equal(await code({ playerId: 'short', subscription }), 'bad-player');
    assert.equal(await code({ playerId: PLAYER }), 'bad-subscription');
    assert.equal(await code({ playerId: PLAYER, subscription: { ...subscription, endpoint: 'http://push.example.com/x' } }), 'bad-subscription');
    assert.equal(await code({ playerId: PLAYER, subscription: { ...subscription, endpoint: 'https://localhost/x' } }), 'bad-subscription');
    assert.equal(await code({ playerId: PLAYER, subscription: { ...subscription, endpoint: 'https://10.0.0.1/x' } }), 'bad-subscription');
    assert.equal(await code({ playerId: PLAYER, subscription: { ...subscription, endpoint: 'https://user:pw@push.example.com/x' } }), 'bad-subscription');
    assert.equal(await code({ playerId: PLAYER, subscription: { endpoint: subscription.endpoint, keys: { p256dh: 'AQID', auth: subscription.keys.auth } } }), 'bad-subscription');
    assert.equal(await code({ playerId: PLAYER, subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: 'AQID' } } }), 'bad-subscription');
    assert.equal(env.PUSH.ops.put, 0);
  });
  test('stores the subscription with a token; the same browser gets the same token back without a write', async () => {
    const env = makeEnv();
    const { subscription } = await fakeBrowser();
    const first = await readJson(await handle(post('/subscribe', { playerId: PLAYER, subscription }), env));
    assert.equal(first.status, 200);
    assert.match(first.data.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.data.reused, false);
    const stored = env.PUSH.json(`sub:${PLAYER}`);
    assert.equal(stored.endpoint, subscription.endpoint);
    assert.deepEqual(stored.keys, subscription.keys);
    assert.equal(stored.token, first.data.token);
    assert.equal(env.PUSH.ops.put, 1);
    const again = await readJson(await handle(post('/subscribe', { playerId: PLAYER, subscription: { ...subscription, keys: { p256dh: subscription.keys.p256dh + '=', auth: subscription.keys.auth } } }), env));
    assert.deepEqual(again.data, { ok: true, token: first.data.token, reused: true });
    assert.equal(env.PUSH.ops.put, 1, 'padding differences do not count as a new subscription');
    const { subscription: other } = await fakeBrowser();
    const replaced = await readJson(await handle(post('/subscribe', { playerId: PLAYER, subscription: other }), env));
    assert.notEqual(replaced.data.token, first.data.token);
    assert.equal(env.PUSH.json(`sub:${PLAYER}`).endpoint, other.endpoint, 'the newest browser wins');
  });
  test('refuses to subscribe while the VAPID public key is unset', async () => {
    const env = makeEnv({ VAPID_PUBLIC_KEY: '' });
    const { subscription } = await fakeBrowser();
    const r = await readJson(await handle(post('/subscribe', { playerId: PLAYER, subscription }), env));
    assert.equal(r.status, 500); assert.equal(r.data.error, 'config');
  });
  test('requireSubscription normalises keys and keeps expirationTime when numeric', async () => {
    const { subscription } = await fakeBrowser();
    const n = requireSubscription({ ...subscription, expirationTime: 1234, keys: { p256dh: subscription.keys.p256dh + '==', auth: subscription.keys.auth } });
    assert.deepEqual(n, { endpoint: subscription.endpoint, keys: subscription.keys, expirationTime: 1234 });
    assert.throws(() => requireSubscription(null), HttpError);
  });
});

// ============================================================ /schedule and /unsubscribe
describe('POST /schedule', () => {
  test('needs a subscription and the matching token', async () => {
    const env = makeEnv();
    let r = await readJson(await handle(post('/schedule', { playerId: PLAYER, token: 'x', timers: [] }), env));
    assert.equal(r.status, 404); assert.equal(r.data.error, 'no-subscription');
    const me = await subscribed(env);
    r = await readJson(await handle(post('/schedule', { playerId: PLAYER, token: me.token.slice(0, -1) + (me.token.endsWith('A') ? 'B' : 'A'), timers: [] }), env));
    assert.equal(r.status, 403); assert.equal(r.data.error, 'bad-token');
    r = await readJson(await handle(post('/schedule', { playerId: PLAYER, timers: [] }), env));
    assert.equal(r.status, 403);
  });
  test('validates the timers', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    const code = async timers => { const r = await readJson(await handle(post('/schedule', { playerId: PLAYER, token: me.token, timers }), env)); return r.data.error; };
    const t = timer('build:home:1,2', NOW + MIN);
    assert.equal(await code('nope'), 'bad-timers');
    assert.equal(await code([null]), 'bad-timers');
    assert.equal(await code([{ ...t, kind: 'party' }]), 'bad-timers');
    assert.equal(await code([{ ...t, id: 'has space' }]), 'bad-timers');
    assert.equal(await code([{ ...t, id: '' }]), 'bad-timers');
    assert.equal(await code([{ ...t, title: '   ' }]), 'bad-timers');
    assert.equal(await code([{ ...t, dueAt: 'soon' }]), 'bad-timers');
    assert.equal(await code([{ ...t, dueAt: Date.now() + 500 * 86400e3 }]), 'bad-timers');
    assert.equal(await code(Array.from({ length: MAX_TIMERS + 1 }, (_, i) => timer(`b${i}`, NOW + i * MIN))), 'too-many');
    assert.equal(env.PUSH.map.has(`timers:${PLAYER}`), false);
  });
  test('stores the cleaned, sorted list, drops finished timers and duplicates, and points the index at the soonest', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    const now = Date.now();
    const timers = [
      timer('expedition:3', now + 40 * MIN, 'expedition', 'Expedition back from Sable Drift'),
      timer('build:home:2,3', now + 5 * MIN, 'build', '  Comms\tRelay   online '),
      timer('build:home:2,3', now + 9 * MIN),                               // duplicate id: first one wins
      timer('plot:home:2', now - PAST_GRACE_MS - 1000, 'plot', 'Ring 2 cleared'),   // long over: dropped
      timer('daily', now - 5000, 'daily', 'Daily reward ready'),           // just over: kept (grace)
      { id: 'upgrade:home:1,1', kind: 'upgrade', title: 'Dock is now level 2'.padEnd(120, '!'), dueAt: String(now + 2 * HOUR) },
    ];
    const r = await readJson(await handle(post('/schedule', { playerId: PLAYER, token: me.token, station: '  Harrow  Point  ', timers }), env));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { ok: true, count: 4, nextDueAt: now - 5000, unchanged: false });
    const rec = env.PUSH.json(`timers:${PLAYER}`);
    assert.equal(rec.station, 'Harrow Point');
    assert.deepEqual(rec.timers.map(t => t.id), ['daily', 'build:home:2,3', 'expedition:3', 'upgrade:home:1,1']);
    assert.equal(rec.timers[1].title, 'Comms Relay online');
    assert.equal(rec.timers[3].title.length, 80);
    assert.equal(rec.timers[3].dueAt, now + 2 * HOUR, 'numeric strings are accepted');
    assert.deepEqual(env.PUSH.json(KEY_INDEX), { [PLAYER]: now - 5000 });
  });
  test('an unchanged list costs no writes; an empty list clears the player', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    const timers = [timer('a', NOW + 10 * MIN), timer('b', NOW + 20 * MIN)];
    await handle(post('/schedule', { playerId: PLAYER, token: me.token, station: 'Varro', timers }), env);
    const puts = env.PUSH.ops.put;
    const r = await readJson(await handle(post('/schedule', { playerId: PLAYER, token: me.token, station: 'Varro', timers: timers.slice().reverse() }), env));
    assert.deepEqual(r.data, { ok: true, count: 2, nextDueAt: NOW + 10 * MIN, unchanged: true });
    assert.equal(env.PUSH.ops.put, puts, 'same timers, same station: nothing written');
    const moved = await readJson(await handle(post('/schedule', { playerId: PLAYER, token: me.token, station: 'Varro', timers: [timer('a', NOW + 10 * MIN), timer('b', NOW + 25 * MIN)] }), env));
    assert.equal(moved.data.unchanged, false);
    assert.equal(env.PUSH.ops.put, puts + 1, 'the timers key is rewritten but the index (same soonest) is not');
    const cleared = await readJson(await handle(post('/schedule', { playerId: PLAYER, token: me.token, timers: [] }), env));
    assert.deepEqual(cleared.data, { ok: true, count: 0, nextDueAt: null, unchanged: false });
    assert.equal(env.PUSH.map.has(`timers:${PLAYER}`), false);
    assert.deepEqual(env.PUSH.json(KEY_INDEX), {});
    const again = await readJson(await handle(post('/schedule', { playerId: PLAYER, token: me.token, timers: [] }), env));
    assert.equal(again.data.unchanged, true);
  });
  test('two players keep separate entries in the one index', async () => {
    const env = makeEnv();
    const a = await subscribed(env, PLAYER), b = await subscribed(env, OTHER);
    await handle(post('/schedule', { playerId: PLAYER, token: a.token, timers: [timer('x', NOW + MIN)] }), env);
    await handle(post('/schedule', { playerId: OTHER, token: b.token, timers: [timer('y', NOW + 2 * MIN)] }), env);
    assert.deepEqual(env.PUSH.json(KEY_INDEX), { [PLAYER]: NOW + MIN, [OTHER]: NOW + 2 * MIN });
  });
});

describe('POST /unsubscribe', () => {
  test('forgets the subscription, the timers and the index entry; idempotent afterwards', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    await handle(post('/schedule', { playerId: PLAYER, token: me.token, timers: [timer('x', NOW + MIN)] }), env);
    const bad = await readJson(await handle(post('/unsubscribe', { playerId: PLAYER, token: 'wrong' }), env));
    assert.equal(bad.status, 403);
    const r = await readJson(await handle(post('/unsubscribe', { playerId: PLAYER, token: me.token }), env));
    assert.deepEqual(r.data, { ok: true, removed: true });
    assert.equal(env.PUSH.map.has(`sub:${PLAYER}`), false);
    assert.equal(env.PUSH.map.has(`timers:${PLAYER}`), false);
    assert.deepEqual(env.PUSH.json(KEY_INDEX), {});
    const again = await readJson(await handle(post('/unsubscribe', { playerId: PLAYER }), env));
    assert.deepEqual(again.data, { ok: true, removed: false });
  });
});

// ============================================================ text
describe('composeNotification', () => {
  test('one timer: its title, the station in the body', () => {
    const n = composeNotification([timer('a', 5, 'build', 'Comms Relay online')], 'Harrow Point', 10);
    assert.deepEqual(n, { title: 'Comms Relay online', body: 'Harrow Point is waiting on the bridge.', tag: 'portsolace', at: 5, kinds: ['build'] });
    assert.equal(composeNotification([timer('a', 5)], '', 10).body, 'Your station is waiting on the bridge.');
    assert.equal(composeNotification([timer('d', 5, 'daily', 'Daily reward ready')], 'Harrow Point', 10).body, 'Your streak at Harrow Point is waiting.');
    const t = composeNotification([timer('test', 5, 'test', 'Test notification')], 'Harrow Point', 10);
    assert.equal(t.title, 'Port Solace');
    assert.match(t.body, /Notifications are working/);
  });
  test('several timers: a count, the titles joined, the kinds de-duplicated, long bodies trimmed', () => {
    const n = composeNotification([timer('b', 9, 'build', 'Dock online'), timer('a', 5, 'build', 'Comms Relay online'), timer('e', 7, 'expedition', 'Expedition back from Sable Drift')], 'Harrow Point', 10);
    assert.equal(n.title, '3 things finished at Harrow Point');
    assert.equal(n.body, 'Comms Relay online · Expedition back from Sable Drift · Dock online');
    assert.deepEqual(n.kinds, ['build', 'expedition']);
    assert.equal(n.at, 9);
    const long = composeNotification(Array.from({ length: 8 }, (_, i) => timer(`t${i}`, i, 'build', `Observation Deck number ${i} online`)), '', 10);
    assert.ok(long.body.length <= 181 && long.body.endsWith('…'), long.body);
    assert.equal(long.title, '8 things finished');
  });
});

// ============================================================ the cron
describe('cron', () => {
  test('nothing due: one index read, no sends, no writes', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    await handle(post('/schedule', { playerId: PLAYER, token: me.token, timers: [timer('a', NOW + 5 * MIN)] }), env);
    const before = { ...env.PUSH.ops };
    const svc = pushService([me]);
    const stats = await runCron(env, NOW, { fetchImpl: svc });
    assert.deepEqual(stats, { checked: 0, sent: 0, failed: 0, pruned: 0, dropped: 0, deferred: 0, healed: false });
    assert.equal(svc.calls.length, 0);
    assert.equal(env.PUSH.ops.get, before.get + 1);
    assert.equal(env.PUSH.ops.put, before.put);
  });

  test('sends one encrypted notification for a due timer, keeps the rest and moves the index on', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    const t0 = NOW - 20e3;
    await handle(post('/schedule', { playerId: PLAYER, token: me.token, station: 'Harrow Point', timers: [timer('build:home:2,3', t0, 'build', 'Comms Relay online'), timer('expedition:1', NOW + 30 * MIN, 'expedition', 'Expedition back from Sable Drift')] }), env);
    const svc = pushService([me]);
    const stats = await runCron(env, NOW, { fetchImpl: svc });
    assert.equal(stats.sent, 1, JSON.stringify(stats));
    assert.equal(stats.checked, 1);
    assert.equal(svc.calls.length, 1);
    const call = svc.calls[0];
    assert.equal(call.url, me.subscription.endpoint);
    assert.equal(call.init.headers['content-encoding'], 'aes128gcm');
    assert.equal(call.init.headers.ttl, String(24 * 3600));
    assert.equal(call.init.headers.topic, 'portsolace');
    assert.match(call.init.headers.authorization, new RegExp(`^vapid t=.+, k=${VAPID.publicKey}$`));
    assert.deepEqual(call.payload, { title: 'Comms Relay online', body: 'Harrow Point is waiting on the bridge.', tag: 'portsolace', at: t0, kinds: ['build'] });
    const rec = env.PUSH.json(`timers:${PLAYER}`);
    assert.deepEqual(rec.timers.map(t => t.id), ['expedition:1']);
    assert.equal(rec.station, 'Harrow Point');
    assert.deepEqual(env.PUSH.json(KEY_INDEX), { [PLAYER]: NOW + 30 * MIN });
    // the next minute: nothing due again
    const again = await runCron(env, NOW + MIN, { fetchImpl: svc });
    assert.equal(again.sent, 0);
    assert.equal(svc.calls.length, 1);
  });

  test('several due timers for one player collapse into one notification; the last one clears the player', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    await handle(post('/schedule', { playerId: PLAYER, token: me.token, station: 'Varro Reach', timers: [timer('a', NOW - 90e3, 'build', 'Dock online'), timer('b', NOW - 30e3, 'upgrade', 'Comms Relay is now level 2')] }), env);
    const svc = pushService([me]);
    const stats = await runCron(env, NOW, { fetchImpl: svc });
    assert.equal(stats.sent, 1);
    assert.equal(svc.calls.length, 1);
    assert.equal(svc.calls[0].payload.title, '2 things finished at Varro Reach');
    assert.equal(svc.calls[0].payload.body, 'Dock online · Comms Relay is now level 2');
    assert.equal(env.PUSH.map.has(`timers:${PLAYER}`), false);
    assert.deepEqual(env.PUSH.json(KEY_INDEX), {});
  });

  test('a 410 from the push service prunes the subscription and its timers', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    await handle(post('/schedule', { playerId: PLAYER, token: me.token, timers: [timer('a', NOW - MIN), timer('b', NOW + HOUR)] }), env);
    const svc = pushService([me], () => 410);
    const stats = await runCron(env, NOW, { fetchImpl: svc });
    assert.equal(stats.pruned, 1);
    assert.equal(stats.sent, 0);
    assert.equal(env.PUSH.map.has(`sub:${PLAYER}`), false);
    assert.equal(env.PUSH.map.has(`timers:${PLAYER}`), false);
    assert.deepEqual(env.PUSH.json(KEY_INDEX), {});
  });

  test('a 429 or 5xx keeps the due timers for the next minute; a 400 drops them', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    await handle(post('/schedule', { playerId: PLAYER, token: me.token, timers: [timer('a', NOW - MIN), timer('b', NOW + HOUR)] }), env);
    let code = 429;
    const svc = pushService([me], () => code);
    let stats = await runCron(env, NOW, { fetchImpl: svc });
    assert.deepEqual([stats.failed, stats.sent], [1, 0]);
    assert.deepEqual(env.PUSH.json(`timers:${PLAYER}`).timers.map(t => t.id), ['a', 'b']);
    assert.deepEqual(env.PUSH.json(KEY_INDEX), { [PLAYER]: NOW - MIN }, 'still due');
    code = 503;
    stats = await runCron(env, NOW + MIN, { fetchImpl: svc });
    assert.equal(stats.failed, 1);
    assert.deepEqual(env.PUSH.json(`timers:${PLAYER}`).timers.map(t => t.id), ['a', 'b']);
    code = 201;
    stats = await runCron(env, NOW + 2 * MIN, { fetchImpl: svc });
    assert.equal(stats.sent, 1);
    assert.deepEqual(env.PUSH.json(`timers:${PLAYER}`).timers.map(t => t.id), ['b']);
    // a permanent refusal
    const env2 = makeEnv();
    const you = await subscribed(env2, OTHER);
    await handle(post('/schedule', { playerId: OTHER, token: you.token, timers: [timer('a', NOW - MIN), timer('b', NOW + HOUR)] }), env2);
    const svc2 = pushService([you], () => 400);
    stats = await runCron(env2, NOW, { fetchImpl: svc2 });
    assert.equal(stats.failed, 1);
    assert.deepEqual(env2.PUSH.json(`timers:${OTHER}`).timers.map(t => t.id), ['b']);
    assert.deepEqual(env2.PUSH.json(KEY_INDEX), { [OTHER]: NOW + HOUR });
  });

  test('timers long past due are forgotten rather than announced', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    // write the record directly: /schedule would already have dropped a timer this old
    await env.PUSH.put(`timers:${PLAYER}`, JSON.stringify({ station: '', timers: [timer('old', NOW - STALE_MS - MIN), timer('fresh', NOW - MIN), timer('later', NOW + MIN)] }));
    await env.PUSH.put(KEY_INDEX, JSON.stringify({ [PLAYER]: NOW - STALE_MS - MIN }));
    const svc = pushService([me]);
    const stats = await runCron(env, NOW, { fetchImpl: svc });
    assert.deepEqual([stats.sent, stats.dropped], [1, 1]);
    assert.equal(svc.calls[0].payload.title, 'fresh online');
    assert.deepEqual(env.PUSH.json(`timers:${PLAYER}`).timers.map(t => t.id), ['later']);
  });

  test('index entries without timers or without a subscription are cleaned up', async () => {
    const env = makeEnv();
    await env.PUSH.put(KEY_INDEX, JSON.stringify({ ghost: NOW - MIN, nosub: NOW - MIN, later: NOW + HOUR }));
    await env.PUSH.put('timers:nosub', JSON.stringify({ station: '', timers: [timer('a', NOW - MIN)] }));
    const svc = pushService([]);
    const stats = await runCron(env, NOW, { fetchImpl: svc });
    assert.equal(svc.calls.length, 0);
    assert.equal(stats.dropped, 1);
    assert.deepEqual(env.PUSH.json(KEY_INDEX), { later: NOW + HOUR });
    assert.equal(env.PUSH.map.has('timers:nosub'), false);
  });

  test(`at most ${MAX_SENDS_PER_RUN} sends per run; the rest stay due for the next minute`, async () => {
    const env = makeEnv();
    const browsers = [];
    const index = {};
    for (let i = 0; i < MAX_SENDS_PER_RUN + 2; i++) {
      const pid = `player-${String(i).padStart(4, '0')}`;
      const b = await fakeBrowser();
      browsers.push(b);
      await env.PUSH.put(`sub:${pid}`, JSON.stringify({ ...b.subscription, token: 't'.repeat(43) }));
      await env.PUSH.put(`timers:${pid}`, JSON.stringify({ station: '', timers: [timer('a', NOW - i * 1000)] }));
      index[pid] = NOW - i * 1000;
    }
    await env.PUSH.put(KEY_INDEX, JSON.stringify(index));
    const svc = pushService(browsers);
    const stats = await runCron(env, NOW, { fetchImpl: svc });
    assert.equal(stats.sent, MAX_SENDS_PER_RUN);
    assert.equal(stats.deferred, 2);
    assert.equal(Object.keys(env.PUSH.json(KEY_INDEX)).length, 2);
    const next = await runCron(env, NOW + MIN, { fetchImpl: svc });
    assert.equal(next.sent, 2);
    assert.deepEqual(env.PUSH.json(KEY_INDEX), {});
  });

  test('every 15 minutes the index is rebuilt from the timers keys', async () => {
    const env = makeEnv();
    const me = await subscribed(env);
    await handle(post('/schedule', { playerId: PLAYER, token: me.token, timers: [timer('a', NOW - MIN)] }), env);
    await env.PUSH.delete(KEY_INDEX);                        // a lost update
    const svc = pushService([me]);
    const quiet = await runCron(env, NOW, { fetchImpl: svc });
    assert.equal(quiet.sent, 0, 'a normal minute trusts the index');
    const healMinute = NOW + (HEAL_EVERY_MIN - (Math.floor(NOW / MIN) % HEAL_EVERY_MIN)) * MIN;
    assert.equal(Math.floor(healMinute / MIN) % HEAL_EVERY_MIN, 0);
    const healed = await runCron(env, healMinute, { fetchImpl: svc });
    assert.equal(healed.healed, true);
    assert.equal(healed.sent, 1);
    assert.equal(env.PUSH.ops.list, 1);
    assert.deepEqual(await rebuildIndex(env.PUSH), {});
  });

  test('rebuildIndex pages through list results', async () => {
    const kv = kvStub();
    for (let i = 0; i < 5; i++) await kv.put(`timers:p${i}`, JSON.stringify({ timers: [timer('b', 100 + i), timer('a', 50 + i)] }));
    await kv.put('sub:p0', '{}');
    const paged = { ...kv, list: opts => kv.list({ ...opts, limit: 2 }) };
    assert.deepEqual(await rebuildIndex(paged), { p0: 50, p1: 51, p2: 52, p3: 53, p4: 54 });
  });

  test('refuses to run without the VAPID keys, and the scheduled() export drives runCron', async () => {
    await assert.rejects(runCron(makeEnv({ VAPID_PRIVATE_KEY: '' }), NOW), err => err instanceof HttpError && err.code === 'config');
    const env = makeEnv();
    const me = await subscribed(env);
    await handle(post('/schedule', { playerId: PLAYER, token: me.token, timers: [timer('a', NOW - MIN)] }), env);
    const svc = pushService([me]);
    const realFetch = globalThis.fetch; globalThis.fetch = svc;
    const realLog = console.log; const logs = []; console.log = (...a) => logs.push(a.join(' '));
    try {
      const waits = [];
      worker.scheduled({ scheduledTime: NOW, cron: '* * * * *' }, env, { waitUntil: p => waits.push(p) });
      await Promise.all(waits);
    } finally { globalThis.fetch = realFetch; console.log = realLog; }
    assert.equal(svc.calls.length, 1);
    assert.match(logs.join('\n'), /push: cron .*"sent":1/);
  });
});

describe('helpers', () => {
  test('timingSafeEqual and normaliseTimers edge cases', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
    assert.equal(timingSafeEqual('abc', 'abcd'), false);
    assert.deepEqual(normaliseTimers([], NOW), []);
    const many = Array.from({ length: MAX_TIMERS }, (_, i) => timer(`t${i}`, NOW + (MAX_TIMERS - i) * MIN));
    const n = normaliseTimers(many, NOW);
    assert.equal(n.length, MAX_TIMERS);
    assert.equal(n[0].id, `t${MAX_TIMERS - 1}`, 'sorted by dueAt');
  });
});

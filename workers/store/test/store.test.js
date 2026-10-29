// ============================================================
// PORT SOLACE — store tests (DESIGN2.md 7.4 / 10.1)
// Run with `node workers/store/test/store.test.js` (or `npm test` in workers/store). Exit code 0 = all green.
//
// Part 1 exercises the Worker handlers through `handle(request, env)` with a mocked globalThis.fetch for
// api.stripe.com and an in-memory KV stub. Part 2 loads play/js/store.js into a node:vm context with a fake
// document / localStorage / location / history / Sim / Meta and exercises the sandbox and Stripe client flows.
// ============================================================
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

import worker, { handle, signPayload, verifyStripeSignature, hmacSha256Hex, timingSafeEqual, parsePrices } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://portsolace.com';
const RETURN_URL = `${ORIGIN}/play/`;
const PLAYER = '7f0c1c2e-6d4a-4a7b-9b7e-1f2d3c4b5a69';
const OTHER_PLAYER = '00000000-1111-4222-8333-444444444444';
const WH_SECRET = 'whsec_test_secret_for_unit_tests';
const PRICES = { am_50: 'price_am50', am_140: 'price_am140', sector_pass: 'price_pass', credits_s: 'price_creds' };

// ---------------------------------------------------------- stubs
function kvStub() {
  const map = new Map();
  return {
    map,
    async get(key, type) { const v = map.has(key) ? map.get(key) : null; return v !== null && type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
  };
}
function makeEnv(overrides = {}) {
  return {
    STORE: kvStub(),
    ALLOWED_ORIGIN: `${ORIGIN}, http://localhost:8794`,
    PRICES: JSON.stringify(PRICES),
    STRIPE_SECRET_KEY: 'sk_test_unit',
    STRIPE_WEBHOOK_SECRET: WH_SECRET,
    ...overrides,
  };
}
const jsonRes = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// A scripted Stripe: records every call, answers from `sessions` by id, and lists them for /restore.
function stripeMock({ sessions = {}, createId = 'cs_test_created0001' } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.stripe.com', `unexpected fetch to ${url}`);
    assert.equal(init.headers.authorization, 'Bearer sk_test_unit');
    const call = { method: init.method || 'GET', path: u.pathname, query: u.searchParams, body: init.body ? new URLSearchParams(init.body) : null };
    calls.push(call);
    if (call.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
      return jsonRes(200, { id: createId, url: `https://checkout.stripe.com/c/pay/${createId}`, object: 'checkout.session' });
    }
    if (call.method === 'GET' && u.pathname === '/v1/checkout/sessions') {
      const email = u.searchParams.get('customer_details[email]');
      const data = Object.values(sessions).filter(s => (s.customer_details || {}).email === email);
      return jsonRes(200, { object: 'list', data, has_more: false });
    }
    const m = u.pathname.match(/^\/v1\/checkout\/sessions\/(.+)$/);
    if (call.method === 'GET' && m) {
      const s = sessions[decodeURIComponent(m[1])];
      return s ? jsonRes(200, s) : jsonRes(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such checkout.session' } });
    }
    return jsonRes(500, { error: { message: `unmocked ${call.method} ${u.pathname}` } });
  };
  fn.calls = calls;
  return fn;
}
const session = (id, { paid = true, player = PLAYER, sku = 'am_50', email = 'buyer@example.com' } = {}) => ({
  id, object: 'checkout.session', payment_status: paid ? 'paid' : 'unpaid', status: paid ? 'complete' : 'open',
  client_reference_id: player, metadata: { sku, playerId: player }, customer_details: { email },
});

const req = (path, { method = 'GET', body, headers = {}, origin = ORIGIN } = {}) => new Request(`https://waystation-store.example.workers.dev${path}`, {
  method,
  headers: { ...(origin ? { Origin: origin } : {}), ...(body && typeof body === 'object' ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const readJson = async res => ({ status: res.status, headers: res.headers, data: await res.json() });
// Objects created inside the vm context have their own Object.prototype; compare structure, not realm.
const plain = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const same = (actual, expected, msg) => assert.deepEqual(plain(actual), plain(expected), msg);

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

// ============================================================ Part 1: the Worker
describe('worker: configuration and CORS', () => {
  test('default export routes to handle()', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('/health'), env);
    const { status, data } = await readJson(res);
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.stripe, 'test');
    assert.equal(data.webhookSecret, true);
    assert.equal(data.kv, true);
    same(data.prices.skus.sort(), Object.keys(PRICES).sort());
    same(data.allowedOrigins, [ORIGIN.toLowerCase(), 'http://localhost:8794']);
  });

  test('CORS headers are present for an allowed origin and absent for others', async () => {
    const env = makeEnv();
    const ok = await handle(req('/health', { origin: ORIGIN }), env);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(ok.headers.get('vary'), 'Origin');
    const local = await handle(req('/health', { origin: 'http://localhost:8794' }), env);
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:8794');
    const bad = await handle(req('/health', { origin: 'https://evil.example' }), env);
    assert.equal(bad.status, 200, 'the request still works server-to-server');
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    const none = await handle(req('/health', { origin: null }), env);
    assert.equal(none.headers.get('access-control-allow-origin'), null);
  });

  test('preflight answers 204 with CORS only for the allowed origin', async () => {
    const env = makeEnv();
    const ok = await handle(req('/checkout', { method: 'OPTIONS', origin: ORIGIN, headers: { 'Access-Control-Request-Method': 'POST' } }), env);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.match(ok.headers.get('access-control-allow-headers'), /content-type/i);
    const bad = await handle(req('/checkout', { method: 'OPTIONS', origin: 'https://evil.example' }), env);
    assert.equal(bad.status, 204);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });

  test('unknown routes and wrong methods answer with JSON errors', async () => {
    const env = makeEnv();
    const nf = await readJson(await handle(req('/nope'), env));
    assert.equal(nf.status, 404); assert.equal(nf.data.error, 'not-found');
    const mna = await readJson(await handle(req('/checkout'), env));
    assert.equal(mna.status, 405); assert.equal(mna.data.error, 'method-not-allowed'); same(mna.data.allow, ['POST']);
  });

  test('parsePrices accepts only well-formed sku -> price_ pairs', () => {
    same(parsePrices({ PRICES: '{"am_50":"price_1","Bad Sku":"price_2","am_140":"nope"}' }), { am_50: 'price_1' });
    assert.throws(() => parsePrices({ PRICES: 'not json' }), /PRICES is not valid JSON/);
    assert.throws(() => parsePrices({ PRICES: '[1,2]' }), /must be a JSON object/);
  });
});

describe('worker: POST /checkout', () => {
  test('builds the Stripe form body and returns the session url', async () => {
    const env = makeEnv();
    const stripe = stripeMock(); globalThis.fetch = stripe;
    const { status, data } = await readJson(await handle(req('/checkout', { method: 'POST', body: { sku: 'am_140', playerId: PLAYER, returnUrl: RETURN_URL } }), env));
    assert.equal(status, 200);
    assert.equal(data.id, 'cs_test_created0001');
    assert.equal(data.url, 'https://checkout.stripe.com/c/pay/cs_test_created0001');
    assert.equal(data.sku, 'am_140');

    assert.equal(stripe.calls.length, 1);
    const call = stripe.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/v1/checkout/sessions');
    assert.equal(call.body.get('mode'), 'payment');
    assert.equal(call.body.get('line_items[0][price]'), 'price_am140');
    assert.equal(call.body.get('line_items[0][quantity]'), '1');
    assert.equal(call.body.get('client_reference_id'), PLAYER);
    assert.equal(call.body.get('metadata[sku]'), 'am_140');
    assert.equal(call.body.get('success_url'), `${RETURN_URL}?purchase=success&session_id={CHECKOUT_SESSION_ID}`);
    assert.equal(call.body.get('cancel_url'), `${RETURN_URL}?purchase=cancel`);
  });

  test('every session names the game on the card statement', async () => {
    const env = makeEnv();
    const stripe = stripeMock(); globalThis.fetch = stripe;
    for (const sku of ['am_50', 'am_140']) {
      await handle(req('/checkout', { method: 'POST', body: { sku, playerId: PLAYER, returnUrl: RETURN_URL } }), env);
    }
    assert.equal(stripe.calls.length, 2);
    for (const call of stripe.calls) {
      const suffix = call.body.get('payment_intent_data[statement_descriptor_suffix]');
      assert.equal(suffix, 'PORTSOLACE');
      assert.ok('PRIME SIGN'.length + 2 + suffix.length <= 22, 'prefix + "* " + suffix fits the 22-character limit');
      assert.doesNotMatch(suffix, /[<>\\'"*]/, 'no characters Stripe rejects in a descriptor');
    }
  });

  test('strips any query from returnUrl and rejects foreign origins', async () => {
    const env = makeEnv();
    const stripe = stripeMock(); globalThis.fetch = stripe;
    await handle(req('/checkout', { method: 'POST', body: { sku: 'am_50', playerId: PLAYER, returnUrl: `${RETURN_URL}?purchase=cancel#x` } }), env);
    assert.equal(stripe.calls[0].body.get('cancel_url'), `${RETURN_URL}?purchase=cancel`);
    const bad = await readJson(await handle(req('/checkout', { method: 'POST', body: { sku: 'am_50', playerId: PLAYER, returnUrl: 'https://evil.example/play/' } }), env));
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-return-url');
    assert.equal(stripe.calls.length, 1, 'Stripe is not called for a rejected request');
  });

  test('validates input: unknown sku -> 400, bad player -> 400, bad json -> 400', async () => {
    const env = makeEnv();
    globalThis.fetch = stripeMock();
    const sku = await readJson(await handle(req('/checkout', { method: 'POST', body: { sku: 'am_9999', playerId: PLAYER, returnUrl: RETURN_URL } }), env));
    assert.equal(sku.status, 400); assert.equal(sku.data.error, 'unknown-sku'); assert.ok(sku.data.known.includes('am_50'));
    const player = await readJson(await handle(req('/checkout', { method: 'POST', body: { sku: 'am_50', playerId: 'x', returnUrl: RETURN_URL } }), env));
    assert.equal(player.status, 400); assert.equal(player.data.error, 'bad-player');
    const bad = await readJson(await handle(req('/checkout', { method: 'POST', body: '{nope', headers: { 'content-type': 'application/json' } }), env));
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-json');
  });

  test('missing configuration answers 500 with a clear message', async () => {
    globalThis.fetch = stripeMock();
    const noKey = await readJson(await handle(req('/checkout', { method: 'POST', body: { sku: 'am_50', playerId: PLAYER, returnUrl: RETURN_URL } }), makeEnv({ STRIPE_SECRET_KEY: '' })));
    assert.equal(noKey.status, 500); assert.equal(noKey.data.error, 'config'); assert.match(noKey.data.message, /STRIPE_SECRET_KEY/);
    const noPrices = await readJson(await handle(req('/checkout', { method: 'POST', body: { sku: 'am_50', playerId: PLAYER, returnUrl: RETURN_URL } }), makeEnv({ PRICES: '' })));
    assert.equal(noPrices.status, 500); assert.equal(noPrices.data.error, 'config');
  });

  test('a Stripe error becomes a 502 with the Stripe message', async () => {
    const env = makeEnv();
    globalThis.fetch = async () => jsonRes(400, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such price: price_am50', param: 'line_items[0][price]' } });
    const r = await readJson(await handle(req('/checkout', { method: 'POST', body: { sku: 'am_50', playerId: PLAYER, returnUrl: RETURN_URL } }), env));
    assert.equal(r.status, 502); assert.equal(r.data.error, 'stripe'); assert.match(r.data.message, /No such price/);
  });
});

describe('worker: GET /claim', () => {
  test('grants once and is idempotent', async () => {
    const env = makeEnv();
    globalThis.fetch = stripeMock({ sessions: { cs_test_paid00001: session('cs_test_paid00001', { sku: 'am_50' }) } });
    const first = await readJson(await handle(req(`/claim?session_id=cs_test_paid00001&playerId=${PLAYER}`), env));
    assert.equal(first.status, 200);
    same({ sku: first.data.sku, granted: first.data.granted, grantId: first.data.grantId, duplicate: first.data.duplicate }, { sku: 'am_50', granted: true, grantId: 'cs_test_paid00001', duplicate: false });
    const grant = JSON.parse(env.STORE.map.get('grant:cs_test_paid00001'));
    assert.equal(grant.sku, 'am_50'); assert.equal(grant.playerId, PLAYER); assert.ok(grant.at);
    same(JSON.parse(env.STORE.map.get(`player:${PLAYER}`)), ['cs_test_paid00001']);

    const second = await readJson(await handle(req(`/claim?session_id=cs_test_paid00001&playerId=${PLAYER}`), env));
    assert.equal(second.status, 200); assert.equal(second.data.granted, true); assert.equal(second.data.duplicate, true);
    same(JSON.parse(env.STORE.map.get(`player:${PLAYER}`)), ['cs_test_paid00001'], 'the player list does not grow');
  });

  test('rejects unpaid sessions and mismatched playerIds without writing KV', async () => {
    const env = makeEnv();
    globalThis.fetch = stripeMock({ sessions: {
      cs_test_unpaid0001: session('cs_test_unpaid0001', { paid: false }),
      cs_test_paid00002: session('cs_test_paid00002', { player: OTHER_PLAYER }),
    } });
    const unpaid = await readJson(await handle(req(`/claim?session_id=cs_test_unpaid0001&playerId=${PLAYER}`), env));
    assert.equal(unpaid.status, 402); assert.equal(unpaid.data.error, 'unpaid'); assert.equal(unpaid.data.paymentStatus, 'unpaid');
    const mismatch = await readJson(await handle(req(`/claim?session_id=cs_test_paid00002&playerId=${PLAYER}`), env));
    assert.equal(mismatch.status, 403); assert.equal(mismatch.data.error, 'player-mismatch');
    assert.equal(env.STORE.map.size, 0);
  });

  test('validates ids and reports unknown sessions', async () => {
    const env = makeEnv();
    globalThis.fetch = stripeMock();
    const badId = await readJson(await handle(req(`/claim?session_id=../secrets&playerId=${PLAYER}`), env));
    assert.equal(badId.status, 400); assert.equal(badId.data.error, 'bad-session');
    const missing = await readJson(await handle(req(`/claim?session_id=cs_test_missing001&playerId=${PLAYER}`), env));
    assert.equal(missing.status, 404); assert.equal(missing.data.error, 'no-session');
  });
});

describe('worker: POST /webhook', () => {
  const event = (s, type = 'checkout.session.completed') => JSON.stringify({ id: 'evt_1', object: 'event', type, data: { object: s } });

  test('accepts a correctly signed checkout.session.completed and records the grant once', async () => {
    const env = makeEnv();
    const payload = event(session('cs_test_hook00001', { sku: 'sector_pass' }));
    const sig = await signPayload(payload, WH_SECRET);
    const first = await readJson(await handle(req('/webhook', { method: 'POST', body: payload, headers: { 'Stripe-Signature': sig, 'content-type': 'application/json' }, origin: null }), env));
    assert.equal(first.status, 200);
    same(first.data, { received: true, granted: true, grantId: 'cs_test_hook00001', sku: 'sector_pass', duplicate: false });
    assert.equal(JSON.parse(env.STORE.map.get('grant:cs_test_hook00001')).sku, 'sector_pass');
    const again = await readJson(await handle(req('/webhook', { method: 'POST', body: payload, headers: { 'Stripe-Signature': sig }, origin: null }), env));
    assert.equal(again.data.duplicate, true);
    same(JSON.parse(env.STORE.map.get(`player:${PLAYER}`)), ['cs_test_hook00001']);
  });

  test('rejects a bad signature, a stale timestamp and a malformed header', async () => {
    const env = makeEnv();
    const payload = event(session('cs_test_hook00002'));
    const wrong = await signPayload(payload, 'whsec_wrong');
    const bad = await readJson(await handle(req('/webhook', { method: 'POST', body: payload, headers: { 'Stripe-Signature': wrong }, origin: null }), env));
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-signature'); assert.match(bad.data.message, /mismatch/);
    const tampered = await readJson(await handle(req('/webhook', { method: 'POST', body: payload.replace('"paid"', '"paid "'), headers: { 'Stripe-Signature': await signPayload(payload, WH_SECRET) }, origin: null }), env));
    assert.equal(tampered.status, 400); assert.match(tampered.data.message, /mismatch/);
    const staleSig = await signPayload(payload, WH_SECRET, Math.floor(Date.now() / 1000) - 6 * 60);
    const stale = await readJson(await handle(req('/webhook', { method: 'POST', body: payload, headers: { 'Stripe-Signature': staleSig }, origin: null }), env));
    assert.equal(stale.status, 400); assert.match(stale.data.message, /stale/);
    const malformed = await readJson(await handle(req('/webhook', { method: 'POST', body: payload, headers: { 'Stripe-Signature': 'garbage' }, origin: null }), env));
    assert.equal(malformed.status, 400); assert.match(malformed.data.message, /malformed/);
    const none = await readJson(await handle(req('/webhook', { method: 'POST', body: payload, origin: null }), env));
    assert.equal(none.status, 400);
    assert.equal(env.STORE.map.size, 0);
  });

  test('ignores other event types and unpaid sessions', async () => {
    const env = makeEnv();
    const other = event({ id: 'pi_1' }, 'payment_intent.succeeded');
    const r1 = await readJson(await handle(req('/webhook', { method: 'POST', body: other, headers: { 'Stripe-Signature': await signPayload(other, WH_SECRET) }, origin: null }), env));
    same(r1.data, { received: true, ignored: true, type: 'payment_intent.succeeded' });
    const unpaid = event(session('cs_test_hook00003', { paid: false }));
    const r2 = await readJson(await handle(req('/webhook', { method: 'POST', body: unpaid, headers: { 'Stripe-Signature': await signPayload(unpaid, WH_SECRET) }, origin: null }), env));
    same(r2.data, { received: true, granted: false, reason: 'not-paid' });
    assert.equal(env.STORE.map.size, 0);
  });

  test('signature primitives: multiple v1 values, 5-minute window, constant-time compare', async () => {
    const payload = '{"x":1}';
    const t = Math.floor(Date.now() / 1000);
    const good = await hmacSha256Hex(WH_SECRET, `${t}.${payload}`);
    const header = `t=${t},v1=${'0'.repeat(64)},v1=${good}`;
    same(await verifyStripeSignature(payload, header, WH_SECRET), { valid: true, reason: 'ok' });
    same(await verifyStripeSignature(payload, header, WH_SECRET, { nowS: t + 299 }), { valid: true, reason: 'ok' });
    same(await verifyStripeSignature(payload, header, WH_SECRET, { nowS: t + 301 }), { valid: false, reason: 'stale' });
    same(await verifyStripeSignature(payload, header, WH_SECRET, { nowS: t - 301 }), { valid: false, reason: 'stale' });
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
    assert.equal(timingSafeEqual('abc', 'abcd'), false);
    assert.equal(timingSafeEqual('abc', undefined), false);
  });
});

describe('worker: GET /entitlements and GET /restore', () => {
  test('entitlements lists the grants recorded for a player', async () => {
    const env = makeEnv();
    globalThis.fetch = stripeMock({ sessions: {
      cs_test_ent000001: session('cs_test_ent000001', { sku: 'am_50' }),
      cs_test_ent000002: session('cs_test_ent000002', { sku: 'sector_pass' }),
    } });
    await handle(req(`/claim?session_id=cs_test_ent000001&playerId=${PLAYER}`), env);
    await handle(req(`/claim?session_id=cs_test_ent000002&playerId=${PLAYER}`), env);
    const { status, data } = await readJson(await handle(req(`/entitlements?playerId=${PLAYER}`), env));
    assert.equal(status, 200);
    assert.equal(data.playerId, PLAYER);
    same(data.grants.map(g => [g.grantId, g.sku]), [['cs_test_ent000001', 'am_50'], ['cs_test_ent000002', 'sector_pass']]);
    assert.ok(data.grants.every(g => typeof g.at === 'string'));
    const empty = await readJson(await handle(req(`/entitlements?playerId=${OTHER_PLAYER}`), env));
    same(empty.data.grants, []);
    const bad = await readJson(await handle(req('/entitlements?playerId=nope'), env));
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-player');
  });

  test('restore claims unclaimed paid sessions for this player only and lists everything', async () => {
    const env = makeEnv();
    const stripe = stripeMock({ sessions: {
      cs_test_res000001: session('cs_test_res000001', { sku: 'am_140' }),                          // paid, this player, unclaimed
      cs_test_res000002: session('cs_test_res000002', { sku: 'am_50' }),                           // paid, claimed earlier
      cs_test_res000003: session('cs_test_res000003', { sku: 'am_50', paid: false }),              // not paid
      cs_test_res000004: session('cs_test_res000004', { sku: 'am_50', player: OTHER_PLAYER }),     // someone else's profile
      cs_test_res000005: session('cs_test_res000005', { sku: 'am_50', email: 'other@example.com' }),
    } });
    globalThis.fetch = stripe;
    await handle(req(`/claim?session_id=cs_test_res000002&playerId=${PLAYER}`), env);
    const { status, data } = await readJson(await handle(req(`/restore?email=Buyer%40Example.com&playerId=${PLAYER}`), env));
    assert.equal(status, 200);
    const listCall = stripe.calls.find(c => c.method === 'GET' && c.path === '/v1/checkout/sessions');
    assert.equal(listCall.query.get('customer_details[email]'), 'buyer@example.com', 'email is lower-cased and sent as the list filter');
    assert.equal(data.found, 3);
    assert.equal(data.otherProfile, 1);
    same(data.newlyGranted.map(g => g.sku), ['am_140']);
    same(data.grants.map(g => g.grantId).sort(), ['cs_test_res000001', 'cs_test_res000002']);
    assert.equal(env.STORE.map.has('grant:cs_test_res000004'), false, 'no transfer across profiles');
    const bad = await readJson(await handle(req(`/restore?email=nope&playerId=${PLAYER}`), env));
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-email');
  });
});

// ============================================================ Part 2: the client (play/js/store.js in a vm)
const STORE_SRC = readFileSync(resolve(here, '../../../waystation/play/js/store.js'), 'utf8');

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    clear: () => map.clear(),
  };
}
function fakeMeta({ rate = 100, playerId = null } = {}) {
  const calls = { addAM: [], addCredits: [], unlockAllSectors: [], grantEntitlement: [] };
  const profile = { v: 2, playerId, am: 20, unlocked: ['home'], entitlements: { history: [] } };
  return {
    calls, profile,
    addAM(n, reason) { calls.addAM.push([n, reason]); profile.am += n; },
    addCredits(n, reason) { calls.addCredits.push([n, reason]); },
    totalRate() { return rate; },
    unlockAllSectors(reason) { calls.unlockAllSectors.push(reason); },
    grantEntitlement(sku, payload) { calls.grantEntitlement.push([sku, payload]); profile.entitlements.history.push({ sku, ...payload }); },
    hasEntitlement(sku) { return profile.entitlements.history.some(h => h.sku === sku); },
  };
}

// Builds a fresh browser-ish context and loads store.js into it. Returns { Store, ctx, sim, storage, history }.
function loadStore({ meta: metaContent, storage = fakeStorage(), search = '', Meta, catalog, fetch } = {}) {
  const simEvents = [];
  const Sim = { listeners: {}, on(e, f) { (this.listeners[e] ||= []).push(f); }, emit(e, d) { simEvents.push([e, d]); (this.listeners[e] || []).forEach(f => f(d)); } };
  const replaced = [];
  const ctx = {
    console, setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, Promise, Date, Math, JSON, Error, Object, Array, Number, String, Boolean, Set, Map, Uint8Array,
    crypto: globalThis.crypto,
    localStorage: storage,
    document: {
      readyState: 'complete', body: { dataset: {} }, addEventListener() {},
      querySelector(sel) { return (metaContent !== undefined && sel.includes('portsolace-store')) ? { getAttribute: n => (n === 'content' ? metaContent : null) } : null; },
    },
    location: { origin: ORIGIN, pathname: '/play/', search, hash: '', href: `${RETURN_URL}${search}`, assigned: null, assign(u) { this.assigned = u; } },
    history: { state: null, replaceState(state, title, url) { replaced.push(url); } },
    Sim,
  };
  if (Meta) ctx.Meta = Meta;
  if (catalog) ctx.STORE_CATALOG = catalog;
  if (fetch) ctx.fetch = fetch;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(STORE_SRC, ctx, { filename: 'store.js' });
  const Store = vm.runInContext('Store', ctx);
  return { Store, ctx, simEvents, storage, replaced };
}

describe('client: configuration and catalog', () => {
  test('defaults to sandbox, reads the meta tag, honours the localStorage override, marks the body', async () => {
    const plain = loadStore();
    await plain.Store.ready;
    assert.equal(plain.Store.mode, 'sandbox');
    assert.equal(plain.ctx.document.body.dataset.store, 'sandbox');

    const tagged = loadStore({ meta: '{"mode":"stripe","apiBase":"https://waystation-store.example.workers.dev/"}' });
    assert.equal(tagged.Store.mode, 'stripe');
    assert.equal(tagged.Store.config.apiBase, 'https://waystation-store.example.workers.dev', 'trailing slash removed');
    assert.equal(tagged.ctx.document.body.dataset.store, 'stripe');

    const invalid = loadStore({ meta: '{"mode":"stripe"}' });
    assert.equal(invalid.Store.mode, 'sandbox', 'stripe without apiBase falls back');
    assert.ok(invalid.Store.warnings.some(w => /apiBase/.test(w)));

    const overridden = loadStore({ meta: '{"mode":"sandbox"}', storage: fakeStorage({ 'portsolace.store': '{"mode":"stripe","apiBase":"http://127.0.0.1:8788"}' }) });
    assert.equal(overridden.Store.mode, 'stripe');
    overridden.Store.configure({ mode: 'sandbox' });
    assert.equal(overridden.Store.mode, 'stripe', 'the local override wins over configure()');
  });

  test('falls back to the inline 7.1 catalog and normalises STORE_CATALOG when present', () => {
    const fb = loadStore();
    const cat = fb.Store.catalog();
    assert.equal(fb.Store.catalogSource, 'fallback');
    same(cat.map(e => e.sku), ['am_50', 'am_140', 'am_320', 'am_900', 'credits_s', 'credits_l', 'sector_pass', 'founder', 'liveries']);
    same(cat.map(e => e.priceCents), [199, 499, 999, 2499, 199, 599, 999, 499, 299]);
    assert.equal(cat[1].badge, 'Popular'); assert.equal(cat[3].badge, 'Best value'); assert.equal(cat[0].badge, null);
    assert.equal(cat[1].priceLabel, '$4.99');
    same(cat[4].grant, { credits: { hours: 2, min: 10000 } });
    same(cat[6].grant, { unlockAll: true, entitlement: 'sector_pass' });
    assert.equal(cat[7].grant.am, 100);
    for (const e of cat) for (const k of ['sku', 'kind', 'title', 'desc', 'amount', 'grant', 'priceCents', 'priceLabel', 'badge']) assert.ok(k in e, `${e.sku} has ${k}`);

    const custom = loadStore({ catalog: [
      { sku: 'am_50', kind: 'am', name: 'Fifty', price: '$1.99', grants: '50 AM' },            // string grant -> fallback grant
      { id: 'am_140', kind: 'am', price: 4.99, am: 140, tag: 'Popular' },                        // dollars, am as amount
      { sku: 'credits_s', kind: 'credits', price: 199, grant: { hours: 2, floor: 10000 } },     // cents, hours/floor spelling
      { sku: 'mystery', kind: 'cosmetic', title: 'Mystery', priceCents: 1299 },                 // unknown sku: inferred grant
    ] });
    const c = custom.Store.catalog();
    assert.equal(custom.Store.catalogSource, 'data2');
    same(c.map(e => [e.sku, e.title, e.priceCents, e.priceLabel]), [['am_50', 'Fifty', 199, '$1.99'], ['am_140', '140 Antimatter', 499, '$4.99'], ['credits_s', 'Relief Convoy', 199, '$1.99'], ['mystery', 'Mystery', 1299, '$12.99']]);
    same(c[0].grant, { am: 50 });
    same(c[1].grant, { am: 140 }); assert.equal(c[1].badge, 'Popular');
    same(c[2].grant, { credits: { hours: 2, min: 10000 } });
    same(c[3].grant, { entitlement: 'mystery' });
    assert.equal(custom.Store.item('nope'), null);
  });
});

describe('client: sandbox purchase', () => {
  test('confirms through Store.ui.confirm, grants once after the latency, emits purchase, queues without Meta and flushes into Meta', async () => {
    const { Store, simEvents, storage } = loadStore();
    Store.configure({ latencyMs: 20 });
    const confirms = [];
    Store.ui.confirm = async req => { confirms.push(req); return true; };
    const events = []; Store.on('purchase', e => events.push(e));

    const t0 = Date.now();
    const res = await Store.purchase('am_50');
    assert.ok(Date.now() - t0 >= 15, 'waits the simulated latency');
    same(confirms, [{ sku: 'am_50', title: '50 Antimatter', desc: Store.item('am_50').desc, priceLabel: '$1.99', testMode: true }]);
    assert.equal(res.ok, true); assert.equal(res.sku, 'am_50'); same(res.granted, { am: 50 }); assert.equal(res.pending, true);
    assert.match(res.grantId, /^sandbox-[0-9a-f-]{36}$/);
    assert.equal(events.length, 1);
    assert.equal(simEvents.length, 1); assert.equal(simEvents[0][0], 'purchase');
    same({ sku: simEvents[0][1].sku, granted: simEvents[0][1].granted, mode: simEvents[0][1].mode }, { sku: 'am_50', granted: { am: 50 }, mode: 'sandbox' });
    assert.equal(Store.pending().length, 1, 'queued in localStorage while Meta is absent');
    assert.equal(JSON.parse(storage.getItem('portsolace.store.pending')).length, 1);
    assert.equal(Store.flush().length, 0, 'flush without Meta is a no-op');
    assert.equal(Store.pending().length, 1);
  });

  test('a declined confirm grants nothing and emits purchase with granted:false', async () => {
    const { Store, simEvents } = loadStore({ Meta: fakeMeta() });
    Store.configure({ latencyMs: 0 });
    Store.ui.confirm = async () => false;
    const res = await Store.purchase('am_140');
    same({ ok: res.ok, sku: res.sku, granted: res.granted, cancelled: res.cancelled }, { ok: false, sku: 'am_140', granted: false, cancelled: true });
    assert.equal(simEvents.length, 1); assert.equal(simEvents[0][1].granted, false);
    assert.equal(Store.pending().length, 0);
    assert.equal(Store.entitlements().length, 0);
  });

  test('with Meta present the grant goes straight through: AM, credits (hours x rate with floor), pass, cosmetics', async () => {
    const Meta = fakeMeta({ rate: 100, playerId: PLAYER });
    const { Store } = loadStore({ Meta });
    Store.configure({ latencyMs: 0 });
    Store.ui.confirm = async () => true;

    const am = await Store.purchase('am_320');
    same(am.granted, { am: 320 }); assert.equal(am.pending, false);
    same(Meta.calls.addAM, [[320, 'store:am_320']]);
    assert.equal(Meta.calls.grantEntitlement[0][0], 'am_320');
    assert.equal(Meta.calls.grantEntitlement[0][1].grantId, am.grantId);
    assert.equal(Meta.calls.grantEntitlement[0][1].mode, 'sandbox');

    const small = await Store.purchase('credits_s');       // 2h x 60 x 100/min = 12,000 > floor 10,000
    same(small.granted, { credits: 12000 });
    const big = await Store.purchase('credits_l');         // 8h x 60 x 100/min = 48,000 > floor 40,000
    same(big.granted, { credits: 48000 });
    same(Meta.calls.addCredits, [[12000, 'store:credits_s'], [48000, 'store:credits_l']]);

    const pass = await Store.purchase('sector_pass');
    same(pass.granted, { unlockAll: true, entitlement: 'sector_pass' });
    same(Meta.calls.unlockAllSectors, ['store:sector_pass']);
    assert.equal(Store.owned('sector_pass'), true);
    assert.equal(Store.catalog().find(e => e.sku === 'sector_pass').owned, true);
    const again = await Store.purchase('sector_pass');
    assert.equal(again.ok, false); assert.equal(again.error, 'already-owned');

    const founder = await Store.purchase('founder');
    same(founder.granted, { am: 100, entitlement: 'founder' });
    const rec = Meta.calls.grantEntitlement.find(c => c[0] === 'founder')[1];
    assert.equal(rec.livery, 'founder'); assert.equal(rec.title, 'Founder');

    assert.equal(Store.entitlements().length, 5, 'entitlements come from Meta.profile.entitlements.history');
    assert.equal(Store.playerId(), PLAYER, 'player id comes from the profile when present');
  });

  test('credits packs use the floor when Meta has no totalRate or a tiny station', async () => {
    const Meta = fakeMeta({ rate: 1 }); delete Meta.totalRate;
    const { Store } = loadStore({ Meta });
    Store.configure({ latencyMs: 0 }); Store.ui.confirm = async () => true;
    same((await Store.purchase('credits_s')).granted, { credits: 10000 });
    const Meta2 = fakeMeta({ rate: 3 });
    const two = loadStore({ Meta: Meta2 }); two.Store.configure({ latencyMs: 0 }); two.Store.ui.confirm = async () => true;
    same((await two.Store.purchase('credits_l')).granted, { credits: 40000 });
  });

  test('flush applies the pending queue into Meta exactly once and reconciles the player id', async () => {
    const storage = fakeStorage();
    const first = loadStore({ storage });
    first.Store.configure({ latencyMs: 0 }); first.Store.ui.confirm = async () => true;
    await first.Store.purchase('am_50');
    await first.Store.purchase('liveries');
    const localId = storage.getItem('portsolace.playerId');
    assert.equal(localId, null, 'sandbox purchases need no player id');
    assert.equal(first.Store.playerId().length, 36);
    assert.equal(storage.getItem('portsolace.playerId'), first.Store.playerId(), 'playerId() persists a uuid');
    assert.equal(first.Store.owned('liveries'), true, 'queued cosmetics already count as owned');

    // A later page load: Meta exists now (same localStorage).
    const Meta = fakeMeta();
    const second = loadStore({ storage, Meta });
    const flushes = []; second.Store.on('flush', f => flushes.push(f));
    const applied = second.Store.flush();
    same(applied.map(a => [a.sku, a.granted]), [['am_50', { am: 50 }], ['liveries', { entitlement: 'liveries' }]]);
    same(Meta.calls.addAM, [[50, 'store:am_50']]);
    assert.equal(Meta.calls.grantEntitlement.length, 2);
    same(Meta.calls.grantEntitlement[1][1].liveries, ['sable', 'kessler', 'thessaly', 'marrow', 'oros', 'keth']);
    assert.equal(second.Store.pending().length, 0);
    assert.equal(flushes.length, 1);
    assert.equal(Meta.profile.playerId, first.Store.playerId(), 'the local uuid is reconciled into the profile');

    same(second.Store.flush(), [], 'a second flush applies nothing');
    same(Meta.calls.addAM, [[50, 'store:am_50']]);
    assert.equal(second.simEvents.length, 0, 'flush does not re-emit purchase on the Sim bus');
  });

  test('Store.grant is idempotent by grantId and unknown skus are refused', () => {
    const Meta = fakeMeta();
    const { Store } = loadStore({ Meta });
    const a = Store.grant('am_50', { grantId: 'manual-1' });
    const b = Store.grant('am_50', { grantId: 'manual-1' });
    assert.equal(a.ok, true); same(a.granted, { am: 50 });
    assert.equal(b.ok, false); assert.equal(b.duplicate, true);
    same(Meta.calls.addAM, [[50, 'store:am_50']]);
    assert.equal(Store.grant('nope').error, 'unknown-sku');
    assert.equal((Store.purchase && true), true);
  });
});

describe('client: stripe flow', () => {
  const STRIPE_META = '{"mode":"stripe","apiBase":"https://waystation-store.example.workers.dev"}';

  test('purchase POSTs /checkout with sku, playerId and returnUrl, then redirects to session.url', async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return jsonRes(200, { id: 'cs_test_redirect01', url: 'https://checkout.stripe.com/c/pay/cs_test_redirect01' }); };
    const Meta = fakeMeta({ playerId: PLAYER });
    const { Store, ctx, storage } = loadStore({ meta: STRIPE_META, Meta, fetch });
    assert.equal(Store.mode, 'stripe');
    const res = await Store.purchase('am_140');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://waystation-store.example.workers.dev/checkout');
    assert.equal(calls[0].init.method, 'POST');
    same(JSON.parse(calls[0].init.body), { sku: 'am_140', playerId: PLAYER, returnUrl: RETURN_URL });
    assert.equal(ctx.location.assigned, 'https://checkout.stripe.com/c/pay/cs_test_redirect01');
    same({ ok: res.ok, redirect: res.redirect, granted: res.granted, sessionId: res.sessionId }, { ok: true, redirect: true, granted: false, sessionId: 'cs_test_redirect01' });
    assert.equal(JSON.parse(storage.getItem('portsolace.store.inflight')).sku, 'am_140');
    same(Meta.calls.addAM, [], 'nothing is granted before the claim');
  });

  test('a backend error during checkout resolves ok:false with the error code and emits purchase granted:false', async () => {
    const fetch = async () => jsonRes(400, { error: 'unknown-sku', message: 'Unknown sku "am_140".' });
    const { Store, ctx, simEvents } = loadStore({ meta: STRIPE_META, Meta: fakeMeta({ playerId: PLAYER }), fetch });
    const res = await Store.purchase('am_140');
    assert.equal(res.ok, false); assert.equal(res.error, 'unknown-sku'); assert.match(res.message, /Unknown sku/);
    assert.equal(ctx.location.assigned, null);
    assert.equal(simEvents[0][1].granted, false);
    const down = loadStore({ meta: STRIPE_META, Meta: fakeMeta({ playerId: PLAYER }), fetch: async () => { throw new TypeError('Failed to fetch'); } });
    const r2 = await down.Store.purchase('am_140');
    assert.equal(r2.error, 'network');
  });

  test('resume() claims ?purchase=success once, strips the query, grants through Meta and emits purchase', async () => {
    const calls = [];
    const fetch = async url => { calls.push(url); return jsonRes(200, { sku: 'am_140', granted: true, grantId: 'cs_test_claim0001', playerId: PLAYER, duplicate: false }); };
    const Meta = fakeMeta({ playerId: PLAYER });
    const storage = fakeStorage({ 'portsolace.store.inflight': JSON.stringify({ sku: 'am_140', sessionId: 'cs_test_claim0001', at: 1 }) });
    const { Store, simEvents, replaced } = loadStore({ meta: STRIPE_META, Meta, fetch, storage, search: '?purchase=success&session_id=cs_test_claim0001&keep=1' });
    const res = await Store.resume();
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `https://waystation-store.example.workers.dev/claim?session_id=cs_test_claim0001&playerId=${PLAYER}`);
    same({ handled: res.handled, ok: res.ok, sku: res.sku, granted: res.granted, grantId: res.grantId, mode: res.mode }, { handled: true, ok: true, sku: 'am_140', granted: { am: 140 }, grantId: 'cs_test_claim0001', mode: 'stripe' });
    same(Meta.calls.addAM, [[140, 'store:am_140']]);
    assert.equal(Meta.calls.grantEntitlement[0][1].grantId, 'cs_test_claim0001', 'the Checkout session id is the grant id');
    same(replaced, ['/play/?keep=1'], 'purchase and session_id are stripped, other params kept');
    assert.equal(simEvents.length, 1); assert.equal(simEvents[0][1].mode, 'stripe'); assert.equal(simEvents[0][1].grantId, 'cs_test_claim0001');
    assert.equal(storage.getItem('portsolace.store.inflight'), null);

    // The same session again (e.g. the player re-opens the success URL from history): no second fetch, no second grant.
    const again = loadStore({ meta: STRIPE_META, Meta, fetch, storage, search: '?purchase=success&session_id=cs_test_claim0001' });
    const r2 = await again.Store.resume();
    assert.equal(r2.duplicate, true);
    assert.equal(calls.length, 1);
    same(Meta.calls.addAM, [[140, 'store:am_140']]);
    assert.equal(again.simEvents.length, 0);
  });

  test('resume() handles ?purchase=cancel, no query, and a definitive claim failure', async () => {
    const cancel = loadStore({ meta: STRIPE_META, Meta: fakeMeta({ playerId: PLAYER }), search: '?purchase=cancel', storage: fakeStorage({ 'portsolace.store.inflight': JSON.stringify({ sku: 'am_50', sessionId: 'cs_test_x', at: 1 }) }) });
    const r = await cancel.Store.resume();
    same({ handled: r.handled, ok: r.ok, cancelled: r.cancelled, sku: r.sku, granted: r.granted }, { handled: true, ok: false, cancelled: true, sku: 'am_50', granted: false });
    assert.equal(cancel.simEvents[0][1].granted, false);
    same(cancel.replaced, ['/play/']);
    assert.equal(cancel.storage.getItem('portsolace.store.inflight'), null);

    const idle = loadStore({ meta: STRIPE_META, Meta: fakeMeta({ playerId: PLAYER }) });
    same(await idle.Store.resume(), { handled: false });
    same(idle.replaced, []);

    const unpaid = loadStore({ meta: STRIPE_META, Meta: fakeMeta({ playerId: PLAYER }), search: '?purchase=success&session_id=cs_test_unpaid01', fetch: async () => jsonRes(402, { error: 'unpaid', message: 'This checkout session has not been paid.' }) });
    const u = await unpaid.Store.resume();
    assert.equal(u.ok, false); assert.equal(u.error, 'unpaid'); assert.equal(u.granted, false);
    assert.equal(unpaid.storage.getItem('portsolace.store.inflight'), null, 'a 4xx is final: no retry');
  });

  test('a network failure during claim is retried on the next resume()', async () => {
    const storage = fakeStorage();
    const Meta = fakeMeta({ playerId: PLAYER });
    const down = loadStore({ meta: STRIPE_META, Meta, storage, search: '?purchase=success&session_id=cs_test_retry001', fetch: async () => { throw new TypeError('Failed to fetch'); } });
    const r1 = await down.Store.resume();
    assert.equal(r1.ok, false); assert.equal(r1.error, 'network');
    assert.equal(JSON.parse(storage.getItem('portsolace.store.inflight')).unclaimed, true);

    const up = loadStore({ meta: STRIPE_META, Meta, storage, fetch: async () => jsonRes(200, { sku: 'am_50', granted: true, grantId: 'cs_test_retry001' }) });
    const r2 = await up.Store.resume();
    assert.equal(r2.ok, true); assert.equal(r2.retry, true); same(r2.granted, { am: 50 });
    same(Meta.calls.addAM, [[50, 'store:am_50']]);
    assert.equal(storage.getItem('portsolace.store.inflight'), null);
  });

  test('restore(email) applies grants the backend lists that are not yet applied; restore() without email uses /entitlements', async () => {
    const calls = [];
    const fetch = async url => { calls.push(url); return jsonRes(200, { playerId: PLAYER, grants: [{ grantId: 'cs_test_r1', sku: 'am_50', at: 'x' }, { grantId: 'cs_test_r2', sku: 'sector_pass', at: 'y' }], otherProfile: 1 }); };
    const Meta = fakeMeta({ playerId: PLAYER });
    const { Store, simEvents } = loadStore({ meta: STRIPE_META, Meta, fetch });
    Store.grant('am_50', { grantId: 'cs_test_r1', mode: 'stripe' });               // already applied earlier
    const res = await Store.restore('  Buyer@Example.com ');
    assert.equal(calls[0], `https://waystation-store.example.workers.dev/restore?email=buyer%40example.com&playerId=${PLAYER}`);
    same(res.applied.map(a => a.sku), ['sector_pass']);
    assert.equal(res.found, 2); assert.equal(res.otherProfile, 1);
    same(Meta.calls.unlockAllSectors, ['store:sector_pass']);
    same(Meta.calls.addAM, [[50, 'store:am_50']], 'am_50 is not granted twice');
    assert.equal(simEvents.length, 1); assert.equal(simEvents[0][1].restored, true);
    await Store.restore();
    assert.equal(calls[1], `https://waystation-store.example.workers.dev/entitlements?playerId=${PLAYER}`);
    const sandbox = loadStore({ Meta: fakeMeta() });
    same(await sandbox.Store.restore('a@b.co'), { ok: true, mode: 'sandbox', applied: [], message: 'Test mode: purchases live in this browser only.' });
  });
});

// ============================================================
// PORT SOLACE — account worker tests (DESIGN2.md A2.1)
// Run with `npm test` in workers/account (node --test test/). Exercises handle(request, env, {now}) with an
// in-memory KV stub. Real PBKDF2 at 100,000 iterations (about 12 ms per derivation in Node).
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import worker, { handle } from '../src/index.js';
import {
  derive, hashSecret, verifySecret, makePhrase, normalisePhrase, summarise, timingSafeEqual, readBodyBytes,
  WORDS, PBKDF2_ITER, WORKERS_PBKDF2_MAX, TOKEN_TTL_S, TOKEN_REFRESH_MS, SAVE_MAX_BYTES, LIMITS, PHRASE_WORDS,
} from '../src/lib.js';

const ORIGIN = 'https://portsolace.com';
const PEPPER = 'unit-test-pepper-that-is-long-enough';
const EMAIL = 'Commander@Example.com';
const PASSWORD = 'orbital-mechanics-42';
const HOUR = 3600e3, DAY = 86400e3;

// ---------------------------------------------------------- stubs
function kvStub() {
  const map = new Map(), puts = [];
  return {
    map, puts,
    async get(key, type) { const v = map.has(key) ? map.get(key) : null; return v !== null && type === 'json' ? JSON.parse(v) : v; },
    async put(key, value, opts) { map.set(key, String(value)); puts.push({ key, ttl: opts && opts.expirationTtl }); },
    async delete(key) { map.delete(key); },
  };
}
const makeEnv = (over = {}) => ({ ACCOUNTS: kvStub(), ALLOWED_ORIGIN: `${ORIGIN}, http://localhost:8794`, PEPPER, ...over });

const req = (path, { method = 'GET', body, headers = {}, origin = ORIGIN, token, ip = '203.0.113.7' } = {}) => new Request(`https://waystation-account.example.workers.dev${path}`, {
  method,
  headers: {
    ...(origin ? { Origin: origin } : {}),
    ...(body !== undefined && typeof body !== 'string' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'CF-Connecting-IP': ip,
    ...headers,
  },
  body: body === undefined ? undefined : typeof body === 'string' || body instanceof ArrayBuffer || body instanceof Uint8Array ? body : JSON.stringify(body),
});
const read = async res => ({ status: res.status, headers: res.headers, data: await res.json() });
const clock = t => ({ now: () => t });
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

const profile = (over = {}) => ({
  v: 2, playerId: 'p1', createdAt: T0 - DAY, savedAt: T0, credits: 12345.6, am: 42, rank: { xp: 950, level: 3 },
  activeSector: 'sable', unlocked: ['home', 'sable'],
  sectors: { home: { name: 'Lantern Reach', day: 40, level: 3, credits: 0 }, sable: { name: 'Dust Harbour', day: 12, level: 2 } },
  stats: { buildsPlaced: 9 }, ...over,
});

async function signupUser(env, email = EMAIL, password = PASSWORD, now = T0) {
  const r = await read(await handle(req('/signup', { method: 'POST', body: { email, password } }), env, clock(now)));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

// ============================================================ configuration, CORS, routing
describe('configuration and CORS', () => {
  test('health reports configuration without secrets', async () => {
    const env = makeEnv();
    const { status, data } = await read(await worker.fetch(req('/health'), env));
    assert.equal(status, 200);
    assert.equal(data.ok, true); assert.equal(data.kv, true); assert.equal(data.pepper, true);
    assert.deepEqual(data.allowedOrigins, [ORIGIN.toLowerCase(), 'http://localhost:8794']);
    assert.equal(data.pbkdf2Iterations, 100000); assert.equal(data.tokenTtlDays, 30); assert.equal(data.words, 512);
    assert.equal(JSON.stringify(data).includes(PEPPER), false);
    const bare = await read(await handle(req('/health'), makeEnv({ PEPPER: '' })));
    assert.equal(bare.data.pepper, false);
  });

  test('CORS headers only for allowed origins; preflight allows PUT/DELETE and Authorization', async () => {
    const env = makeEnv();
    const ok = await handle(req('/health', { origin: ORIGIN }), env);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const bad = await handle(req('/health', { origin: 'https://evil.example' }), env);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    const pre = await handle(req('/save', { method: 'OPTIONS', origin: ORIGIN }), env);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, PUT, DELETE, OPTIONS');
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization/i);
    const preBad = await handle(req('/save', { method: 'OPTIONS', origin: 'https://evil.example' }), env);
    assert.equal(preBad.headers.get('access-control-allow-origin'), null);
  });

  test('unknown routes, wrong methods and missing config answer with JSON errors', async () => {
    const env = makeEnv();
    const nf = await read(await handle(req('/nope'), env));
    assert.equal(nf.status, 404); assert.equal(nf.data.error, 'not-found');
    const mna = await read(await handle(req('/signup'), env));
    assert.equal(mna.status, 405); assert.deepEqual(mna.data.allow, ['POST']);
    const noPepper = await read(await handle(req('/signup', { method: 'POST', body: { email: EMAIL, password: PASSWORD } }), makeEnv({ PEPPER: '' })));
    assert.equal(noPepper.status, 500); assert.equal(noPepper.data.error, 'config'); assert.match(noPepper.data.message, /PEPPER/);
    const noKv = await read(await handle(req('/me', { token: 'x'.repeat(43) }), makeEnv({ ACCOUNTS: undefined })));
    assert.equal(noKv.status, 500); assert.equal(noKv.data.error, 'config');
  });
});

// ============================================================ hashing primitives
describe('PBKDF2, phrases and summaries', () => {
  test('PBKDF2-SHA256 vector is stable across runs (secret + pepper, 100k iterations, within the Workers cap)', async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
    const hex = Array.from(await derive('correct horse battery', 'pepper', salt, PBKDF2_ITER), b => b.toString(16).padStart(2, '0')).join('');
    assert.equal(hex, 'aff02e515d3e189a294d71648cd822d2729dddd975dd19071b04c613fb39468c');
    const again = Array.from(await derive('correct horse battery', 'pepper', salt, PBKDF2_ITER), b => b.toString(16).padStart(2, '0')).join('');
    assert.equal(again, hex);
    const otherPepper = Array.from(await derive('correct horse battery', 'pepper2', salt, PBKDF2_ITER), b => b.toString(16).padStart(2, '0')).join('');
    assert.notEqual(otherPepper, hex);
  });

  test('the iteration count stays within what the Workers runtime accepts (Node would allow more)', () => {
    assert.equal(WORKERS_PBKDF2_MAX, 100000);
    assert.ok(PBKDF2_ITER <= WORKERS_PBKDF2_MAX, `PBKDF2_ITER ${PBKDF2_ITER} > ${WORKERS_PBKDF2_MAX}: every sign-up would fail with a 500 on Cloudflare`);
  });

  test('hashSecret / verifySecret round trip with a random salt', async () => {
    const rec = await hashSecret('hunter2-but-longer', PEPPER);
    assert.equal(rec.iter, 100000);
    assert.match(rec.salt, /^[A-Za-z0-9_-]{22}$/); assert.match(rec.hash, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await verifySecret('hunter2-but-longer', PEPPER, rec), true);
    assert.equal(await verifySecret('hunter2-but-longer', 'other-pepper-value', rec), false);
    assert.equal(await verifySecret('hunter2-but-longe', PEPPER, rec), false);
    assert.equal(await verifySecret('x', PEPPER, null), false);
    const rec2 = await hashSecret('hunter2-but-longer', PEPPER);
    assert.notEqual(rec2.salt, rec.salt); assert.notEqual(rec2.hash, rec.hash);
    assert.equal(timingSafeEqual('abc', 'abc'), true); assert.equal(timingSafeEqual('abc', 'abd'), false); assert.equal(timingSafeEqual('abc', 'ab'), false);
  });

  test('the word list has 512 distinct lower-case words and phrases draw ten of them', () => {
    assert.equal(WORDS.length, 512);
    assert.equal(new Set(WORDS).size, 512);
    assert.ok(WORDS.every(w => /^[a-z]{3,8}$/.test(w)));
    for (let i = 0; i < 20; i++) {
      const words = makePhrase().split(' ');
      assert.equal(words.length, PHRASE_WORDS);
      assert.ok(words.every(w => WORDS.includes(w)));
    }
    assert.equal(normalisePhrase('  Orbit, COMET - nova\nPulsar quasar nebula planet rocket lunar solar '), 'orbit comet nova pulsar quasar nebula planet rocket lunar solar');
  });

  test('summarise is defensive and reads the active station', () => {
    assert.deepEqual(summarise(profile()), { name: 'Dust Harbour', day: 12, level: 2, credits: 12346, am: 42, sectors: 2, rank: 3 });
    assert.deepEqual(summarise(null), { name: 'Unnamed station', day: 0, level: 1, credits: 0, am: 0, sectors: 0, rank: 1 });
    assert.deepEqual(summarise({ v: 2, sectors: [], activeSector: 7, credits: 'lots', rank: 'x' }), { name: 'Unnamed station', day: 0, level: 1, credits: 0, am: 0, sectors: 0, rank: 1 });
    const s = summarise({ sectors: { home: { name: 'x'.repeat(80), level: 4, credits: 99 } }, activeSector: 'home' });
    assert.equal(s.name.length, 40); assert.equal(s.level, 4); assert.equal(s.credits, 99); assert.equal(s.sectors, 1);
  });
});

// ============================================================ sign-up and login
describe('POST /signup and POST /login', () => {
  test('sign-up returns a token, the user and a ten-word recovery phrase; the stored record holds only hashes', async () => {
    const env = makeEnv();
    const data = await signupUser(env);
    assert.match(data.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(data.user.email, 'commander@example.com'); assert.match(data.user.id, /^u_[A-Za-z0-9_-]{16}$/);
    const words = data.recovery.split(' ');
    assert.equal(words.length, 10); assert.ok(words.every(w => WORDS.includes(w)));
    const stored = JSON.parse(env.ACCOUNTS.map.get('user:commander@example.com'));
    assert.equal(stored.id, data.user.id); assert.equal(stored.tokenGen, 1);
    assert.equal(stored.pw.iter, 100000); assert.ok(stored.pw.salt && stored.pw.hash); assert.ok(stored.rec.salt && stored.rec.hash);
    const raw = env.ACCOUNTS.map.get('user:commander@example.com');
    assert.equal(raw.includes(PASSWORD), false); assert.equal(raw.includes(data.recovery), false); assert.equal(raw.includes(words[0]), false);
    const tokKeys = [...env.ACCOUNTS.map.keys()].filter(k => k.startsWith('tok:'));
    assert.equal(tokKeys.length, 1);
    assert.equal(env.ACCOUNTS.puts.find(p => p.key === tokKeys[0]).ttl, TOKEN_TTL_S);
    assert.equal(tokKeys[0].includes(data.token), false, 'tokens are stored by hash');
  });

  test('duplicate email -> 409, weak password -> 400, bad email -> 400, bad json -> 400', async () => {
    const env = makeEnv();
    await signupUser(env);
    const dup = await read(await handle(req('/signup', { method: 'POST', body: { email: ' COMMANDER@example.com ', password: PASSWORD } }), env, clock(T0)));
    assert.equal(dup.status, 409); assert.equal(dup.data.error, 'email-taken');
    const weak = await read(await handle(req('/signup', { method: 'POST', body: { email: 'a@b.co', password: 'short' } }), env, clock(T0)));
    assert.equal(weak.status, 400); assert.equal(weak.data.error, 'weak-password'); assert.equal(weak.data.min, 10);
    const bad = await read(await handle(req('/signup', { method: 'POST', body: { email: 'nope', password: PASSWORD } }), env, clock(T0)));
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-email');
    const json = await read(await handle(req('/signup', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }), env, clock(T0)));
    assert.equal(json.status, 400); assert.equal(json.data.error, 'bad-json');
  });

  test('login succeeds with the right password and fails the same way for a wrong password or unknown email', async () => {
    const env = makeEnv();
    const su = await signupUser(env);
    const ok = await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL.toUpperCase(), password: PASSWORD } }), env, clock(T0)));
    assert.equal(ok.status, 200); assert.match(ok.data.token, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(ok.data.token, su.token);
    assert.deepEqual(ok.data.user, su.user);
    const me = await read(await handle(req('/me', { token: ok.data.token }), env, clock(T0)));
    assert.equal(me.status, 200); assert.deepEqual(me.data, { user: su.user, save: null });
    const wrong = await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD + 'x' } }), env, clock(T0)));
    assert.equal(wrong.status, 401); assert.equal(wrong.data.error, 'bad-credentials');
    const unknown = await read(await handle(req('/login', { method: 'POST', body: { email: 'nobody@example.com', password: PASSWORD } }), env, clock(T0)));
    assert.equal(unknown.status, 401); assert.equal(unknown.data.error, 'bad-credentials'); assert.equal(unknown.data.message, wrong.data.message);
    const empty = await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL } }), env, clock(T0)));
    assert.equal(empty.status, 400);
  });
});

// ============================================================ tokens
describe('tokens: bearer auth, sliding TTL, logout, revocation on recover', () => {
  test('bad or missing bearer -> 401', async () => {
    const env = makeEnv();
    const none = await read(await handle(req('/me'), env));
    assert.equal(none.status, 401); assert.equal(none.data.error, 'unauthorised');
    const junk = await read(await handle(req('/me', { headers: { Authorization: 'Bearer nope' } }), env));
    assert.equal(junk.status, 401);
    const unknown = await read(await handle(req('/me', { token: 'A'.repeat(43) }), env));
    assert.equal(unknown.status, 401);
  });

  test('the token TTL slides: refreshed once it is older than TOKEN_REFRESH_MS, not on every call', async () => {
    const env = makeEnv();
    const { token } = await signupUser(env);
    const tokKey = [...env.ACCOUNTS.map.keys()].find(k => k.startsWith('tok:'));
    const putsBefore = env.ACCOUNTS.puts.length;
    assert.equal((await read(await handle(req('/me', { token }), env, clock(T0 + HOUR)))).status, 200);
    assert.equal(env.ACCOUNTS.puts.length, putsBefore, 'no KV write for a fresh token');
    const later = T0 + TOKEN_REFRESH_MS + 60e3;
    assert.equal((await read(await handle(req('/me', { token }), env, clock(later)))).status, 200);
    const refresh = env.ACCOUNTS.puts.slice(putsBefore).find(p => p.key === tokKey);
    assert.ok(refresh, 'the token record was rewritten'); assert.equal(refresh.ttl, TOKEN_TTL_S);
    assert.equal(JSON.parse(env.ACCOUNTS.map.get(tokKey)).refreshedAt, later);
  });

  test('logout deletes the token; recover issues a new phrase and revokes every older token', async () => {
    const env = makeEnv();
    const su = await signupUser(env);
    const second = (await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } }), env, clock(T0)))).data;
    const out = await read(await handle(req('/logout', { method: 'POST', token: second.token }), env, clock(T0)));
    assert.deepEqual(out.data, { ok: true });
    assert.equal((await handle(req('/me', { token: second.token }), env, clock(T0))).status, 401);
    assert.equal((await handle(req('/me', { token: su.token }), env, clock(T0))).status, 200, 'other tokens survive a logout');

    const messy = su.recovery.toUpperCase().split(' ').join(', ');
    const rec = await read(await handle(req('/recover', { method: 'POST', body: { email: EMAIL, recovery: messy, newPassword: 'a-brand-new-password' } }), env, clock(T0 + DAY)));
    assert.equal(rec.status, 200, JSON.stringify(rec.data));
    assert.match(rec.data.token, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(rec.data.recovery, su.recovery);
    assert.equal(rec.data.recovery.split(' ').length, 10);
    assert.equal((await handle(req('/me', { token: su.token }), env, clock(T0 + DAY))).status, 401, 'the old token is revoked');
    assert.equal((await handle(req('/me', { token: rec.data.token }), env, clock(T0 + DAY))).status, 200);
    assert.equal(JSON.parse(env.ACCOUNTS.map.get('user:commander@example.com')).tokenGen, 2);
    const oldPw = await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } }), env, clock(T0 + DAY)));
    assert.equal(oldPw.status, 401);
    const newPw = await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: 'a-brand-new-password' } }), env, clock(T0 + DAY)));
    assert.equal(newPw.status, 200);
    const oldPhrase = await read(await handle(req('/recover', { method: 'POST', body: { email: EMAIL, recovery: su.recovery, newPassword: 'yet-another-password' } }), env, clock(T0 + DAY)));
    assert.equal(oldPhrase.status, 401); assert.equal(oldPhrase.data.error, 'bad-recovery');
    const short = await read(await handle(req('/recover', { method: 'POST', body: { email: EMAIL, recovery: 'only three words', newPassword: 'yet-another-password' } }), env, clock(T0 + DAY)));
    assert.equal(short.status, 400); assert.equal(short.data.error, 'bad-recovery');
  });
});

// ============================================================ the cloud save
describe('GET/PUT /save', () => {
  test('no save yet -> 404; put with baseVersion 0 -> version 1; get returns the profile; /me shows the summary', async () => {
    const env = makeEnv();
    const { token } = await signupUser(env);
    const none = await read(await handle(req('/save', { token }), env, clock(T0)));
    assert.equal(none.status, 404); assert.equal(none.data.error, 'no-save');
    const put = await read(await handle(req('/save', { method: 'PUT', token, body: { profile: profile(), baseVersion: 0 } }), env, clock(T0 + 1000)));
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.equal(put.data.version, 1); assert.equal(put.data.updatedAt, new Date(T0 + 1000).toISOString());
    assert.deepEqual(put.data.summary, { name: 'Dust Harbour', day: 12, level: 2, credits: 12346, am: 42, sectors: 2, rank: 3 });
    assert.ok(put.data.size > 100);
    const get = await read(await handle(req('/save', { token }), env, clock(T0 + 2000)));
    assert.equal(get.status, 200); assert.equal(get.data.version, 1); assert.deepEqual(get.data.profile, profile()); assert.deepEqual(get.data.summary, put.data.summary);
    const me = await read(await handle(req('/me', { token }), env, clock(T0 + 2000)));
    assert.deepEqual(me.data.save, { version: 1, updatedAt: put.data.updatedAt, size: put.data.size, summary: put.data.summary });
    const stored = JSON.parse(env.ACCOUNTS.map.get(`save:${me.data.user.id}`));
    assert.deepEqual(Object.keys(stored).sort(), ['profile', 'size', 'summary', 'updatedAt', 'version']);
  });

  test('a stale baseVersion -> 409 with the server summary; the right one advances the version', async () => {
    const env = makeEnv();
    const { token } = await signupUser(env);
    await handle(req('/save', { method: 'PUT', token, body: { profile: profile(), baseVersion: 0 } }), env, clock(T0));
    const two = await read(await handle(req('/save', { method: 'PUT', token, body: { profile: profile({ am: 50 }), baseVersion: 1 } }), env, clock(T0 + 5000)));
    assert.equal(two.status, 200); assert.equal(two.data.version, 2);
    const stale = await read(await handle(req('/save', { method: 'PUT', token, body: { profile: profile({ am: 7 }), baseVersion: 1 } }), env, clock(T0 + 9000)));
    assert.equal(stale.status, 409); assert.equal(stale.data.error, 'conflict');
    assert.deepEqual(stale.data.server, { version: 2, updatedAt: new Date(T0 + 5000).toISOString(), summary: { ...two.data.summary } });
    assert.equal(stale.data.server.summary.am, 50);
    const missing = await read(await handle(req('/save', { method: 'PUT', token, body: { profile: profile() } }), env, clock(T0 + 9000)));
    assert.equal(missing.status, 409, 'omitting baseVersion when a save exists is a conflict');
    const get = await read(await handle(req('/save', { token }), env, clock(T0)));
    assert.equal(get.data.version, 2); assert.equal(get.data.profile.am, 50, 'the stale write changed nothing');
    const neg = await read(await handle(req('/save', { method: 'PUT', token, body: { profile: profile(), baseVersion: -1 } }), env, clock(T0)));
    assert.equal(neg.status, 400); assert.equal(neg.data.error, 'bad-version');
  });

  test('rejects non-profiles and enforces the 1 MB cap (plain and gzip bodies)', async () => {
    const env = makeEnv();
    const { token } = await signupUser(env);
    const notObj = await read(await handle(req('/save', { method: 'PUT', token, body: { profile: 'nope', baseVersion: 0 } }), env, clock(T0)));
    assert.equal(notObj.status, 400); assert.equal(notObj.data.error, 'bad-profile');
    const notV2 = await read(await handle(req('/save', { method: 'PUT', token, body: { profile: { v: 1, grid: [] }, baseVersion: 0 } }), env, clock(T0)));
    assert.equal(notV2.status, 400); assert.equal(notV2.data.error, 'bad-profile');
    const big = profile({ blob: 'x'.repeat(SAVE_MAX_BYTES) });
    const tooBig = await read(await handle(req('/save', { method: 'PUT', token, body: { profile: big, baseVersion: 0 } }), env, clock(T0)));
    assert.equal(tooBig.status, 413); assert.equal(tooBig.data.error, 'too-large'); assert.equal(tooBig.data.max, SAVE_MAX_BYTES);
    // a 1 MB string of 'x' gzips to a few KB: the cap must apply after inflation
    const gz = async obj => new Uint8Array(await new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const zipBig = await gz({ profile: big, baseVersion: 0 });
    assert.ok(zipBig.byteLength < 20000);
    const zipped = await read(await handle(req('/save', { method: 'PUT', token, body: zipBig, headers: { 'content-type': 'application/gzip' } }), env, clock(T0)));
    assert.equal(zipped.status, 413);
    const zipOk = await read(await handle(req('/save', { method: 'PUT', token, body: await gz({ profile: profile({ am: 9 }), baseVersion: 0 }), headers: { 'content-type': 'application/gzip' } }), env, clock(T0)));
    assert.equal(zipOk.status, 200); assert.equal(zipOk.data.summary.am, 9);
    assert.equal((await read(await handle(req('/save', { token }), env, clock(T0)))).data.profile.am, 9);
    const declared = await read(await handle(req('/save', { method: 'PUT', token, body: '{}', headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) } }), env, clock(T0)));
    assert.equal(declared.status, 413);
  });

  test('readBodyBytes passes plain bodies through and inflates gzip ones', async () => {
    const plain = await readBodyBytes(new Request('https://x/', { method: 'POST', body: '{"a":1}' }), 1000);
    assert.equal(new TextDecoder().decode(plain), '{"a":1}');
    const zipped = new Uint8Array(await new Response(new Blob(['{"b":2}']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const out = await readBodyBytes(new Request('https://x/', { method: 'POST', body: zipped }), 1000);
    assert.equal(new TextDecoder().decode(out), '{"b":2}');
  });

  test('saves are per account', async () => {
    const env = makeEnv();
    const a = await signupUser(env, 'a@example.com');
    const b = await signupUser(env, 'b@example.com');
    await handle(req('/save', { method: 'PUT', token: a.token, body: { profile: profile({ am: 1 }), baseVersion: 0 } }), env, clock(T0));
    assert.equal((await handle(req('/save', { token: b.token }), env, clock(T0))).status, 404);
    const me = await read(await handle(req('/me', { token: b.token }), env, clock(T0)));
    assert.equal(me.data.save, null);
  });
});

// ============================================================ delete
describe('DELETE /account', () => {
  test('needs the password; wipes the user, the save and the token', async () => {
    const env = makeEnv();
    const { token, user } = await signupUser(env);
    await handle(req('/save', { method: 'PUT', token, body: { profile: profile(), baseVersion: 0 } }), env, clock(T0));
    const wrong = await read(await handle(req('/account', { method: 'DELETE', token, body: { password: 'not-the-password' } }), env, clock(T0)));
    assert.equal(wrong.status, 401); assert.equal(wrong.data.error, 'bad-credentials');
    assert.ok(env.ACCOUNTS.map.has(`save:${user.id}`));
    const ok = await read(await handle(req('/account', { method: 'DELETE', token, body: { password: PASSWORD } }), env, clock(T0)));
    assert.deepEqual(ok.data, { ok: true });
    assert.equal(env.ACCOUNTS.map.has(`save:${user.id}`), false);
    assert.equal(env.ACCOUNTS.map.has('user:commander@example.com'), false);
    assert.equal([...env.ACCOUNTS.map.keys()].some(k => k.startsWith('tok:')), false);
    assert.equal((await handle(req('/me', { token }), env, clock(T0))).status, 401);
    const login = await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } }), env, clock(T0)));
    assert.equal(login.status, 401);
    const again = await signupUser(env);                      // the email is free again
    assert.notEqual(again.user.id, user.id);
  });
});

// ============================================================ rate limits
describe('rate limits per IP', () => {
  test('recover: 5 attempts per hour, then 429 with retryAfter; the window resets', async () => {
    const env = makeEnv();
    await signupUser(env);
    const attempt = async (now, ip) => read(await handle(req('/recover', { method: 'POST', ip, body: { email: EMAIL, recovery: 'one two three four five six seven eight nine ten', newPassword: 'whatever-new-password' } }), env, clock(now)));
    for (let i = 0; i < LIMITS.recover.max; i++) assert.equal((await attempt(T0 + i * 1000)).status, 401);
    const blocked = await attempt(T0 + 6000);
    assert.equal(blocked.status, 429); assert.equal(blocked.data.error, 'rate-limited');
    assert.ok(blocked.data.retryAfter > 3500 && blocked.data.retryAfter <= 3600, String(blocked.data.retryAfter));
    assert.equal(blocked.headers.get('retry-after'), String(blocked.data.retryAfter));
    assert.equal((await attempt(T0 + 7000, '198.51.100.9')).status, 401, 'another IP is not affected');
    assert.equal((await attempt(T0 + LIMITS.recover.windowS * 1000 + 1000)).status, 401, 'the window has reset');
    const rl = env.ACCOUNTS.puts.find(p => p.key === 'rl:recover:203.0.113.7');
    assert.ok(rl && rl.ttl >= 60);
  });

  test('login and signup buckets are enforced with their own limits', async () => {
    const env = makeEnv();
    await signupUser(env);
    for (let i = 0; i < LIMITS.login.max; i++) {
      const r = await read(await handle(req('/login', { method: 'POST', body: { email: 'ghost@example.com', password: 'wrong-password-1' } }), env, clock(T0 + i)));
      assert.equal(r.status, 401);
    }
    const blocked = await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } }), env, clock(T0 + 100)));
    assert.equal(blocked.status, 429); assert.ok(blocked.data.retryAfter <= LIMITS.login.windowS);
    const env2 = makeEnv();
    for (let i = 0; i < LIMITS.signup.max; i++) await signupUser(env2, `user${i}@example.com`);
    const eleventh = await read(await handle(req('/signup', { method: 'POST', body: { email: 'user99@example.com', password: PASSWORD } }), env2, clock(T0)));
    assert.equal(eleventh.status, 429);
    const invalid = await read(await handle(req('/signup', { method: 'POST', body: { email: 'nope', password: PASSWORD } }), env2, clock(T0)));
    assert.equal(invalid.status, 400, 'validation runs before the limiter, so malformed requests do not consume attempts');
  });
});

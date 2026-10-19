// ============================================================
// WAYSTATION — password reset by email: the email module and the /forgot and /reset routes (A2.1)
// Run with `npm test` in workers/account. The provider is a mocked fetch handed in through handle()'s opts;
// no network. Real PBKDF2, same in-memory KV stub as account.test.js.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import worker, { handle } from '../src/index.js';
import { LIMITS, RESET_TOKEN_TTL_S, WORDS, sha256Hex } from '../src/lib.js';
import { emailConfig, resetEmail, resetLink, sendEmail, PROVIDERS, SENDER_NAME, RESET_MINUTES } from '../src/email.js';

const ORIGIN = 'https://joshanderson051.github.io';
const PLAY = 'https://joshanderson051.github.io/waystation/play/';
const PEPPER = 'unit-test-pepper-that-is-long-enough';
const EMAIL = 'Commander@Example.com';
const PASSWORD = 'orbital-mechanics-42';
const NEW_PASSWORD = 'a-brand-new-password';
const HOUR = 3600e3;
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

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
const makeEnv = (over = {}) => ({
  ACCOUNTS: kvStub(), ALLOWED_ORIGIN: ORIGIN, PEPPER,
  EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'onboarding@resend.dev', PLAY_URL: PLAY, EMAIL_API_KEY: 're_unit_test_key_123',
  ...over,
});
// A provider that records every call and answers as told (status, json).
function provider(answer = { status: 200, json: { id: 'em_1' } }) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const a = typeof answer === 'function' ? await answer(call) : answer;
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}
const req = (path, { method = 'GET', body, headers = {}, origin = ORIGIN, token, ip = '203.0.113.7' } = {}) => new Request(`https://waystation-account.example.workers.dev${path}`, {
  method,
  headers: { ...(origin ? { Origin: origin } : {}), ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), 'CF-Connecting-IP': ip, ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const read = async res => ({ status: res.status, headers: res.headers, data: await res.json() });
const at = (t, extra = {}) => ({ now: () => t, ...extra });
const quiet = async fn => { const orig = console.error; const logged = []; console.error = (...a) => logged.push(a.join(' ')); try { return [await fn(), logged]; } finally { console.error = orig; } };

async function signupUser(env, email = EMAIL, password = PASSWORD, now = T0) {
  const r = await read(await handle(req('/signup', { method: 'POST', body: { email, password } }), env, at(now)));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
// Asks for a reset link and returns the token the email carried (the mocked provider saw the link).
async function askForLink(env, mail, { email = EMAIL, now = T0, ip } = {}) {
  const r = await read(await handle(req('/forgot', { method: 'POST', body: { email }, ip }), env, at(now, { fetch: mail })));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const last = mail.calls[mail.calls.length - 1];
  const m = last && last.body.text.match(/\?reset=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// ============================================================ email.js
describe('email module', () => {
  test('emailConfig reads the vars, defaults the provider and lists what is missing', () => {
    const ok = emailConfig(makeEnv());
    assert.deepEqual(ok, { provider: 'resend', from: 'onboarding@resend.dev', playUrl: PLAY, key: 're_unit_test_key_123', missing: [], configured: true });
    assert.equal(emailConfig(makeEnv({ EMAIL_PROVIDER: undefined })).provider, 'resend');
    assert.equal(emailConfig(makeEnv({ EMAIL_PROVIDER: ' Brevo ' })).provider, 'brevo');
    const none = emailConfig({});
    assert.equal(none.configured, false);
    assert.deepEqual(none.missing, ['EMAIL_FROM', 'PLAY_URL', 'EMAIL_API_KEY']);
    assert.deepEqual(emailConfig(makeEnv({ EMAIL_PROVIDER: 'pigeon', EMAIL_API_KEY: '' })).missing, ['EMAIL_PROVIDER', 'EMAIL_API_KEY']);
    assert.deepEqual(emailConfig(makeEnv({ EMAIL_FROM: 'not an address', PLAY_URL: 'play/' })).missing, ['EMAIL_FROM', 'PLAY_URL']);
  });

  test('resetLink appends ?reset= (or &reset= after an existing query) with the token encoded', () => {
    assert.equal(resetLink(PLAY, 'abc_DEF-123'), `${PLAY}?reset=abc_DEF-123`);
    assert.equal(resetLink('https://x.example/play/?lang=en', 'tok'), 'https://x.example/play/?lang=en&reset=tok');
    assert.equal(resetLink(PLAY, 'a b'), `${PLAY}?reset=a%20b`);
  });

  test('resetEmail: plain text and HTML carry the link, the address and the time limit; HTML escapes the address', () => {
    const link = `${PLAY}?reset=tok123`;
    const m = resetEmail({ email: 'cmdr+<x>@example.com', link, playUrl: PLAY });
    assert.equal(m.subject, 'Reset your Waystation password');
    assert.match(m.text, /^Commander,\n/);
    assert.ok(m.text.includes(link)); assert.ok(m.text.includes('cmdr+<x>@example.com')); assert.ok(m.text.includes(`${RESET_MINUTES} minutes`));
    assert.ok(m.text.includes('recovery phrase')); assert.ok(m.text.includes('ignore this message'));
    assert.equal(m.text.includes('<'), true, 'the raw address is allowed in plain text');
    assert.ok(m.text.trimEnd().endsWith(PLAY));
    assert.ok(m.html.startsWith('<!doctype html>'));
    assert.equal(m.html.includes('cmdr+<x>@example.com'), false, 'HTML escapes the address');
    assert.ok(m.html.includes('cmdr+&lt;x&gt;@example.com'));
    assert.equal(m.html.split(`href="${link}"`).length, 3, 'the link is a button and a plain fallback');
    assert.ok(m.html.includes('Set a new password')); assert.ok(m.html.includes(`${RESET_MINUTES} minutes`));
    assert.equal(/<script/i.test(m.html), false);
    const bare = resetEmail({ email: 'a@b.co', link, minutes: 5 });
    assert.ok(bare.text.includes('5 minutes')); assert.ok(bare.text.trimEnd().endsWith('Waystation'));
  });

  test('sendEmail with Resend: bearer key, "Waystation <from>", to as an array, text and html; returns the id', async () => {
    const mail = provider({ status: 200, json: { id: 'em_resend_1' } });
    const r = await sendEmail(makeEnv(), { to: 'player@example.com', subject: 'S', text: 'T', html: '<p>H</p>' }, mail);
    assert.deepEqual(r, { ok: true, id: 'em_resend_1', provider: 'resend' });
    assert.equal(mail.calls.length, 1);
    const c = mail.calls[0];
    assert.equal(c.url, PROVIDERS.resend.url); assert.equal(c.method, 'POST');
    assert.equal(c.headers.authorization, 'Bearer re_unit_test_key_123'); assert.equal(c.headers['content-type'], 'application/json');
    assert.deepEqual(c.body, { from: `${SENDER_NAME} <onboarding@resend.dev>`, to: ['player@example.com'], subject: 'S', text: 'T', html: '<p>H</p>' });
  });

  test('sendEmail with Brevo: api-key header, sender object, to as objects, textContent/htmlContent; returns the messageId', async () => {
    const mail = provider({ status: 201, json: { messageId: '<abc@relay.brevo.com>' } });
    const env = makeEnv({ EMAIL_PROVIDER: 'brevo', EMAIL_FROM: 'Owner@Example.com', EMAIL_API_KEY: 'xkeysib-unit-test' });
    const r = await sendEmail(env, { to: 'player@example.com', subject: 'S', text: 'T', html: '<p>H</p>' }, mail);
    assert.deepEqual(r, { ok: true, id: '<abc@relay.brevo.com>', provider: 'brevo' });
    const c = mail.calls[0];
    assert.equal(c.url, PROVIDERS.brevo.url);
    assert.equal(c.headers['api-key'], 'xkeysib-unit-test'); assert.equal(c.headers.authorization, undefined);
    assert.deepEqual(c.body, { sender: { name: SENDER_NAME, email: 'owner@example.com' }, to: [{ email: 'player@example.com' }], subject: 'S', textContent: 'T', htmlContent: '<p>H</p>' });
  });

  test('sendEmail reports provider errors, network failures and missing configuration without throwing', async () => {
    const denied = await sendEmail(makeEnv(), { to: 'x@example.com', subject: 'S', text: 'T', html: 'H' }, provider({ status: 403, json: { statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address' } }));
    assert.equal(denied.ok, false); assert.equal(denied.status, 403); assert.match(denied.error, /^Resend answered 403: You can only send testing emails/);
    const down = await sendEmail(makeEnv(), { to: 'x@example.com', subject: 'S', text: 'T', html: 'H' }, provider(new Error('ECONNRESET')));
    assert.equal(down.ok, false); assert.equal(down.status, 0); assert.equal(down.error, 'Resend: ECONNRESET');
    const html = await sendEmail(makeEnv(), { to: 'x@example.com', subject: 'S', text: 'T', html: 'H' }, async () => new Response('<html>gateway</html>', { status: 502 }));
    assert.equal(html.ok, false); assert.equal(html.status, 502); assert.equal(html.error, 'Resend answered 502');
    const none = await sendEmail(makeEnv({ EMAIL_API_KEY: '' }), { to: 'x@example.com', subject: 'S', text: 'T', html: 'H' }, provider());
    assert.equal(none.ok, false); assert.match(none.error, /email not configured: EMAIL_API_KEY/);
  });
});

// ============================================================ POST /forgot
describe('POST /forgot', () => {
  test('an existing account: 200 {ok}, a 30-minute reset record stored by hash, one email with the link to the address', async () => {
    const env = makeEnv();
    const { user } = await signupUser(env);
    const mail = provider();
    const r = await read(await handle(req('/forgot', { method: 'POST', body: { email: ' COMMANDER@example.com ' } }), env, at(T0 + 1000, { fetch: mail })));
    assert.equal(r.status, 200); assert.deepEqual(r.data, { ok: true });
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(mail.calls.length, 1);
    const sent = mail.calls[0].body;
    assert.deepEqual(sent.to, ['commander@example.com']);
    assert.equal(sent.from, 'Waystation <onboarding@resend.dev>');
    assert.equal(sent.subject, 'Reset your Waystation password');
    const token = sent.text.match(/\?reset=([A-Za-z0-9_-]+)/)[1];
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(sent.text.includes(`${PLAY}?reset=${token}`)); assert.ok(sent.html.includes(`href="${PLAY}?reset=${token}"`));
    const keys = [...env.ACCOUNTS.map.keys()].filter(k => k.startsWith('reset:'));
    assert.equal(keys.length, 1);
    assert.equal(keys[0], `reset:${await sha256Hex(token)}`, 'stored by SHA-256, not by the token');
    assert.equal(keys[0].includes(token), false);
    assert.deepEqual(JSON.parse(env.ACCOUNTS.map.get(keys[0])), { userId: user.id, email: 'commander@example.com', gen: 1, createdAt: T0 + 1000 });
    assert.equal(env.ACCOUNTS.puts.find(p => p.key === keys[0]).ttl, RESET_TOKEN_TTL_S);
    assert.equal(RESET_TOKEN_TTL_S, 1800);
  });

  test('an unknown address: the same 200 {ok}, no email, no record', async () => {
    const env = makeEnv();
    await signupUser(env);
    const mail = provider();
    const known = await read(await handle(req('/forgot', { method: 'POST', body: { email: EMAIL } }), env, at(T0, { fetch: mail })));
    const unknown = await read(await handle(req('/forgot', { method: 'POST', body: { email: 'nobody@example.com' } }), env, at(T0, { fetch: mail })));
    assert.equal(unknown.status, 200); assert.deepEqual(unknown.data, known.data);
    assert.equal(mail.calls.length, 1, 'only the known address got an email');
    assert.equal([...env.ACCOUNTS.map.keys()].filter(k => k.startsWith('reset:')).length, 1);
  });

  test('a malformed address or body -> 400; no provider key -> 503 email-not-configured (and nothing stored)', async () => {
    const env = makeEnv();
    await signupUser(env);
    const bad = await read(await handle(req('/forgot', { method: 'POST', body: { email: 'nope' } }), env, at(T0, { fetch: provider() })));
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-email');
    const json = await read(await handle(req('/forgot', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }), env, at(T0)));
    assert.equal(json.status, 400); assert.equal(json.data.error, 'bad-json');
    const mail = provider();
    const off = await read(await handle(req('/forgot', { method: 'POST', body: { email: EMAIL } }), makeEnv({ ACCOUNTS: env.ACCOUNTS, EMAIL_API_KEY: undefined }), at(T0, { fetch: mail })));
    assert.equal(off.status, 503); assert.equal(off.data.error, 'email-not-configured'); assert.deepEqual(off.data.missing, ['EMAIL_API_KEY']);
    assert.match(off.data.message, /recovery phrase/);
    assert.equal(mail.calls.length, 0);
    assert.equal([...env.ACCOUNTS.map.keys()].some(k => k.startsWith('reset:') || k.startsWith('rl:forgot')), false, 'nothing counted or stored');
  });

  test('a provider failure still answers 200 (the record exists, the failure is logged)', async () => {
    const env = makeEnv();
    await signupUser(env);
    const mail = provider({ status: 403, json: { message: 'You can only send testing emails to your own email address' } });
    const [r, logged] = await quiet(async () => read(await handle(req('/forgot', { method: 'POST', body: { email: EMAIL } }), env, at(T0, { fetch: mail }))));
    assert.equal(r.status, 200); assert.deepEqual(r.data, { ok: true });
    assert.equal(mail.calls.length, 1);
    assert.equal(logged.length, 1); assert.match(logged[0], /reset email not sent.*Resend answered 403/);
    const [r2, logged2] = await quiet(async () => read(await handle(req('/forgot', { method: 'POST', body: { email: EMAIL } }), env, at(T0 + 1, { fetch: provider(new Error('boom')) }))));
    assert.equal(r2.status, 200); assert.match(logged2[0], /Resend: boom/);
  });

  test('with waitUntil the response does not wait for the provider; the send is handed to the runtime', async () => {
    const env = makeEnv();
    await signupUser(env);
    let release;
    const gate = new Promise(r => { release = r; });
    const mail = provider(async () => { await gate; return { status: 200, json: { id: 'late' } }; });
    const background = [];
    const r = await read(await handle(req('/forgot', { method: 'POST', body: { email: EMAIL } }), env, at(T0, { fetch: mail, waitUntil: p => background.push(p) })));
    assert.equal(r.status, 200);
    assert.equal(background.length, 1, 'one background job');
    assert.equal(mail.calls.length, 1, 'the provider call started before the response');
    release();
    const out = await background[0];
    assert.deepEqual(out, { ok: true, id: 'late', provider: 'resend' });
  });

  test('rate limits: 3 per hour per IP and 3 per hour per address, each with its own window', async () => {
    const env = makeEnv();
    await signupUser(env);
    const ask = async (email, ip, now) => read(await handle(req('/forgot', { method: 'POST', body: { email }, ip }), env, at(now, { fetch: provider() })));
    for (let i = 0; i < LIMITS.forgot.max; i++) assert.equal((await ask(`user${i}@example.com`, '203.0.113.7', T0 + i)).status, 200);
    const ipBlocked = await ask('user9@example.com', '203.0.113.7', T0 + 10);
    assert.equal(ipBlocked.status, 429); assert.equal(ipBlocked.data.error, 'rate-limited');
    assert.ok(ipBlocked.data.retryAfter > 3500 && ipBlocked.data.retryAfter <= 3600); assert.equal(ipBlocked.headers.get('retry-after'), String(ipBlocked.data.retryAfter));
    // the same address from three different IPs, then a fourth IP is refused for that address only
    for (let i = 0; i < LIMITS.forgotEmail.max; i++) assert.equal((await ask(EMAIL, `198.51.100.${i}`, T0 + 100 + i)).status, 200);
    const mailBlocked = await ask(EMAIL, '198.51.100.9', T0 + 200);
    assert.equal(mailBlocked.status, 429);
    assert.equal((await ask('someone-else@example.com', '198.51.100.9', T0 + 201)).status, 200, 'the fourth IP may still ask for another address');
    assert.equal([...env.ACCOUNTS.map.keys()].filter(k => k.startsWith('reset:')).length, LIMITS.forgotEmail.max, 'one record per accepted request for the real account');
    assert.ok(env.ACCOUNTS.map.has('rl:forgotEmail:commander@example.com')); assert.ok(env.ACCOUNTS.map.has('rl:forgot:203.0.113.7'));
    assert.equal((await ask(EMAIL, '198.51.100.9', T0 + LIMITS.forgotEmail.windowS * 1000 + 300)).status, 200, 'the window has reset');
  });
});

// ============================================================ POST /reset
describe('POST /reset', () => {
  test('a fresh link sets the new password, revokes older sign-ins and reset links, and hands back a session and a new phrase', async () => {
    const env = makeEnv();
    const su = await signupUser(env);
    const mail = provider();
    const first = await askForLink(env, mail, { now: T0 + 1000 });
    const second = await askForLink(env, mail, { now: T0 + 2000 });
    assert.ok(first && second && first !== second);
    const r = await read(await handle(req('/reset', { method: 'POST', body: { token: second, newPassword: NEW_PASSWORD } }), env, at(T0 + 5000)));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.token, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(r.data.token, su.token);
    assert.deepEqual(r.data.user, su.user);
    const words = r.data.recovery.split(' ');
    assert.equal(words.length, 10); assert.ok(words.every(w => WORDS.includes(w))); assert.notEqual(r.data.recovery, su.recovery);
    assert.equal(JSON.stringify(r.data).includes(NEW_PASSWORD), false);
    const stored = JSON.parse(env.ACCOUNTS.map.get('user:commander@example.com'));
    assert.equal(stored.tokenGen, 2); assert.equal(stored.resetAt, T0 + 5000);
    assert.equal(env.ACCOUNTS.map.has(`reset:${await sha256Hex(second)}`), false, 'the used link is gone');
    assert.equal((await handle(req('/me', { token: su.token }), env, at(T0 + 5000))).status, 401, 'the sign-up session is revoked');
    assert.equal((await handle(req('/me', { token: r.data.token }), env, at(T0 + 5000))).status, 200, 'the new session works');
    assert.equal((await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } }), env, at(T0 + 5000)))).status, 401, 'the old password is dead');
    assert.equal((await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: NEW_PASSWORD } }), env, at(T0 + 5000)))).status, 200);
    const oldPhrase = await read(await handle(req('/recover', { method: 'POST', body: { email: EMAIL, recovery: su.recovery, newPassword: 'yet-another-password' } }), env, at(T0 + 5000)));
    assert.equal(oldPhrase.status, 401, 'the old phrase is dead');
    const newPhrase = await read(await handle(req('/recover', { method: 'POST', body: { email: EMAIL, recovery: r.data.recovery, newPassword: 'yet-another-password' } }), env, at(T0 + 6000)));
    assert.equal(newPhrase.status, 200, 'the new phrase works');
    // the first (unused) link belongs to the old token generation: dead as well
    const stale = await read(await handle(req('/reset', { method: 'POST', body: { token: first, newPassword: 'one-more-password' } }), env, at(T0 + 7000)));
    assert.equal(stale.status, 401); assert.equal(stale.data.error, 'bad-token');
    assert.equal(env.ACCOUNTS.map.has(`reset:${await sha256Hex(first)}`), false, 'a stale record is cleaned up when tried');
  });

  test('a used, unknown or malformed link -> 401/400 bad-token; a weak password -> 400 before anything is consumed', async () => {
    const env = makeEnv();
    await signupUser(env);
    const token = await askForLink(env, provider());
    const weak = await read(await handle(req('/reset', { method: 'POST', body: { token, newPassword: 'short' } }), env, at(T0)));
    assert.equal(weak.status, 400); assert.equal(weak.data.error, 'weak-password');
    assert.ok(env.ACCOUNTS.map.has(`reset:${await sha256Hex(token)}`), 'the link survives a weak password');
    const malformed = await read(await handle(req('/reset', { method: 'POST', body: { token: 'not a token!', newPassword: NEW_PASSWORD } }), env, at(T0)));
    assert.equal(malformed.status, 400); assert.equal(malformed.data.error, 'bad-token');
    const missing = await read(await handle(req('/reset', { method: 'POST', body: { newPassword: NEW_PASSWORD } }), env, at(T0)));
    assert.equal(missing.status, 400);
    const unknown = await read(await handle(req('/reset', { method: 'POST', body: { token: 'A'.repeat(43), newPassword: NEW_PASSWORD } }), env, at(T0)));
    assert.equal(unknown.status, 401); assert.equal(unknown.data.error, 'bad-token'); assert.match(unknown.data.message, /expired or was already used/);
    const ok = await read(await handle(req('/reset', { method: 'POST', body: { token, newPassword: NEW_PASSWORD } }), env, at(T0)));
    assert.equal(ok.status, 200);
    const again = await read(await handle(req('/reset', { method: 'POST', body: { token, newPassword: 'another-new-password' } }), env, at(T0)));
    assert.equal(again.status, 401); assert.equal(again.data.error, 'bad-token');
    assert.equal((await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: NEW_PASSWORD } }), env, at(T0)))).status, 200, 'the second attempt changed nothing');
  });

  test('a link for an account that was deleted meanwhile is refused and removed', async () => {
    const env = makeEnv();
    const { token: session } = await signupUser(env);
    const token = await askForLink(env, provider());
    assert.equal((await handle(req('/account', { method: 'DELETE', token: session, body: { password: PASSWORD } }), env, at(T0))).status, 200);
    const r = await read(await handle(req('/reset', { method: 'POST', body: { token, newPassword: NEW_PASSWORD } }), env, at(T0)));
    assert.equal(r.status, 401); assert.equal(r.data.error, 'bad-token');
    assert.equal(env.ACCOUNTS.map.has(`reset:${await sha256Hex(token)}`), false);
  });

  test('a link cannot be used by a different account that took the address over', async () => {
    const env = makeEnv();
    const { token: session } = await signupUser(env);
    const token = await askForLink(env, provider());
    await handle(req('/account', { method: 'DELETE', token: session, body: { password: PASSWORD } }), env, at(T0));
    await signupUser(env, EMAIL, 'the-second-owner-pw', T0 + 1000);          // same address, new user id
    const r = await read(await handle(req('/reset', { method: 'POST', body: { token, newPassword: NEW_PASSWORD } }), env, at(T0 + 2000)));
    assert.equal(r.status, 401);
    assert.equal((await read(await handle(req('/login', { method: 'POST', body: { email: EMAIL, password: 'the-second-owner-pw' } }), env, at(T0 + 2000)))).status, 200, 'the new owner is untouched');
  });

  test('rate limit: 10 attempts per hour per IP', async () => {
    const env = makeEnv();
    await signupUser(env);
    const attempt = async (now, ip) => read(await handle(req('/reset', { method: 'POST', ip, body: { token: 'B'.repeat(43), newPassword: NEW_PASSWORD } }), env, at(now)));
    for (let i = 0; i < LIMITS.reset.max; i++) assert.equal((await attempt(T0 + i)).status, 401);
    const blocked = await attempt(T0 + 100);
    assert.equal(blocked.status, 429); assert.equal(blocked.data.error, 'rate-limited');
    assert.equal((await attempt(T0 + 101, '198.51.100.9')).status, 401, 'another IP is not affected');
    assert.equal((await attempt(T0 + LIMITS.reset.windowS * 1000 + 200)).status, 401, 'the window has reset');
    const token = await askForLink(env, provider(), { now: T0 + HOUR + 1000 });
    assert.equal((await read(await handle(req('/reset', { method: 'POST', body: { token, newPassword: NEW_PASSWORD } }), env, at(T0 + HOUR + 2000)))).status, 200, 'a real link works once the window is over');
  });

  test('health reports the email configuration without the key; the worker entry forwards waitUntil', async () => {
    const h = await read(await worker.fetch(req('/health'), makeEnv(), { waitUntil() {} }));
    assert.deepEqual(h.data.email, { provider: 'resend', from: 'onboarding@resend.dev', playUrl: PLAY, configured: true, missing: [], resetMinutes: 30 });
    assert.equal(JSON.stringify(h.data).includes('re_unit_test_key_123'), false);
    const bare = await read(await worker.fetch(req('/health'), makeEnv({ EMAIL_API_KEY: '' })));
    assert.equal(bare.data.email.configured, false); assert.deepEqual(bare.data.email.missing, ['EMAIL_API_KEY']);
    assert.deepEqual(h.data.limits.forgot, { max: 3, windowS: 3600 }); assert.deepEqual(h.data.limits.forgotEmail, { max: 3, windowS: 3600 });
    const env = makeEnv();
    await signupUser(env);
    const jobs = [];
    const mail = provider();
    const realFetch = globalThis.fetch;
    globalThis.fetch = mail;                                  // the entry point has no injected fetch: it must use the global one
    try {
      const r = await read(await worker.fetch(req('/forgot', { method: 'POST', body: { email: EMAIL } }), env, { waitUntil: p => jobs.push(p) }));
      assert.equal(r.status, 200);
      assert.equal(jobs.length, 1, 'the entry hands the send to the runtime');
      assert.deepEqual(await jobs[0], { ok: true, id: 'em_1', provider: 'resend' });
      assert.equal(mail.calls.length, 1); assert.deepEqual(mail.calls[0].body.to, ['commander@example.com']);
    } finally { globalThis.fetch = realFetch; }
  });
});

// ============================================================
// PORT SOLACE — push worker tests, part 1: the Web Push primitives (src/webpush.js)
// Run with `npm test` in workers/push (node:test). Checks the aes128gcm construction against the
// RFC 8291 Appendix A vector, round-trips with fresh browser-style keys, and verifies the VAPID JWT
// with WebCrypto. Nothing touches the network.
// ============================================================
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  b64u, concat, utf8, encrypt, decrypt, importPrivateKey, importPublicKey, vapidAuthorization,
  generateVapidKeys, sendPush, decodePoint, MAX_PLAINTEXT, VAPID_MAX_AGE_S,
} from '../src/webpush.js';

// RFC 8291 Appendix A (whitespace removed)
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  // the complete body from RFC 8291 section 5 (header and ciphertext above are separate base64 strings, so they cannot simply be concatenated)
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

import { browserKeys } from './helpers.js';

describe('base64url', () => {
  test('encodes without padding and decodes with or without it', () => {
    assert.equal(b64u.encode(new Uint8Array([251, 255, 191])), '-_-_');
    assert.deepEqual([...b64u.decode('-_-_')], [251, 255, 191]);
    assert.deepEqual([...b64u.decode('AQI')], [1, 2]);
    assert.deepEqual([...b64u.decode('AQI=')], [1, 2]);
    assert.deepEqual([...b64u.decode('AQ I\n')], [1, 2], 'whitespace is ignored');
    assert.equal(b64u.normalise('+/8='), '-_8');
    assert.throws(() => b64u.decode('not base64!'), /invalid base64url/);
  });
  test('decodePoint accepts only 65-byte uncompressed points', () => {
    assert.equal(decodePoint(RFC.uaPublic).length, 65);
    assert.throws(() => decodePoint(RFC.auth), /65-byte/);
    assert.throws(() => decodePoint('A' + RFC.uaPublic.slice(1)), /65-byte/);
  });
});

describe('aes128gcm (RFC 8291)', () => {
  test('reproduces the RFC 8291 Appendix A ciphertext byte for byte', async () => {
    const asKeyPair = { privateKey: await importPrivateKey(RFC.asPublic, RFC.asPrivate, 'ECDH'), publicRaw: decodePoint(RFC.asPublic) };
    const body = await encrypt(b64u.decode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: b64u.decode(RFC.salt), asKeyPair });
    assert.equal(b64u.encode(body), RFC.body);
    assert.deepEqual([...body], [...b64u.decode(RFC.header), ...b64u.decode(RFC.ciphertext)]);
    assert.equal(body.length, 86 + 42 + 16, 'header + plaintext + delimiter + tag');
    assert.equal(new DataView(body.buffer, 16, 4).getUint32(0), 4096, 'record size');
    assert.equal(body[20], 65, 'key id length');
  });
  test('the receiver side decrypts the RFC body back to the watermelon sentence', async () => {
    const uaPrivate = await importPrivateKey(RFC.uaPublic, RFC.uaPrivate, 'ECDH');
    const plain = await decrypt(b64u.decode(RFC.body), uaPrivate, decodePoint(RFC.uaPublic), RFC.auth);
    assert.equal(new TextDecoder().decode(plain), 'When I grow up, I want to be a watermelon');
  });
  test('round-trips a JSON payload with fresh browser keys and an ephemeral sender key', async () => {
    const ua = await browserKeys();
    const payload = JSON.stringify({ title: 'Comms Relay online', body: 'Varro Reach is waiting on the bridge.', tag: 'portsolace' });
    const a = await encrypt(utf8(payload), { p256dh: ua.p256dh, auth: ua.auth });
    const b = await encrypt(utf8(payload), { p256dh: ua.p256dh, auth: ua.auth });
    assert.notEqual(b64u.encode(a), b64u.encode(b), 'a new salt and sender key every time');
    assert.equal(new TextDecoder().decode(await decrypt(a, ua.privateKey, ua.publicRaw, ua.auth)), payload);
    assert.equal(new TextDecoder().decode(await decrypt(b, ua.privateKey, ua.publicRaw, ua.auth)), payload);
  });
  test('a tampered body or the wrong auth secret fails to decrypt', async () => {
    const ua = await browserKeys();
    const body = await encrypt(utf8('hello'), { p256dh: ua.p256dh, auth: ua.auth });
    const bad = body.slice(); bad[bad.length - 1] ^= 1;
    await assert.rejects(decrypt(bad, ua.privateKey, ua.publicRaw, ua.auth));
    await assert.rejects(decrypt(body, ua.privateKey, ua.publicRaw, b64u.encode(new Uint8Array(16))));
  });
  test('rejects bad inputs', async () => {
    const ua = await browserKeys();
    await assert.rejects(encrypt(new Uint8Array(MAX_PLAINTEXT + 1), { p256dh: ua.p256dh, auth: ua.auth }), /too large/);
    await assert.rejects(encrypt(utf8('x'), { p256dh: ua.p256dh, auth: 'AQID' }), /16-byte auth/);
    await assert.rejects(encrypt(utf8('x'), { p256dh: 'AQID', auth: ua.auth }), /65-byte/);
    await assert.rejects(encrypt(utf8('x'), { p256dh: ua.p256dh, auth: ua.auth }, { salt: new Uint8Array(8) }), /salt must be 16/);
  });
});

describe('VAPID (RFC 8292)', () => {
  let keys;
  before(async () => { keys = await generateVapidKeys(); });

  test('generateVapidKeys yields a 65-byte point and a 32-byte scalar', () => {
    assert.equal(decodePoint(keys.publicKey).length, 65);
    assert.equal(b64u.decode(keys.privateKey).length, 32);
    assert.doesNotMatch(keys.publicKey + keys.privateKey, /[+/=]/, 'base64url, unpadded');
  });

  test('builds an ES256 JWT for the endpoint origin that verifies with the public key', async () => {
    const now = 1_760_000_000_000;
    const header = await vapidAuthorization({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:owner@example.com', now });
    const m = /^vapid t=([^,]+), k=(\S+)$/.exec(header);
    assert.ok(m, header);
    assert.equal(m[2], keys.publicKey);
    const [h, c, s] = m[1].split('.');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(b64u.decode(h))), { typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(new TextDecoder().decode(b64u.decode(c)));
    assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:owner@example.com' });
    const sig = b64u.decode(s);
    assert.equal(sig.length, 64, 'raw r||s');
    const pub = await importPublicKey(keys.publicKey, 'ECDSA');
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, utf8(`${h}.${c}`)), true);
    const other = await generateVapidKeys();
    const otherPub = await importPublicKey(other.publicKey, 'ECDSA');
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, otherPub, sig, utf8(`${h}.${c}`)), false);
  });

  test('caps exp at 24 hours, accepts https subjects and padded keys, rejects other subjects', async () => {
    const now = 1_760_000_000_000;
    const h = await vapidAuthorization({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', publicKey: keys.publicKey + '=', privateKey: keys.privateKey, subject: 'https://portsolace.com/', now, expiresInS: 99 * 3600 });
    const claims = JSON.parse(new TextDecoder().decode(b64u.decode(h.split(' ')[1].slice(2).split('.')[1])));
    assert.equal(claims.exp, Math.floor(now / 1000) + VAPID_MAX_AGE_S);
    assert.equal(claims.aud, 'https://updates.push.services.mozilla.com');
    assert.match(h, new RegExp(`k=${keys.publicKey}$`), 'the k parameter is unpadded');
    await assert.rejects(vapidAuthorization({ endpoint: 'https://x.example', publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'owner@example.com' }), /mailto: address or an https: URL/);
  });
});

describe('sendPush', () => {
  let keys;
  before(async () => { keys = await generateVapidKeys(); });
  const vapid = () => ({ publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:owner@example.com' });

  test('POSTs an encrypted body with the Web Push headers and the payload decrypts on the browser side', async () => {
    const ua = await browserKeys();
    const sub = { endpoint: 'https://push.example.com/send/one', keys: { p256dh: ua.p256dh, auth: ua.auth } };
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response('', { status: 201 }); };
    const r = await sendPush(sub, { title: 'Dock online', body: 'x' }, { vapid: vapid(), topic: 'portsolace', fetchImpl });
    assert.deepEqual(r, { ok: true, status: 201, gone: false, retry: false, body: '' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, sub.endpoint);
    assert.equal(calls[0].init.method, 'POST');
    const h = calls[0].init.headers;
    assert.equal(h['content-encoding'], 'aes128gcm');
    assert.equal(h['content-type'], 'application/octet-stream');
    assert.equal(h.ttl, '86400');
    assert.equal(h.urgency, 'normal');
    assert.equal(h.topic, 'portsolace');
    assert.match(h.authorization, /^vapid t=.+, k=.+$/);
    const plain = await decrypt(calls[0].init.body, ua.privateKey, ua.publicRaw, ua.auth);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), { title: 'Dock online', body: 'x' });
  });

  test('maps push service answers to gone / retry and never throws', async () => {
    const ua = await browserKeys();
    const sub = { endpoint: 'https://push.example.com/send/two', keys: { p256dh: ua.p256dh, auth: ua.auth } };
    const status = async code => sendPush(sub, 'x', { vapid: vapid(), fetchImpl: async () => new Response('nope', { status: code }) });
    assert.deepEqual(await status(410), { ok: false, status: 410, gone: true, retry: false, body: 'nope' });
    assert.equal((await status(404)).gone, true);
    assert.deepEqual(await status(429), { ok: false, status: 429, gone: false, retry: true, body: 'nope' });
    assert.equal((await status(503)).retry, true);
    assert.equal((await status(401)).retry, true);
    assert.deepEqual(await status(400), { ok: false, status: 400, gone: false, retry: false, body: 'nope' });
    const down = await sendPush(sub, 'x', { vapid: vapid(), fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    assert.deepEqual(down, { ok: false, status: 0, gone: false, retry: true, body: 'ECONNRESET' });
  });
});

// keep concat exercised (used by the e2e script too)
test('concat joins byte arrays', () => { assert.deepEqual([...concat(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3]))], [1, 2, 3]); });

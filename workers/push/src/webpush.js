// ============================================================
// WAYSTATION — Web Push primitives for the push worker
// RFC 8291 (message encryption, aes128gcm per RFC 8188) and RFC 8292 (VAPID), written against WebCrypto
// only, so the same file runs inside a Cloudflare Worker and under Node 20+ (the tests). No dependencies.
//
//   sendPush(subscription, payload, { vapid, ttl, urgency, topic, fetchImpl })
//     encrypts `payload` for the subscription's keys, signs a VAPID JWT for the endpoint's origin and
//     POSTs it. Returns { ok, status, gone, retry, body }; never throws for network or HTTP failures.
//   encrypt(plaintext, keys, { salt, asKeyPair })  the aes128gcm body (salt and sender key injectable for tests)
//   decrypt(body, uaPrivateKey, uaPublicRaw, auth)  the receiver side (tests and the local e2e script)
//   vapidAuthorization({ endpoint, publicKey, privateKey, subject })  the `Authorization: vapid t=…, k=…` value
//   generateVapidKeys()                               a fresh P-256 pair as base64url strings (scripts/vapid-keys.mjs)
// ============================================================

const enc = new TextEncoder();
export const utf8 = s => enc.encode(String(s));

export const b64u = {
  encode(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = String(str == null ? '' : str).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (/[^A-Za-z0-9+/]/.test(s)) throw new Error('invalid base64url');
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  normalise(str) { return b64u.encode(b64u.decode(str)); },
};

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// RFC 5869 extract + expand in one WebCrypto call
export async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// ---------------------------------------------------------- keys
// A base64url uncompressed P-256 point (65 bytes: 0x04 || x || y), as browsers and VAPID use them
export function decodePoint(b64) {
  const p = b64u.decode(b64);
  if (p.length !== 65 || p[0] !== 4) throw new Error('expected a 65-byte uncompressed P-256 public key');
  return p;
}
function pointToJwk(point) {
  return { kty: 'EC', crv: 'P-256', x: b64u.encode(point.slice(1, 33)), y: b64u.encode(point.slice(33, 65)) };
}
// Import a raw 32-byte private scalar (base64url) together with its public point, for ECDSA (VAPID) or ECDH.
export async function importPrivateKey(publicB64, privateB64, algo = 'ECDSA') {
  const point = decodePoint(publicB64);
  const d = b64u.decode(privateB64);
  if (d.length !== 32) throw new Error('expected a 32-byte P-256 private key');
  const jwk = { ...pointToJwk(point), d: b64u.encode(d), ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: algo, namedCurve: 'P-256' }, false, algo === 'ECDSA' ? ['sign'] : ['deriveBits']);
}
export async function importPublicKey(publicB64OrRaw, algo = 'ECDH') {
  const raw = typeof publicB64OrRaw === 'string' ? decodePoint(publicB64OrRaw) : publicB64OrRaw;
  return crypto.subtle.importKey('raw', raw, { name: algo, namedCurve: 'P-256' }, false, algo === 'ECDSA' ? ['verify'] : []);
}
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const publicKey = b64u.encode(concat(new Uint8Array([4]), b64u.decode(jwk.x), b64u.decode(jwk.y)));
  return { publicKey, privateKey: b64u.normalise(jwk.d) };
}

// ---------------------------------------------------------- VAPID (RFC 8292)
const keyCache = new Map();                 // "private|public" -> CryptoKey, per isolate
export const VAPID_MAX_AGE_S = 24 * 3600;   // RFC 8292 4.1: exp at most 24 hours ahead

export async function vapidAuthorization({ endpoint, publicKey, privateKey, subject, now = Date.now(), expiresInS = 12 * 3600 }) {
  const aud = new URL(endpoint).origin;
  const pub = b64u.normalise(publicKey);
  decodePoint(pub);
  if (!/^(mailto:|https:)/.test(String(subject || ''))) throw new Error('VAPID subject must be a mailto: address or an https: URL');
  const cacheKey = `${privateKey}|${pub}`;
  let key = keyCache.get(cacheKey);
  if (!key) { key = await importPrivateKey(pub, privateKey, 'ECDSA'); keyCache.set(cacheKey, key); }
  const header = b64u.encode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(utf8(JSON.stringify({ aud, exp: Math.floor(now / 1000) + Math.min(expiresInS, VAPID_MAX_AGE_S), sub: subject })));
  const input = `${header}.${claims}`;
  // WebCrypto's ECDSA signature is the raw r || s pair (64 bytes), which is exactly the JWS encoding
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(input)));
  return `vapid t=${input}.${b64u.encode(sig)}, k=${pub}`;
}

// ---------------------------------------------------------- content encryption (RFC 8291 / RFC 8188)
export const RECORD_SIZE = 4096;
export const MAX_PLAINTEXT = 3900;          // 4096 - 86 header - 1 delimiter - 16 tag, with margin: push services cap bodies at 4 KiB
const NUL = new Uint8Array([0]);
const KEY_INFO = concat(utf8('WebPush: info'), NUL);
const CEK_INFO = concat(utf8('Content-Encoding: aes128gcm'), NUL);
const NONCE_INFO = concat(utf8('Content-Encoding: nonce'), NUL);

async function deriveContentKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt) {
  const ikm = await hkdf(authSecret, ecdhSecret, concat(KEY_INFO, uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);
  return { cek, nonce };
}

// `keys` is the subscription's {p256dh, auth}. Options exist for the tests: a fixed `salt` (16 bytes) and a fixed
// sender pair `asKeyPair` = { privateKey: CryptoKey(ECDH, deriveBits), publicRaw: Uint8Array(65) }.
export async function encrypt(plaintext, keys, { salt, asKeyPair, recordSize = RECORD_SIZE } = {}) {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`payload too large (${plaintext.length} > ${MAX_PLAINTEXT} bytes)`);
  const uaPublic = decodePoint(keys && keys.p256dh);
  const authSecret = b64u.decode(keys && keys.auth);
  if (authSecret.length !== 16) throw new Error('expected a 16-byte auth secret');
  let asPrivate, asPublic;
  if (asKeyPair) { asPrivate = asKeyPair.privateKey; asPublic = asKeyPair.publicRaw; }
  else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = kp.privateKey; asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await importPublicKey(uaPublic, 'ECDH');
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  const s = salt || crypto.getRandomValues(new Uint8Array(16));
  if (s.length !== 16) throw new Error('salt must be 16 bytes');
  const { cek, nonce } = await deriveContentKeys(ecdhSecret, authSecret, uaPublic, asPublic, s);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(plaintext, new Uint8Array([2]));          // one record; 0x02 marks the last one, no padding
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, record));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, recordSize);
  return concat(s, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);   // RFC 8188 header + ciphertext
}

// The receiver side for single-record bodies (everything this worker produces).
export async function decrypt(body, uaPrivateKey, uaPublicRaw, auth) {
  if (body.length < 21 + 65 + 17) throw new Error('body too short');
  const salt = body.slice(0, 16), idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen), ciphertext = body.slice(21 + idlen);
  const asKey = await importPublicKey(asPublic, 'ECDH');
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivateKey, 256));
  const { cek, nonce } = await deriveContentKeys(ecdhSecret, b64u.decode(auth), uaPublicRaw, asPublic, salt);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 2) throw new Error('bad padding delimiter');
  return padded.slice(0, end);
}

// ---------------------------------------------------------- the whole send
export async function sendPush(subscription, payload, { vapid, ttl = 24 * 3600, urgency = 'normal', topic, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const body = await encrypt(utf8(typeof payload === 'string' ? payload : JSON.stringify(payload)), subscription.keys);
  const headers = {
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    ttl: String(Math.max(0, Math.floor(ttl))),
    urgency,
    authorization: await vapidAuthorization({ endpoint: subscription.endpoint, ...vapid }),
  };
  if (topic) headers.topic = String(topic).slice(0, 32);
  let res;
  try { res = await f(subscription.endpoint, { method: 'POST', headers, body }); }
  catch (e) { return { ok: false, status: 0, gone: false, retry: true, body: String((e && e.message) || e) }; }
  let text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  const status = res.status;
  return {
    ok: res.ok, status,
    gone: status === 404 || status === 410,                                      // the subscription no longer exists
    retry: status === 429 || status >= 500 || status === 401 || status === 403, // try again next minute (rate limit, outage, VAPID trouble)
    body: text.slice(0, 200),
  };
}

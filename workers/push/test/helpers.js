// Shared test helpers for the push worker tests (no tests in here).
import { b64u } from '../src/webpush.js';

// A browser-side key set the way PushManager.subscribe() would produce it
export async function browserKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: kp.privateKey, publicRaw, p256dh: b64u.encode(publicRaw), auth: b64u.encode(auth) };
}

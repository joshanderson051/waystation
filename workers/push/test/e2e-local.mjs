#!/usr/bin/env node
// ============================================================
// PORT SOLACE — local end-to-end check for the push worker, no browser needed.
//   1. npm run keys -- --dev-vars      (once; writes .dev.vars with a throwaway pair and DEV_ALLOW_LOCAL_ENDPOINT=1)
//   2. npm run dev                      (wrangler dev on 8789 with /__scheduled exposed)
//   3. node test/e2e-local.mjs          (this file; PUSH_API and FAKE_PORT override the defaults)
// It starts a fake push service on 127.0.0.1:8790, invents a browser key pair, subscribes and schedules a timer
// that is already due, triggers the cron through /__scheduled, then verifies the VAPID JWT with the worker's
// public key and decrypts the aes128gcm body exactly as a browser would. Exit code 0 when the payload arrives.
// ============================================================
import http from 'node:http';
import { b64u, decrypt, utf8, importPublicKey } from '../src/webpush.js';
import { browserKeys } from './helpers.js';

const API = (process.env.PUSH_API || 'http://127.0.0.1:8789').replace(/\/+$/, '');
const PORT = Number(process.env.FAKE_PORT || 8790);
const PLAYER = `e2e${Date.now().toString(36)}`;
const ORIGIN = 'http://localhost:8787';
const step = (msg, ok = true) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
const fail = msg => { step(msg, false); process.exitCode = 1; };

async function call(path, body) {
  const res = await fetch(API + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`);
  return { data, headers: res.headers };
}

// ---- the fake push service: records the one request we expect
const ua = await browserKeys();
const received = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => { received.push({ headers: req.headers, body: new Uint8Array(Buffer.concat(chunks)) }); res.writeHead(201); res.end(); });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${PORT}/send/${PLAYER}`;

try {
  const health = await call('/health');
  step(`/health: vapid ${health.data.vapid.publicKey}/${health.data.vapid.privateKey}, kv ${health.data.kv}, origins ${health.data.allowedOrigins.join(' ')}`);
  if (health.headers.get('access-control-allow-origin') !== ORIGIN) fail(`CORS header missing for ${ORIGIN} (ALLOWED_ORIGIN in .dev.vars?)`);
  const { data: keyData } = await call('/key');
  const publicKey = keyData.publicKey;
  step(`/key: ${publicKey.slice(0, 12)}…`);

  const sub = await call('/subscribe', { playerId: PLAYER, subscription: { endpoint, expirationTime: null, keys: { p256dh: ua.p256dh, auth: ua.auth } } });
  step(`/subscribe: token ${sub.data.token.slice(0, 6)}… reused=${sub.data.reused}`);
  const token = sub.data.token;

  const now = Date.now();
  const sched = await call('/schedule', { playerId: PLAYER, token, station: 'Harrow Point', timers: [
    { id: 'build:home:2,3', kind: 'build', title: 'Comms Relay online', dueAt: now - 5000 },
    { id: 'expedition:1', kind: 'expedition', title: 'Expedition back from Sable Drift', dueAt: now + 3600e3 },
  ] });
  step(`/schedule: count ${sched.data.count}, nextDueAt ${new Date(sched.data.nextDueAt).toISOString()}, unchanged=${sched.data.unchanged}`);
  const again = await call('/schedule', { playerId: PLAYER, token, station: 'Harrow Point', timers: [
    { id: 'expedition:1', kind: 'expedition', title: 'Expedition back from Sable Drift', dueAt: now + 3600e3 },
    { id: 'build:home:2,3', kind: 'build', title: 'Comms Relay online', dueAt: now - 5000 },
  ] });
  step(`/schedule again (same list, other order): unchanged=${again.data.unchanged}`, again.data.unchanged === true);

  const cron = await fetch(`${API}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
  step(`/__scheduled: ${cron.status} ${(await cron.text()).trim()}`);
  const t0 = Date.now();
  while (!received.length && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
  if (!received.length) { fail('the fake push service received nothing within 10 s'); }
  else {
    const { headers, body } = received[0];
    step(`push received: ${body.length} bytes, content-encoding ${headers['content-encoding']}, ttl ${headers.ttl}, urgency ${headers.urgency}, topic ${headers.topic}`,
      headers['content-encoding'] === 'aes128gcm' && headers.ttl === '86400');
    const m = /^vapid t=([^,]+), k=(\S+)$/.exec(headers.authorization || '');
    if (!m) fail(`authorization header malformed: ${headers.authorization}`);
    else {
      const [h, c, s] = m[1].split('.');
      const claims = JSON.parse(new TextDecoder().decode(b64u.decode(c)));
      const key = await importPublicKey(publicKey, 'ECDSA');
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u.decode(s), utf8(`${h}.${c}`));
      step(`VAPID: k matches /key (${m[2] === publicKey}), signature valid (${valid}), aud ${claims.aud}, sub ${claims.sub}, exp in ${Math.round((claims.exp * 1000 - Date.now()) / 3600e3)} h`,
        m[2] === publicKey && valid && claims.aud === `http://127.0.0.1:${PORT}`);
    }
    const plain = JSON.parse(new TextDecoder().decode(await decrypt(body, ua.privateKey, ua.publicRaw, ua.auth)));
    step(`payload decrypted: ${JSON.stringify(plain)}`, plain.title === 'Comms Relay online' && /Harrow Point/.test(plain.body));
  }

  const second = await fetch(`${API}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
  await second.text();
  await new Promise(r => setTimeout(r, 500));
  step(`second cron run sent nothing more (${received.length} message(s) in total)`, received.length === 1);

  const bye = await call('/unsubscribe', { playerId: PLAYER, token });
  step(`/unsubscribe: removed=${bye.data.removed}`, bye.data.removed === true);
} catch (e) {
  fail(e.message);
} finally {
  server.close();
}
console.log(process.exitCode ? '\nE2E FAILED' : '\nE2E OK: the local worker encrypted, signed and delivered a due timer.');

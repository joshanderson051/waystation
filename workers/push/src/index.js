// ============================================================
// PORT SOLACE — push backend: Cloudflare module Worker (DESIGN2.md Addendum A3)
// Keeps one Web Push subscription and one list of pending timers per player in KV; a 1-minute cron sends
// VAPID-signed, aes128gcm-encrypted notifications for the timers that have come due (src/webpush.js).
// No SDK, no npm runtime dependencies.
//
// Endpoints (JSON in, JSON out; CORS for ALLOWED_ORIGIN only)
//   GET  /health       -> configuration summary (no secrets)
//   GET  /key          -> {publicKey}                                  the VAPID public key the browser subscribes with
//   POST /subscribe    {playerId, subscription}       -> {ok, token}   stores the PushSubscription; `token` guards later calls
//   POST /schedule     {playerId, token, station?, timers:[{id, kind, title, dueAt}]} -> {ok, count, nextDueAt}
//                                                                      replaces that player's pending timers
//   POST /unsubscribe  {playerId, token}              -> {ok}          forgets the subscription and its timers
//
// Cron (wrangler.toml [triggers] crons = ["* * * * *"])
//   reads `index` (playerId -> soonest dueAt), sends one notification per player covering every timer that is
//   due, deletes the timers it sent, drops subscriptions the push service reports gone (404/410), keeps timers
//   the push service refused temporarily (429/5xx) for the next minute, forgets timers more than STALE_MS past
//   due, and every HEAL_EVERY_MIN minutes rebuilds `index` from the `timers:` keys (KV is eventually consistent
//   and `index` is shared, so a lost update there heals itself).
//
// KV (binding PUSH)
//   sub:{playerId}     -> {endpoint, keys:{p256dh, auth}, expirationTime, token, at}
//   timers:{playerId}  -> {station, timers:[{id, kind, title, dueAt}], at}
//   index              -> {playerId: nextDueAt}   one key, so the cron costs one read a minute (the KV free plan
//                         allows 1,000 list operations a day; a 1-minute cron alone would need 1,440)
//
// Environment (wrangler.toml [vars] / `wrangler secret put`)
//   ALLOWED_ORIGIN     comma-separated list of site origins allowed to call this worker
//   VAPID_PUBLIC_KEY   base64url, 65-byte uncompressed P-256 point (npm run keys)
//   VAPID_SUBJECT      contact for the push services: an https: URL or a mailto: address (default: the game's site)
//   VAPID_PRIVATE_KEY  secret, base64url 32-byte scalar (npm run keys, then `wrangler secret put VAPID_PRIVATE_KEY`)
// ============================================================
import { sendPush, decodePoint, b64u } from './webpush.js';
import {
  KINDS, MAX_TIMERS, STALE_MS, PAST_GRACE_MS, FUTURE_LIMIT_MS, MAX_SENDS_PER_RUN, HEAL_EVERY_MIN,
  DEFAULT_SUBJECT, KEY_INDEX, TTL_S, TOPIC, MAX_BODY_BYTES,
} from './config.js';   // constants live there: the runtime accepts only functions and handlers as named exports here

const PLAYER_RE = /^[A-Za-z0-9_-]{8,64}$/;    // Meta's p<base36> ids and the store's uuids
const ID_RE = /^[\x21-\x7e]{1,80}$/;          // printable ASCII, no spaces
const KIND_SET = new Set(KINDS);

const ROUTES = {
  '/health':      { GET: health },
  '/key':         { GET: key },
  '/subscribe':   { POST: subscribe },
  '/schedule':    { POST: schedule },
  '/unsubscribe': { POST: unsubscribe },
};

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra || {};
  }
}

export default {
  fetch(request, env) { return handle(request, env); },
  scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCron(env, (event && event.scheduledTime) || Date.now())
        .then(stats => console.log('push: cron', JSON.stringify(stats)))
        .catch(err => console.error('push: cron failed', err && err.message)),
    );
  },
};

// ---------------------------------------------------------- dispatch
export async function handle(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request.headers.get('Origin'), env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const route = ROUTES[path];
    if (!route) throw new HttpError(404, 'not-found', `No route for ${path}.`);
    const fn = route[request.method];
    if (!fn) throw new HttpError(405, 'method-not-allowed', `${request.method} is not allowed on ${path}.`, { allow: Object.keys(route) });
    const result = await fn(request, url, env);
    return json(result.status || 200, result.data, cors);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message, ...err.extra }, cors);
    console.error('push: unhandled error', err && err.message);
    return json(500, { error: 'internal', message: 'The push backend hit an unexpected error.' }, cors);
  }
}

function json(status, data, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

// ---------------------------------------------------------- CORS (the site origin only)
export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '').split(',').map(normaliseOrigin).filter(Boolean);
}
function normaliseOrigin(o) { return String(o || '').trim().replace(/\/+$/, '').toLowerCase(); }

export function corsHeaders(origin, env) {
  if (!origin || !allowedOrigins(env).includes(normaliseOrigin(origin))) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

// ---------------------------------------------------------- configuration
function requireKv(env) {
  if (!env.PUSH || typeof env.PUSH.get !== 'function') throw new HttpError(500, 'config', 'The PUSH KV namespace is not bound. Check wrangler.toml.');
  return env.PUSH;
}
export function requirePublicKey(env) {
  const k = String(env.VAPID_PUBLIC_KEY || '').trim();
  if (!k || /REPLACE/.test(k)) throw new HttpError(500, 'config', 'VAPID_PUBLIC_KEY is not set in wrangler.toml. Run `npm run keys`; see README.md.');
  try { decodePoint(k); } catch (e) { throw new HttpError(500, 'config', 'VAPID_PUBLIC_KEY is not a valid P-256 public key. Run `npm run keys` and paste the public key exactly.'); }
  return b64u.normalise(k);
}
export function subjectOf(env) {
  const s = String(env.VAPID_SUBJECT || '').trim();
  return /^(mailto:|https:)/.test(s) ? s : DEFAULT_SUBJECT;
}
export function vapidConfig(env) {
  const publicKey = requirePublicKey(env);
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  if (!privateKey) throw new HttpError(500, 'config', 'VAPID_PRIVATE_KEY is not set. Run `wrangler secret put VAPID_PRIVATE_KEY`.');
  return { publicKey, privateKey, subject: subjectOf(env) };
}

// ---------------------------------------------------------- validation helpers
async function readJsonBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, 'too-large', `The request body must be under ${MAX_BODY_BYTES} bytes.`);
  let text;
  try { text = await request.text(); } catch (e) { throw new HttpError(400, 'bad-json', 'The request body could not be read.'); }
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too-large', `The request body must be under ${MAX_BODY_BYTES} bytes.`);
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new HttpError(400, 'bad-json', 'The request body must be JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad-json', 'The request body must be a JSON object.');
  return body;
}
function requirePlayer(v) {
  if (typeof v !== 'string' || !PLAYER_RE.test(v)) throw new HttpError(400, 'bad-player', 'playerId must be 8-64 letters, digits, "_" or "-".');
  return v;
}
function requireToken(given, expected) {
  if (typeof given !== 'string' || !expected || !timingSafeEqual(given, expected)) {
    throw new HttpError(403, 'bad-token', 'The token does not match this player\'s subscription. Subscribe again.');
  }
}
// `allowLocal` exists for `wrangler dev` only (DEV_ALLOW_LOCAL_ENDPOINT=1 in .dev.vars): test/e2e-local.mjs runs a
// fake push service on 127.0.0.1. It is never set in wrangler.toml, so a deployed worker keeps the https rule.
export function requireSubscription(v, { allowLocal = false } = {}) {
  const bad = why => new HttpError(400, 'bad-subscription', `subscription must be the PushSubscription JSON: ${why}.`);
  if (!v || typeof v !== 'object') throw bad('an object with endpoint and keys');
  let u;
  try { u = new URL(String(v.endpoint || '')); } catch (e) { throw bad('endpoint must be an absolute URL'); }
  if (u.protocol !== 'https:' && !(allowLocal && u.protocol === 'http:')) throw bad('endpoint must be https');
  if (u.username || u.password) throw bad('endpoint must not carry credentials');
  if (!allowLocal && /^(localhost|.*\.local|.*\.internal|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i.test(u.hostname)) throw bad('endpoint must be a public push service');
  if (u.href.length > 1024) throw bad('endpoint is too long');
  const keys = v.keys && typeof v.keys === 'object' ? v.keys : {};
  try { decodePoint(keys.p256dh); } catch (e) { throw bad('keys.p256dh must be a base64url P-256 public key'); }
  let auth;
  try { auth = b64u.decode(keys.auth); } catch (e) { auth = new Uint8Array(0); }
  if (auth.length !== 16) throw bad('keys.auth must be a 16-byte base64url secret');
  const expirationTime = typeof v.expirationTime === 'number' && Number.isFinite(v.expirationTime) ? v.expirationTime : null;
  return { endpoint: u.href, keys: { p256dh: b64u.normalise(keys.p256dh), auth: b64u.normalise(keys.auth) }, expirationTime };
}
const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Validates, cleans and sorts the client's list. Timers already over (beyond a short grace) are dropped
// rather than rejected, duplicates by id collapse, and only the soonest MAX_TIMERS survive.
export function normaliseTimers(list, now = Date.now()) {
  if (!Array.isArray(list)) throw new HttpError(400, 'bad-timers', 'timers must be an array.');
  if (list.length > MAX_TIMERS) throw new HttpError(400, 'too-many', `timers may hold at most ${MAX_TIMERS} entries; send the soonest ones.`);
  const out = [], seen = new Set();
  for (const t of list) {
    if (!t || typeof t !== 'object') throw new HttpError(400, 'bad-timers', 'each timer must be an object {id, kind, title, dueAt}.');
    const id = String(t.id == null ? '' : t.id), kind = String(t.kind == null ? '' : t.kind), title = cleanText(t.title, 80), dueAt = Number(t.dueAt);
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad-timers', `timer id "${id.slice(0, 20)}" must be 1-80 printable characters without spaces.`);
    if (!KIND_SET.has(kind)) throw new HttpError(400, 'bad-timers', `timer kind "${kind.slice(0, 20)}" is not one of ${KINDS.join(', ')}.`);
    if (!title) throw new HttpError(400, 'bad-timers', `timer "${id.slice(0, 20)}" needs a title (1-80 characters).`);
    if (!Number.isFinite(dueAt) || dueAt > now + FUTURE_LIMIT_MS) throw new HttpError(400, 'bad-timers', `timer "${id.slice(0, 20)}" needs dueAt as a Unix time in milliseconds.`);
    if (dueAt < now - PAST_GRACE_MS) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, kind, title, dueAt: Math.round(dueAt) });
  }
  out.sort((a, b) => a.dueAt - b.dueAt || (a.id < b.id ? -1 : 1));
  return out.slice(0, MAX_TIMERS);
}
function sameTimers(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!x || x.id !== y.id || x.kind !== y.kind || x.title !== y.title || x.dueAt !== y.dueAt) return false;
  }
  return true;
}

function newToken() { return b64u.encode(crypto.getRandomValues(new Uint8Array(32))); }
export function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// ---------------------------------------------------------- the shared index (playerId -> soonest dueAt)
// `mutate(index)` returns true when it changed something; the write is skipped otherwise and a failed write
// (KV allows one write per second to a single key) is logged, not raised: the cron's periodic rebuild repairs it.
async function updateIndex(kv, mutate) {
  let index = await kv.get(KEY_INDEX, 'json');
  if (!index || typeof index !== 'object' || Array.isArray(index)) index = {};
  if (!mutate(index)) return false;
  try { await kv.put(KEY_INDEX, JSON.stringify(index)); return true; }
  catch (e) { console.warn('push: index write failed, the cron will rebuild it', e && e.message); return false; }
}
export async function rebuildIndex(kv) {
  const out = {};
  let cursor;
  do {
    const page = await kv.list({ prefix: 'timers:', cursor, limit: 1000 });
    for (const k of page.keys || []) {
      const rec = await kv.get(k.name, 'json');
      const list = rec && Array.isArray(rec.timers) ? rec.timers.filter(t => t && Number.isFinite(t.dueAt)) : [];
      if (list.length) out[k.name.slice('timers:'.length)] = Math.min(...list.map(t => t.dueAt));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------- GET /health
async function health(request, url, env) {
  const kv = !!(env.PUSH && typeof env.PUSH.get === 'function');
  let scheduledPlayers = null;
  if (kv) { try { const idx = await env.PUSH.get(KEY_INDEX, 'json'); scheduledPlayers = idx && typeof idx === 'object' ? Object.keys(idx).length : 0; } catch (e) { scheduledPlayers = null; } }
  let publicKey = 'missing';
  if (env.VAPID_PUBLIC_KEY && !/REPLACE/.test(env.VAPID_PUBLIC_KEY)) { try { decodePoint(env.VAPID_PUBLIC_KEY); publicKey = 'ok'; } catch (e) { publicKey = 'invalid'; } }
  return {
    data: {
      ok: true,
      service: 'waystation-push',
      vapid: { publicKey, privateKey: env.VAPID_PRIVATE_KEY ? 'set' : 'missing', subject: subjectOf(env) },
      kv,
      allowedOrigins: allowedOrigins(env),
      scheduledPlayers,
      limits: { maxTimers: MAX_TIMERS, staleMs: STALE_MS, maxSendsPerRun: MAX_SENDS_PER_RUN },
    },
  };
}

// ---------------------------------------------------------- GET /key
function key(request, url, env) {
  return { data: { publicKey: requirePublicKey(env) } };
}

// ---------------------------------------------------------- POST /subscribe
// Stores the browser's PushSubscription under the player id and hands back a token that /schedule and
// /unsubscribe must present. The same subscription (endpoint and keys) gets the same token back without a
// write, so a reload or a lost localStorage entry costs nothing. A different subscription for the same player
// (a new browser, an imported profile) replaces the old one: one device per player, the newest wins.
async function subscribe(request, url, env) {
  const kv = requireKv(env);
  requirePublicKey(env);
  const body = await readJsonBody(request);
  const playerId = requirePlayer(body.playerId);
  const sub = requireSubscription(body.subscription, { allowLocal: String(env.DEV_ALLOW_LOCAL_ENDPOINT || '') === '1' });
  const existing = await kv.get(`sub:${playerId}`, 'json');
  if (existing && existing.token && existing.endpoint === sub.endpoint && existing.keys &&
      existing.keys.p256dh === sub.keys.p256dh && existing.keys.auth === sub.keys.auth) {
    return { data: { ok: true, token: existing.token, reused: true } };
  }
  const token = newToken();
  await kv.put(`sub:${playerId}`, JSON.stringify({ ...sub, token, at: new Date().toISOString() }));
  return { data: { ok: true, token, reused: false } };
}

// ---------------------------------------------------------- POST /schedule
// Replaces the player's pending timers. Nothing is written when the list is unchanged (reads are a hundred
// times cheaper than writes on the free plan), and `index` is touched only when the soonest dueAt moved.
async function schedule(request, url, env) {
  const kv = requireKv(env);
  const body = await readJsonBody(request);
  const playerId = requirePlayer(body.playerId);
  const sub = await kv.get(`sub:${playerId}`, 'json');
  if (!sub) throw new HttpError(404, 'no-subscription', 'No subscription for this player. Subscribe first.');
  requireToken(body.token, sub.token);
  const now = Date.now();
  const timers = normaliseTimers(body.timers, now);
  const station = cleanText(body.station, 28);
  const nextDueAt = timers.length ? timers[0].dueAt : null;
  const tkey = `timers:${playerId}`;
  const existing = await kv.get(tkey, 'json');
  const unchanged = existing ? sameTimers(existing.timers, timers) && (existing.station || '') === station : timers.length === 0;
  if (!unchanged) {
    if (timers.length) await kv.put(tkey, JSON.stringify({ station, timers, at: new Date(now).toISOString() }));
    else await kv.delete(tkey);
  }
  await updateIndex(kv, idx => {
    if (nextDueAt == null) { if (!(playerId in idx)) return false; delete idx[playerId]; return true; }
    if (idx[playerId] === nextDueAt) return false;
    idx[playerId] = nextDueAt; return true;
  });
  return { data: { ok: true, count: timers.length, nextDueAt, unchanged } };
}

// ---------------------------------------------------------- POST /unsubscribe
async function unsubscribe(request, url, env) {
  const kv = requireKv(env);
  const body = await readJsonBody(request);
  const playerId = requirePlayer(body.playerId);
  const sub = await kv.get(`sub:${playerId}`, 'json');
  if (sub) { requireToken(body.token, sub.token); await kv.delete(`sub:${playerId}`); }
  await kv.delete(`timers:${playerId}`);
  await updateIndex(kv, idx => { if (!(playerId in idx)) return false; delete idx[playerId]; return true; });
  return { data: { ok: true, removed: !!sub } };
}

// ---------------------------------------------------------- the notification text
export function composeNotification(ready, station, now = Date.now()) {
  const items = ready.slice().sort((a, b) => a.dueAt - b.dueAt);
  const where = cleanText(station, 28);
  if (items.length === 1) {
    const t = items[0];
    const body = t.kind === 'test' ? 'Notifications are working. This is the test you asked for in Settings.'
      : t.kind === 'daily' ? (where ? `Your streak at ${where} is waiting.` : 'Your streak is waiting on the bridge.')
      : (where ? `${where} is waiting on the bridge.` : 'Your station is waiting on the bridge.');
    return { title: t.kind === 'test' ? 'Port Solace' : t.title, body, tag: TOPIC, at: t.dueAt, kinds: [t.kind] };
  }
  let body = items.map(t => t.title).join(' · ');
  if (body.length > 180) body = `${body.slice(0, 177).replace(/\s+\S*$/, '')}…`;
  return {
    title: `${items.length} things finished${where ? ` at ${where}` : ''}`,
    body, tag: TOPIC, at: items[items.length - 1].dueAt, kinds: [...new Set(items.map(t => t.kind))],
  };
}

// ---------------------------------------------------------- the cron
export async function runCron(env, now = Date.now(), { fetchImpl } = {}) {
  const kv = requireKv(env);
  const vapid = vapidConfig(env);
  const stats = { checked: 0, sent: 0, failed: 0, pruned: 0, dropped: 0, deferred: 0, healed: false };
  let index = await kv.get(KEY_INDEX, 'json');
  if (!index || typeof index !== 'object' || Array.isArray(index)) index = {};
  let dirty = false;
  if (Math.floor(now / 60e3) % HEAL_EVERY_MIN === 0) {
    const rebuilt = await rebuildIndex(kv);
    if (JSON.stringify(sortKeys(rebuilt)) !== JSON.stringify(sortKeys(index))) { index = rebuilt; dirty = true; }
    stats.healed = true;
  }
  const due = Object.entries(index).filter(([, at]) => typeof at === 'number' && at <= now).sort((a, b) => a[1] - b[1]);
  let sends = 0;
  for (const [playerId] of due) {
    stats.checked++;
    const tkey = `timers:${playerId}`;
    const rec = await kv.get(tkey, 'json');
    const timers = rec && Array.isArray(rec.timers) ? rec.timers.filter(t => t && Number.isFinite(t.dueAt)) : [];
    if (!timers.length) { if (rec) await kv.delete(tkey); delete index[playerId]; dirty = true; continue; }
    const sub = await kv.get(`sub:${playerId}`, 'json');
    if (!sub || !sub.endpoint || !sub.keys) { await kv.delete(tkey); delete index[playerId]; dirty = true; stats.dropped += timers.length; continue; }

    const ready = timers.filter(t => t.dueAt <= now && now - t.dueAt <= STALE_MS);
    const stale = timers.filter(t => t.dueAt <= now && now - t.dueAt > STALE_MS);
    let remaining = timers.filter(t => t.dueAt > now);
    stats.dropped += stale.length;
    if (ready.length) {
      if (sends >= MAX_SENDS_PER_RUN) { stats.deferred++; remaining = ready.concat(remaining); }
      else {
        sends++;
        const r = await sendPush(sub, composeNotification(ready, rec.station, now), { vapid, ttl: TTL_S, topic: TOPIC, fetchImpl });
        if (r.gone) {
          await kv.delete(`sub:${playerId}`); await kv.delete(tkey);
          delete index[playerId]; dirty = true; stats.pruned++;
          continue;
        }
        if (r.ok) stats.sent++;
        else {
          stats.failed++;
          console.warn(`push: ${playerId} -> ${r.status} ${r.body || ''}`.trim());
          if (r.retry) remaining = ready.concat(remaining);     // a 400/413 is ours to fix; those timers are dropped
        }
      }
    }
    remaining.sort((a, b) => a.dueAt - b.dueAt);
    if (remaining.length !== timers.length) {
      if (remaining.length) await kv.put(tkey, JSON.stringify({ ...rec, timers: remaining }));
      else await kv.delete(tkey);
    }
    const next = remaining.length ? remaining[0].dueAt : null;
    if (next == null) { delete index[playerId]; dirty = true; }
    else if (index[playerId] !== next) { index[playerId] = next; dirty = true; }
  }
  if (dirty) {
    try { await kv.put(KEY_INDEX, JSON.stringify(index)); }
    catch (e) { console.warn('push: index write failed after the cron', e && e.message); }
  }
  return stats;
}
function sortKeys(o) { return Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]])); }

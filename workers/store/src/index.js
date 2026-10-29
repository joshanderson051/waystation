// ============================================================
// PORT SOLACE — store backend: Cloudflare module Worker (DESIGN2.md 7.4)
// Plain fetch to the Stripe REST API. No SDK, no npm runtime dependencies.
//
// Endpoints
//   POST /checkout      {sku, playerId, returnUrl} -> {id, url}   creates a Stripe Checkout Session
//   GET  /claim         ?session_id&playerId        -> {sku, granted, grantId, duplicate}
//   POST /webhook       Stripe event (checkout.session.completed), signature verified
//   GET  /entitlements  ?playerId                   -> {playerId, grants:[{grantId, sku, at}]}
//   GET  /restore       ?email&playerId             -> claims paid sessions for this player + lists grants
//   GET  /health        -> configuration summary (no secrets)
//
// KV (binding STORE)
//   grant:{sessionId}  -> {sku, playerId, at}
//   player:{playerId}  -> [grantId, ...]
//
// Environment (wrangler.toml [vars] / `wrangler secret put`)
//   ALLOWED_ORIGIN          comma-separated list of site origins allowed to call this worker
//   PRICES                  JSON map sku -> Stripe price id ("price_...")
//   STRIPE_SECRET_KEY       secret, sk_test_... or sk_live_...
//   STRIPE_WEBHOOK_SECRET   secret, whsec_... from the webhook endpoint
// ============================================================

const STRIPE_API = 'https://api.stripe.com';
const SIGNATURE_TOLERANCE_S = 5 * 60;                     // 7.4: 5-minute tolerance on webhook timestamps
const RESTORE_PAGE = 100;                                 // Stripe list limit (max 100); older sessions are not scanned
const STATEMENT_SUFFIX = 'WAYSTATION';                    // card statements read "PRIME SIGN* WAYSTATION" (22 chars max with the prefix)

const PLAYER_RE  = /^[A-Za-z0-9_-]{8,64}$/;               // uuid or similar
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{8,}$/;
const SKU_RE     = /^[a-z0-9_]{2,40}$/;
const PRICE_RE   = /^price_[A-Za-z0-9]+$/;
const EMAIL_RE   = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/;

const ROUTES = {
  '/health':       { GET: health },
  '/checkout':     { POST: checkout },
  '/claim':        { GET: claim },
  '/webhook':      { POST: webhook },
  '/entitlements': { GET: entitlements },
  '/restore':      { GET: restore },
};

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra || {};
  }
}

export default {
  fetch(request, env) { return handle(request, env); },
};

// ---------------------------------------------------------- dispatch
export async function handle(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request.headers.get('Origin'), env);
  if (request.method === 'OPTIONS') return preflight(cors);
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
    console.error('store: unhandled error', err && err.message);
    return json(500, { error: 'internal', message: 'The store backend hit an unexpected error.' }, cors);
  }
}

function json(status, data, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

// ---------------------------------------------------------- CORS (7.4: the site origin only)
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
function preflight(cors) { return new Response(null, { status: 204, headers: cors }); }

// ---------------------------------------------------------- configuration
export function parsePrices(env) {
  let map;
  try { map = JSON.parse(env.PRICES || ''); } catch (e) { throw new HttpError(500, 'config', 'PRICES is not valid JSON. See workers/store/README.md.'); }
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new HttpError(500, 'config', 'PRICES must be a JSON object of sku -> price id.');
  const out = {};
  for (const [sku, price] of Object.entries(map)) {
    if (SKU_RE.test(sku) && typeof price === 'string' && PRICE_RE.test(price)) out[sku] = price;
  }
  return out;
}
function requireKey(env) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(500, 'config', 'STRIPE_SECRET_KEY is not set. Run `wrangler secret put STRIPE_SECRET_KEY`.');
  return env.STRIPE_SECRET_KEY;
}
function requireKv(env) {
  if (!env.STORE || typeof env.STORE.get !== 'function') throw new HttpError(500, 'config', 'The STORE KV namespace is not bound. Check wrangler.toml.');
  return env.STORE;
}

// ---------------------------------------------------------- Stripe REST
async function stripe(env, method, path, form) {
  const key = requireKey(env);
  let res;
  try {
    res = await fetch(STRIPE_API + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? form.toString() : undefined,
    });
  } catch (e) {
    throw new HttpError(502, 'stripe-unreachable', 'Could not reach Stripe.');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) {
    const se = data.error || {};
    throw new HttpError(502, 'stripe', se.message || `Stripe answered ${res.status}.`, { stripeType: se.type, stripeCode: se.code });
  }
  return data;
}

async function retrieveSession(env, sessionId) {
  try { return await stripe(env, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`); }
  catch (err) {
    if (err instanceof HttpError && err.extra.stripeCode === 'resource_missing') throw new HttpError(404, 'no-session', 'Stripe has no record of that checkout session.');
    throw err;
  }
}

// ---------------------------------------------------------- validation helpers
async function readJsonBody(request) {
  let body;
  try { body = await request.json(); } catch (e) { throw new HttpError(400, 'bad-json', 'The request body must be JSON.'); }
  if (!body || typeof body !== 'object') throw new HttpError(400, 'bad-json', 'The request body must be a JSON object.');
  return body;
}
function requirePlayer(v) {
  if (typeof v !== 'string' || !PLAYER_RE.test(v)) throw new HttpError(400, 'bad-player', 'playerId must be 8-64 letters, digits, "_" or "-".');
  return v;
}
function requireSession(v) {
  if (typeof v !== 'string' || !SESSION_RE.test(v)) throw new HttpError(400, 'bad-session', 'session_id must be a Stripe Checkout Session id (cs_...).');
  return v;
}
function requireSku(v, prices) {
  if (typeof v !== 'string' || !SKU_RE.test(v) || !prices[v]) throw new HttpError(400, 'unknown-sku', `Unknown sku "${String(v).slice(0, 40)}".`, { known: Object.keys(prices) });
  return v;
}
function requireReturnUrl(v, env) {
  let u;
  try { u = new URL(String(v)); } catch (e) { throw new HttpError(400, 'bad-return-url', 'returnUrl must be an absolute http(s) URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'bad-return-url', 'returnUrl must be an http(s) URL.');
  if (!allowedOrigins(env).includes(normaliseOrigin(u.origin))) throw new HttpError(400, 'bad-return-url', 'returnUrl must be on an allowed origin.');
  return u.origin + u.pathname;                                   // query and hash are ours to add
}
function requireEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, 'bad-email', 'email must be a valid email address.');
  return e;
}

// ---------------------------------------------------------- KV grants (idempotent)
async function recordGrant(env, grantId, sku, playerId) {
  const kv = requireKv(env);
  const key = `grant:${grantId}`;
  const existing = await kv.get(key, 'json');
  if (existing) return { grant: existing, duplicate: true };
  const grant = { sku, playerId, at: new Date().toISOString() };
  await kv.put(key, JSON.stringify(grant));
  const pkey = `player:${playerId}`;
  const ids = (await kv.get(pkey, 'json')) || [];
  if (!ids.includes(grantId)) { ids.push(grantId); await kv.put(pkey, JSON.stringify(ids)); }
  return { grant, duplicate: false };
}

async function listGrants(env, playerId) {
  const kv = requireKv(env);
  const ids = (await kv.get(`player:${playerId}`, 'json')) || [];
  const grants = await Promise.all([...new Set(ids)].map(async grantId => {
    const g = await kv.get(`grant:${grantId}`, 'json');
    return g ? { grantId, sku: g.sku, at: g.at } : null;
  }));
  return grants.filter(Boolean);
}

// ---------------------------------------------------------- GET /health
async function health(request, url, env) {
  const key = env.STRIPE_SECRET_KEY || '';
  let prices;
  try { const skus = Object.keys(parsePrices(env)); prices = { count: skus.length, skus }; }
  catch (e) { prices = { error: e.message }; }
  return {
    data: {
      ok: true,
      service: 'waystation-store',
      stripe: !key ? 'missing' : key.startsWith('sk_test_') ? 'test' : key.startsWith('sk_live_') ? 'live' : 'unrecognised-key',
      webhookSecret: Boolean(env.STRIPE_WEBHOOK_SECRET),
      kv: Boolean(env.STORE && typeof env.STORE.get === 'function'),
      allowedOrigins: allowedOrigins(env),
      prices,
    },
  };
}

// ---------------------------------------------------------- POST /checkout (7.4)
async function checkout(request, url, env) {
  const prices = parsePrices(env);
  const body = await readJsonBody(request);
  const sku = requireSku(body.sku, prices);
  const playerId = requirePlayer(body.playerId);
  const returnUrl = requireReturnUrl(body.returnUrl, env);

  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('line_items[0][price]', prices[sku]);
  form.set('line_items[0][quantity]', '1');
  form.set('client_reference_id', playerId);
  form.set('metadata[sku]', sku);
  form.set('metadata[playerId]', playerId);
  form.set('success_url', `${returnUrl}?purchase=success&session_id={CHECKOUT_SESSION_ID}`);
  form.set('cancel_url', `${returnUrl}?purchase=cancel`);
  form.set('payment_intent_data[statement_descriptor_suffix]', STATEMENT_SUFFIX);   // the merchant is a marketing LLC: name the game

  const session = await stripe(env, 'POST', '/v1/checkout/sessions', form);
  if (!session.url) throw new HttpError(502, 'stripe', 'Stripe created a session without a checkout URL.');
  return { data: { id: session.id, url: session.url, sku } };
}

// ---------------------------------------------------------- GET /claim (7.4)
async function claim(request, url, env) {
  const sessionId = requireSession(url.searchParams.get('session_id'));
  const playerId = requirePlayer(url.searchParams.get('playerId'));
  const session = await retrieveSession(env, sessionId);
  if (session.client_reference_id !== playerId) throw new HttpError(403, 'player-mismatch', 'This checkout session belongs to a different player.');
  if (session.payment_status !== 'paid') throw new HttpError(402, 'unpaid', 'This checkout session has not been paid.', { paymentStatus: session.payment_status || 'unknown' });
  const sku = session.metadata && session.metadata.sku;
  if (typeof sku !== 'string' || !SKU_RE.test(sku)) throw new HttpError(409, 'no-sku', 'This checkout session carries no sku; it was not created by this store.');
  const { duplicate } = await recordGrant(env, session.id, sku, playerId);
  return { data: { sku, granted: true, grantId: session.id, playerId, duplicate } };
}

// ---------------------------------------------------------- POST /webhook (7.4)
async function webhook(request, url, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(500, 'config', 'STRIPE_WEBHOOK_SECRET is not set. Run `wrangler secret put STRIPE_WEBHOOK_SECRET`.');
  const payload = await request.text();
  const check = await verifyStripeSignature(payload, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!check.valid) throw new HttpError(400, 'bad-signature', `Webhook signature rejected (${check.reason}).`);

  let event;
  try { event = JSON.parse(payload); } catch (e) { throw new HttpError(400, 'bad-json', 'The webhook payload is not JSON.'); }
  const type = event && event.type;
  if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') {
    return { data: { received: true, ignored: true, type: String(type || 'unknown') } };
  }
  const s = (event.data && event.data.object) || {};
  const sku = s.metadata && s.metadata.sku;
  const ok = s.payment_status === 'paid' && SESSION_RE.test(String(s.id || '')) && PLAYER_RE.test(String(s.client_reference_id || '')) && SKU_RE.test(String(sku || ''));
  if (!ok) return { data: { received: true, granted: false, reason: s.payment_status !== 'paid' ? 'not-paid' : 'not-a-store-session' } };
  const { duplicate } = await recordGrant(env, s.id, sku, s.client_reference_id);
  return { data: { received: true, granted: true, grantId: s.id, sku, duplicate } };
}

// ---------------------------------------------------------- Stripe-Signature (WebCrypto HMAC-SHA256 over `${t}.${payload}`)
export function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') out.t = v;
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) out.v1.push(v.toLowerCase());
  }
  return out;
}

export async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison of two equal-length strings (hex digests).
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyStripeSignature(payload, header, secret, { toleranceS = SIGNATURE_TOLERANCE_S, nowS = Date.now() / 1000 } = {}) {
  const { t, v1 } = parseSignatureHeader(header);
  if (!t || !/^\d+$/.test(t) || !v1.length) return { valid: false, reason: 'malformed' };
  if (Math.abs(nowS - Number(t)) > toleranceS) return { valid: false, reason: 'stale' };
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  let match = false;
  for (const sig of v1) match = timingSafeEqual(sig, expected) || match;   // check every v1, no early exit
  return match ? { valid: true, reason: 'ok' } : { valid: false, reason: 'mismatch' };
}

// Builds a Stripe-Signature header the way Stripe does. Used by the tests (and handy for curl checks).
export async function signPayload(payload, secret, tS = Math.floor(Date.now() / 1000)) {
  return `t=${tS},v1=${await hmacSha256Hex(secret, `${tS}.${payload}`)}`;
}

// ---------------------------------------------------------- GET /entitlements
async function entitlements(request, url, env) {
  const playerId = requirePlayer(url.searchParams.get('playerId'));
  return { data: { playerId, grants: await listGrants(env, playerId) } };
}

// ---------------------------------------------------------- GET /restore (7.4)
// Lists Checkout Sessions by the email Checkout collected (customer_details.email) and claims the paid ones that
// belong to this player and were never claimed (browser closed before the return, webhook not yet configured, ...).
// Sessions bound to another playerId are counted, not transferred: the player should import that profile instead.
// Limitation: Stripe matches the exact email the buyer typed at checkout; sessions with no email are not found.
async function restore(request, url, env) {
  const email = requireEmail(url.searchParams.get('email'));
  const playerId = requirePlayer(url.searchParams.get('playerId'));
  const q = new URLSearchParams({ 'customer_details[email]': email, limit: String(RESTORE_PAGE) });
  const list = await stripe(env, 'GET', `/v1/checkout/sessions?${q}`);

  let found = 0, otherProfile = 0;
  const newlyGranted = [];
  for (const s of Array.isArray(list.data) ? list.data : []) {
    if (s.payment_status !== 'paid' || !SESSION_RE.test(String(s.id || ''))) continue;
    const sku = s.metadata && s.metadata.sku;
    if (typeof sku !== 'string' || !SKU_RE.test(sku)) continue;
    found++;
    if (s.client_reference_id !== playerId) { otherProfile++; continue; }
    const { grant, duplicate } = await recordGrant(env, s.id, sku, playerId);
    if (!duplicate) newlyGranted.push({ grantId: s.id, sku, at: grant.at });
  }
  return { data: { playerId, email, found, otherProfile, newlyGranted, grants: await listGrants(env, playerId) } };
}

// ============================================================
// PORT SOLACE — Port Authority on the account worker (DESIGN2.md Addendum A9): presence, gifts, the admin API
// Every running game reports presence keyed by its random profile.playerId; the owner's portal
// (portsolace.com/admin/) lists those players and sends them gifts of credits and Antimatter, which the
// next presence call hands to the game. Storage is the D1 database `portsolace` (binding DB, schema in
// migrations/0001_port_authority.sql). Purchases are read from the store worker's KV (binding STORE, read only).
//
// Public (CORS, JSON, no-store, rate-limited per IP)
//   POST /presence  {playerId, summary:{name, day, level, rank, credits, am, sectors}, platform, version}
//                   optional Bearer (links the account; an invalid token is ignored)
//                   -> {ok:true, gifts:[{id, credits, am, note, createdAt}]}   every unacked, unrevoked gift
//   POST /gifts/ack {playerId, ids:[...]}                    -> {ok:true, acked:[ids marked now]}
//
// Admin (Bearer account token whose KV user id is in the ADMIN_USER_IDS secret AND whose email is in ADMIN_EMAILS;
//        401 no or bad token, 403 not-admin). The id check matters: /signup does not verify emails, so an email alone
//        would let anyone who signs up with an admin's address (before the owner does, or after a delete) in.
//   GET  /admin/stats                                         -> {players, active24h, active7d, active30d, accounts, giftsPending, giftsDelivered, giftsApplied, giftsRevoked}
//   GET  /admin/players?q&active&sort&dir&limit&offset        -> {total, players:[row + {pendingGifts}]}
//   GET  /admin/players/:playerId                             -> {player, gifts:[row + {status}], purchases:[{grantId, sku, at}], purchasesAvailable}
//   POST /admin/gifts {playerId, credits, am, note, requestId} -> {gift}            (logged; a repeated requestId returns the first gift)
//   POST /admin/gifts/:id/revoke                              -> {gift}             (logged; 409 once applied)
//   GET  /admin/log?limit                                     -> {entries:[{id, at, admin, action, target, detail}]}
//
// SQL is always prepare().bind(); the only text spliced into a statement comes from fixed whitelists here.
// ============================================================
import { HttpError, LIMITS, TOKEN_RE, b64u, randomBytes } from './lib.js';

export const PLAYER_RE = /^[A-Za-z0-9_-]{8,64}$/;            // the store worker's PLAYER_RE
export const GIFT_RE = /^gft_[A-Za-z0-9_-]{22}$/;            // 'gft_' + 16 random bytes base64url
export const REQUEST_RE = /^[A-Za-z0-9_-]{8,64}$/;          // the portal's per-review idempotency key (a uuid)
export const NUM_MAX = 1e12;                                  // presence numbers are clamped to 0..1e12
export const NAME_MAX = 40;
export const VERSION_MAX = 40;
export const NOTE_MAX = 140;
export const GIFT_CREDITS_MAX = 10000000;
export const GIFT_AM_MAX = 100000;
export const SESSION_GAP_MS = 30 * 60e3;                      // a new session when last_seen is older than this
export const PRESENCE_GIFTS_MAX = 50;                         // gifts handed out per presence call (the rest follow next time)
export const ACK_IDS_MAX = 50;
export const PLAYERS_PAGE_MAX = 200;
export const LOG_PAGE_MAX = 200;
export const ACCOUNTS_CACHE_MS = 5 * 60e3;                    // KV list calls are scarce (1,000 a day on the free plan)
const DAY = 86400e3;
const ACTIVE = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
// sort key -> [SQL expression, default direction]; anything else falls back to last_seen
const SORTS = {
  last_seen: ['p.last_seen', 'DESC'], first_seen: ['p.first_seen', 'DESC'], level: ['p.level', 'DESC'],
  credits: ['p.credits', 'DESC'], am: ['p.am', 'DESC'], rank: ['p.rank', 'DESC'], day: ['p.day', 'DESC'],
  sectors: ['p.sectors', 'DESC'], sessions: ['p.sessions', 'DESC'],
  station: ['p.station COLLATE NOCASE', 'ASC'], email: ['p.email COLLATE NOCASE', 'ASC'], platform: ['p.platform', 'ASC'],
};
// a presence without a summary object keeps the station figures it reported before
const SUMMARY_SET = `station = excluded.station, day = excluded.day, level = excluded.level, rank = excluded.rank,
          credits = excluded.credits, am = excluded.am, sectors = excluded.sectors,`;
const PENDING_SQL ='SELECT COUNT(*) FROM gifts g WHERE g.player_id = p.player_id AND g.acked_at IS NULL AND g.revoked_at IS NULL';

// ---------------------------------------------------------- pure helpers (unit-tested)
// Control characters, zero-width and bidi-override characters are removed; whitespace runs become one space.
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
export function cleanText(v, max) {
  const s = String(v == null ? '' : v).replace(/[\t\n\r\u2028\u2029]/g, ' ').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  return max == null ? s : Array.from(s).slice(0, max).join('');
}
export const textLength = s => Array.from(s).length;
export function clampInt(v, max = NUM_MAX) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.floor(n))) : 0;
}
export const escapeLike = s => String(s).replace(/[\\%_]/g, '\\$&');
export function adminEmails(env) {
  return String((env && env.ADMIN_EMAILS) || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}
// ADMIN_USER_IDS: account ids (u_...), comma-separated; a secret (wrangler secret put ADMIN_USER_IDS), never a [vars] entry.
export function adminIds(env) {
  return String((env && env.ADMIN_USER_IDS) || '').split(',').map(s => s.trim()).filter(Boolean);
}
// Both lists must name the account: its server-side KV user record's id and its email.
export function isAdmin(env, user) {
  const email = String((user && user.email) || '').toLowerCase();
  const id = user && typeof user.id === 'string' ? user.id : '';
  return Boolean(email && id && adminEmails(env).includes(email) && adminIds(env).includes(id));
}
export function giftStatus(g) {
  if (g.acked_at != null) return 'applied';                  // acked wins: the game has applied it
  if (g.revoked_at != null) return 'revoked';
  return g.delivered_at != null ? 'delivered' : 'pending';
}
export const newGiftId = () => 'gft_' + b64u(randomBytes(16));
export const d1Bound = env => Boolean(env && env.DB && typeof env.DB.prepare === 'function');

function requirePlayerId(v) {
  if (typeof v !== 'string' || !PLAYER_RE.test(v)) throw new HttpError(400, 'bad-player', 'playerId must be 8-64 letters, digits, "_" or "-".');
  return v;
}
function giftAmount(v, max, code, label) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) {
    throw new HttpError(400, code, `${label} must be a whole number from 0 to ${max.toLocaleString('en-US')}.`, { max });
  }
  return n;
}
function intParam(url, name, def, min, max) {
  const raw = url.searchParams.get(name);
  const n = raw == null || raw === '' ? def : Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
const withStatus = g => ({ ...g, status: giftStatus(g) });

// ---------------------------------------------------------- routes
// deps: {authenticate, rateLimit, readJsonBody, kv} from index.js (passed in, so there is no import cycle).
export function portAuthority(deps) {
  const { authenticate, rateLimit, readJsonBody, kv } = deps;

  function db(env) {
    if (!d1Bound(env)) throw new HttpError(500, 'config', 'The DB (D1) database is not bound. Check wrangler.toml and apply the migrations.');
    return env.DB;
  }

  // Admin auth: Bearer validated exactly like /me, then isAdmin (the KV user's id in ADMIN_USER_IDS and its email in
  // ADMIN_EMAILS). The token is checked first, so a valid admin always gets in, whatever else shares the IP (phones
  // sit behind carrier-grade NAT). An admin's calls count against `admin`, keyed by the account. Only failures that
  // presented a well-formed Bearer token count against `adminAuth` per IP; once that is full, such failures answer
  // 429 for the rest of the window. A call with no token is never a guessing attempt and costs no KV write.
  async function requireAdmin(request, env, ctx) {
    const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
    const presented = Boolean(m && TOKEN_RE.test(m[1]));
    let user;
    try {
      ({ user } = await authenticate(request, env, ctx));
      if (!isAdmin(env, user)) throw new HttpError(403, 'not-admin', 'This account is not a Port Authority admin.');
    } catch (err) {
      if (presented && err instanceof HttpError && (err.status === 401 || err.status === 403)) await countAdminFailure(env, ctx);
      throw err;
    }
    await rateLimit(env, ctx, 'admin', `u:${user.id}`);
    return String(user.email).toLowerCase();
  }
  async function countAdminFailure(env, ctx) {
    const L = LIMITS.adminAuth, now = ctx.now();
    const rec = await kv(env).get(`rl:adminAuth:${ctx.ip}`, 'json');
    if (rec && rec.resetAt > now && rec.count >= L.max) {
      const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      throw new HttpError(429, 'rate-limited', 'Too many failed sign-ins. Try again later.', { retryAfter }, { 'retry-after': String(retryAfter) });
    }
    await rateLimit(env, ctx, 'adminAuth');
  }

  // ---------------------------------------------------------- POST /presence
  async function presence(request, url, env, ctx) {
    const body = await readJsonBody(request);
    const playerId = requirePlayerId(body.playerId);
    const hasSummary = Boolean(body.summary && typeof body.summary === 'object' && !Array.isArray(body.summary));
    const s = hasSummary ? body.summary : {};
    const platform = body.platform === 'phone' || body.platform === 'desktop' ? body.platform : '';
    const version = typeof body.version === 'string' ? cleanText(body.version, VERSION_MAX) : '';
    const station = cleanText(s.name, NAME_MAX);
    const d = db(env);
    await rateLimit(env, ctx, 'presence');
    let user = null;
    if (request.headers.get('Authorization')) {
      try { user = (await authenticate(request, env, ctx)).user; }
      catch (err) { if (!(err instanceof HttpError) || err.status !== 401) throw err; }   // an invalid token is ignored
    }
    const now = ctx.now();
    const open = 'player_id = ? AND acked_at IS NULL AND revoked_at IS NULL';
    const [, pending] = await d.batch([
      d.prepare(`INSERT INTO players (player_id, user_id, email, station, day, level, rank, credits, am, sectors, platform, version, first_seen, last_seen, sessions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(player_id) DO UPDATE SET
          user_id = COALESCE(excluded.user_id, players.user_id),
          email = COALESCE(excluded.email, players.email),
          ${hasSummary ? SUMMARY_SET : ''}
          platform = excluded.platform, version = excluded.version,
          sessions = players.sessions + CASE WHEN excluded.last_seen - players.last_seen > ? THEN 1 ELSE 0 END,
          last_seen = MAX(players.last_seen, excluded.last_seen)`)
        .bind(playerId, user ? user.id : null, user ? String(user.email).toLowerCase() : null, station,
          clampInt(s.day), clampInt(s.level), clampInt(s.rank), clampInt(s.credits), clampInt(s.am), clampInt(s.sectors),
          platform, version, now, now, SESSION_GAP_MS),
      d.prepare(`SELECT id, credits, am, note, created_at FROM gifts WHERE ${open} ORDER BY created_at, id LIMIT ?`)
        .bind(playerId, PRESENCE_GIFTS_MAX),
      d.prepare(`UPDATE gifts SET delivered_at = ? WHERE delivered_at IS NULL AND id IN (SELECT id FROM gifts WHERE ${open} ORDER BY created_at, id LIMIT ?)`)
        .bind(now, playerId, PRESENCE_GIFTS_MAX),
    ]);
    const gifts = (pending.results || []).map(g => ({ id: g.id, credits: g.credits, am: g.am, note: g.note, createdAt: g.created_at }));
    return { data: { ok: true, gifts } };
  }

  // ---------------------------------------------------------- POST /gifts/ack
  // Only gifts of this player, only once. A gift revoked after it reached the game can still be acked: the game
  // applied it, and acked_at records that truthfully (status 'applied').
  async function giftsAck(request, url, env, ctx) {
    const body = await readJsonBody(request);
    const playerId = requirePlayerId(body.playerId);
    if (!Array.isArray(body.ids)) throw new HttpError(400, 'bad-ids', 'ids must be an array of gift ids.');
    const ids = [...new Set(body.ids.filter(id => typeof id === 'string' && GIFT_RE.test(id)))].slice(0, ACK_IDS_MAX);
    const d = db(env);
    await rateLimit(env, ctx, 'giftsAck');
    if (!ids.length) return { data: { ok: true, acked: [] } };
    const now = ctx.now();
    const r = await d.prepare(`UPDATE gifts SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?)
      WHERE player_id = ? AND acked_at IS NULL AND id IN (${ids.map(() => '?').join(', ')}) RETURNING id`)
      .bind(now, now, playerId, ...ids).all();
    return { data: { ok: true, acked: (r.results || []).map(x => x.id) } };
  }

  // ---------------------------------------------------------- GET /admin/stats
  async function adminStats(request, url, env, ctx) {
    await requireAdmin(request, env, ctx);
    const d = db(env), now = ctx.now();
    const [p, g] = await d.batch([
      d.prepare(`SELECT COUNT(*) AS players,
          COALESCE(SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END), 0) AS active24h,
          COALESCE(SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END), 0) AS active7d,
          COALESCE(SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END), 0) AS active30d
        FROM players`).bind(now - ACTIVE['24h'], now - ACTIVE['7d'], now - ACTIVE['30d']),
      d.prepare(`SELECT
          COALESCE(SUM(CASE WHEN acked_at IS NULL AND revoked_at IS NULL AND delivered_at IS NULL THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN acked_at IS NULL AND revoked_at IS NULL AND delivered_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS delivered,
          COALESCE(SUM(CASE WHEN acked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS applied,
          COALESCE(SUM(CASE WHEN acked_at IS NULL AND revoked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS revoked
        FROM gifts`),
    ]);
    const pr = (p.results && p.results[0]) || {}, gr = (g.results && g.results[0]) || {};
    return {
      data: {
        players: pr.players || 0, active24h: pr.active24h || 0, active7d: pr.active7d || 0, active30d: pr.active30d || 0,
        accounts: await countAccounts(env, now),
        giftsPending: gr.pending || 0, giftsDelivered: gr.delivered || 0, giftsApplied: gr.applied || 0, giftsRevoked: gr.revoked || 0,
      },
    };
  }

  // The number of `user:` keys in the ACCOUNTS namespace, cached per isolate for ACCOUNTS_CACHE_MS. null when unknown.
  async function countAccounts(env, now) {
    const ns = env.ACCOUNTS;
    if (!ns || typeof ns.list !== 'function') return null;
    const hit = accountsCache.get(ns);
    if (hit && now - hit.at < ACCOUNTS_CACHE_MS) return hit.n;
    try {
      let n = 0, cursor;
      for (let page = 0; page < 100; page++) {
        const res = await ns.list({ prefix: 'user:', limit: 1000, ...(cursor ? { cursor } : {}) });
        n += (res.keys || []).length;
        if (res.list_complete || !res.cursor) break;
        cursor = res.cursor;
      }
      accountsCache.set(ns, { at: now, n });
      return n;
    } catch (err) {
      console.error('account: could not count accounts', err && err.message);
      return hit ? hit.n : null;
    }
  }

  // ---------------------------------------------------------- GET /admin/players
  async function adminPlayers(request, url, env, ctx) {
    await requireAdmin(request, env, ctx);
    const d = db(env), now = ctx.now();
    const q = cleanText(url.searchParams.get('q') || '', 100);
    const active = ACTIVE[url.searchParams.get('active')] || 0;
    const [col, defDir] = SORTS[url.searchParams.get('sort')] || SORTS.last_seen;
    const dirParam = String(url.searchParams.get('dir') || '').toLowerCase();
    const dir = dirParam === 'asc' ? 'ASC' : dirParam === 'desc' ? 'DESC' : defDir;
    const limit = intParam(url, 'limit', 50, 1, PLAYERS_PAGE_MAX);
    const offset = intParam(url, 'offset', 0, 0, 1e6);
    const where = [], binds = [];
    if (active) { where.push('p.last_seen >= ?'); binds.push(now - active); }
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push("(p.station LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\' OR p.player_id LIKE ? ESCAPE '\\')");
      binds.push(like, like, like);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [count, page] = await d.batch([
      d.prepare(`SELECT COUNT(*) AS n FROM players p ${w}`).bind(...binds),
      d.prepare(`SELECT p.*, (${PENDING_SQL}) AS pendingGifts FROM players p ${w} ORDER BY ${col} ${dir}, p.player_id ${dir} LIMIT ? OFFSET ?`)
        .bind(...binds, limit, offset),
    ]);
    return { data: { total: (count.results && count.results[0] && count.results[0].n) || 0, players: page.results || [] } };
  }

  // ---------------------------------------------------------- GET /admin/players/:playerId
  async function adminPlayer(request, url, env, ctx) {
    await requireAdmin(request, env, ctx);
    const playerId = requirePlayerId(ctx.params[0]);
    const d = db(env);
    const [p, g] = await d.batch([
      d.prepare(`SELECT p.*, (${PENDING_SQL}) AS pendingGifts FROM players p WHERE p.player_id = ?`).bind(playerId),
      d.prepare('SELECT * FROM gifts WHERE player_id = ? ORDER BY created_at DESC, id DESC').bind(playerId),
    ]);
    const player = p.results && p.results[0];
    if (!player) throw new HttpError(404, 'unknown-player', 'No game has reported presence with that player id.');
    const { purchases, available } = await readPurchases(env, playerId);
    return { data: { player, gifts: (g.results || []).map(withStatus), purchases, purchasesAvailable: available } };
  }

  // The store worker's KV: player:{playerId} -> [grantId, ...], grant:{grantId} -> {sku, playerId, at}. Read only.
  async function readPurchases(env, playerId) {
    const store = env.STORE;
    if (!store || typeof store.get !== 'function') return { purchases: [], available: false };
    try {
      const ids = await store.get(`player:${playerId}`, 'json');
      const list = Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string'))].slice(0, 200) : [];
      const grants = await Promise.all(list.map(async grantId => {
        const g = await store.get(`grant:${grantId}`, 'json');
        return g && typeof g === 'object' ? { grantId, sku: String(g.sku || ''), at: g.at == null ? null : g.at } : null;
      }));
      const purchases = grants.filter(Boolean).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      return { purchases, available: true };
    } catch (err) {
      console.error('account: could not read purchases', err && err.message);
      return { purchases: [], available: false };
    }
  }

  // ---------------------------------------------------------- POST /admin/gifts
  async function adminCreateGift(request, url, env, ctx) {
    const admin = await requireAdmin(request, env, ctx);
    const body = await readJsonBody(request);
    const playerId = requirePlayerId(body.playerId);
    const credits = giftAmount(body.credits, GIFT_CREDITS_MAX, 'bad-credits', 'Credits');
    const am = giftAmount(body.am, GIFT_AM_MAX, 'bad-am', 'Antimatter');
    if (credits === 0 && am === 0) throw new HttpError(400, 'empty-gift', 'A gift needs some credits or some Antimatter.');
    if (body.note != null && typeof body.note !== 'string') throw new HttpError(400, 'bad-note', 'The note must be text.');
    const note = cleanText(body.note);
    if (textLength(note) > NOTE_MAX) throw new HttpError(400, 'bad-note', `The note may not exceed ${NOTE_MAX} characters.`, { max: NOTE_MAX });
    const requestId = body.requestId == null || body.requestId === '' ? null : body.requestId;
    if (requestId !== null && (typeof requestId !== 'string' || !REQUEST_RE.test(requestId))) {
      throw new HttpError(400, 'bad-request-id', 'requestId must be 8-64 letters, digits, "_" or "-".');
    }
    const d = db(env);
    const exists = await d.prepare('SELECT player_id FROM players WHERE player_id = ?').bind(playerId).first();
    if (!exists) throw new HttpError(404, 'unknown-player', 'No game has reported presence with that player id.');
    const now = ctx.now(), id = newGiftId();
    // Idempotent on requestId (migration 0002, a unique index): a retry after a lost answer inserts nothing and gets
    // the first gift back. The log row is written only when this call's gift row exists, in the same batch.
    const [ins] = await d.batch([
      d.prepare(`INSERT INTO gifts (id, player_id, credits, am, note, created_at, created_by, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO NOTHING RETURNING *`)
        .bind(id, playerId, credits, am, note, now, admin, requestId),
      d.prepare(`INSERT INTO admin_log (at, admin, action, target, detail) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM gifts WHERE id = ?)`)
        .bind(now, admin, 'gift.create', playerId, JSON.stringify({ giftId: id, credits, am, note }), id),
    ]);
    const made = ins.results && ins.results[0];
    if (made) return { data: { gift: withStatus(made) } };
    const prev = await d.prepare('SELECT * FROM gifts WHERE request_id = ?').bind(requestId).first();
    if (!prev) throw new HttpError(500, 'internal', 'The gift was not stored. Try again.');
    if (prev.player_id !== playerId || prev.credits !== credits || prev.am !== am) {
      throw new HttpError(409, 'request-reused', 'That requestId already belongs to a different gift.', { gift: withStatus(prev) });
    }
    return { data: { gift: withStatus(prev), duplicate: true } };
  }

  // ---------------------------------------------------------- POST /admin/gifts/:id/revoke
  async function adminRevokeGift(request, url, env, ctx) {
    const admin = await requireAdmin(request, env, ctx);
    const id = ctx.params[0];
    if (typeof id !== 'string' || !GIFT_RE.test(id)) throw new HttpError(400, 'bad-gift', 'That is not a gift id.');
    const d = db(env), now = ctx.now();
    // The revoke and its log row commit together (one batch); the INSERT only finds the row this UPDATE just revoked.
    const [upd] = await d.batch([
      d.prepare('UPDATE gifts SET revoked_at = ? WHERE id = ? AND acked_at IS NULL AND revoked_at IS NULL RETURNING *').bind(now, id),
      d.prepare(`INSERT INTO admin_log (at, admin, action, target, detail)
        SELECT ?, ?, 'gift.revoke', id, json_object('playerId', player_id, 'credits', credits, 'am', am,
          'delivered', json(CASE WHEN delivered_at IS NULL THEN 'false' ELSE 'true' END))
        FROM gifts WHERE id = ? AND revoked_at = ? AND acked_at IS NULL`).bind(now, admin, id, now),
    ]);
    const done = upd.results && upd.results[0];
    if (done) return { data: { gift: withStatus(done) } };
    const gift = await d.prepare('SELECT * FROM gifts WHERE id = ?').bind(id).first();
    if (!gift) throw new HttpError(404, 'unknown-gift', 'There is no gift with that id.');
    if (gift.acked_at != null) throw new HttpError(409, 'already-applied', 'The game has already applied this gift; it can no longer be revoked.', { gift: withStatus(gift) });
    return { data: { gift: withStatus(gift) } };                // already revoked: idempotent, not logged again
  }

  // ---------------------------------------------------------- GET /admin/log
  async function adminLog(request, url, env, ctx) {
    await requireAdmin(request, env, ctx);
    const limit = intParam(url, 'limit', 50, 1, LOG_PAGE_MAX);
    const r = await db(env).prepare('SELECT id, at, admin, action, target, detail FROM admin_log ORDER BY id DESC LIMIT ?').bind(limit).all();
    return { data: { entries: r.results || [] } };
  }

  return { presence, giftsAck, adminStats, adminPlayers, adminPlayer, adminCreateGift, adminRevokeGift, adminLog };
}

const accountsCache = new WeakMap();

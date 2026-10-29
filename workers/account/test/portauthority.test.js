// ============================================================
// PORT SOLACE — Port Authority tests (DESIGN2.md A9): presence, gifts and the admin API on the account worker
// Run with `npm test` in workers/account. D1 is real SQLite (node:sqlite, test/d1.js) with the migration applied;
// KV is the same in-memory stub as account.test.js plus list(). Real PBKDF2 for the sign-ups.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import worker, { handle } from '../src/index.js';
import { LIMITS } from '../src/lib.js';
import {
  cleanText, clampInt, escapeLike, adminEmails, adminIds, isAdmin, giftStatus, newGiftId, GIFT_RE, NOTE_MAX, GIFT_CREDITS_MAX, GIFT_AM_MAX, SESSION_GAP_MS,
} from '../src/portauthority.js';
import { d1 } from './d1.js';

const ORIGIN = 'https://portsolace.com';
const PEPPER = 'unit-test-pepper-that-is-long-enough';
const PASSWORD = 'orbital-mechanics-42';
const ADMIN = 'Owner@Example.com';
const PLAYER = 'b3a1c2d4-0000-4000-8000-00000000abcd';
const OTHER = 'player_two_0002';
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);

// ---------------------------------------------------------- stubs
function kvStub(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])), puts = [];
  let lists = 0;
  return {
    map, puts, get lists() { return lists; },
    async get(key, type) { const v = map.has(key) ? map.get(key) : null; return v !== null && type === 'json' ? JSON.parse(v) : v; },
    async put(key, value, opts) { map.set(key, String(value)); puts.push({ key, ttl: opts && opts.expirationTtl }); },
    async delete(key) { map.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      lists++;
      const names = [...map.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const keys = names.slice(start, start + limit).map(name => ({ name }));
      const end = start + keys.length;
      return end < names.length ? { keys, list_complete: false, cursor: String(end) } : { keys, list_complete: true };
    },
  };
}
const makeEnv = (over = {}) => ({
  ACCOUNTS: kvStub(), DB: d1(), STORE: kvStub(), ALLOWED_ORIGIN: ORIGIN, PEPPER,
  ADMIN_EMAILS: ' owner@example.com , Deputy@Example.com,, ', ...over,
});
const req = (path, { method = 'GET', body, headers = {}, origin = ORIGIN, token, ip = '203.0.113.7' } = {}) => new Request(`https://account.portsolace.com${path}`, {
  method,
  headers: { ...(origin ? { Origin: origin } : {}), ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), 'CF-Connecting-IP': ip, ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const read = async res => ({ status: res.status, headers: res.headers, data: await res.json() });
const at = t => ({ now: () => t });
const call = async (env, path, opts = {}, t = T0) => read(await handle(req(path, opts), env, at(t)));
const quiet = async fn => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

async function signup(env, email, t = T0) {
  const r = await call(env, '/signup', { method: 'POST', body: { email, password: PASSWORD }, ip: '198.51.100.' + Math.floor(Math.random() * 200) }, t);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const summary = (over = {}) => ({ name: 'Lantern Reach', day: 40, level: 3, rank: 2, credits: 12345.6, am: 42, sectors: 2, ...over });
const presence = (env, { playerId = PLAYER, t = T0, token, ip, ...over } = {}) =>
  call(env, '/presence', { method: 'POST', token, ip, body: { playerId, summary: summary(), platform: 'desktop', version: '2026.10.29', ...over } }, t);
const row = (env, playerId = PLAYER) => env.DB.sqlite.prepare('SELECT * FROM players WHERE player_id = ?').get(playerId);
const giftRow = (env, id) => ({ ...env.DB.sqlite.prepare('SELECT * FROM gifts WHERE id = ?').get(id) });
const logRows = env => env.DB.sqlite.prepare('SELECT * FROM admin_log ORDER BY id').all().map(r => ({ ...r }));

// ADMIN_USER_IDS is a secret listing account ids; an admin must be on it as well as on ADMIN_EMAILS.
const promote = (env, ...users) => { env.ADMIN_USER_IDS = [...adminIds(env), ...users.map(u => u.id)].join(','); };
async function adminEnv(over = {}) {
  const env = makeEnv(over);
  const { token, user } = await signup(env, ADMIN);
  promote(env, user);
  return { env, token, user };
}
const sendGift = (env, token, body, t = T0) => call(env, '/admin/gifts', { method: 'POST', token, body }, t);

// ============================================================ helpers and schema
describe('Port Authority helpers and schema', () => {
  test('cleanText strips control, zero-width and bidi characters and caps by code point', () => {
    assert.equal(cleanText('  Dust\u0000 Harbour\u202E\n\tNorth\u200B  '), 'Dust Harbour North');
    assert.equal(cleanText(null), '');
    assert.equal(cleanText('x'.repeat(80), 40).length, 40);
    assert.equal(cleanText('\u{10400}'.repeat(50), 40), '\u{10400}'.repeat(40), 'astral characters are not split');
  });

  test('clampInt, escapeLike, adminEmails, giftStatus, gift ids', () => {
    assert.equal(clampInt(-5), 0); assert.equal(clampInt(1e15), 1e12); assert.equal(clampInt(12.9), 12);
    assert.equal(clampInt('x'), 0); assert.equal(clampInt(undefined), 0); assert.equal(clampInt(Infinity), 0); assert.equal(clampInt('7'), 7);
    assert.equal(escapeLike('100%_\\x'), '100\\%\\_\\\\x');
    assert.deepEqual(adminEmails({ ADMIN_EMAILS: ' A@B.co ,, c@d.co ' }), ['a@b.co', 'c@d.co']);
    assert.deepEqual(adminEmails({}), []);
    assert.deepEqual(adminIds({ ADMIN_USER_IDS: ' u_a ,,u_b ' }), ['u_a', 'u_b']); assert.deepEqual(adminIds({}), []);
    const env = { ADMIN_EMAILS: 'a@b.co', ADMIN_USER_IDS: 'u_a' };
    assert.equal(isAdmin(env, { id: 'u_a', email: 'A@B.co' }), true);
    assert.equal(isAdmin(env, { id: 'u_other', email: 'a@b.co' }), false, 'the right email on another account id');
    assert.equal(isAdmin(env, { id: 'u_a', email: 'x@y.co' }), false);
    assert.equal(isAdmin({ ADMIN_EMAILS: 'a@b.co' }, { id: 'u_a', email: 'a@b.co' }), false, 'no ADMIN_USER_IDS admits nobody');
    assert.equal(isAdmin(env, null), false);
    assert.equal(giftStatus({}), 'pending'); assert.equal(giftStatus({ delivered_at: 1 }), 'delivered');
    assert.equal(giftStatus({ delivered_at: 1, acked_at: 2 }), 'applied'); assert.equal(giftStatus({ revoked_at: 3 }), 'revoked');
    assert.equal(giftStatus({ delivered_at: 1, revoked_at: 3, acked_at: 4 }), 'applied', 'acked wins');
    const id = newGiftId();
    assert.match(id, GIFT_RE); assert.equal(id.length, 26); assert.notEqual(newGiftId(), id);
  });

  test('the migration creates the three tables and their indexes', () => {
    const db = d1();
    const names = db.sqlite.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => `${r.type}:${r.name}`);
    assert.deepEqual(names, ['table:admin_log', 'table:gifts', 'index:gifts_player', 'index:gifts_request', 'table:players', 'index:players_last_seen', 'index:players_user']);
    const cols = t => db.sqlite.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    assert.deepEqual(cols('players'), ['player_id', 'user_id', 'email', 'station', 'day', 'level', 'rank', 'credits', 'am', 'sectors', 'platform', 'version', 'first_seen', 'last_seen', 'sessions']);
    assert.deepEqual(cols('gifts'), ['id', 'player_id', 'credits', 'am', 'note', 'created_at', 'created_by', 'delivered_at', 'acked_at', 'revoked_at', 'request_id']);
    assert.deepEqual(cols('admin_log'), ['id', 'at', 'admin', 'action', 'target', 'detail']);
  });
});

// ============================================================ presence
describe('POST /presence', () => {
  test('creates the player row and answers {ok, gifts:[]} with CORS and no-store', async () => {
    const env = makeEnv();
    const res = await handle(req('/presence', { method: 'POST', body: { playerId: PLAYER, summary: summary(), platform: 'phone', version: 'b42' } }), env, at(T0));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: true, gifts: [] });
    assert.deepEqual({ ...row(env) }, {
      player_id: PLAYER, user_id: null, email: null, station: 'Lantern Reach', day: 40, level: 3, rank: 2, credits: 12345, am: 42, sectors: 2,
      platform: 'phone', version: 'b42', first_seen: T0, last_seen: T0, sessions: 1,
    });
  });

  test('the upsert is one INSERT ... ON CONFLICT statement; sessions count only after a 30-minute gap', async () => {
    const env = makeEnv();
    await presence(env);
    const upserts = env.DB.log.filter(s => /INSERT INTO players/.test(s.sql));
    assert.equal(upserts.length, 1);
    assert.match(upserts[0].sql, /ON CONFLICT\(player_id\) DO UPDATE/);
    await presence(env, { t: T0 + 10 * MIN, summary: summary({ day: 41, credits: 50 }) });
    let r = row(env);
    assert.equal(r.sessions, 1, 'ten minutes later is the same session'); assert.equal(r.last_seen, T0 + 10 * MIN);
    assert.equal(r.first_seen, T0); assert.equal(r.day, 41); assert.equal(r.credits, 50);
    await presence(env, { t: T0 + 10 * MIN + SESSION_GAP_MS });
    assert.equal(row(env).sessions, 1, 'exactly 30 minutes is not a new session');
    await presence(env, { t: T0 + 10 * MIN + 2 * SESSION_GAP_MS + 1 });
    r = row(env);
    assert.equal(r.sessions, 2); assert.equal(r.last_seen, T0 + 10 * MIN + 2 * SESSION_GAP_MS + 1);
    await presence(env, { t: T0 + 3 * DAY });
    assert.equal(row(env).sessions, 3);
    await presence(env, { t: T0 + DAY });                                       // a late, out-of-order report
    assert.equal(row(env).last_seen, T0 + 3 * DAY, 'last_seen never goes backwards');
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n, 1);
  });

  test('numbers are clamped integers, the name is cleaned, platform and version are constrained', async () => {
    const env = makeEnv();
    const r = await presence(env, {
      summary: { name: '\u0007<b>Dust</b>\u202E Harbour ' + 'x'.repeat(60), day: -4, level: 'lots', rank: 2.9, credits: 5e15, am: null, sectors: '3' },
      platform: 'toaster', version: 'v1\u0000\n' + 'y'.repeat(80),
    });
    assert.equal(r.status, 200);
    const p = row(env);
    assert.equal(p.station, ('<b>Dust</b> Harbour ' + 'x'.repeat(60)).slice(0, 40), 'stored as text, cleaned and capped; never interpreted');
    assert.equal(p.day, 0); assert.equal(p.level, 0); assert.equal(p.rank, 2); assert.equal(p.credits, 1e12); assert.equal(p.am, 0); assert.equal(p.sectors, 3);
    assert.equal(p.platform, ''); assert.equal(p.version.length, 40); assert.ok(!/[\u0000-\u001f]/.test(p.version));
    const noSummary = await call(env, '/presence', { method: 'POST', body: { playerId: OTHER } });
    assert.equal(noSummary.status, 200);
    assert.equal(row(env, OTHER).station, '');
    await presence(env, { playerId: OTHER, summary: summary({ name: 'Kept Station', level: 6 }) });
    await call(env, '/presence', { method: 'POST', body: { playerId: OTHER, summary: 'junk', platform: 'phone' } }, T0 + MIN);
    const kept = row(env, OTHER);
    assert.equal(kept.station, 'Kept Station', 'a report without a summary keeps the station figures');
    assert.equal(kept.level, 6); assert.equal(kept.platform, 'phone'); assert.equal(kept.last_seen, T0 + MIN);
  });

  test('bad playerId and bad JSON -> 400; nothing is written', async () => {
    const env = makeEnv();
    for (const playerId of [undefined, 'short', 'x'.repeat(65), 'has space in it', "a'; DROP TABLE players;--", 12345678]) {
      const r = await call(env, '/presence', { method: 'POST', body: { playerId, summary: summary() } });
      assert.equal(r.status, 400, String(playerId)); assert.equal(r.data.error, 'bad-player');
    }
    const bad = await call(env, '/presence', { method: 'POST', body: '{nope', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-json');
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
  });

  test('a valid Bearer token links the account; an invalid one is ignored; a later anonymous report keeps the link', async () => {
    const env = makeEnv();
    const { token, user } = await signup(env, 'Pilot@Example.com');
    const junk = await presence(env, { token: 'A'.repeat(43) });
    assert.equal(junk.status, 200, 'an invalid token is never an error');
    assert.equal(row(env).user_id, null);
    const garbage = await call(env, '/presence', { method: 'POST', headers: { Authorization: 'Basic xyz' }, body: { playerId: PLAYER } });
    assert.equal(garbage.status, 200);
    await presence(env, { token, t: T0 + MIN });
    assert.equal(row(env).user_id, user.id); assert.equal(row(env).email, 'pilot@example.com');
    await presence(env, { t: T0 + 2 * MIN });
    assert.equal(row(env).user_id, user.id, 'signing out of the game does not unlink the player');
  });

  test('DB not bound -> 500 config; presence is rate-limited per IP', async () => {
    const noDb = await call(makeEnv({ DB: undefined }), '/presence', { method: 'POST', body: { playerId: PLAYER } });
    assert.equal(noDb.status, 500); assert.equal(noDb.data.error, 'config');
    const env = makeEnv();
    for (let i = 0; i < LIMITS.presence.max; i++) assert.equal((await presence(env, { t: T0 + i })).status, 200);
    const blocked = await presence(env, { t: T0 + 1000 });
    assert.equal(blocked.status, 429); assert.equal(blocked.data.error, 'rate-limited');
    assert.equal((await presence(env, { t: T0 + 1000, ip: '192.0.2.50' })).status, 200, 'another IP is not affected');
    assert.equal((await presence(env, { t: T0 + LIMITS.presence.windowS * 1000 + 1 })).status, 200, 'the window resets');
  });
});

// ============================================================ gifts
describe('the gift lifecycle', () => {
  test('create -> presence delivers -> ack -> no longer delivered; double ack is harmless', async () => {
    const { env, token } = await adminEnv();
    await presence(env);
    const made = await sendGift(env, token, { playerId: PLAYER, credits: 10000, am: 50, note: 'Thanks for flying with us\u0000!' }, T0 + MIN);
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const g = made.data.gift;
    assert.match(g.id, GIFT_RE);
    assert.deepEqual(g, { id: g.id, player_id: PLAYER, credits: 10000, am: 50, note: 'Thanks for flying with us!', created_at: T0 + MIN, created_by: 'owner@example.com', delivered_at: null, acked_at: null, revoked_at: null, request_id: null, status: 'pending' });

    const first = await presence(env, { t: T0 + 5 * MIN });
    assert.deepEqual(first.data, { ok: true, gifts: [{ id: g.id, credits: 10000, am: 50, note: 'Thanks for flying with us!', createdAt: T0 + MIN }] });
    assert.equal(giftRow(env, g.id).delivered_at, T0 + 5 * MIN);
    const again = await presence(env, { t: T0 + 6 * MIN });
    assert.equal(again.data.gifts.length, 1, 'an unacked gift is handed out again');
    assert.equal(giftRow(env, g.id).delivered_at, T0 + 5 * MIN, 'delivered_at keeps the first delivery');

    const ack = await call(env, '/gifts/ack', { method: 'POST', body: { playerId: PLAYER, ids: [g.id, g.id, 'junk', 7] } }, T0 + 7 * MIN);
    assert.deepEqual(ack.data, { ok: true, acked: [g.id] });
    assert.equal(giftRow(env, g.id).acked_at, T0 + 7 * MIN);
    assert.deepEqual((await presence(env, { t: T0 + 20 * MIN })).data.gifts, []);
    const twice = await call(env, '/gifts/ack', { method: 'POST', body: { playerId: PLAYER, ids: [g.id] } }, T0 + 30 * MIN);
    assert.deepEqual(twice.data, { ok: true, acked: [] });
    assert.equal(giftRow(env, g.id).acked_at, T0 + 7 * MIN, 'the second ack changes nothing');
    const detail = await call(env, `/admin/players/${PLAYER}`, { token });
    assert.equal(detail.data.gifts[0].status, 'applied');
    assert.deepEqual(logRows(env).map(r => [r.action, r.target, r.admin]), [['gift.create', PLAYER, 'owner@example.com']]);
    assert.deepEqual(JSON.parse(logRows(env)[0].detail), { giftId: g.id, credits: 10000, am: 50, note: 'Thanks for flying with us!' });
  });

  test('an ack from another player is ignored; ack validation', async () => {
    const { env, token } = await adminEnv();
    await presence(env); await presence(env, { playerId: OTHER });
    const { gift } = (await sendGift(env, token, { playerId: PLAYER, credits: 5 })).data;
    const wrong = await call(env, '/gifts/ack', { method: 'POST', body: { playerId: OTHER, ids: [gift.id] } });
    assert.deepEqual(wrong.data, { ok: true, acked: [] });
    assert.equal(giftRow(env, gift.id).acked_at, null);
    assert.equal((await presence(env)).data.gifts.length, 1, 'still pending for its own player');
    const notArray = await call(env, '/gifts/ack', { method: 'POST', body: { playerId: PLAYER, ids: gift.id } });
    assert.equal(notArray.status, 400); assert.equal(notArray.data.error, 'bad-ids');
    const badPlayer = await call(env, '/gifts/ack', { method: 'POST', body: { playerId: 'x', ids: [gift.id] } });
    assert.equal(badPlayer.status, 400); assert.equal(badPlayer.data.error, 'bad-player');
    const empty = await call(env, '/gifts/ack', { method: 'POST', body: { playerId: PLAYER, ids: [] } });
    assert.deepEqual(empty.data, { ok: true, acked: [] });
  });

  test('revoke before ack: never delivered again; revoke is idempotent and logged once; an applied gift cannot be revoked', async () => {
    const { env, token } = await adminEnv();
    await presence(env);
    const a = (await sendGift(env, token, { playerId: PLAYER, credits: 100 }, T0 + 1)).data.gift;
    const b = (await sendGift(env, token, { playerId: PLAYER, am: 7 }, T0 + 2)).data.gift;
    const rv = await call(env, `/admin/gifts/${a.id}/revoke`, { method: 'POST', token }, T0 + 3);
    assert.equal(rv.status, 200); assert.equal(rv.data.gift.status, 'revoked'); assert.equal(rv.data.gift.revoked_at, T0 + 3);
    assert.deepEqual((await presence(env, { t: T0 + MIN })).data.gifts.map(g => g.id), [b.id]);
    const again = await call(env, `/admin/gifts/${a.id}/revoke`, { method: 'POST', token }, T0 + 4);
    assert.equal(again.status, 200); assert.equal(again.data.gift.revoked_at, T0 + 3);
    assert.equal(logRows(env).filter(r => r.action === 'gift.revoke').length, 1);
    const revLog = logRows(env).find(r => r.action === 'gift.revoke');
    assert.equal(revLog.target, a.id); assert.deepEqual(JSON.parse(revLog.detail), { playerId: PLAYER, credits: 100, am: 0, delivered: false });

    await call(env, '/gifts/ack', { method: 'POST', body: { playerId: PLAYER, ids: [b.id] } }, T0 + 2 * MIN);
    const late = await call(env, `/admin/gifts/${b.id}/revoke`, { method: 'POST', token }, T0 + 3 * MIN);
    assert.equal(late.status, 409); assert.equal(late.data.error, 'already-applied'); assert.equal(late.data.gift.status, 'applied');
    assert.equal(giftRow(env, b.id).revoked_at, null);
    const unknown = await call(env, `/admin/gifts/gft_${'A'.repeat(22)}/revoke`, { method: 'POST', token });
    assert.equal(unknown.status, 404); assert.equal(unknown.data.error, 'unknown-gift');
    const bad = await call(env, '/admin/gifts/not-a-gift/revoke', { method: 'POST', token });
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-gift');
  });

  test('a gift revoked after it reached the game but before the ack is recorded as applied when the ack comes', async () => {
    const { env, token } = await adminEnv();
    await presence(env);
    const g = (await sendGift(env, token, { playerId: PLAYER, credits: 9 })).data.gift;
    await presence(env, { t: T0 + MIN });                       // delivered; the ack is lost (offline)
    await call(env, `/admin/gifts/${g.id}/revoke`, { method: 'POST', token }, T0 + 2 * MIN);
    assert.deepEqual((await presence(env, { t: T0 + 3 * MIN })).data.gifts, []);
    const ack = await call(env, '/gifts/ack', { method: 'POST', body: { playerId: PLAYER, ids: [g.id] } }, T0 + 4 * MIN);
    assert.deepEqual(ack.data.acked, [g.id]);
    assert.equal(giftStatus(giftRow(env, g.id)), 'applied');
  });

  test('POST /admin/gifts is idempotent on requestId: a retry returns the first gift and logs once', async () => {
    const { env, token } = await adminEnv();
    await presence(env); await presence(env, { playerId: OTHER });
    const rid = '3f2b8c1e-9d4a-4e6b-8f00-1234567890ab';
    const a = await sendGift(env, token, { playerId: PLAYER, credits: 500, am: 5, note: 'once', requestId: rid }, T0 + 1);
    assert.equal(a.status, 200); assert.equal(a.data.gift.request_id, rid); assert.equal(a.data.duplicate, undefined);
    const b = await sendGift(env, token, { playerId: PLAYER, credits: 500, am: 5, note: 'once', requestId: rid }, T0 + 2);
    assert.equal(b.status, 200); assert.equal(b.data.gift.id, a.data.gift.id); assert.equal(b.data.duplicate, true);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM gifts').get().n, 1, 'one gift, not two');
    assert.equal(logRows(env).filter(r => r.action === 'gift.create').length, 1, 'logged once');
    const other = await sendGift(env, token, { playerId: OTHER, credits: 500, requestId: rid });
    assert.equal(other.status, 409); assert.equal(other.data.error, 'request-reused');
    const bad = await sendGift(env, token, { playerId: PLAYER, credits: 1, requestId: 'x y' });
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-request-id');
    const c = await sendGift(env, token, { playerId: PLAYER, credits: 1 });
    const d = await sendGift(env, token, { playerId: PLAYER, credits: 1 });
    assert.notEqual(c.data.gift.id, d.data.gift.id, 'without a requestId every call is a new gift');
    assert.equal(logRows(env).filter(r => r.action === 'gift.create').length, 3);
  });

  test('revoke writes its log row in the same batch as the update', async () => {
    const { env, token } = await adminEnv();
    await presence(env);
    const g = (await sendGift(env, token, { playerId: PLAYER, credits: 3 })).data.gift;
    const before = env.DB.log.length;
    assert.equal((await call(env, `/admin/gifts/${g.id}/revoke`, { method: 'POST', token }, T0 + 5)).status, 200);
    const stmts = env.DB.log.slice(before).map(x => x.sql);
    assert.ok(stmts.some(q => /UPDATE gifts SET revoked_at/.test(q)) && stmts.some(q => /INSERT INTO admin_log/.test(q)));
    const failing = makeEnv({ DB: d1({ failBatch: true }), ACCOUNTS: env.ACCOUNTS, ADMIN_USER_IDS: env.ADMIN_USER_IDS });
    failing.DB.sqlite.prepare("INSERT INTO players (player_id, first_seen, last_seen) VALUES (?, 1, 1)").run(PLAYER);
    failing.DB.sqlite.prepare("INSERT INTO gifts (id, player_id, credits, created_at, created_by) VALUES (?, ?, 1, 1, 'x')").run(g.id, PLAYER);
    const r = await quiet(() => call(failing, `/admin/gifts/${g.id}/revoke`, { method: 'POST', token }));
    assert.equal(r.status, 500);
    assert.equal(giftRow(failing, g.id).revoked_at, null, 'nothing revoked without its log row');
  });

  test('validation and caps on POST /admin/gifts', async () => {
    const { env, token } = await adminEnv();
    await presence(env);
    const cases = [
      [{ playerId: 'nope', credits: 1 }, 400, 'bad-player'],
      [{ playerId: PLAYER, credits: -1 }, 400, 'bad-credits'],
      [{ playerId: PLAYER, credits: GIFT_CREDITS_MAX + 1 }, 400, 'bad-credits'],
      [{ playerId: PLAYER, credits: 1e300 }, 400, 'bad-credits'],
      [{ playerId: PLAYER, credits: 1.5 }, 400, 'bad-credits'],
      [{ playerId: PLAYER, credits: 'lots' }, 400, 'bad-credits'],
      [{ playerId: PLAYER, am: GIFT_AM_MAX + 1 }, 400, 'bad-am'],
      [{ playerId: PLAYER, am: -50 }, 400, 'bad-am'],
      [{ playerId: PLAYER, credits: 0, am: 0 }, 400, 'empty-gift'],
      [{ playerId: PLAYER }, 400, 'empty-gift'],
      [{ playerId: PLAYER, credits: 1, note: 'n'.repeat(NOTE_MAX + 1) }, 400, 'bad-note'],
      [{ playerId: PLAYER, credits: 1, note: { html: '<b>' } }, 400, 'bad-note'],
      [{ playerId: OTHER, credits: 1 }, 404, 'unknown-player'],
    ];
    for (const [body, status, error] of cases) {
      const r = await sendGift(env, token, body);
      assert.equal(r.status, status, JSON.stringify(body)); assert.equal(r.data.error, error, JSON.stringify(body));
    }
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM gifts').get().n, 0);
    assert.equal(logRows(env).length, 0, 'refused gifts are not logged');
    const max = await sendGift(env, token, { playerId: PLAYER, credits: GIFT_CREDITS_MAX, am: GIFT_AM_MAX, note: 'n'.repeat(NOTE_MAX) });
    assert.equal(max.status, 200); assert.equal(max.data.gift.note.length, NOTE_MAX);
    const strings = await sendGift(env, token, { playerId: PLAYER, credits: '2500', am: '' });
    assert.equal(strings.status, 200); assert.equal(strings.data.gift.credits, 2500); assert.equal(strings.data.gift.am, 0);
  });
});

// ============================================================ admin auth
describe('admin auth', () => {
  const routes = [['GET', '/admin/stats'], ['GET', '/admin/players'], ['GET', `/admin/players/${PLAYER}`], ['POST', '/admin/gifts'], ['POST', `/admin/gifts/gft_${'A'.repeat(22)}/revoke`], ['GET', '/admin/log']];

  test('no token -> 401, a bad token -> 401, a non-admin account -> 403 not-admin, an admin -> 200', async () => {
    const { env, token } = await adminEnv();
    const plain = await signup(env, 'player@example.com');
    const deputy = await signup(env, 'deputy@example.com');
    promote(env, deputy.user);
    for (const [method, path] of routes) {
      const body = method === 'POST' ? {} : undefined;
      const none = await call(env, path, { method, body, ip: '192.0.2.1' });
      assert.equal(none.status, 401, `${method} ${path}`); assert.equal(none.data.error, 'unauthorised');
      const forged = await call(env, path, { method, body, token: 'B'.repeat(43), ip: '192.0.2.2' });
      assert.equal(forged.status, 401, `${method} ${path}`);
      const nope = await call(env, path, { method, body, token: plain.token, ip: '192.0.2.3' });
      assert.equal(nope.status, 403, `${method} ${path}`); assert.equal(nope.data.error, 'not-admin');
      assert.equal(nope.data.message, 'This account is not a Port Authority admin.');
    }
    assert.equal((await call(env, '/admin/stats', { token })).status, 200);
    assert.equal((await call(env, '/admin/stats', { token: deputy.token })).status, 200, 'a second listed admin');
    assert.equal((await call(makeEnv({ ACCOUNTS: env.ACCOUNTS, ADMIN_EMAILS: '', ADMIN_USER_IDS: env.ADMIN_USER_IDS }), '/admin/stats', { token })).status, 403, 'an empty email list admits nobody');
    assert.equal((await call(makeEnv({ ACCOUNTS: env.ACCOUNTS }), '/admin/stats', { token })).status, 403, 'no ADMIN_USER_IDS admits nobody');
  });

  test('an admin email alone is not enough: a later account with that address (signup does not verify emails) is refused', async () => {
    const { env, token, user } = await adminEnv();
    const del = await call(env, '/account', { method: 'DELETE', token, body: { password: PASSWORD } });   // the owner deletes the account
    assert.equal(del.status, 200);
    const squatter = await signup(env, ' Owner@Example.COM ');                                         // someone signs up with the address
    assert.notEqual(squatter.user.id, user.id);
    assert.equal(squatter.user.email, 'owner@example.com', 'the email is on ADMIN_EMAILS');
    const r = await call(env, '/admin/stats', { token: squatter.token });
    assert.equal(r.status, 403); assert.equal(r.data.error, 'not-admin');
    await presence(env);
    const g = await sendGift(env, squatter.token, { playerId: PLAYER, credits: GIFT_CREDITS_MAX });
    assert.equal(g.status, 403);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM gifts').get().n, 0);
  });

  test('failed admin calls with a token are capped per IP; calls without one are not counted; a valid admin is never blocked', async () => {
    const { env, token, user } = await adminEnv();
    const ip = '192.0.2.99', forged = 'C'.repeat(43);
    for (let i = 0; i < 3 * LIMITS.adminAuth.max; i++) assert.equal((await call(env, '/admin/stats', { ip }, T0 + i)).status, 401, 'no token: a plain 401');
    assert.equal(env.ACCOUNTS.map.has(`rl:adminAuth:${ip}`), false, 'a call without a token costs no KV write');
    assert.equal((await call(env, '/admin/stats', { ip, token }, T0 + 50)).status, 200);
    for (let i = 0; i < LIMITS.adminAuth.max; i++) assert.equal((await call(env, '/admin/stats', { ip, token: forged }, T0 + 100 + i)).status, 401);
    const blocked = await call(env, '/admin/stats', { ip, token: forged }, T0 + 200);
    assert.equal(blocked.status, 429); assert.ok(blocked.data.retryAfter > 0);
    assert.equal((await call(env, '/admin/stats', { ip, token }, T0 + 300)).status, 200, 'the admin on the same (NAT) IP still gets in');
    const plain = await signup(env, 'nat-neighbour@example.com');
    assert.equal((await call(env, '/admin/stats', { ip, token: plain.token }, T0 + 400)).status, 429, 'a non-admin token from the blocked IP');
    assert.equal((await call(env, '/admin/stats', { ip, token: forged }, T0 + LIMITS.adminAuth.windowS * 1000 + 1000)).status, 401, 'the window resets');
    assert.ok(env.ACCOUNTS.map.has(`rl:admin:u:${user.id}`), "an admin's calls count against the general admin bucket, per account");
    assert.equal(env.ACCOUNTS.map.has(`rl:admin:${ip}`), false);
  });
});

// ============================================================ admin reads
describe('admin reads: stats, players, player detail, log', () => {
  async function seeded() {
    const { env, token } = await adminEnv();
    const pilot = await signup(env, 'pilot@example.com');
    await presence(env, { playerId: 'p_percent_01', summary: summary({ name: '100% Pure', level: 9, credits: 10, am: 1 }), t: T0 - 2 * DAY });
    await presence(env, { playerId: 'p_under_0002', summary: summary({ name: 'Under_score', level: 2, credits: 500, am: 300 }), t: T0 - 10 * DAY });
    await presence(env, { playerId: 'p_plain_0003', summary: summary({ name: 'Plain Station', level: 5, credits: 99 }), t: T0 - HOUR, token: pilot.token, platform: 'phone' });
    await presence(env, { playerId: 'p_old_000004', summary: summary({ name: 'Old Harbour', level: 1, credits: 7 }), t: T0 - 40 * DAY });
    return { env, token, pilot };
  }
  const list = async (env, token, qs) => (await call(env, `/admin/players${qs ? '?' + qs : ''}`, { token })).data;

  test('players: activity filters, sort, paging, total and pendingGifts', async () => {
    const { env, token } = await seeded();
    let r = await list(env, token, '');
    assert.equal(r.total, 4);
    assert.deepEqual(r.players.map(p => p.player_id), ['p_plain_0003', 'p_percent_01', 'p_under_0002', 'p_old_000004'], 'default: last_seen newest first');
    assert.deepEqual(Object.keys(r.players[0]).sort(), ['am', 'credits', 'day', 'email', 'first_seen', 'last_seen', 'level', 'pendingGifts', 'platform', 'player_id', 'rank', 'sectors', 'sessions', 'station', 'user_id', 'version']);
    assert.equal(r.players[0].email, 'pilot@example.com'); assert.equal(r.players[0].platform, 'phone');
    assert.equal((await list(env, token, 'active=24h')).total, 1);
    assert.equal((await list(env, token, 'active=7d')).total, 2);
    assert.equal((await list(env, token, 'active=30d')).total, 3);
    assert.equal((await list(env, token, 'active=all')).total, 4);
    assert.equal((await list(env, token, 'active=bogus')).total, 4);
    assert.deepEqual((await list(env, token, 'sort=level')).players.map(p => p.level), [9, 5, 2, 1]);
    assert.deepEqual((await list(env, token, 'sort=credits&dir=asc')).players.map(p => p.credits), [7, 10, 99, 500]);
    assert.deepEqual((await list(env, token, 'sort=am')).players[0].player_id, 'p_under_0002');
    assert.deepEqual((await list(env, token, 'sort=first_seen')).players[0].player_id, 'p_plain_0003');
    assert.deepEqual((await list(env, token, 'sort=station')).players.map(p => p.station), ['100% Pure', 'Old Harbour', 'Plain Station', 'Under_score']);
    assert.deepEqual((await list(env, token, 'sort=level; DROP TABLE players')).players.length, 4, 'an unknown sort falls back, never reaches SQL');
    const page = await list(env, token, 'sort=level&limit=2&offset=2');
    assert.equal(page.total, 4); assert.deepEqual(page.players.map(p => p.level), [2, 1]);
    assert.equal((await list(env, token, 'limit=0')).players.length, 1, 'limit is clamped to at least 1');
    await sendGift(env, token, { playerId: 'p_under_0002', credits: 1 });
    await sendGift(env, token, { playerId: 'p_under_0002', am: 1 });
    const pg = (await list(env, token, 'sort=am')).players[0];
    assert.equal(pg.pendingGifts, 2);
  });

  test('q matches station, email or player id; LIKE wildcards in q are escaped', async () => {
    const { env, token } = await seeded();
    const ids = async q => (await list(env, token, `q=${encodeURIComponent(q)}`)).players.map(p => p.player_id).sort();
    assert.deepEqual(await ids('%'), ['p_percent_01'], '% is a literal percent sign');
    assert.deepEqual(await ids('_'), ['p_old_000004', 'p_percent_01', 'p_plain_0003', 'p_under_0002'], 'every id has a literal underscore');
    assert.deepEqual(await ids('r_s'), ['p_under_0002'], '_ is a literal underscore, not "any character"');
    assert.deepEqual(await ids('00% p'), ['p_percent_01']);
    assert.deepEqual(await ids('harbour'), ['p_old_000004'], 'case-insensitive');
    assert.deepEqual(await ids('PILOT@'), ['p_plain_0003'], 'email');
    assert.deepEqual(await ids('under_0'), ['p_under_0002'], 'player id');
    assert.deepEqual(await ids("' OR 1=1 --"), []);
    assert.deepEqual(await ids('\\'), []);
    const searches = env.DB.log.filter(s => /LIKE/.test(s.sql));
    assert.ok(searches.length && searches.every(s => /ESCAPE '\\'/.test(s.sql) && !s.sql.includes('harbour')), 'q only ever travels as a bound parameter');
  });

  test('player detail: the row, gifts newest first with status, purchases from the store KV', async () => {
    const { env, token } = await seeded();
    env.STORE.map.set('player:p_plain_0003', JSON.stringify(['cs_live_aaaaaaaa1', 'cs_live_bbbbbbbb2', 'cs_live_aaaaaaaa1', 'cs_live_missing00']));
    env.STORE.map.set('grant:cs_live_aaaaaaaa1', JSON.stringify({ sku: 'am_small', playerId: 'p_plain_0003', at: '2026-10-01T10:00:00.000Z' }));
    env.STORE.map.set('grant:cs_live_bbbbbbbb2', JSON.stringify({ sku: 'supporter', playerId: 'p_plain_0003', at: '2026-10-20T10:00:00.000Z' }));
    const g1 = (await sendGift(env, token, { playerId: 'p_plain_0003', credits: 1 }, T0 + 1)).data.gift;
    const g2 = (await sendGift(env, token, { playerId: 'p_plain_0003', am: 2 }, T0 + 2)).data.gift;
    await presence(env, { playerId: 'p_plain_0003', t: T0 + 3 });
    const d = (await call(env, '/admin/players/p_plain_0003', { token })).data;
    assert.equal(d.player.player_id, 'p_plain_0003'); assert.equal(d.player.email, 'pilot@example.com'); assert.equal(d.player.pendingGifts, 2);
    assert.deepEqual(d.gifts.map(g => [g.id, g.status]), [[g2.id, 'delivered'], [g1.id, 'delivered']]);
    assert.deepEqual(d.purchases, [
      { grantId: 'cs_live_bbbbbbbb2', sku: 'supporter', at: '2026-10-20T10:00:00.000Z' },
      { grantId: 'cs_live_aaaaaaaa1', sku: 'am_small', at: '2026-10-01T10:00:00.000Z' },
    ]);
    assert.equal(d.purchasesAvailable, true);
    assert.equal(env.STORE.puts.length, 0, 'the store namespace is only read');
    const none = (await call(env, '/admin/players/p_percent_01', { token })).data;
    assert.deepEqual(none.purchases, []); assert.deepEqual(none.gifts, []);
    const unbound = (await call({ ...env, STORE: undefined }, '/admin/players/p_percent_01', { token })).data;
    assert.deepEqual(unbound.purchases, []); assert.equal(unbound.purchasesAvailable, false);
    const unknown = await call(env, '/admin/players/p_nobody_0009', { token });
    assert.equal(unknown.status, 404); assert.equal(unknown.data.error, 'unknown-player');
    const bad = await call(env, '/admin/players/bad%20id', { token });
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'bad-player');
  });

  test('stats: players, activity, accounts from the KV list (cached), gift counts by status', async () => {
    const { env, token } = await seeded();
    await presence(env, { playerId: 'p_new_000005', t: T0 - 6 * DAY });
    const a = (await sendGift(env, token, { playerId: 'p_plain_0003', credits: 1 })).data.gift;
    const b = (await sendGift(env, token, { playerId: 'p_plain_0003', credits: 2 })).data.gift;
    const c = (await sendGift(env, token, { playerId: 'p_old_000004', credits: 3 })).data.gift;
    await sendGift(env, token, { playerId: 'p_old_000004', credits: 4 });
    await presence(env, { playerId: 'p_plain_0003', t: T0 });
    await call(env, '/gifts/ack', { method: 'POST', body: { playerId: 'p_plain_0003', ids: [a.id] } });
    await call(env, `/admin/gifts/${c.id}/revoke`, { method: 'POST', token });
    assert.ok(b);
    const s = (await call(env, '/admin/stats', { token })).data;
    assert.deepEqual(s, { players: 5, active24h: 1, active7d: 3, active30d: 4, accounts: 2, giftsPending: 1, giftsDelivered: 1, giftsApplied: 1, giftsRevoked: 1 });
    const lists = env.ACCOUNTS.lists;
    await signup(env, 'third@example.com');
    assert.equal((await call(env, '/admin/stats', { token }, T0 + MIN)).data.accounts, 2, 'cached for a few minutes');
    assert.equal(env.ACCOUNTS.lists, lists);
    assert.equal((await call(env, '/admin/stats', { token }, T0 + 10 * MIN)).data.accounts, 3);
  });

  test('accounts are counted across KV list pages; a failing list gives null, not an error', async () => {
    const seed = {};
    for (let i = 0; i < 2345; i++) seed[`user:u${i}@example.com`] = '{}';
    seed['save:x'] = '{}';
    const env = makeEnv({ ACCOUNTS: kvStub(seed) });
    const { token, user } = await signup(env, ADMIN);
    promote(env, user);
    assert.equal((await call(env, '/admin/stats', { token })).data.accounts, 2346);
    const env2 = makeEnv();
    const s2 = await signup(env2, ADMIN);
    promote(env2, s2.user);
    const t2 = s2.token;
    env2.ACCOUNTS.list = async () => { throw new Error('KV list limit exceeded'); };
    const r = await quiet(() => call(env2, '/admin/stats', { token: t2 }));
    assert.equal(r.status, 200); assert.equal(r.data.accounts, null);
  });

  test('log: newest first, limited', async () => {
    const { env, token } = await seeded();
    for (let i = 1; i <= 3; i++) await sendGift(env, token, { playerId: 'p_plain_0003', credits: i }, T0 + i);
    const all = (await call(env, '/admin/log', { token })).data.entries;
    assert.equal(all.length, 3);
    assert.deepEqual(all.map(e => JSON.parse(e.detail).credits), [3, 2, 1]);
    assert.deepEqual(Object.keys(all[0]).sort(), ['action', 'admin', 'at', 'detail', 'id', 'target']);
    assert.equal(all[0].admin, 'owner@example.com'); assert.equal(all[0].at, T0 + 3);
    assert.equal((await call(env, '/admin/log?limit=1', { token })).data.entries.length, 1);
    assert.equal((await call(env, '/admin/log?limit=nope', { token })).data.entries.length, 3);
  });
});

// ============================================================ routing and health
describe('routing, CORS and /health', () => {
  test('/health reports presence, D1, the admin count and the store binding, never the emails', async () => {
    const env = makeEnv();
    const { status, data } = await read(await worker.fetch(req('/health'), env));
    assert.equal(status, 200);
    assert.equal(data.presence, true); assert.equal(data.d1, true); assert.equal(data.admins, 2); assert.equal(data.storeKv, true);
    assert.equal(data.adminIds, 0);
    const withIds = (await read(await handle(req('/health'), makeEnv({ ADMIN_USER_IDS: 'u_secretid1,u_secretid2' })))).data;
    assert.equal(withIds.adminIds, 2); assert.equal(/u_secretid/.test(JSON.stringify(withIds)), false, 'never the ids');
    assert.equal(data.limits.presence.max, 120); assert.equal(data.limits.admin.max, 300);
    assert.equal(/example\.com/i.test(JSON.stringify(data)), false);
    const bare = (await read(await handle(req('/health'), makeEnv({ DB: undefined, STORE: undefined, ADMIN_EMAILS: undefined })))).data;
    assert.equal(bare.d1, false); assert.equal(bare.admins, 0); assert.equal(bare.storeKv, false); assert.equal(bare.presence, true);
  });

  test('parameter routes, 404s and 405s; preflight and CORS on the new routes', async () => {
    const { env, token } = await adminEnv();
    const pre = await handle(req(`/admin/gifts/gft_${'A'.repeat(22)}/revoke`, { method: 'OPTIONS' }), env);
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization/i);
    const evil = await handle(req('/presence', { method: 'POST', origin: 'https://evil.example', body: { playerId: PLAYER } }), env, at(T0));
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const err = await handle(req('/admin/stats'), env, at(T0));
    assert.equal(err.status, 401); assert.equal(err.headers.get('access-control-allow-origin'), ORIGIN, 'errors carry CORS too');
    for (const path of ['/admin/players/a/b', '/admin/gifts/gft_x', '/admin/gifts/x/revoke/more', '/admin', '/gifts']) {
      assert.equal((await call(env, path, { token })).status, 404, path);
    }
    assert.equal((await call(env, '/admin/players/', { token })).status, 200, 'a trailing slash is the list');
    const m1 = await call(env, '/presence');
    assert.equal(m1.status, 405); assert.deepEqual(m1.data.allow, ['POST']);
    const m2 = await call(env, `/admin/players/${PLAYER}`, { method: 'POST', token, body: {} });
    assert.equal(m2.status, 405); assert.deepEqual(m2.data.allow, ['GET']);
    const m3 = await call(env, `/admin/gifts/gft_${'A'.repeat(22)}/revoke`, { token });
    assert.equal(m3.status, 405);
    assert.equal((await call(env, '/me', { token })).status, 200, 'the old routes still work');
    assert.equal((await call(env, '/constructor')).status, 404);
  });
});

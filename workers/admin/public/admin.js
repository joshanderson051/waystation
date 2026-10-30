// ============================================================
// PORT SOLACE — Port Authority: the owner's player portal (DESIGN2.md Addendum A9)
// Classic script, vanilla JS, no dependencies. Served by workers/admin at https://admin.portsolace.com/, which only
// hands this page out after sign-in (login.html) and keeps the session in an HttpOnly cookie this script never sees.
// Every call goes to this origin; the worker adds the admin's Bearer token and proxies /api/admin/* to the account
// worker (workers/account) at /admin/*:
//   GET  /api/session                                       the signed-in email (top rail)
//   GET  /api/admin/stats                                   overview tiles
//   GET  /api/admin/players?q=&active=&sort=&limit=&offset= players table
//   GET  /api/admin/players/:playerId                       the player panel
//   POST /api/admin/gifts {playerId, credits, am, note, requestId}   Send a gift
//   POST /api/admin/gifts/:id/revoke                        Revoke
//   GET  /api/admin/log?limit=50                            admin log tab
//   POST /logout                                            Sign out (the worker revokes the token and clears the cookie)
// 401 anywhere -> /login ("Your sign-in expired"); 403 not-admin -> /login ("This account is not a Port Authority admin.").
// Framing is refused by the worker (frame-ancestors 'none', X-Frame-Options DENY).
//
// Every string that came from a player or the server (station names, notes, emails, ids, messages) is rendered
// through textContent (the h() helper below never parses HTML). No innerHTML anywhere.
// ============================================================
'use strict';

(() => {
  const API = '/api';                       // same origin; workers/admin proxies /api/admin/* to the account worker
  const LOGIN = '/login';
  const PAGE = 50;
  const REFRESH_MS = 60000;
  const TIMEOUT_MS = 15000;
  const SEARCH_DEBOUNCE_MS = 300;
  const MODAL_SETTLE_MS = 400;              // the confirmation box's 280 ms reveal plus slack (backdrop clicks ignored)
  const ONLINE_MS = 12 * 60000;             // presence comes every 10 minutes while a game is visible
  const MAX_CREDITS = 10000000, MAX_AM = 100000, NOTE_MAX = 140;
  const PLAYER_RE = /^[A-Za-z0-9_-]{8,64}$/;
  // sort key -> the worker's default direction (the worker sorts text ascending, numbers and dates descending)
  const SORT_DEFAULT = { last_seen: 'desc', first_seen: 'desc', level: 'desc', credits: 'desc', am: 'desc', rank: 'desc', station: 'asc', email: 'asc', platform: 'asc' };
  const SORTS = Object.keys(SORT_DEFAULT);
  const ACTIVE = ['all', '24h', '7d', '30d'];
  const DELIVERY_LINE = "Delivered the next time this player's game checks in (within 10 minutes while they are playing).";
  const NOT_ADMIN = 'This account is not a Port Authority admin.';

  const ICON = {
    credits: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z M15 9.5a3.5 3.5 0 1 0 0 5',
    am: 'M4.21 16.5A9 3.5 -30 1 0 19.79 7.5A9 3.5 -30 1 0 4.21 16.5Z M4.21 7.5A9 3.5 30 1 0 19.79 16.5A9 3.5 30 1 0 4.21 7.5Z M13.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z',
    phone: 'M8 2.75h8a1 1 0 0 1 1 1v16.5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1Z M11 18.25h2',
    desktop: 'M3.5 4.5h17v11h-17Z M9 19.5h6 M12 15.5v4',
    unknown: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z M12 16.25v.5 M9.75 9.5a2.25 2.25 0 1 1 3.4 1.95c-.7.4-1.15.9-1.15 1.8',
    gift: 'M4 10.5h16v9.5H4Z M3 7h18v3.5H3Z M12 7v13 M12 7C10.5 4 7 3.5 7 5.8 7 7 9.5 7 12 7Z M12 7c1.5-3 5-3.5 5-1.2C17 7 14.5 7 12 7Z',
    copy: 'M8.5 8.5h11v11h-11Z M15.5 8.5v-4h-11v11h4',
    check: 'M4.5 12.5 9.5 17.5 19.5 7',
  };

  // ---------------------------------------------------------- tiny DOM helpers (text only, never HTML)
  const $ = id => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(name, cls) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICON[name] || ICON.unknown);
    svg.appendChild(p);
    return svg;
  }
  const replaceKids = (el, ...kids) => { el.replaceChildren(); return append(el, kids); };   // skips null/false, unlike replaceChildren
  const setText = (el, s) => { if (el) el.textContent = s == null ? '' : String(s); };
  const show = (el, on) => { if (el) el.hidden = !on; };

  // ---------------------------------------------------------- formatting
  const NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const fmt = n => (Number.isFinite(n) ? NF.format(n) : '—');
  function fmtShort(n) {
    if (!Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a < 1e6) return NF.format(n);
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];
    for (const [v, u] of units) {
      if (a < v) continue;
      const x = n / v;
      const s = Math.abs(x) >= 100 ? x.toFixed(0) : (Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.?0+$/, '');
      return s + u;
    }
    return NF.format(n);
  }
  function toMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? v * 1000 : v) : 0;   // seconds tolerated
    if (/^\d+$/.test(String(v))) return toMs(Number(v));
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : 0;
  }
  function ago(ms, now = Date.now()) {
    if (!ms) return '—';
    const d = Math.max(0, now - ms);
    if (d < 60e3) return 'just now';
    if (d < 3600e3) return `${Math.floor(d / 60e3)} min ago`;
    if (d < 86400e3) return `${Math.floor(d / 3600e3)} h ago`;
    const days = Math.floor(d / 86400e3);
    if (days < 60) return days === 1 ? '1 day ago' : `${days} days ago`;
    const months = Math.floor(days / 30.4);
    if (months < 24) return `${months} months ago`;
    return `${Math.floor(days / 365)} years ago`;
  }
  const DTF = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const DF = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const TF = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const TFS = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const when = ms => (ms ? DTF.format(new Date(ms)) : '—');
  function fnv1a32(str) {                         // the game's registryOf (art.js), so the PS- number matches the HUD
    let x = 0x811c9dc5;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x >>> 0;
  }
  const registryOf = name => 'PS-' + (1000 + (fnv1a32(name) % 9000));
  const shortId = id => String(id || '').slice(0, 8);
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

  // ---------------------------------------------------------- normalising server rows (camelCase or the D1 column names)
  const pick = (o, ...ks) => { if (!o || typeof o !== 'object') return undefined; for (const k of ks) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const str = v => (v == null ? '' : String(v));
  function normPlayer(r) {
    return {
      playerId: str(pick(r, 'playerId', 'player_id', 'id')),
      userId: str(pick(r, 'userId', 'user_id')),
      email: str(pick(r, 'email')),
      station: str(pick(r, 'station', 'name')),
      day: num(pick(r, 'day')), level: num(pick(r, 'level')), rank: num(pick(r, 'rank')),
      credits: num(pick(r, 'credits')), am: num(pick(r, 'am')), sectors: num(pick(r, 'sectors')),
      platform: str(pick(r, 'platform')), version: str(pick(r, 'version')),
      firstSeen: toMs(pick(r, 'firstSeen', 'first_seen')), lastSeen: toMs(pick(r, 'lastSeen', 'last_seen')),
      sessions: num(pick(r, 'sessions')),
      pendingGifts: num(pick(r, 'pendingGifts', 'pending_gifts', 'pending')),
    };
  }
  function normGift(g) {
    const out = {
      id: str(pick(g, 'id', 'giftId', 'gift_id')),
      playerId: str(pick(g, 'playerId', 'player_id')),
      credits: num(pick(g, 'credits')), am: num(pick(g, 'am')), note: str(pick(g, 'note')),
      createdAt: toMs(pick(g, 'createdAt', 'created_at')), createdBy: str(pick(g, 'createdBy', 'created_by')),
      deliveredAt: toMs(pick(g, 'deliveredAt', 'delivered_at')), ackedAt: toMs(pick(g, 'ackedAt', 'acked_at')),
      revokedAt: toMs(pick(g, 'revokedAt', 'revoked_at')),
      status: str(pick(g, 'status')).toLowerCase(),
    };
    // the server's status wins when it sends one; otherwise the same order as the worker's giftStatus (acked beats revoked)
    out.state = ['pending', 'delivered', 'applied', 'revoked'].includes(out.status) ? out.status
      : out.ackedAt ? 'applied' : out.revokedAt ? 'revoked' : out.deliveredAt ? 'delivered' : 'pending';
    return out;
  }
  function normPurchase(p) {
    return { grantId: str(pick(p, 'grantId', 'grant_id', 'id')), sku: str(pick(p, 'sku')), at: toMs(pick(p, 'at', 'createdAt', 'created_at')) };
  }
  function normLog(e) {
    return { id: str(pick(e, 'id')), at: toMs(pick(e, 'at')), admin: str(pick(e, 'admin')), action: str(pick(e, 'action')), target: str(pick(e, 'target')), detail: pick(e, 'detail') };
  }
  const listOf = (data, ...keys) => { if (Array.isArray(data)) return data; for (const k of keys) if (data && Array.isArray(data[k])) return data[k]; return []; };

  // ---------------------------------------------------------- state
  const state = {
    email: '', view: 'boot', tab: 'players', leaving: false,
    q: '', active: 'all', sort: 'last_seen', dir: '', offset: 0, total: 0, players: [], seenMap: new Map(),
    listSeq: 0, statsSeq: 0, panelSeq: 0, logSeq: 0,
    open: null, panel: null, lastRefresh: 0, timer: null, refreshing: false,
    modal: null, returnFocus: null, searchTimer: null,
    limitedUntil: 0, limitTimer: null,
  };

  // ---------------------------------------------------------- HTTP
  class ApiError extends Error {
    constructor(code, message, status, data) { super(message); this.code = code; this.status = status || 0; this.data = data || null; this.handled = false; }
  }
  function statusMessage(status) {
    if (status === 401) return 'Sign in to continue.';
    if (status === 403) return NOT_ADMIN;
    if (status === 404) return 'The account service does not know this address. Is the Port Authority update deployed?';
    if (status === 429) return 'Too many requests. Wait a minute and try again.';
    if (status >= 500) return `The account service hit an error (${status}).`;
    return `The account service answered ${status}.`;
  }
  // Same-origin JSON call (the session cookie rides along; there is no Authorization header to send). A 401 means the
  // session is gone and a 403 not-admin that the account is no longer an admin: both leave for the sign-in page.
  async function api(path, o = {}) {
    const headers = { accept: 'application/json' };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetch(path, {
        method: o.method || 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        credentials: 'same-origin', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new ApiError('timeout', 'Port Authority took too long to answer. Try again.', 0);
      throw new ApiError('offline', 'Could not reach Port Authority. Check the connection and try again.', 0);
    } finally { if (timer) clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = data && typeof data.message === 'string' && data.message ? data.message : statusMessage(res.status);
      const err = new ApiError((data && data.error) || `http-${res.status}`, msg, res.status, data);
      if (res.status === 401) { err.handled = true; toLogin('expired'); }
      else if (res.status === 403 && err.code === 'not-admin') { err.handled = true; toLogin('not-admin'); }
      throw err;
    }
    return data || {};
  }
  // Admin calls (path under /admin, sent to /api/admin/...): a 429 pauses the console until the worker's retryAfter
  // has passed (every call before then would be refused too) and shows one notice.
  async function adminApi(path, o) {
    if (state.limitedUntil > Date.now()) {
      const err = new ApiError('rate-limited', limitText(), 429, null);
      err.handled = true;
      throw err;
    }
    try { return await api(API + path, o); }
    catch (err) {
      if (err.status === 429) { err.handled = true; rateLimited(err); }
      throw err;
    }
  }
  // Leave for the sign-in page (once), which shows the matching fixed message.
  function toLogin(reason) {
    if (state.leaving) return;
    state.leaving = true;
    stopRefresh();
    window.location.replace(reason ? `${LOGIN}?e=${encodeURIComponent(reason)}` : LOGIN);
  }
  function retryAfterOf(err) {
    const n = Number(err && err.data && err.data.retryAfter);
    return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.ceil(n)) : 60;
  }
  const waitText = sec => (sec >= 90 ? `${Math.ceil(sec / 60)} min` : `${sec} s`);
  const limitText = () => `Port Authority is rate-limited for ${waitText(Math.max(1, Math.ceil((state.limitedUntil - Date.now()) / 1000)))}. It resumes by itself.`;
  function rateLimited(err) {
    state.limitedUntil = Date.now() + retryAfterOf(err) * 1000;
    stopRefresh();
    clearTimeout(state.limitTimer);
    state.limitTimer = setTimeout(() => {
      state.limitTimer = null; state.limitedUntil = 0;
      show($('stats-error'), false);
      if (state.view === 'console') refreshAll(true);
    }, state.limitedUntil - Date.now() + 250);
    if (state.view === 'console') {
      setLive('paused');
      const box = $('stats-error');
      box.replaceChildren(h('span', { class: 'n-text' }, h('span', { class: 'n-word', text: 'Paused' }), limitText()));
      box.className = 'notice warn';
      show(box, true);
    }
  }

  // ---------------------------------------------------------- views
  function showView(v) {
    state.view = v;
    document.body.dataset.view = v;
    show($('view-boot'), v === 'boot');
    show($('view-console'), v === 'console');
    show($('rail-session'), v === 'console');
    if (v === 'console') requestAnimationFrame(placeIndicator);
  }

  // ---------------------------------------------------------- session (the worker let this page load, so one exists)
  // GET /api/session names the admin; GET /api/admin/stats fills the tiles. Network trouble on the first call keeps
  // the boot view with a Retry; any later trouble opens the console and shows it there.
  async function enterConsole() {
    show($('boot-error'), false);
    show($('boot-line'), true);
    let who;
    try { who = await api(`${API}/session`); }
    catch (err) {
      if (err.handled) return;
      show($('boot-line'), false);
      errorNotice($('boot-error'), err.message, () => enterConsole());
      return;
    }
    state.email = str(who && who.email);
    let stats = null, statsErr = null;
    try { stats = await adminApi('/admin/stats'); }
    catch (err) {
      if (err.handled && err.status !== 429) return;          // on its way to the sign-in page
      statsErr = err;                                         // rate limit, config or network trouble: shown in the console
    }
    openConsole(stats, statsErr);
  }

  // Sign out: the worker revokes the account token and clears the session cookie.
  async function signOut() {
    const btn = $('signout');
    btn.classList.add('busy'); btn.disabled = true;
    stopRefresh();
    let ok = false;
    try {
      const res = await fetch('/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      ok = res.ok;
    } catch (e) { ok = false; }
    if (ok) { state.leaving = true; window.location.replace(`${LOGIN}?e=signed-out`); return; }
    btn.classList.remove('busy'); btn.disabled = false;
    scheduleRefresh();
    toast('Could not sign out. Check the connection and try again.', 'bad');
  }

  // ---------------------------------------------------------- console
  function openConsole(stats, statsErr) {
    showView('console');
    setText($('who'), state.email);
    $('who').title = state.email;
    if (stats) renderStats(stats);
    else if (statsErr && statsErr.status === 429) rateLimited(statsErr);
    else if (statsErr) showStatsError(statsErr);
    state.lastRefresh = Date.now();
    loadPlayers();
    if (state.tab === 'log') loadLog();
    renderUpdated();
    scheduleRefresh();
    $('main').focus({ preventScroll: true });
  }

  // ---- overview
  async function loadStats() {
    const seq = ++state.statsSeq;
    try {
      const data = await adminApi('/admin/stats');
      if (seq === state.statsSeq) renderStats(data);
    } catch (err) { if (!err.handled && seq === state.statsSeq) showStatsError(err); }
  }
  function renderStats(d) {
    show($('stats-error'), false);
    const players = Number(d.players);
    document.querySelectorAll('#tiles .tile').forEach(tile => {
      const k = tile.dataset.stat;
      const v = Number(d[k]);
      setText(tile.querySelector('[data-v]'), Number.isFinite(v) ? fmt(v) : '—');
      tile.title = Number.isFinite(v) ? `${tile.querySelector('.label').textContent}: ${fmt(v)}` : '';
      const bar = tile.querySelector('[data-bar]');
      if (bar) {
        const share = Number.isFinite(v) && players > 0 ? Math.min(1, v / players) : 0;
        bar.style.width = `${(share * 100).toFixed(1)}%`;
        setText(tile.querySelector('[data-sub]'), players > 0 && Number.isFinite(v) ? `${Math.round(share * 100)}% of players` : 'No players yet');
      }
    });
    const inFlight = Number(d.giftsDelivered), revoked = Number(d.giftsRevoked);
    const extra = [Number.isFinite(inFlight) && inFlight > 0 ? `${fmt(inFlight)} in flight` : '', Number.isFinite(revoked) && revoked > 0 ? `${fmt(revoked)} revoked` : ''].filter(Boolean);
    setText(document.querySelector('#tiles .tile[data-stat="giftsApplied"] [data-sub]'), extra.length ? extra.join(' · ') : 'Confirmed by the game');
    $('tiles').classList.remove('loading');
  }
  function showStatsError(err) {
    $('tiles').classList.add('loading');
    errorNotice($('stats-error'), `Could not load the overview: ${err.message}`, () => loadStats());
  }
  function errorNotice(box, text, retry) {
    box.replaceChildren(h('span', { class: 'n-text' }, h('span', { class: 'n-word', text: 'Error' }), text));
    if (retry) box.appendChild(h('button', { class: 'btn small', type: 'button', text: 'Retry', onclick: retry }));
    box.className = 'notice bad';
    show(box, true);
  }

  // ---- players table
  // A click on the active column flips its direction; a new column starts from the worker's default direction.
  // The phone's Sort menu carries "key" (default direction) and "key:asc|desc" options.
  function setSort(sort, o = {}) {
    let dir = o.dir;
    if (typeof sort === 'string' && sort.includes(':')) [sort, dir] = sort.split(':');
    if (!SORTS.includes(sort)) return;
    if (dir !== 'asc' && dir !== 'desc') dir = o.toggle && sort === state.sort ? (sortDir() === 'asc' ? 'desc' : 'asc') : '';
    if (dir === SORT_DEFAULT[sort]) dir = '';
    if (sort === state.sort && dir === state.dir) return;
    state.sort = sort; state.dir = dir; state.offset = 0;
    syncSortHeaders();
    loadPlayers();
  }
  const sortDir = () => state.dir || SORT_DEFAULT[state.sort] || 'desc';
  function syncSortHeaders() {
    const dir = sortDir();
    document.querySelectorAll('#players-table th[data-sort]').forEach(th => {
      const on = th.dataset.sort === state.sort;
      th.setAttribute('aria-sort', on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
      const b = th.querySelector('.sort-btn');
      if (b) b.title = on ? `Sorted ${dir === 'asc' ? 'ascending' : 'descending'}; click to reverse` : 'Sort by this column';
    });
    const sel = $('sort');
    const exact = `${state.sort}:${dir}`;
    sel.value = Array.from(sel.options).some(op => op.value === exact) ? exact : state.sort;
  }
  function setActive(active) {
    if (!ACTIVE.includes(active)) return;
    document.querySelectorAll('#active button').forEach(b => {
      const on = b.dataset.active === active;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    if (active === state.active) return;
    state.active = active; state.offset = 0;
    loadPlayers();
  }

  function skeleton() {
    const rows = [];
    for (let i = 0; i < 6; i++) {
      rows.push(h('tr', { class: 'skel', 'aria-hidden': 'true' },
        h('td', { class: 'c-station' }, h('span', { class: 'w80' })), h('td', { class: 'c-player' }, h('span', { class: 'w60' })),
        h('td', { class: 'c-num' }, h('span', { class: 'w40' })), h('td', { class: 'c-num c-rank' }, h('span', { class: 'w40' })),
        h('td', { class: 'c-num' }, h('span', { class: 'w40' })), h('td', { class: 'c-num' }, h('span', { class: 'w40' })),
        h('td', { class: 'c-seen' }, h('span', { class: 'w60' })), h('td', { class: 'c-plat' }, h('span', { class: 'w60' })), h('td', { class: 'c-gifts' }),
        h('td', { class: 'c-nums' }, h('span', { class: 'w60' }))));
    }
    $('players-body').replaceChildren(...rows);
  }

  async function loadPlayers(o = {}) {
    const seq = ++state.listSeq;
    if (!o.quiet) { skeleton(); show($('players-empty'), false); setText($('players-summary'), 'Loading players'); }
    const qs = new URLSearchParams({ q: state.q, active: state.active, sort: state.sort, limit: String(PAGE), offset: String(state.offset) });
    if (state.dir) qs.set('dir', state.dir);
    let data;
    try { data = await adminApi(`/admin/players?${qs}`); }
    catch (err) {
      if (seq !== state.listSeq) return;
      if (err.status === 429 && !o.quiet) { $('players-body').replaceChildren(); setText($('players-summary'), ''); updatePager(); }
      if (err.handled) return;
      errorNotice($('players-error'), `${o.quiet ? 'Could not refresh the players' : 'Could not load the players'}: ${err.message}`, () => loadPlayers());
      if (!o.quiet) { $('players-body').replaceChildren(); setText($('players-summary'), ''); updatePager(); }
      return;
    }
    if (seq !== state.listSeq) return;
    show($('players-error'), false);
    const rows = listOf(data, 'players', 'rows').map(normPlayer).filter(p => p.playerId);
    state.total = Number.isFinite(Number(data.total)) ? Number(data.total) : rows.length;
    if (!rows.length && state.offset > 0 && state.total > 0) {      // the page emptied under us (filters, deletions): go to the last page
      state.offset = Math.floor((state.total - 1) / PAGE) * PAGE;
      return loadPlayers(o);
    }
    state.players = rows;
    renderPlayers(o.quiet);
  }

  function renderPlayers(quiet) {
    const now = Date.now();
    const body = $('players-body');
    const prevSeen = state.seenMap;
    const nextSeen = new Map();
    const frag = document.createDocumentFragment();
    for (const p of state.players) {
      nextSeen.set(p.playerId, p.lastSeen);
      const tr = playerRow(p, now);
      if (quiet && prevSeen.has(p.playerId) && prevSeen.get(p.playerId) !== p.lastSeen) tr.classList.add('fresh');
      if (state.open === p.playerId) tr.classList.add('selected');
      frag.appendChild(tr);
    }
    state.seenMap = nextSeen;
    const hadFocus = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    body.replaceChildren(frag);
    if (hadFocus) { const again = body.querySelector(`tr[data-id="${CSS.escape(hadFocus)}"]`); if (again) again.focus({ preventScroll: true }); }

    const empty = !state.players.length;
    show($('players-empty'), empty);
    if (empty) {
      const filtered = state.q || state.active !== 'all';
      if (!filtered) {
        setText($('players-empty-title'), 'No players have checked in yet.');
        setText($('players-empty-body'), 'Players appear here the first time they open the game after this update.');
      } else if (state.q) {
        setText($('players-empty-title'), `No players match "${state.q}".`);
        setText($('players-empty-body'), state.active !== 'all' ? `Only players active in the last ${activeLabel()} are searched. Try All.` : 'Search by station name, account email or player id.');
      } else {
        setText($('players-empty-title'), `No players active in the last ${activeLabel()}.`);
        setText($('players-empty-body'), 'A player counts as active when their game checks in; it does that every 10 minutes while they play.');
      }
    }
    const from = state.total ? state.offset + 1 : 0, to = state.offset + state.players.length;
    setText($('players-summary'), state.total ? `${fmt(from)}–${fmt(to)} of ${plural(state.total, 'player', 'players')}` : '0 players');
    setText($('tab-players-count'), fmt(state.total));
    updatePager();
  }
  const activeLabel = () => ({ '24h': '24 hours', '7d': '7 days', '30d': '30 days' })[state.active] || '';
  function updatePager() {
    $('prev').disabled = state.offset <= 0;
    $('next').disabled = state.offset + state.players.length >= state.total;
  }

  function playerRow(p, now) {
    const name = p.station || 'Unnamed station';
    const seenAgo = now - p.lastSeen;
    const seenCls = p.lastSeen && seenAgo < ONLINE_MS ? 'seen now' : p.lastSeen && seenAgo < 86400e3 ? 'seen day' : 'seen';
    const who = p.email ? p.email : `Anonymous ${shortId(p.playerId)}`;
    const tr = h('tr', { tabindex: '0', 'data-id': p.playerId, 'aria-label': `${name}, ${who}, last seen ${ago(p.lastSeen, now)}. Open player panel.` },
      h('td', { class: 'c-station' },
        h('span', { class: 'st-name', text: name, title: name }),
        h('span', { class: 'st-sub', text: `${registryOf(name)} · Day ${fmt(p.day)} · ${plural(p.sectors, 'sector', 'sectors')}` })),
      h('td', { class: 'c-player' },
        p.email ? h('span', { class: 'pl-email', text: p.email, title: p.email }) : h('span', { class: 'pl-anon', text: 'Anonymous' }),
        h('span', { class: 'pl-id', text: shortId(p.playerId), title: p.playerId })),
      h('td', { class: 'c-num' }, h('span', { class: 'n', text: fmt(p.level) })),
      h('td', { class: 'c-num c-rank' }, h('span', { class: 'n', text: fmt(p.rank) })),
      h('td', { class: 'c-num' }, h('span', { class: 'n cr', text: fmtShort(p.credits), title: `${fmt(p.credits)} credits` })),
      h('td', { class: 'c-num' }, h('span', { class: p.am ? 'n am' : 'n dim', text: fmtShort(p.am), title: `${fmt(p.am)} Antimatter` })),
      h('td', { class: 'c-seen' }, h('span', { class: seenCls, title: p.lastSeen ? when(p.lastSeen) : 'Never' }, h('i'), ago(p.lastSeen, now))),
      h('td', { class: 'c-plat' }, platformTag(p.platform)),
      h('td', { class: 'c-gifts' }, p.pendingGifts > 0 ? h('span', { class: 'gift-badge', title: `${plural(p.pendingGifts, 'gift', 'gifts')} waiting for this player's game` }, icon('gift'), fmt(p.pendingGifts)) : null),
      h('td', { class: 'c-nums' }, h('div', { class: 'nums' },
        h('span', null, h('b', { text: 'Lv' }), fmt(p.level)),
        h('span', null, h('b', { text: 'Rank' }), fmt(p.rank)),
        h('span', { class: 'cr' }, h('b', { text: 'Cr' }), fmtShort(p.credits)),
        h('span', { class: 'am' }, h('b', { text: 'AM' }), fmtShort(p.am)),
        p.platform ? h('span', null, h('b', { text: p.platform === 'phone' ? 'Phone' : p.platform === 'desktop' ? 'Desktop' : p.platform })) : null)));
    return tr;
  }
  function platformTag(platform) {
    if (!platform) return h('span', { class: 'plat', text: '—' });
    const known = platform === 'phone' || platform === 'desktop';
    return h('span', { class: 'plat', title: platform }, icon(known ? platform : 'unknown'), known ? platform : platform.slice(0, 12));
  }

  // ---------------------------------------------------------- player panel
  function openPlayer(id, fromEl) {
    if (!PLAYER_RE.test(id)) return;
    const switching = state.open !== id;
    state.open = id;
    state.returnFocus = fromEl || document.activeElement;
    document.querySelectorAll('#players-body tr.selected').forEach(tr => tr.classList.remove('selected'));
    const row = $('players-body').querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.add('selected');
    show($('scrim'), true);
    show($('drawer'), true);
    document.body.classList.add('locked');
    if (switching) {
      resetGiftForm();
      show($('g-done'), false);
      const fromList = state.players.find(p => p.playerId === id);
      state.panel = fromList ? { player: fromList, gifts: null, purchases: null } : null;
      renderPanel();
      $('d-body').scrollTop = 0;
    }
    $('d-close').focus({ preventScroll: true });
    loadPlayer(id);
  }
  function closePanel(silent) {
    if ($('drawer').hidden) { state.open = null; return; }
    show($('drawer'), false);
    show($('scrim'), false);
    document.body.classList.remove('locked');
    document.querySelectorAll('#players-body tr.selected').forEach(tr => tr.classList.remove('selected'));
    const id = state.open;
    state.open = null; state.panel = null;
    if (silent) return;
    const row = id && $('players-body').querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    const back = row || (state.returnFocus && document.contains(state.returnFocus) ? state.returnFocus : null);
    if (back) back.focus({ preventScroll: true });
  }

  async function loadPlayer(id, o = {}) {
    const seq = ++state.panelSeq;
    const body = $('d-body');
    if (!o.quiet) { body.classList.add('loading'); show($('d-loading'), !state.panel); }
    let data;
    try { data = await adminApi(`/admin/players/${encodeURIComponent(id)}`); }
    catch (err) {
      if (seq !== state.panelSeq || state.open !== id) return;
      if (err.status === 429) { body.classList.remove('loading'); show($('d-loading'), false); }
      if (err.handled) return;
      body.classList.remove('loading'); show($('d-loading'), false);
      const msg = err.status === 404 ? 'This player is not in the registry. Their game may not have checked in since the update.' : err.message;
      errorNotice($('d-error'), o.quiet ? `Could not refresh this player: ${msg}` : msg, err.status === 404 ? null : () => loadPlayer(id));
      if (!state.panel) { setText($('d-name'), 'Player unavailable'); setText($('d-reg'), shortId(id)); }
      return;
    }
    if (seq !== state.panelSeq || state.open !== id) return;
    body.classList.remove('loading'); show($('d-loading'), false); show($('d-error'), false);
    const player = normPlayer(data.player || {});
    if (!player.playerId) player.playerId = id;
    const gifts = listOf(data, 'gifts').map(normGift).sort((a, b) => b.createdAt - a.createdAt);
    const purchases = listOf(data, 'purchases').map(normPurchase).sort((a, b) => b.at - a.at);
    player.pendingGifts = gifts.filter(g => g.state === 'pending' || g.state === 'delivered').length;
    state.panel = { player, gifts, purchases, purchasesAvailable: data.purchasesAvailable !== false };
    renderPanel();
  }

  function renderPanel() {
    const P = state.panel;
    const hasPlayer = !!(P && P.player);
    show($('d-summary-sec'), hasPlayer);
    show($('gift-sec'), hasPlayer);
    if (!hasPlayer) { setText($('d-name'), 'Loading'); setText($('d-reg'), ''); $('d-chips').replaceChildren(); $('d-gifts').replaceChildren(); $('d-purchases').replaceChildren(); return; }
    const p = P.player, now = Date.now();
    const name = p.station || 'Unnamed station';
    setText($('d-name'), name);
    setText($('d-reg'), `${registryOf(name)} · Player ${shortId(p.playerId)}`);
    const online = p.lastSeen && now - p.lastSeen < ONLINE_MS;
    replaceKids($('d-chips'),
      online ? h('span', { class: 'chip good' }, h('span', { class: 'shape', text: '▲' }), 'In game now') : h('span', { class: 'chip dim', text: `Seen ${ago(p.lastSeen, now)}` }),
      p.email ? h('span', { class: 'chip sage', text: 'Account' }) : h('span', { class: 'chip dim', text: 'Anonymous' }),
      p.platform ? h('span', { class: 'chip ice', text: p.platform }) : null,
      p.pendingGifts > 0 ? h('span', { class: 'chip' }, h('span', { class: 'shape', text: '■' }), `${fmt(p.pendingGifts)} pending`) : null);
    setText($('d-seen-tag'), `Day ${fmt(p.day)} · ${plural(p.sectors, 'sector', 'sectors')}`);

    const stat = (label, value, cls, ic, title) => h('div', { class: 'd-stat', title: title || null }, h('span', { class: 'label' }, ic ? icon(ic, ic === 'credits' ? 'cr' : 'am') : null, label), h('span', { class: 'v' + (cls ? ' ' + cls : ''), text: value }));
    $('d-stats').replaceChildren(
      stat('Credits', fmtShort(p.credits), 'cr', 'credits', `${fmt(p.credits)} credits`),
      stat('Antimatter', fmt(p.am), 'am', 'am', `${fmt(p.am)} Antimatter`),
      stat('Level', fmt(p.level)),
      stat('Rank', fmt(p.rank)),
      stat('Day', fmt(p.day)),
      stat('Sessions', fmt(p.sessions), null, null, 'A new session starts when the game checks in after 30 minutes or more away'));

    const kv = [];
    const row = (k, ...v) => kv.push(h('dt', { text: k }), h('dd', null, ...v));
    row('Player', p.email ? h('span', { text: p.email }) : 'Anonymous (no account)');
    row('Player id', h('span', { text: p.playerId }), copyBtn(p.playerId, 'player id'));
    if (p.userId) row('Account id', h('span', { text: p.userId }));
    row('Last seen', when(p.lastSeen), h('span', { class: 'rel', text: ago(p.lastSeen, now) }));
    row('First seen', when(p.firstSeen), h('span', { class: 'rel', text: ago(p.firstSeen, now) }));
    row('Platform', p.platform || '—', p.version ? h('span', { class: 'rel', text: `build ${p.version}` }) : null);
    $('d-kv').replaceChildren(...kv);

    renderGifts();
    renderPurchases();
    syncGiftForm();
  }
  function copyBtn(text, what) {
    const b = h('button', { class: 'btn ghost small copy', type: 'button', title: `Copy ${what}`, 'aria-label': `Copy ${what}` }, icon('copy'));
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast(`Copied the ${what}.`, 'good'); }
      catch (e) { toast('Copy is not available in this browser.', 'warn'); }
    });
    return b;
  }

  const GIFT_STATE = {
    pending:   { label: 'Pending',   cls: '',     shape: '■', hint: 'Waiting for the player\'s game to check in' },
    delivered: { label: 'Delivered', cls: 'ice',  shape: '■', hint: 'The game has received it; waiting for it to confirm it applied it' },
    applied:   { label: 'Applied',   cls: 'good', shape: '▲', hint: 'The game applied it to the player\'s profile' },
    revoked:   { label: 'Revoked',   cls: 'dim',  shape: '▼', hint: 'Cancelled before the game applied it' },
  };
  function renderGifts() {
    const gifts = state.panel && state.panel.gifts;
    const list = $('d-gifts');
    if (!gifts) { list.replaceChildren(); show($('d-gifts-empty'), false); setText($('hist-tag'), ''); return; }
    show($('d-gifts-empty'), gifts.length === 0);
    const totals = gifts.filter(g => g.state !== 'revoked').reduce((t, g) => ({ c: t.c + g.credits, a: t.a + g.am }), { c: 0, a: 0 });
    setText($('hist-tag'), gifts.length ? `${plural(gifts.length, 'gift', 'gifts')} · ${fmtShort(totals.c)} cr · ${fmt(totals.a)} AM` : '');
    list.replaceChildren(...gifts.map(g => {
      const st = GIFT_STATE[g.state] || GIFT_STATE.pending;
      const canRevoke = g.state === 'pending' || g.state === 'delivered';
      const meta = [`Sent ${when(g.createdAt)}`];
      if (g.createdBy) meta.push(`by ${g.createdBy}`);
      if (g.deliveredAt) meta.push(`delivered ${ago(g.deliveredAt)}`);
      if (g.ackedAt) meta.push(`applied ${ago(g.ackedAt)}`);
      if (g.revokedAt) meta.push(`revoked ${ago(g.revokedAt)}`);
      return h('li', { class: g.state },
        h('div', { class: 'g-amt' },
          g.credits ? h('span', { class: 'cr' }, icon('credits'), fmt(g.credits)) : null,
          g.am ? h('span', { class: 'am' }, icon('am'), `${fmt(g.am)} AM`) : null),
        h('div', { class: 'g-side' },
          h('span', { class: `chip ${st.cls}`, title: st.hint }, h('span', { class: 'shape', text: st.shape }), st.label),
          canRevoke ? h('button', { class: 'btn danger small', type: 'button', text: 'Revoke', onclick: () => confirmRevoke(g) }) : null),
        g.note ? h('p', { class: 'g-note', text: g.note }) : null,
        h('p', { class: 'g-meta', text: meta.join(' · ') + (g.id ? ` · ${g.id}` : '') }));
    }));
  }
  function renderPurchases() {
    const items = state.panel && state.panel.purchases;
    const list = $('d-purchases');
    if (!items) { list.replaceChildren(); show($('d-purchases-empty'), false); setText($('buy-tag'), ''); return; }
    show($('d-purchases-empty'), items.length === 0);
    setText($('d-purchases-empty'), state.panel.purchasesAvailable === false
      ? 'Purchase records are unavailable: the store\'s KV is not readable from the account worker.'
      : 'No store purchases recorded for this player id.');
    setText($('buy-tag'), items.length ? plural(items.length, 'purchase', 'purchases') : '');
    list.replaceChildren(...items.map(p => h('li', null,
      h('span', { class: 'p-sku' }, p.sku || 'Unknown item', h('span', { class: 'p-id', text: p.grantId })),
      h('span', { class: 'p-at', text: p.at ? DF.format(new Date(p.at)) : '—', title: when(p.at) }))));
  }

  // ---------------------------------------------------------- Send a gift
  function parseAmount(raw) {
    const s = String(raw == null ? '' : raw).replace(/[\s,_]/g, '');
    if (!s) return 0;
    return /^\d{1,9}$/.test(s) ? Number(s) : NaN;
  }
  function readGift() {
    const credits = parseAmount($('g-credits').value), am = parseAmount($('g-am').value);
    const note = $('g-note').value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, NOTE_MAX);
    let error = null, field = null;
    if (!Number.isInteger(credits) || credits < 0) { error = 'Credits must be a whole number.'; field = 'g-credits'; }
    else if (credits > MAX_CREDITS) { error = `Credits can be at most ${fmt(MAX_CREDITS)} per gift.`; field = 'g-credits'; }
    else if (!Number.isInteger(am) || am < 0) { error = 'Antimatter must be a whole number.'; field = 'g-am'; }
    else if (am > MAX_AM) { error = `Antimatter can be at most ${fmt(MAX_AM)} per gift.`; field = 'g-am'; }
    else if (credits === 0 && am === 0) { error = 'Enter some credits, some Antimatter, or both.'; field = 'g-credits'; }
    return { credits, am, note, error, field };
  }
  function setGiftError(text, field) {
    setText($('g-error'), text || ''); show($('g-error'), !!text);
    ['g-credits', 'g-am'].forEach(id => $(id).setAttribute('aria-invalid', field === id ? 'true' : 'false'));
  }
  function resetGiftForm() {
    $('g-credits').value = ''; $('g-am').value = ''; $('g-note').value = '';
    setGiftError('');
    syncGiftForm();
  }
  function syncGiftForm() {
    const n = $('g-note').value.length;
    setText($('g-count'), `${n} / ${NOTE_MAX}`);
    $('g-count').classList.toggle('over', n >= NOTE_MAX);
  }
  function addAmount(id, add) {
    const el = $(id);
    const cur = parseAmount(el.value);
    const cap = id === 'g-am' ? MAX_AM : MAX_CREDITS;
    el.value = fmt(Math.min(cap, (Number.isFinite(cur) ? cur : 0) + add));
    setGiftError('');
    show($('g-done'), false);
  }
  function tidyAmount(ev) {
    const v = parseAmount(ev.target.value);
    if (Number.isFinite(v) && ev.target.value.trim() !== '') ev.target.value = v ? fmt(v) : '';
  }
  function reviewGift(ev) {
    ev.preventDefault();
    const P = state.panel;
    if (!P || !P.player) return;
    const g = readGift();
    if (g.error) { setGiftError(g.error, g.field); $(g.field).focus(); return; }
    setGiftError('');
    const p = P.player, name = p.station || 'Unnamed station';
    const requestId = newRequestId();                       // one per review: Send again after a timeout reuses it
    openModal({
      kind: 'send',
      tag: 'Port Authority · Outgoing gift',
      title: `Send this gift to ${name}?`,
      body: [
        h('div', { class: 'm-amounts' },
          h('div', null, h('span', { class: 'label' }, icon('credits', 'cr'), ' Credits'), h('span', { class: 'v cr' + (g.credits ? '' : ' zero'), text: fmt(g.credits) })),
          h('div', null, h('span', { class: 'label' }, icon('am', 'am'), ' Antimatter'), h('span', { class: 'v am' + (g.am ? '' : ' zero'), text: fmt(g.am) }))),
        h('p', { class: 'm-to' }, 'To ', h('strong', { text: name }), ` · ${p.email || 'Anonymous'} · ${shortId(p.playerId)}`),
        g.note ? h('p', { class: 'm-quote', text: g.note }) : h('p', { text: 'No note. The player sees the gift with a standard message.' }),
        h('p', { class: 'fine', text: `The player sees this in a "Port Authority" message. ${DELIVERY_LINE}` }),
      ],
      ok: 'Send gift',
      run: async () => {
        try { await sendGift(p, g, requestId); }
        catch (err) {
          // the gift may have been stored before the answer was lost: Send again is safe (same requestId)
          if (err.code === 'timeout' || err.code === 'offline') err.message = `${err.message} Sending again is safe: it cannot create a second gift.`;
          throw err;
        }
      },
    });
  }
  function newRequestId() {
    try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); } catch (e) { /* older browsers */ }
    const b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }
  async function sendGift(p, g, requestId) {
    const data = await adminApi('/admin/gifts', { method: 'POST', body: { playerId: p.playerId, credits: g.credits, am: g.am, note: g.note, requestId } });
    const gift = normGift((data && data.gift) || { credits: g.credits, am: g.am, note: g.note, createdAt: Date.now() });
    if (state.open === p.playerId && state.panel) {
      if (state.panel.gifts && gift.id && !state.panel.gifts.some(x => x.id === gift.id)) state.panel.gifts.unshift(gift);
      resetGiftForm();
      const what = [g.credits ? `${fmt(g.credits)} credits` : '', g.am ? `${fmt(g.am)} Antimatter` : ''].filter(Boolean).join(' and ');
      const done = $('g-done');
      done.replaceChildren(h('span', { class: 'n-text' }, h('span', { class: 'n-word', text: 'Sent' }), `${what} for ${p.station || 'this station'}. ${DELIVERY_LINE}`));
      show(done, true);
      renderGifts();
      loadPlayer(p.playerId, { quiet: true });
    }
    toast(`Gift queued for ${p.station || shortId(p.playerId)}.`, 'good');
    loadStats();
    loadPlayers({ quiet: true });
    if (state.tab === 'log') loadLog();
  }

  function confirmRevoke(g) {
    const P = state.panel;
    if (!P || !P.player) return;
    const p = P.player;
    const what = [g.credits ? `${fmt(g.credits)} credits` : '', g.am ? `${fmt(g.am)} Antimatter` : ''].filter(Boolean).join(' and ');
    openModal({
      kind: 'revoke', danger: true,
      tag: 'Port Authority · Revoke',
      title: 'Revoke this gift?',
      body: [
        h('p', { class: 'm-to' }, `${what} for `, h('strong', { text: p.station || 'Unnamed station' }), g.createdAt ? `, sent ${ago(g.createdAt)}.` : '.'),
        g.note ? h('p', { class: 'm-quote', text: g.note }) : null,
        g.state === 'delivered'
          ? h('p', { text: 'This player\'s game has already received the gift. If it applied it before the revoke, the player keeps it; revoking stops it being offered again.' })
          : h('p', { text: 'The game has not picked it up yet. After revoking, it will never be delivered.' }),
      ],
      ok: 'Revoke gift',
      run: async () => {
        try { await adminApi(`/admin/gifts/${encodeURIComponent(g.id)}/revoke`, { method: 'POST', body: {} }); }
        catch (err) {
          if (err.status !== 409 && err.status !== 404) throw err;
          closeModal();
          if (err.status === 409 && err.data && err.data.gift && state.panel && state.panel.gifts && state.open === p.playerId) {
            const fresh = normGift(err.data.gift);
            state.panel.gifts = state.panel.gifts.map(x => (x.id === fresh.id ? fresh : x));
            renderGifts();
          }
          toast(err.status === 409 ? 'The game had already applied this gift; it was not revoked.' : 'That gift no longer exists.', 'warn');
          if (state.open === p.playerId) loadPlayer(p.playerId, { quiet: true });
          loadStats();
          return;
        }
        toast('Gift revoked.', 'good');
        show($('g-done'), false);
        if (state.open === p.playerId) loadPlayer(p.playerId, { quiet: true });
        loadStats();
        loadPlayers({ quiet: true });
        if (state.tab === 'log') loadLog();
      },
    });
  }

  // ---------------------------------------------------------- modal (confirmation step)
  function openModal(m) {
    state.modal = m;
    const box = document.querySelector('#modal .modal-box');
    box.classList.toggle('danger', !!m.danger);
    setText($('m-tag'), m.tag);
    setText($('m-title'), m.title);
    $('m-body').replaceChildren(...m.body.filter(Boolean));
    setText($('m-error'), ''); show($('m-error'), false);
    const ok = $('m-ok');
    setText(ok, m.ok);
    ok.className = m.danger ? 'btn danger' : 'btn primary';
    ok.disabled = false; $('m-cancel').disabled = false;
    m.returnFocus = document.activeElement;
    m.openedAt = performance.now();
    show($('modal'), true);
    ok.focus();
  }
  function closeModal() {
    const m = state.modal;
    show($('modal'), false);
    state.modal = null;
    if (m && m.returnFocus && document.contains(m.returnFocus) && !m.returnFocus.closest('[hidden]')) m.returnFocus.focus({ preventScroll: true });
  }
  async function runModal() {
    const m = state.modal;
    if (!m || m.busy) return;
    m.busy = true;
    const ok = $('m-ok');
    ok.classList.add('busy'); ok.disabled = true; $('m-cancel').disabled = true;
    try {
      await m.run();
      if (state.modal === m) closeModal();
    } catch (err) {
      if ((err.handled && err.status !== 429) || state.modal !== m) return;
      setText($('m-error'), err.message || 'Something went wrong.'); show($('m-error'), true);
    } finally {
      m.busy = false;
      ok.classList.remove('busy'); ok.disabled = false; $('m-cancel').disabled = false;
    }
  }

  // ---------------------------------------------------------- admin log
  async function loadLog(o = {}) {
    const seq = ++state.logSeq;
    if (!o.quiet && !$('log-list').children.length) setText($('log-tag'), 'Loading');
    let data;
    try { data = await adminApi('/admin/log?limit=50'); }
    catch (err) {
      if (seq !== state.logSeq) return;
      if (err.status === 429) setText($('log-tag'), '');
      if (err.handled) return;
      errorNotice($('log-error'), `Could not load the admin log: ${err.message}`, () => loadLog());
      setText($('log-tag'), '');
      return;
    }
    if (seq !== state.logSeq) return;
    show($('log-error'), false);
    const rows = listOf(data, 'log', 'entries', 'rows', 'items').map(normLog).sort((a, b) => b.at - a.at);
    show($('log-empty'), rows.length === 0);
    setText($('log-tag'), rows.length ? `Latest ${fmt(rows.length)}` : '');
    $('log-list').replaceChildren(...rows.map(logRow));
  }
  function parseDetail(d) {
    if (d == null || d === '') return null;
    if (typeof d === 'object') return d;
    const s = String(d);
    if (/^\s*[{[]/.test(s)) { try { const v = JSON.parse(s); if (v && typeof v === 'object') return v; } catch (e) { /* plain text */ } }
    return s;
  }
  function logRow(e) {
    const action = e.action.toLowerCase();
    const isRevoke = /revoke/.test(action), isGift = !isRevoke && /gift|grant/.test(action);
    const detail = parseDetail(e.detail);
    const obj = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null;
    const credits = obj ? num(pick(obj, 'credits')) : 0, am = obj ? num(pick(obj, 'am')) : 0;
    const note = obj ? str(pick(obj, 'note')) : '';
    const playerRef = obj ? str(pick(obj, 'playerId', 'player_id')) : '';
    const target = e.target;
    const targetIsPlayer = PLAYER_RE.test(target) && !/^gft_/.test(target);
    const pid = targetIsPlayer ? target : PLAYER_RE.test(playerRef) ? playerRef : '';

    const amounts = [credits ? `${fmt(credits)} credits` : '', am ? `${fmt(am)} AM` : ''].filter(Boolean).join(', ');
    const line = h('p', { class: 'l-line' },
      isGift ? `Gift${amounts ? ` of ${amounts}` : ''}` : isRevoke ? `Revoked${amounts ? ` ${amounts}` : ' a gift'}` : e.action || 'Action',
      pid ? [' for ', h('button', { class: 'linklike', type: 'button', text: `player ${shortId(pid)}`, title: `Open player ${pid}`, onclick: () => openPlayer(pid) })]
        : target ? [' · ', h('span', { class: 'mono', text: target })] : null);
    const meta = [];
    if (e.admin) meta.push(`by ${e.admin}`);
    if (!isGift && !isRevoke && e.action) meta.push(e.action);
    if (isRevoke && target && !targetIsPlayer) meta.push(target);
    if (obj) {
      for (const k in obj) {
        if (['credits', 'am', 'note', 'playerId', 'player_id'].includes(k)) continue;
        const v = obj[k];
        if (v == null || typeof v === 'object') continue;
        meta.push(`${k} ${String(v).slice(0, 80)}`);
      }
    } else if (typeof detail === 'string') meta.push(detail.slice(0, 200));
    const d = e.at ? new Date(e.at) : null;
    return h('li', null,
      h('span', { class: 'l-when', title: e.at ? when(e.at) : '' }, d ? DF.format(d) : '—', h('b', { text: d ? TFS.format(d) : '' })),
      h('span', { class: 'l-action' }, isRevoke ? h('span', { class: 'chip bad' }, h('span', { class: 'shape', text: '▼' }), 'Revoke')
        : isGift ? h('span', { class: 'chip' }, h('span', { class: 'shape', text: '■' }), 'Gift')
        : h('span', { class: 'chip dim', text: (e.action || 'Action').slice(0, 18) })),
      h('div', { class: 'l-main' }, line,
        note ? h('p', { class: 'l-meta', text: `Note: "${note}"` }) : null,
        meta.length ? h('p', { class: 'l-meta', text: meta.join(' · ') }) : null));
  }

  // ---------------------------------------------------------- tabs
  function setTab(tab, focus) {
    state.tab = tab;
    document.querySelectorAll('#tabs .tab').forEach(b => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    show($('pane-players'), tab === 'players');
    show($('pane-log'), tab === 'log');
    placeIndicator();
    if (tab === 'log') loadLog();
  }
  function placeIndicator() {
    const on = document.querySelector('#tabs .tab[aria-selected="true"]');
    const ind = $('tab-indicator');
    if (!on || !on.offsetWidth) return;
    ind.style.width = `${on.offsetWidth}px`;
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
  }

  // ---------------------------------------------------------- refresh (every 60 s while visible)
  function scheduleRefresh() {
    stopRefresh();
    if (state.view !== 'console') return;
    if (document.hidden || state.limitedUntil > Date.now()) { setLive('paused'); return; }   // a 429 resumes via its own timer
    setLive('live');
    const wait = Math.max(1000, REFRESH_MS - (Date.now() - state.lastRefresh));
    state.timer = setTimeout(() => refreshAll(true), wait);
  }
  function stopRefresh() { if (state.timer) { clearTimeout(state.timer); state.timer = null; } }
  async function refreshAll(quiet) {
    if (state.view !== 'console' || state.refreshing) return;
    state.refreshing = true;
    stopRefresh();
    const btn = $('refresh');
    btn.classList.add('busy');
    try {
      const jobs = [loadStats(), loadPlayers({ quiet })];
      if (state.open) jobs.push(loadPlayer(state.open, { quiet: true }));
      if (state.tab === 'log') jobs.push(loadLog({ quiet: true }));
      await Promise.all(jobs);
      state.lastRefresh = Date.now();
      renderUpdated();
    } finally {
      state.refreshing = false;
      btn.classList.remove('busy');
      scheduleRefresh();
    }
  }
  function renderUpdated() {
    setText($('updated'), state.lastRefresh ? `Updated ${TF.format(new Date(state.lastRefresh))} · auto every 60 s` : '');
  }
  function setLive(mode) {
    const el = $('live');
    el.classList.toggle('paused', mode === 'paused');
    setText($('live-text'), mode === 'paused' ? 'Paused' : 'Live');
    el.title = mode === 'paused' ? 'Auto-refresh pauses while this tab is hidden' : 'Refreshes every 60 seconds while this tab is visible';
  }

  // ---------------------------------------------------------- toasts
  function toast(text, kind) {
    const host = $('toasts');
    const t = h('div', { class: `toast ${kind || ''}`, text });
    host.appendChild(t);
    while (host.children.length > 4) host.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3500);
  }

  // ---------------------------------------------------------- focus trap for the panel and the modal
  function trap(ev, root) {
    const f = Array.from(root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(el => !el.disabled && !el.closest('[hidden]') && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    else if (!root.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
  }
  const typing = el => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

  // ---------------------------------------------------------- wiring
  function bind() {
    $('signout').addEventListener('click', signOut);
    $('refresh').addEventListener('click', () => refreshAll(false));

    const q = $('q');
    q.addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        const v = q.value.trim().slice(0, 80);
        if (v === state.q) return;
        state.q = v; state.offset = 0; loadPlayers();
      }, SEARCH_DEBOUNCE_MS);
    });
    q.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); clearTimeout(state.searchTimer); state.q = q.value.trim().slice(0, 80); state.offset = 0; loadPlayers(); }
      if (ev.key === 'Escape' && q.value) { ev.preventDefault(); ev.stopPropagation(); q.value = ''; clearTimeout(state.searchTimer); if (state.q) { state.q = ''; state.offset = 0; loadPlayers(); } }
    });

    const seg = $('active');
    seg.addEventListener('click', ev => { const b = ev.target.closest('button[data-active]'); if (b) setActive(b.dataset.active); });
    seg.addEventListener('keydown', ev => {
      if (!['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
      ev.preventDefault();
      const i = ACTIVE.indexOf(state.active) + (ev.key === 'ArrowRight' ? 1 : -1);
      const next = ACTIVE[(i + ACTIVE.length) % ACTIVE.length];
      setActive(next);
      seg.querySelector(`button[data-active="${next}"]`).focus();
    });
    setActive('all');
    $('sort').addEventListener('change', ev => setSort(ev.target.value));
    document.querySelectorAll('#players-table th[data-sort] .sort-btn').forEach(b => b.addEventListener('click', () => setSort(b.closest('th').dataset.sort, { toggle: true })));
    syncSortHeaders();
    $('prev').addEventListener('click', () => { if (state.offset > 0) { state.offset = Math.max(0, state.offset - PAGE); loadPlayers(); scrollToTable(); } });
    $('next').addEventListener('click', () => { if (state.offset + PAGE < state.total) { state.offset += PAGE; loadPlayers(); scrollToTable(); } });

    const body = $('players-body');
    body.addEventListener('click', ev => { const tr = ev.target.closest('tr[data-id]'); if (tr) openPlayer(tr.dataset.id, tr); });
    body.addEventListener('keydown', ev => {
      const tr = ev.target.closest('tr[data-id]');
      if (!tr) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPlayer(tr.dataset.id, tr); }
      else if (ev.key === 'ArrowDown' && tr.nextElementSibling) { ev.preventDefault(); tr.nextElementSibling.focus(); }
      else if (ev.key === 'ArrowUp' && tr.previousElementSibling) { ev.preventDefault(); tr.previousElementSibling.focus(); }
    });

    document.querySelectorAll('#tabs .tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('tabs').addEventListener('keydown', ev => {
      if (!['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
      ev.preventDefault();
      setTab(state.tab === 'players' ? 'log' : 'players', true);
    });
    window.addEventListener('resize', placeIndicator);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeIndicator).catch(() => {});

    $('d-close').addEventListener('click', () => closePanel());
    $('scrim').addEventListener('click', () => closePanel());
    $('drawer').addEventListener('keydown', ev => { if (ev.key === 'Tab' && !state.modal) trap(ev, $('drawer')); });

    $('gift-form').addEventListener('submit', reviewGift);
    document.querySelectorAll('#gift-form [data-add-credits]').forEach(b => b.addEventListener('click', () => addAmount('g-credits', Number(b.dataset.addCredits))));
    document.querySelectorAll('#gift-form [data-add-am]').forEach(b => b.addEventListener('click', () => addAmount('g-am', Number(b.dataset.addAm))));
    $('g-clear').addEventListener('click', () => { resetGiftForm(); show($('g-done'), false); $('g-credits').focus(); });
    ['g-credits', 'g-am'].forEach(id => {
      $(id).addEventListener('blur', tidyAmount);
      $(id).addEventListener('input', () => { setGiftError(''); show($('g-done'), false); });
    });
    $('g-note').addEventListener('input', () => { syncGiftForm(); show($('g-done'), false); });

    $('m-ok').addEventListener('click', runModal);
    $('m-cancel').addEventListener('click', () => { if (!(state.modal && state.modal.busy)) closeModal(); });
    // The box opens with a clip-path reveal; while it runs, clicks meant for its buttons can land on the backdrop.
    // So a backdrop click closes only when the press also started on the backdrop, after the box has opened.
    let downOnBackdrop = false;
    $('modal').addEventListener('pointerdown', ev => { downOnBackdrop = ev.target === $('modal'); });
    $('modal').addEventListener('click', ev => {
      const m = state.modal;
      if (ev.target !== $('modal') || !downOnBackdrop || !m || m.busy || performance.now() - (m.openedAt || 0) < MODAL_SETTLE_MS) return;
      closeModal();
    });
    $('modal').addEventListener('keydown', ev => { if (ev.key === 'Tab') trap(ev, document.querySelector('#modal .modal-box')); });

    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        if (state.modal) { if (!state.modal.busy) { ev.preventDefault(); closeModal(); } return; }
        if (state.open) { ev.preventDefault(); closePanel(); }
        return;
      }
      if (state.view !== 'console' || state.modal || ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target)) return;
      if (ev.key === '/' && !state.open) { ev.preventDefault(); if (state.tab !== 'players') setTab('players'); $('q').focus(); $('q').select(); }
      else if ((ev.key === 'r' || ev.key === 'R') && !state.open) { ev.preventDefault(); refreshAll(false); }
    });

    document.addEventListener('visibilitychange', () => {
      if (state.view !== 'console') return;
      if (document.hidden) { stopRefresh(); setLive('paused'); return; }
      if (Date.now() - state.lastRefresh >= REFRESH_MS) refreshAll(true); else scheduleRefresh();
    });
  }
  function scrollToTable() {
    const top = $('tabs').getBoundingClientRect().top + window.scrollY - 70;
    if (window.scrollY > top) window.scrollTo({ top, behavior: 'smooth' });
  }

  // ---------------------------------------------------------- boot
  async function boot() {
    bind();
    showView('boot');
    await enterConsole();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

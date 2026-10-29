// ============================================================
// PORT SOLACE — Gifts: presence check-ins and Port Authority gifts (DESIGN2.md Addendum A9, spec section 4)
// Classic script; exposes the `Gifts` global (also window.Gifts). Loads after account.js, before ui/admin.js.
//
// Presence: POST {apiBase}/presence {playerId, summary:{name, day, level, rank, credits, am, sectors}, platform, version}
//   on boot, every 10 minutes while the page is visible, and when the page becomes visible again after 10+ minutes
//   hidden (or after a scheduled check-in was skipped because the page was hidden). The account apiBase is the one
//   Account parsed from <meta name="portsolace-account"> (with its localStorage override). The Bearer token goes
//   along only while Account is signed in. Every failure is silent: presence never disturbs play.
// Gifts: the presence answer lists {id, credits, am, note, createdAt}. Each is applied once (the
//   profile.entitlements.history check), recorded with Meta.grantEntitlement('gift', {grantId, mode:'gift', ...}),
//   saved, then acked with POST {apiBase}/gifts/ack {playerId, ids}. The history entry carries acked:false until the
//   ack succeeds; every check-in re-sends outstanding acks (from memory and from the stored history, so they survive a
//   reload), also when presence returned no gifts, because a gift revoked after it reached the game is no longer
//   offered. A gift whose profile save failed is not acked, so the server offers it again; the history check never
//   grants twice.
// The player sees one Overlays modal for all new gifts; notes are untrusted and only ever set through textContent.
//
// Integration: main.js calls Gifts.init() after Meta.init, Store.flush, Account.boot and UI.init.
// ============================================================
'use strict';

const Gifts = (() => {
  const INTERVAL_MS = 10 * 60e3;           // check-in cadence while visible; also the "hidden long enough" threshold
  const TIMEOUT_MS = 15000;                // per request
  const SHOW_RETRY_MS = 1500;              // the modal waits for the title, other modals and the tutorial
  const PLAYER_RE = /^[A-Za-z0-9_-]{8,64}$/;     // the store worker's PLAYER_RE
  const GIFT_ID_RE = /^[A-Za-z0-9_-]{4,100}$/;   // 'gft_' + base64url on the worker; anything else is ignored, never acked
  const MAX_CREDITS = 10000000, MAX_AM = 100000; // the worker's caps for one gift
  const ACK_BATCH = 50;                          // the worker's ACK_IDS_MAX
  const KEYS = {
    session: 'portsolace.account',          // Account's stored sign-in {token, email}
    config: 'portsolace.account.config',    // Account's optional JSON override of the <meta> config
  };
  const PHONE_MQ = '(max-width: 760px), ((pointer: coarse) and (max-width: 1023px))';   // hud.js PHONE_MQ

  const state = {
    started: false, apiBase: '', lastAt: 0, lastOk: null, lastError: null, sends: 0,
    applied: [], acked: [], unacked: [], shown: 0, waiting: 0,
  };
  let inflight = null, timer = null, showTimer = null;
  let hiddenAt = null, missed = false;
  const toShow = [];                        // applied gifts the player has not seen yet
  const unsaved = new Set();                // applied in memory but the profile save failed: never acked until a save succeeds

  // ---------------------------------------------------------- small helpers (every browser global is optional)
  const hasDoc = () => typeof document !== 'undefined' && !!document;
  const unref = t => { if (t && typeof t.unref === 'function') t.unref(); return t; };   // node harnesses: timers never pin the process
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const int = (v, max) => Math.min(max, Math.max(0, Math.floor(num(v))));
  function storage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
  function readJson(key) {
    const s = storage(); if (!s) return null;
    try { const raw = s.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function account() { return typeof Account !== 'undefined' && Account ? Account : null; }
  function meta() {
    if (typeof Meta === 'undefined' || !Meta || !Meta.profile) return null;
    return typeof Meta.addCredits === 'function' && typeof Meta.addAM === 'function' && typeof Meta.grantEntitlement === 'function' ? Meta : null;
  }
  function hidden() { return hasDoc() && !!document.hidden; }

  // ---------------------------------------------------------- configuration: the same apiBase as Account
  function readTagBase() {
    if (!hasDoc() || typeof document.querySelector !== 'function') return '';
    const tag = document.querySelector('meta[name="portsolace-account"]');
    const content = tag && (typeof tag.getAttribute === 'function' ? tag.getAttribute('content') : tag.content);
    let base = '';
    if (content) { try { const v = JSON.parse(content); if (v && typeof v === 'object' && v.apiBase !== undefined) base = v.apiBase; } catch (e) { /* not JSON: unconfigured */ } }
    const override = readJson(KEYS.config);
    if (override && typeof override === 'object' && override.apiBase !== undefined) base = override.apiBase;
    return base;
  }
  function apiBase() {
    const a = account();
    let base;
    try { base = a && a.config && typeof a.config.apiBase === 'string' ? a.config.apiBase : readTagBase(); } catch (e) { base = readTagBase(); }
    base = String(base || '').trim().replace(/\/+$/, '');
    return /^https?:\/\/\S+$/.test(base) ? base : '';
  }
  // Bearer only while Account says it is signed in; the token is read where Account stores it.
  function bearer() {
    const a = account(); if (!a) return null;
    let signedIn = false;
    try { signedIn = !!(a.state && a.state.signedIn); } catch (e) { signedIn = false; }
    if (!signedIn) return null;
    const s = readJson(KEYS.session);
    return s && typeof s === 'object' && typeof s.token === 'string' && s.token ? s.token : null;
  }

  // ---------------------------------------------------------- what presence reports
  function playerId() {
    const m = typeof Meta !== 'undefined' && Meta && Meta.profile ? Meta : null;
    let id = m && m.profile.playerId ? String(m.profile.playerId) : '';
    if (!id && typeof Store !== 'undefined' && Store && typeof Store.playerId === 'function') { try { id = String(Store.playerId() || ''); } catch (e) { id = ''; } }
    return PLAYER_RE.test(id) ? id : '';
  }
  function localSummary(p) {
    const sectors = p && p.sectors && typeof p.sectors === 'object' && !Array.isArray(p.sectors) ? p.sectors : {};
    const active = p && typeof p.activeSector === 'string' && sectors[p.activeSector] && typeof sectors[p.activeSector] === 'object' ? sectors[p.activeSector] : null;
    return {
      name: String(active && active.name ? active.name : 'Unnamed station').slice(0, 40),
      day: num(active && active.day), level: num(active && active.level) || 1,
      rank: num(p && p.rank && p.rank.level) || 1, credits: num(p && p.credits), am: num(p && p.am),
      sectors: Math.max(p && Array.isArray(p.unlocked) ? p.unlocked.length : 0, Object.keys(sectors).length),
    };
  }
  function summary() {
    const m = typeof Meta !== 'undefined' && Meta && Meta.profile ? Meta : null;
    if (!m) return { name: '', day: 0, level: 0, rank: 0, credits: 0, am: 0, sectors: 0 };
    let s = null;
    const a = account();
    if (a && typeof a.summary === 'function') { try { s = a.summary(m.profile); } catch (e) { s = null; } }
    if (!s || typeof s !== 'object') s = localSummary(m.profile);
    let credits = s.credits;
    try { if (Number.isFinite(Number(m.credits))) credits = m.credits; } catch (e) { /* the profile's copy */ }   // the live wallet
    return {
      name: String(s.name == null ? '' : s.name).slice(0, 40),
      day: int(s.day, 1e12), level: int(s.level, 1e12), rank: int(s.rank, 1e12),
      credits: int(credits, 1e12), am: int(s.am, 1e12), sectors: int(s.sectors, 1e12),
    };
  }
  function platform() {
    try { if (typeof UI !== 'undefined' && UI && 'phone' in UI) return UI.phone ? 'phone' : 'desktop'; } catch (e) { /* fall through */ }
    try { if (typeof matchMedia === 'function') return matchMedia(PHONE_MQ).matches ? 'phone' : 'desktop'; } catch (e) { /* fall through */ }
    return 'desktop';
  }
  function version() {
    try { if (typeof GAME_VERSION === 'string') return GAME_VERSION.slice(0, 40); } catch (e) { /* no build string */ }   // no build string ships today: ''
    return '';
  }

  // ---------------------------------------------------------- HTTP (never throws to the caller)
  async function post(base, path, body, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctrl ? unref(setTimeout(() => ctrl.abort(), TIMEOUT_MS)) : null;
    try {
      const res = await fetch(base + path, {
        method: 'POST', headers, body: JSON.stringify(body), mode: 'cors', credentials: 'omit',
        signal: ctrl ? ctrl.signal : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) return { ok: false, why: (data && data.error) || `http-${res.status}`, status: res.status };
      return { ok: true, data: data || {} };
    } catch (err) {
      return { ok: false, why: 'offline' };
    } finally { if (t) clearTimeout(t); }
  }

  // ---------------------------------------------------------- applying gifts: once each, through Meta
  function historyHas(id) {
    const m = typeof Meta !== 'undefined' && Meta && Meta.profile ? Meta : null;
    const hist = m && m.profile.entitlements && m.profile.entitlements.history;
    return Array.isArray(hist) && hist.some(h => h === id || (h && (h.grantId === id || h.id === id)));
  }
  function cleanGift(g) {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !GIFT_ID_RE.test(g.id)) return null;
    return {
      id: g.id, credits: int(g.credits, MAX_CREDITS), am: int(g.am, MAX_AM),
      note: typeof g.note === 'string' ? g.note.slice(0, 140) : '',
      createdAt: Number.isFinite(Number(g.createdAt)) ? Number(g.createdAt) : null,
    };
  }
  // Meta.save() answers false when localStorage refuses the write (quota full, storage blocked).
  function saveProfile(m) {
    if (!m || typeof m.save !== 'function') return true;
    try { return m.save() !== false; } catch (e) { return false; }
  }
  // Returns {applied:[gift], already:[id], saved}; ids that could not be read are neither applied nor acked.
  // Each new gift's history entry carries acked:false until the server has confirmed the ack (see run()).
  function applyGifts(list) {
    const m = meta();
    const applied = [], already = [];
    if (!m) return { applied, already, saved: true, why: 'no-profile' };
    for (const raw of Array.isArray(list) ? list : []) {
      const g = cleanGift(raw); if (!g) continue;
      if (historyHas(g.id)) { if (!already.includes(g.id) && !applied.some(a => a.id === g.id)) already.push(g.id); continue; }
      if (g.credits > 0) m.addCredits(g.credits, 'gift');
      if (g.am > 0) m.addAM(g.am, 'gift');
      m.grantEntitlement('gift', { grantId: g.id, mode: 'gift', at: Date.now(), granted: { credits: g.credits, am: g.am }, note: g.note, acked: false });
      applied.push(g);
    }
    const saved = applied.length ? saveProfile(m) : true;
    return { applied, already, saved };
  }
  // Gift history entries the server has not confirmed yet (a lost ack, or a reload before it was sent).
  function giftHistory() {
    const m = typeof Meta !== 'undefined' && Meta && Meta.profile ? Meta : null;
    const hist = m && m.profile.entitlements && m.profile.entitlements.history;
    return Array.isArray(hist) ? hist.filter(h => h && typeof h === 'object' && h.mode === 'gift' && typeof h.grantId === 'string') : [];
  }
  const pendingAcks = () => giftHistory().filter(h => h.acked === false && GIFT_ID_RE.test(h.grantId)).map(h => h.grantId);
  function markAcked(ids) {
    let changed = false;
    for (const h of giftHistory()) if (h.acked === false && ids.includes(h.grantId)) { h.acked = true; changed = true; }
    if (changed) saveProfile(meta());
  }

  // ---------------------------------------------------------- the modal: one for every gift not yet shown
  function canShow() {
    if (typeof Overlays === 'undefined' || !Overlays || typeof Overlays.modal !== 'function' || !hasDoc()) return false;
    if (typeof Overlays.anyOpen === 'function' && Overlays.anyOpen()) return false;
    const body = document.body;
    if (body && typeof body.getAttribute === 'function' && body.getAttribute('data-screen') === 'title') return false;
    if (typeof Tutorial !== 'undefined' && Tutorial && Tutorial.active) return false;
    return true;
  }
  function scheduleShow() {
    if (!toShow.length || showTimer) return;
    if (canShow()) { show(); return; }
    state.waiting = toShow.length;
    showTimer = unref(setTimeout(() => { showTimer = null; scheduleShow(); }, SHOW_RETRY_MS));
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const fmtN = n => Math.round(num(n)).toLocaleString('en-US');
  function chipsNode(g) {
    const box = el('div', 'chips');
    // rewardChips builds its markup from the two integers alone (the game's credit and Antimatter icons)
    if (typeof Overlays !== 'undefined' && Overlays && typeof Overlays.rewardChips === 'function') {
      box.innerHTML = Overlays.rewardChips({ credits: int(g.credits, MAX_CREDITS), am: int(g.am, MAX_AM) });
    } else {
      if (g.credits > 0) box.appendChild(el('span', 'rchip amber', `${fmtN(g.credits)} cr`));
      if (g.am > 0) box.appendChild(el('span', 'rchip am', `${fmtN(g.am)} AM`));
    }
    return box;
  }
  function show() {
    const gifts = toShow.splice(0, toShow.length);
    state.waiting = 0;
    if (!gifts.length) return;
    Overlays.modal({
      kind: 'event', tag: 'Port Authority', title: 'A gift from the Port Solace crew', html: '', extra: '',
      actions: [{ label: gifts.length > 1 ? 'Thank you all' : 'Thank you', primary: true }],
      dismissible: true,
    });
    const host = document.getElementById('modal-text');
    if (host) {
      host.appendChild(el('p', null, gifts.length > 1 ? `${gifts.length} gifts were added to your station.` : 'Added to your station.'));
      for (const g of gifts) {
        const row = el('div', 'gift');
        row.appendChild(chipsNode(g));
        if (g.note) row.appendChild(el('p', 'gift-note', g.note));
        host.appendChild(row);
      }
    }
    state.shown += gifts.length;
  }

  // ---------------------------------------------------------- one check-in: presence -> apply -> ack -> show
  async function run() {
    const base = apiBase();
    state.apiBase = base;
    if (!base) return { ok: false, why: 'unconfigured' };
    const pid = playerId();
    if (!pid) return { ok: false, why: 'no-player' };
    state.lastAt = Date.now(); state.sends++;
    const body = { playerId: pid, summary: summary(), platform: platform(), version: version() };
    const r = await post(base, '/presence', body, bearer());
    if (!r.ok) { state.lastOk = false; state.lastError = r.why; return { ok: false, why: r.why }; }
    state.lastOk = true; state.lastError = null;
    const list = Array.isArray(r.data.gifts) ? r.data.gifts : [];
    const { applied, already, saved, why } = list.length ? applyGifts(list) : { applied: [], already: [], saved: true };
    if (why) return { ok: true, applied: [], already: [], acked: false, why };
    for (const g of applied) state.applied.push(g.id);
    if (applied.length) { toShow.push(...applied); scheduleShow(); }
    // A gift is acked only once it is in the stored profile: if the save failed, the server keeps offering it and a
    // reload re-applies it from scratch. An earlier unsaved gift is retried with the next save that succeeds.
    if (!saved) for (const g of applied) unsaved.add(g.id);
    else if (applied.length) unsaved.clear();
    else if (unsaved.size && saveProfile(meta())) unsaved.clear();
    // Outstanding acks go out on every check-in, gifts or not: this run's, earlier failures (state.unacked) and
    // history entries still marked acked:false (they survive a reload). The worker accepts an ack after a late
    // revoke and records the gift as applied, so the portal shows what the player really kept.
    const ids = [...new Set([...applied.map(g => g.id), ...already, ...state.unacked, ...pendingAcks()])].filter(id => !unsaved.has(id));
    let acked = false;
    if (ids.length) {
      const done = [];
      for (let i = 0; i < ids.length; i += ACK_BATCH) {          // the worker reads at most 50 ids per ack
        const batch = ids.slice(i, i + ACK_BATCH);
        const a = await post(base, '/gifts/ack', { playerId: pid, ids: batch });
        if (a.ok) done.push(...batch);
      }
      acked = done.length === ids.length;
      if (done.length) { state.acked.push(...done); state.unacked = state.unacked.filter(id => !done.includes(id)); markAcked(done); }
      for (const id of ids) if (!done.includes(id) && !state.unacked.includes(id)) state.unacked.push(id);
    }
    for (const id of unsaved) if (!state.unacked.includes(id)) state.unacked.push(id);
    return { ok: true, applied: applied.map(g => g.id), already, acked, saved, ackedIds: ids };
  }
  function checkNow() {
    if (inflight) return inflight;
    inflight = (async () => {
      try { return await run(); }
      catch (e) { state.lastOk = false; state.lastError = 'error'; return { ok: false, why: 'error' }; }
      finally { inflight = null; }
    })();
    return inflight;
  }

  // ---------------------------------------------------------- cadence
  function restartTimer() {
    if (timer) clearInterval(timer);
    timer = unref(setInterval(() => { if (hidden()) { missed = true; return; } checkNow(); }, INTERVAL_MS));
  }
  function onVisibility() {
    if (hidden()) { if (hiddenAt == null) hiddenAt = Date.now(); return; }
    const away = hiddenAt == null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (away >= INTERVAL_MS || missed) { missed = false; checkNow(); restartTimer(); }
  }
  function init() {
    if (state.started) return api;
    state.started = true;
    if (hasDoc() && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisibility);
    if (hidden()) hiddenAt = Date.now();
    restartTimer();
    checkNow();
    return api;
  }

  const api = {
    init,
    checkNow,
    get state() { return { ...state, applied: state.applied.slice(), acked: state.acked.slice(), unacked: state.unacked.slice(), inflight: !!inflight }; },
  };
  if (typeof window !== 'undefined' && window) window.Gifts = api;
  return api;
})();

// ============================================================
// WAYSTATION — Account: email + password sign-in and cloud saves (DESIGN2.md Addendum A2.1)
// Classic script; exposes the `Account` global. Loads after hud.js, before admin.js and main.js.
//
// One cloud save per account (the whole Meta.profile). Newest wins; when both sides moved since the
// last sync the HUD's chooser decides (Account.ui.choose). Nothing here touches the DOM.
//
// Integration:
//   main.js  awaits Account.boot() after Meta.init() and before the title (status 'cloud' means the
//            local profile was replaced; main re-reads it with Meta.load()).
//   H        sets Account.ui.choose({local:{summary, savedAt}, cloud:{summary, updatedAt}}) -> Promise<'local'|'cloud'>
//            and renders Account.state (listen to Account.on('state') or the Sim 'account' event); opens the portal's
//            "Set a new password" view when Account.resetToken is set (the ?reset= link from a "Forgot your password?" email).
//   Meta     export() / import(json) / save(now) / profile.savedAt; this file writes profile.cloud =
//            {version, syncedAt, userId} after every successful sync.
// ============================================================
'use strict';

const Account = (() => {
  const NOT_CONNECTED = 'Cloud saves are not connected yet';
  const KEYS = {
    session: 'waystation.account',          // {token, email}
    config: 'waystation.account.config',    // optional JSON override of the <meta> config (local testing)
  };
  const DEFAULTS = {
    apiBase: '',
    debounceMs: 20000,     // A2.1: push 20 s after the last `change`
    intervalMs: 60000,     // A2.1: and every 60 s while dirty (also retries while offline)
    timeoutMs: 15000,      // per request
    graceMs: 5000,         // savedAt may trail syncedAt by autosave noise; within this window local counts as unchanged
    gzipMin: 2048,         // compress bodies above this size (keeps the pagehide keepalive push under 64 KB)
  };
  const IMMEDIATE = {      // Sim events that push at once (A2.1 push policy)
    sector: d => d && d.state === 'switched',
    purchase: () => true,
    mission: d => d && d.state === 'claimed',
    achievement: d => d && d.state === 'claimed',
  };

  const config = { ...DEFAULTS };
  const state = {
    available: false, signedIn: false, user: null, syncing: false, dirty: false,
    lastSyncAt: null, lastError: null, cloud: null, conflict: false, offline: false,
  };
  const listeners = {};
  let session = null;        // {token, email}
  let inflight = null;       // the push promise currently running (never more than one)
  let queued = false;        // a change arrived while a push was in flight
  let applying = false;      // Meta.import in progress: its change events are not ours
  let bound = false;
  let debounceTimer = null, intervalTimer = null;

  class AccountError extends Error {
    constructor(code, message, status, data) { super(message); this.code = code; this.status = status || 0; this.data = data || null; }
  }

  // ---------------------------------------------------------- small helpers
  const hasDoc = () => typeof document !== 'undefined' && !!document;
  const hasWin = () => typeof window !== 'undefined' && !!window;
  function storage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
  function readJson(key, fallback) {
    const s = storage(); if (!s) return fallback;
    try { const raw = s.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    const s = storage(); if (!s) return;
    try { if (value == null) s.removeItem(key); else s.setItem(key, JSON.stringify(value)); } catch (e) { /* quota / private mode */ }
  }
  const snapshot = () => ({ ...state, user: state.user ? { ...state.user } : null, cloud: state.cloud ? { ...state.cloud } : null });
  const fail = (why, extra) => ({ ok: false, why, ...(extra || {}) });

  function meta() {
    if (typeof Meta === 'undefined' || !Meta || !Meta.profile) return null;
    return typeof Meta.export === 'function' && typeof Meta.import === 'function' ? Meta : null;
  }

  // ---------------------------------------------------------- events: Account bus + Sim bus `account` (A2.1)
  const SIM_STATES = new Set(['signed-in', 'signed-out', 'synced', 'conflict', 'error', 'offline']);
  function emit(evt, data) {
    (listeners[evt] || []).slice().forEach(fn => {
      try { fn(data); } catch (err) { setTimeout(() => { throw err; }, 0); }
    });
    if (SIM_STATES.has(evt) && typeof Sim !== 'undefined' && Sim && typeof Sim.emit === 'function') Sim.emit('account', { state: evt, ...(data || {}) });
  }
  function setState(patch) { Object.assign(state, patch); emit('state', snapshot()); }
  function on(evt, fn) { if (typeof fn === 'function') (listeners[evt] ||= []).push(fn); return api; }
  function off(evt, fn) { const l = listeners[evt]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return api; }

  // ---------------------------------------------------------- profile summary (mirrors workers/account/src/index.js summarise)
  function summarise(p) {
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const sectors = p && p.sectors && typeof p.sectors === 'object' && !Array.isArray(p.sectors) ? p.sectors : {};
    const active = p && typeof p.activeSector === 'string' && sectors[p.activeSector] && typeof sectors[p.activeSector] === 'object' ? sectors[p.activeSector] : null;
    let best = 0;
    for (const id in sectors) if (sectors[id] && typeof sectors[id] === 'object') best = Math.max(best, Math.floor(num(sectors[id].level)));
    const unlocked = p && Array.isArray(p.unlocked) ? p.unlocked.length : 0;
    return {
      name: String(active && active.name ? active.name : 'Unnamed station').slice(0, 40),
      day: Math.max(0, Math.floor(num(active && active.day))),
      level: Math.max(1, active ? Math.floor(num(active.level)) || best || 1 : best || 1),
      credits: Math.round(num(p && p.credits != null ? p.credits : active && active.credits)),
      am: Math.round(num(p && p.am)),
      sectors: Math.max(unlocked, Object.keys(sectors).length, 0),
      rank: Math.max(1, Math.floor(num(p && p.rank && p.rank.level)) || 1),
    };
  }
  // A profile nobody has played yet: replacing it with a cloud save loses nothing.
  function isFresh(p) {
    const st = (p && p.stats) || {};
    const sectors = p && p.sectors && typeof p.sectors === 'object' ? Object.keys(p.sectors).length : 0;
    return !(st.buildsPlaced > 0 || st.servedTotal > 0 || st.collects > 0 || st.missionsClaimed > 0 || sectors > 1);
  }
  function localSide() {
    const m = meta();
    return m ? { summary: summarise(m.profile), savedAt: m.profile.savedAt || 0, fresh: isFresh(m.profile) } : null;
  }

  // ---------------------------------------------------------- the sync marker on the profile: {version, syncedAt, userId}
  function marker() {
    const m = meta(); const c = m && m.profile.cloud;
    if (!c || typeof c !== 'object' || !state.user) return null;
    return c.userId === state.user.id ? c : null;             // a marker left by another account says nothing about this one
  }
  function setMarker(version, syncedAt) {
    const m = meta(); if (!m) return;
    m.profile.cloud = { version, syncedAt, userId: state.user ? state.user.id : null };
    if (typeof m.save === 'function') m.save(syncedAt);        // savedAt === syncedAt: local is "unchanged" until the next change
  }
  function clearMarker() { const m = meta(); if (m && m.profile.cloud) { m.profile.cloud = null; if (typeof m.save === 'function') m.save(); } }

  // ---------------------------------------------------------- configuration
  function readTagConfig() {
    if (!hasDoc() || typeof document.querySelector !== 'function') return {};
    const tag = document.querySelector('meta[name="waystation-account"]');
    const content = tag && (typeof tag.getAttribute === 'function' ? tag.getAttribute('content') : tag.content);
    if (!content) return {};
    try { const v = JSON.parse(content); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
  }
  function configure(opts = {}) {
    const next = { ...config };
    const apply = o => {
      if (o.apiBase !== undefined) next.apiBase = String(o.apiBase || '').trim().replace(/\/+$/, '');
      for (const k of ['debounceMs', 'intervalMs', 'timeoutMs', 'graceMs', 'gzipMin']) if (o[k] !== undefined) next[k] = Math.max(0, Number(o[k]) || 0);
    };
    apply(opts || {});
    const override = readJson(KEYS.config, null);
    if (override && typeof override === 'object') apply(override);
    Object.assign(config, next);
    setState({ available: /^https?:\/\/\S+$/.test(config.apiBase) });
    if (state.signedIn) startInterval();
    return api;
  }

  // ---------------------------------------------------------- session
  function loadSession() {
    const s = readJson(KEYS.session, null);
    session = s && typeof s === 'object' && typeof s.token === 'string' && s.token ? { token: s.token, email: String(s.email || '') } : null;
    return session;
  }
  function setSignedIn(user, token) {
    if (token) { session = { token, email: user.email }; writeJson(KEYS.session, session); }
    setState({ signedIn: true, user: { id: user.id, email: user.email }, conflict: false, lastError: null });
    startInterval();
    emit('signed-in', { user: { ...state.user } });
  }
  function setSignedOut(reason) {
    session = null; writeJson(KEYS.session, null);
    stopTimers(); queued = false;
    setState({ signedIn: false, user: null, cloud: null, conflict: false, dirty: false, syncing: false, offline: false });
    emit('signed-out', { reason });
    if (reason === 'expired' && typeof UI !== 'undefined' && UI && typeof UI.toast === 'function') {
      UI.toast('Your cloud sign-in expired. Sign in again to keep saving to the cloud.', 'warn');
    }
  }

  // ---------------------------------------------------------- HTTP
  async function encodeBody(obj) {
    const json = JSON.stringify(obj);
    if (typeof CompressionStream === 'function' && typeof Blob === 'function' && typeof Response === 'function' && json.length >= config.gzipMin) {
      try {
        const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
        return { body: await new Response(stream).arrayBuffer(), headers: { 'content-type': 'application/gzip' } };
      } catch (e) { /* plain JSON below */ }
    }
    return { body: json, headers: { 'content-type': 'application/json' } };
  }

  async function call(path, o = {}) {
    if (!state.available) throw new AccountError('unavailable', NOT_CONNECTED);
    const headers = {};
    if (o.auth !== false && session && session.token) headers.authorization = `Bearer ${session.token}`;
    let body;
    if (o.body !== undefined) { const enc = await encodeBody(o.body); body = enc.body; Object.assign(headers, enc.headers); }
    const ctrl = typeof AbortController === 'function' && !o.keepalive && config.timeoutMs > 0 ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), config.timeoutMs) : null;
    let res;
    try {
      res = await fetch(config.apiBase + path, {
        method: o.method || 'GET', headers, body, mode: 'cors', credentials: 'omit',
        keepalive: !!o.keepalive, signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (err) {
      throw new AccountError('offline', 'Could not reach the cloud save service.');
    } finally { if (timer) clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new AccountError((data && data.error) || `http-${res.status}`, (data && data.message) || `The cloud save service answered ${res.status}.`, res.status, data);
    return data || {};
  }

  // ---------------------------------------------------------- pull and push (the two primitives)
  async function doPull() {
    const m = meta(); if (!m) throw new AccountError('no-profile', 'The game has not loaded a profile yet.');
    const data = await call('/save');
    applying = true;
    let r;
    try { r = m.import(data.profile); } finally { applying = false; }
    if (!r || !r.ok) throw new AccountError('bad-cloud-save', (r && r.why) || 'The cloud save could not be read.');
    const now = Date.now();
    setMarker(data.version, now);
    setState({ cloud: { version: data.version, updatedAt: data.updatedAt, summary: data.summary || summarise(data.profile) }, dirty: false, conflict: false, offline: false, lastError: null, lastSyncAt: now });
    queued = false;
    emit('synced', { direction: 'pull', version: data.version, updatedAt: data.updatedAt });
    return { ok: true, direction: 'pull', version: data.version };
  }

  async function doPush(o = {}) {
    const m = meta(); if (!m) throw new AccountError('no-profile', 'The game has not loaded a profile yet.');
    let profile;
    try { profile = JSON.parse(m.export()); } catch (e) { throw new AccountError('bad-profile', 'The local profile could not be exported.'); }
    delete profile.cloud;                                     // the marker is per browser, not part of the save
    const mk = marker();
    const baseVersion = o.baseVersion != null ? o.baseVersion : mk ? mk.version : state.cloud ? state.cloud.version : 0;
    const data = await call('/save', { method: 'PUT', body: { profile, baseVersion }, keepalive: !!o.keepalive });
    const now = Date.now();
    setMarker(data.version, now);
    setState({ cloud: { version: data.version, updatedAt: data.updatedAt, summary: data.summary || summarise(profile) }, dirty: queued, conflict: false, offline: false, lastError: null, lastSyncAt: now });
    emit('synced', { direction: 'push', version: data.version, updatedAt: data.updatedAt });
    return { ok: true, direction: 'push', version: data.version };
  }

  // One push in flight at a time; a request during a flight runs again afterwards.
  function runPush(o = {}) {
    if (!state.available) return Promise.resolve(fail(NOT_CONNECTED));
    if (!state.signedIn) return Promise.resolve(fail('Not signed in', { code: 'signed-out' }));
    if (!meta()) return Promise.resolve(fail('The game has not loaded a profile yet', { code: 'no-profile' }));
    if (state.conflict && !o.force) return Promise.resolve(fail('Choose which save to keep first', { code: 'conflict', status: 'conflict' }));
    if (inflight) { queued = true; return inflight; }
    clearDebounce();
    inflight = (async () => {
      setState({ syncing: true }); emit('syncing', { busy: true });
      try { return await doPush(o); }
      catch (err) { return handleSyncError(err, 'push', o); }
      finally {
        inflight = null;
        setState({ syncing: false }); emit('syncing', { busy: false });
        if (queued) { queued = false; if (state.signedIn && !state.conflict) { state.dirty = true; scheduleDebounce(); } }
      }
    })();
    return inflight;
  }

  async function runPull() {
    if (!state.available) return fail(NOT_CONNECTED);
    if (!state.signedIn) return fail('Not signed in', { code: 'signed-out' });
    if (inflight) { try { await inflight; } catch (e) { /* reported by the push */ } }
    setState({ syncing: true }); emit('syncing', { busy: true });
    try { return await doPull(); }
    catch (err) { return handleSyncError(err, 'pull', {}); }
    finally { setState({ syncing: false }); emit('syncing', { busy: false }); }
  }

  // Maps an HTTP failure to state and events. 401 -> signed out; 409 -> chooser; network -> offline.
  async function handleSyncError(err, direction, o) {
    const code = err.code || 'error';
    if (err.status === 401) { setSignedOut('expired'); return fail('Your sign-in expired', { code: 'signed-out' }); }
    if (err.status === 409 && !o.noResolve) {
      const server = (err.data && err.data.server) || { version: 0, updatedAt: null, summary: null };
      setState({ cloud: { version: server.version, updatedAt: server.updatedAt, summary: server.summary }, conflict: true });
      emit('conflict', { local: localSide(), cloud: state.cloud ? { ...state.cloud } : null });
      return resolveConflict();
    }
    if (code === 'offline') {
      setState({ offline: true, lastError: 'offline' });
      emit('offline', { direction });
      return fail('offline', { code: 'offline', status: 'offline' });
    }
    if (code === 'too-large') setState({ dirty: false });     // retrying every minute cannot help; the next change tries again
    setState({ lastError: code });
    emit('error', { code, message: err.message, direction, status: err.status || 0 });
    return fail(err.message, { code, status: err.status || 0 });
  }

  // Both sides moved: ask the HUD (default: the newest, and the cloud when the local profile is untouched).
  async function choose() {
    const local = localSide(), cloud = state.cloud ? { ...state.cloud } : null;
    const hook = api.ui && typeof api.ui.choose === 'function' ? api.ui.choose : null;
    if (hook) { try { return await hook({ local, cloud }); } catch (e) { return null; } }
    if (!cloud) return 'local';
    if (!local || local.fresh) return 'cloud';
    const ct = cloud.updatedAt ? Date.parse(cloud.updatedAt) || 0 : 0;
    return ct > (local.savedAt || 0) ? 'cloud' : 'local';
  }
  async function resolveConflict() {
    const choice = await choose();
    try {
      if (choice === 'cloud') return { ...(await doPull()), choice };
      if (choice === 'local') return { ...(await doPush({ baseVersion: state.cloud ? state.cloud.version : 0 })), choice };
    } catch (err) { return handleSyncError(err, choice === 'cloud' ? 'pull' : 'push', { noResolve: true }); }
    return fail('Choose which save to keep', { code: 'conflict', status: 'conflict', choice: choice || null });
  }

  // ---------------------------------------------------------- reconcile (boot, sign-in, Sync now)
  async function reconcile(o = {}) {
    let me;
    try { me = await call('/me'); }
    catch (err) {
      if (err.status === 401) { setSignedOut('expired'); return { status: 'none', why: 'expired' }; }
      setState({ offline: err.code === 'offline', lastError: err.code || 'error' });
      if (err.code === 'offline') emit('offline', { direction: 'me' }); else emit('error', { code: err.code, message: err.message, direction: 'me' });
      return { status: 'offline', why: err.message };
    }
    if (!state.signedIn) setSignedIn(me.user);
    else setState({ user: { id: me.user.id, email: me.user.email } });
    const cloud = me.save ? { version: me.save.version, updatedAt: me.save.updatedAt, summary: me.save.summary, size: me.save.size } : null;
    setState({ cloud, offline: false, lastError: null });
    const m = meta();
    if (!m) return { status: cloud ? 'cloud' : 'none', why: 'no-profile' };

    if (!cloud) {                                             // first sync: the local profile becomes the cloud save
      const r = await runPush({ baseVersion: 0, force: true });
      return { status: r.ok ? 'local' : r.status || 'local', pushed: !!r.ok, why: r.ok ? undefined : r.why };
    }
    const mk = marker();
    const local = localSide();
    const localMoved = state.dirty || !mk || (local.savedAt || 0) > (mk.syncedAt || 0) + config.graceMs;   // dirty = a change since the last successful push
    const cloudMoved = !mk || cloud.version !== mk.version;
    if (local.fresh && cloudMoved) return outcome(await runPull(), 'cloud');     // nothing to lose here: take the cloud save
    if (!cloudMoved && !localMoved) return { status: 'local', inSync: true };
    if (cloudMoved && !localMoved) return outcome(await runPull(), 'cloud');
    if (localMoved && !cloudMoved) return outcome(await runPush({ baseVersion: cloud.version, force: true }), 'local');
    setState({ conflict: true });
    emit('conflict', { local, cloud: { ...cloud } });
    const r = await resolveConflict();
    return { ...outcome(r, r.direction === 'pull' ? 'cloud' : 'local'), choice: r.choice || null, conflict: true };
  }
  const outcome = (r, okStatus) => (r.ok ? { status: okStatus } : { status: r.status || (r.code === 'offline' ? 'offline' : r.code === 'signed-out' ? 'none' : 'local'), why: r.why });

  // ---------------------------------------------------------- push policy (A2.1): debounce, immediate beats, interval, pagehide
  function markDirty() {
    if (applying || !state.signedIn || !state.available) return;
    state.dirty = true;
    if (inflight) { queued = true; return; }
    if (state.conflict) return;
    scheduleDebounce();
  }
  const unref = t => { if (t && typeof t.unref === 'function') t.unref(); return t; };   // node harnesses: timers never pin the process
  function scheduleDebounce() {
    clearDebounce();
    debounceTimer = unref(setTimeout(() => { debounceTimer = null; if (state.dirty) runPush(); }, config.debounceMs));
  }
  function clearDebounce() { if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; } }
  function startInterval() {
    stopInterval();
    if (config.intervalMs > 0) intervalTimer = unref(setInterval(tick, config.intervalMs));
  }
  function stopInterval() { if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; } }
  function stopTimers() { clearDebounce(); stopInterval(); }
  function tick() {
    if (!state.signedIn || inflight || !state.available) return;
    if (state.offline) { reconcile().catch(() => {}); return; }
    if (state.dirty && !state.conflict) runPush();
  }
  function flushOnHide() {
    if (!state.signedIn || state.conflict || !(state.dirty || queued)) return;
    runPush({ keepalive: true }).catch(() => {});
  }
  function bindOnce() {
    if (bound) return; bound = true;
    if (typeof Sim !== 'undefined' && Sim && typeof Sim.on === 'function') {
      Sim.on('change', markDirty);
      for (const evt in IMMEDIATE) Sim.on(evt, d => { if (applying || !IMMEDIATE[evt](d)) return; markDirty(); if (state.signedIn && !state.conflict) runPush(); });
    }
    if (hasWin() && typeof window.addEventListener === 'function') window.addEventListener('pagehide', flushOnHide);
    if (hasDoc() && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', () => { if (document.hidden) flushOnHide(); });
  }

  // ---------------------------------------------------------- public API (A2.1)
  const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/.test(String(e || '').trim());
  const cleanEmail = e => String(e || '').trim().toLowerCase();
  const unavailable = () => fail(NOT_CONNECTED, { code: 'unavailable' });
  const netFail = err => fail(err.message, { code: err.code, status: err.status || 0, retryAfter: err.data && err.data.retryAfter });

  async function boot() {
    bindOnce();
    if (!state.available) return { status: 'none', why: NOT_CONNECTED };
    if (!loadSession()) return { status: 'none' };
    return reconcile();
  }

  async function signup(email, password) {
    bindOnce();
    if (!state.available) return unavailable();
    if (!validEmail(email)) return fail('Enter a valid email address', { code: 'bad-email' });
    if (typeof password !== 'string' || password.length < 10) return fail('Use a password of at least 10 characters', { code: 'weak-password' });
    let data;
    try { data = await call('/signup', { method: 'POST', auth: false, body: { email: cleanEmail(email), password } }); }
    catch (err) { return netFail(err); }
    clearMarker();
    setSignedIn(data.user, data.token);
    const r = meta() ? await runPush({ baseVersion: 0, force: true }) : fail('no-profile');
    return { ok: true, recovery: data.recovery, user: { ...state.user }, status: r.ok ? 'local' : r.status || 'local' };
  }

  async function login(email, password) {
    bindOnce();
    if (!state.available) return unavailable();
    if (!validEmail(email)) return fail('Enter a valid email address', { code: 'bad-email' });
    if (typeof password !== 'string' || !password) return fail('Enter your password', { code: 'bad-password' });
    let data;
    try { data = await call('/login', { method: 'POST', auth: false, body: { email: cleanEmail(email), password } }); }
    catch (err) { return netFail(err); }
    setSignedIn(data.user, data.token);
    const r = await reconcile({ afterSignIn: true });
    return { ok: true, user: { ...state.user }, status: r.status, choice: r.choice || null, why: r.why };
  }

  async function recover(email, phrase, newPassword) {
    bindOnce();
    if (!state.available) return unavailable();
    if (!validEmail(email)) return fail('Enter a valid email address', { code: 'bad-email' });
    if (typeof phrase !== 'string' || phrase.trim().split(/\s+/).length < 10) return fail('Enter all ten words of your recovery phrase', { code: 'bad-recovery' });
    if (typeof newPassword !== 'string' || newPassword.length < 10) return fail('Use a new password of at least 10 characters', { code: 'weak-password' });
    let data;
    try { data = await call('/recover', { method: 'POST', auth: false, body: { email: cleanEmail(email), recovery: phrase, newPassword } }); }
    catch (err) { return netFail(err); }
    setSignedIn(data.user, data.token);
    const r = await reconcile({ afterSignIn: true });
    return { ok: true, recovery: data.recovery, user: { ...state.user }, status: r.status, choice: r.choice || null };
  }

  // ---------------------------------------------------------- password reset by email: "Forgot your password?" and the ?reset= link
  // The backend always answers /forgot with {ok:true}; it never says whether the address has an account.
  async function forgot(email) {
    if (!state.available) return unavailable();
    if (!validEmail(email)) return fail('Enter a valid email address', { code: 'bad-email' });
    try { await call('/forgot', { method: 'POST', auth: false, body: { email: cleanEmail(email) } }); }
    catch (err) { return netFail(err); }
    return { ok: true };
  }

  // The link in the email opens PLAY_URL?reset=<token>; the token is captured once at load and taken out of the
  // address bar so a reload or a shared screenshot does not carry it. The HUD reads Account.resetToken.
  const RESET_RE = /^[A-Za-z0-9_-]{32,128}$/;
  let resetToken = null;
  function captureResetToken() {
    if (!hasWin() || !window.location || typeof window.location.search !== 'string' || !window.location.search) return null;
    let tok = null;
    try { tok = new URLSearchParams(window.location.search).get('reset'); } catch (e) { return null; }
    if (tok == null) return null;
    resetToken = RESET_RE.test(tok) ? tok : null;
    try {
      const h = window.history;
      if (h && typeof h.replaceState === 'function') {
        const u = new URL(window.location.href);
        u.searchParams.delete('reset');
        h.replaceState(h.state == null ? null : h.state, '', u.pathname + u.search + u.hash);
      }
    } catch (e) { /* a malformed location: leave the address bar alone */ }
    return resetToken;
  }

  async function reset(token, newPassword) {
    bindOnce();
    if (!state.available) return unavailable();
    if (typeof token !== 'string' || !RESET_RE.test(token)) return fail('This reset link is not valid. Ask for a new one.', { code: 'bad-token' });
    if (typeof newPassword !== 'string' || newPassword.length < 10) return fail('Use a new password of at least 10 characters', { code: 'weak-password' });
    let data;
    try { data = await call('/reset', { method: 'POST', auth: false, body: { token, newPassword } }); }
    catch (err) { return netFail(err); }
    if (resetToken === token) resetToken = null;
    setSignedIn(data.user, data.token);
    const r = await reconcile({ afterSignIn: true });
    return { ok: true, recovery: data.recovery, user: { ...state.user }, status: r.status, choice: r.choice || null };
  }

  async function logout() {
    if (!state.available) return unavailable();
    if (!state.signedIn && !session) return { ok: true };
    try { await call('/logout', { method: 'POST' }); } catch (e) { /* the local sign-out happens regardless */ }
    setSignedOut('user');
    return { ok: true };
  }

  async function deleteAccount(password) {
    if (!state.available) return unavailable();
    if (!state.signedIn) return fail('Not signed in', { code: 'signed-out' });
    if (typeof password !== 'string' || !password) return fail('Enter your password', { code: 'bad-password' });
    try { await call('/account', { method: 'DELETE', body: { password } }); }
    catch (err) { if (err.status === 401 && err.code === 'unauthorised') setSignedOut('expired'); return netFail(err); }
    clearMarker();
    setSignedOut('deleted');
    return { ok: true };
  }

  async function syncNow() {
    if (!state.available) return unavailable();
    if (!state.signedIn) return fail('Not signed in', { code: 'signed-out' });
    const r = await reconcile();
    return { ok: r.status !== 'offline' && r.status !== 'conflict' && r.status !== 'none', status: r.status, why: r.why, choice: r.choice || null };
  }

  const api = {
    ui: { choose: null },                                     // H sets Account.ui.choose({local, cloud}) -> Promise<'local'|'cloud'>
    configure,
    boot,
    signup, login, logout, recover, deleteAccount,
    forgot, reset,
    get resetToken() { return resetToken; },                 // the token from ?reset=<token>, until it is used or cleared
    clearResetToken() { resetToken = null; return api; },
    syncNow,
    pull: () => runPull(),
    // "Keep this browser's": overwrite the newest cloud version we know of (state.cloud is never behind the marker)
    push: () => runPush({ force: true, baseVersion: state.cloud ? state.cloud.version : marker() ? marker().version : 0 }),
    summary: p => summarise(p == null && meta() ? meta().profile : p),
    on, off,
    get state() { return snapshot(); },
    get available() { return state.available; },
    get config() { return { ...config }; },
    get session() { return session ? { email: session.email, hasToken: !!session.token } : null; },
    NOT_CONNECTED,
  };

  configure(readTagConfig());
  captureResetToken();
  if (hasDoc() && document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => configure(readTagConfig()), { once: true });
  }
  return api;
})();

// ============================================================
// PORT SOLACE — Account: email + password sign-in and cloud saves (DESIGN2.md Addendum A2.1)
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
//
// Signed in on the Build the Ages hub (only where the page carries <meta name="bta-hub">, which the bta-space Worker adds
// at space.buildtheages.com, and only with authBase in the portsolace-account tag): boot() makes one quiet visit to
// <authBase>/authorize?prompt=none, the hand-off every Build the Ages world uses (buildtheages workers/account/src/handoff.js),
// and swaps the code that comes back at /handoff/exchange for the usual token. Port Solace keeps its own sign-in form;
// portsolace.com has no hub tag and never runs any of this. The quiet visit happens at most once per browser session, unless
// the hub says it has just signed in (?sso=1 on its links), or the token kept here has expired; never after the player signed
// out here, unless the hub says so; never with a reset link, a purchase or a hand-off answer in the address; never in a frame.
// ============================================================
'use strict';

const Account = (() => {
  const NOT_CONNECTED = 'Cloud saves are not connected yet';
  const KEYS = {
    session: 'portsolace.account',          // {token, email}
    config: 'portsolace.account.config',    // optional JSON override of the <meta> config (local testing)
    signedOut: 'portsolace.account.signedOut',   // hub hand-off only: this player signed out here, so no quiet sign-in back
  };
  const SESSION_KEYS = {                     // sessionStorage, hub hand-off only
    state: 'portsolace.account.state',       // the state sent to /authorize
    tried: 'portsolace.account.silent',      // a quiet visit to /authorize already happened in this browser session
  };
  const HANDOFF_GAME = 'portsolace';         // this game's id in the Build the Ages registry (workers/shared/games.js)
  const SILENT_WAIT_MS = 2500;               // how long the title may wait on the /health check before the quiet visit
  const SILENT_GIVE_UP_MS = 4000;            // if the browser has not left by then, the game carries on
  // Query parameters a quiet visit may carry there and back. Anything else (a reset link, a checkout's return, a hand-off
  // answer) is something this page has to deal with first, so the visit waits for the next load.
  const QUIET_OK = /^(app|sso|ref|gclid|fbclid|msclkid|utm_[a-z]+)$/;
  const DEFAULTS = {
    apiBase: '',
    authBase: '',          // the Build the Ages accounts host, for the hub hand-off (header); empty: no hand-off
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
    const tag = document.querySelector('meta[name="portsolace-account"]');
    const content = tag && (typeof tag.getAttribute === 'function' ? tag.getAttribute('content') : tag.content);
    if (!content) return {};
    try { const v = JSON.parse(content); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
  }
  function configure(opts = {}) {
    const next = { ...config };
    const apply = o => {
      if (o.apiBase !== undefined) next.apiBase = String(o.apiBase || '').trim().replace(/\/+$/, '');
      if (o.authBase !== undefined) next.authBase = String(o.authBase || '').trim().replace(/\/+$/, '');
      for (const k of ['debounceMs', 'intervalMs', 'timeoutMs', 'graceMs', 'gzipMin']) if (o[k] !== undefined) next[k] = Math.max(0, Number(o[k]) || 0);
    };
    apply(opts || {});
    const override = readJson(KEYS.config, null);
    if (override && typeof override === 'object') apply(override);
    Object.assign(config, next);
    // The App Store app's first version has no sign-in (store.js shell 'ios'): Apple lets a game use what was bought on
    // the web only if it also sells it through in-app purchase, so the cloud save, which carries those purchases, waits
    // for that. Unavailable hides every sign-in control and nudge; the game saves on the device as a guest's does.
    const noAccountHere = typeof Store !== 'undefined' && !!Store && Store.shell === 'ios';
    setState({ available: !noAccountHere && /^https?:\/\/\S+$/.test(config.apiBase) });
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
    /*qa:L2user*/ if (!user || typeof user !== 'object' || !user.id) { const e = new Error('The account service gave an answer the game could not read. Please try again.'); e.code = 'bad-answer'; throw e; }
    if (token) { session = { token, email: user.email }; writeJson(KEYS.session, session); if (hubHandoff()) writeJson(KEYS.signedOut, null); }
    setState({ signedIn: true, user: { id: user.id, email: user.email }, conflict: false, lastError: null });
    startInterval();
    emit('signed-in', { user: { ...state.user } });
  }
  function setSignedOut(reason) {
    clearRefused();   /*qa:refusedOut*/ // it belonged to this account's cloud save
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
      res = await fetch((o.base || config.apiBase) + path, {
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
  var pullRefused = false;   /*qa:pullVar*/ // (var: setSignedOut, defined above, may run before this line)
  /*qa:refused*/ // ...and across visits: the version of a cloud save this device could not read. While the cloud still holds that
  // version, nothing but the player's own choice writes over it (doPush).
  const REFUSED_KEY = 'portsolace.account.refused';
  function isRefused() { if (pullRefused) return true; const r = readJson(REFUSED_KEY, null); return !!(r && state.cloud && typeof r.version === 'number' && r.version === state.cloud.version); }
  function setRefused(version) { pullRefused = true; if (typeof version === 'number') writeJson(REFUSED_KEY, { version, at: Date.now() }); }
  function clearRefused() { pullRefused = false; try { localStorage.removeItem(REFUSED_KEY); } catch (e) { /* storage is blocked */ } }
  async function doPull() {
    const m = meta(); if (!m) throw new AccountError('no-profile', 'The game has not loaded a profile yet.');
    const data = await call('/save');
    /*qa:pullAnswer*/ if (!data || typeof data !== 'object' || !data.profile || typeof data.version !== 'number') throw new AccountError('bad-answer', 'The cloud save service gave an answer the game could not read.');
    applying = true;
    let r;
    try { r = m.import(data.profile); } finally { applying = false; }
    /*qa:pullRefused*/ // A cloud save this device cannot read is left exactly as it is: no automatic push may write the local station
    // over it (runPush). Only the player's own "keep this one" does.
    if (!r || !r.ok) { /*qa:refusedSet*/ setRefused(data.version); throw new AccountError('bad-cloud-save', 'The cloud save could not be read on this device, so it is left as it is. You are playing the station saved here.'); }
    clearRefused();   /*qa:refusedOk*/
    const now = Date.now();
    setMarker(data.version, now);
    setState({ cloud: { version: data.version, updatedAt: data.updatedAt, summary: data.summary || summarise(data.profile) }, dirty: false, conflict: false, offline: false, lastError: null, lastSyncAt: now });
    queued = false;
    emit('synced', { direction: 'pull', version: data.version, updatedAt: data.updatedAt });
    return { ok: true, direction: 'pull', version: data.version };
  }

  async function doPush(o = {}) {
    const m = meta(); if (!m) throw new AccountError('no-profile', 'The game has not loaded a profile yet.');
    /*qa:refusedDoPush*/ // every push comes through here, the conflict's default answer included (resolveConflict): only a push the
    // player asked for (force, or chosen in the chooser) may replace a cloud save this device could not read
    if (!o.force && !o.chosen && isRefused()) throw new AccountError('bad-cloud-save', 'Your cloud save could not be read on this device, so it is left as it is. You are playing the station saved here.');
    let profile;
    try { profile = JSON.parse(m.export()); } catch (e) { throw new AccountError('bad-profile', 'The local profile could not be exported.'); }
    delete profile.cloud;                                     // the marker is per browser, not part of the save
    const mk = marker();
    const baseVersion = o.baseVersion != null ? o.baseVersion : mk ? mk.version : state.cloud ? state.cloud.version : 0;
    const data = await call('/save', { method: 'PUT', body: { profile, baseVersion }, keepalive: !!o.keepalive });
    /*qa:pushAnswer*/ // without a version in the answer nothing says the save was stored
    if (!data || typeof data !== 'object' || typeof data.version !== 'number') throw new AccountError('bad-answer', 'The cloud save service gave an answer the game could not read.');
    const now = Date.now();
    clearRefused();   /*qa:pullClear*/ /*qa:refusedPush*/ // the service took this station: the cloud save is readable again
    setMarker(data.version, now);
    setState({ cloud: { version: data.version, updatedAt: data.updatedAt, summary: data.summary || summarise(profile) }, dirty: queued, conflict: false, offline: false, lastError: null, lastSyncAt: now });
    emit('synced', { direction: 'push', version: data.version, updatedAt: data.updatedAt });
    return { ok: true, direction: 'push', version: data.version };
  }

  // One push in flight at a time; a request during a flight runs again afterwards.
  function runPush(o = {}) {
    /*qa:pullGuard*/ /*qa:refusedGuard*/ if (!o.force && isRefused()) return Promise.resolve(fail('The cloud save could not be read on this device and is left as it is', { code: 'bad-cloud-save' }));
    /*qa:trial*/ if (typeof Meta !== 'undefined' && Meta && Meta._trial) return Promise.resolve(fail('The save is being checked', { code: 'trial' }));   // an import still on trial (meta.js import)
    /*qa:H1push*/ if (typeof Meta !== 'undefined' && Meta && Meta.stoodDown) return Promise.resolve(fail('This game is open in another tab, which holds the save', { code: 'stood-down' }));
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
    /*qa:newest*/ // "The newest" is judged by when this device last saved before this start. (The start itself stamps the save with
    // now, which made the local side win every time: a device that had lain unused wrote its old save over the newer
    // cloud save.) Within two minutes the local one stays: the two times are not read from the same clock.
    const m = meta(), mine = m && m._asLoaded ? m._asLoaded.savedAt || 0 : (local.savedAt || 0);
    return ct > mine + 120000 ? 'cloud' : 'local';
  }
  async function resolveConflict() {
    const choice = await choose();
    try {
      if (choice === 'cloud') return { ...(await doPull()), choice };
      /*qa:refusedChoice*/ // chosen: the player picked it in the chooser (with no chooser up, "local" is only the default answer)
      if (choice === 'local') return { ...(await doPush({ baseVersion: state.cloud ? state.cloud.version : 0, chosen: !!(api.ui && typeof api.ui.choose === 'function') })), choice };
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
    /*qa:L2me*/ // a 200 that is not the service's answer (a Wi-Fi sign-in page): the same as not reaching it
    if (!me || typeof me !== 'object' || !me.user || !me.user.id) {
      setState({ offline: true, lastError: 'bad-answer' });
      emit('offline', { direction: 'me' });
      return { status: 'offline', why: 'The cloud save service gave an answer the game could not read.' };
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
    /*qa:ownPush*/ // The last push of a visit goes out as the page closes, and its answer never comes back: at the next start the
    // cloud's version is one this device does not know, though the save is its own. When the cloud holds exactly the save
    // this device had when the game opened, the cloud has not moved.
    const loaded = m._asLoaded && m._asLoaded.profile ? summarise(m._asLoaded.profile) : null;
    const ownPush = !!(loaded && cloud.summary && ['name', 'day', 'level', 'credits', 'am', 'sectors', 'rank'].every(k => loaded[k] === cloud.summary[k]));
    if (m._asLoaded) m._asLoaded.profile = null;              // only its time is needed from here on (choose())
    const localMoved = state.dirty || !mk || (local.savedAt || 0) > (mk.syncedAt || 0) + config.graceMs;   // dirty = a change since the last successful push
    const cloudMoved = (!mk || cloud.version !== mk.version) && !ownPush;
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

  // ---------------------------------------------------------- the Build the Ages hub hand-off (header; only with the hub tag)
  function hubTag() {
    if (!hasDoc() || typeof document.querySelector !== 'function') return false;
    try { return !!document.querySelector('meta[name="bta-hub"]'); } catch (e) { return false; }
  }
  const hubHandoff = () => state.available && /^https:\/\/\S+$/.test(config.authBase) && hubTag();
  function sessionStore() { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch (e) { return null; } }
  function cleanAddress(keys) {
    try {
      const h = window.history;
      if (!h || typeof h.replaceState !== 'function') return;
      const u = new URL(window.location.href);
      for (const k of keys) u.searchParams.delete(k);
      h.replaceState(h.state == null ? null : h.state, '', u.pathname + u.search + u.hash);
    } catch (e) { /* a malformed location: leave the address bar alone */ }
  }
  const query = () => { try { return new URLSearchParams(hasWin() && window.location && typeof window.location.search === 'string' ? window.location.search : ''); } catch (e) { return new URLSearchParams(''); } };

  // Taken once at load, and out of the address bar: the hub's "signed in just now" (?sso=1) and the answer from /authorize.
  let hinted = false;        // the hub sent the player here signed in
  let returned = null;       // {code} after a matching state
  function captureHandoff() {
    if (!hubHandoff() || !hasWin() || !window.location) return;
    const q = query();
    if (q.has('sso')) { hinted = q.get('sso') === '1'; cleanAddress(['sso']); }
    if (!q.has('code') && !q.has('error')) return;
    if (!q.has('state')) return;                             // not an answer from /authorize: not ours to touch
    const ss = sessionStore();
    let expected = null;
    if (ss) { try { expected = ss.getItem(SESSION_KEYS.state); ss.removeItem(SESSION_KEYS.state); } catch (e) { expected = null; } }
    const code = q.get('code');
    if (code && expected && q.get('state') === expected) returned = { code };
    cleanAddress(['code', 'state', 'error']);
  }

  /*qa:L9var*/ let handoffError = null;
  async function finishHandoff() {
    const { code } = returned;
    returned = null;
    let data;
    try { data = await call('/handoff/exchange', { method: 'POST', auth: false, base: config.authBase, body: { code, game: HANDOFF_GAME } }); }
    catch (err) {
      setState({ lastError: err.code || 'error' });
      /*qa:L9*/ handoffError = { code: err.code || 'error', status: err.status || 0 };   // the HUD is not listening yet: it asks for this when it starts
      emit('error', { code: err.code, message: err.message, direction: 'handoff', status: err.status || 0 });
      return null;
    }
    try { setSignedIn(data.user, data.token); }
    catch (err) { setState({ lastError: 'bad-answer' }); handoffError = { code: 'bad-answer', status: 200 }; return null; }
    return reconcile({ afterSignIn: true });
  }

  // Sends the player to /authorize?prompt=none. False, with nothing done, when this browser could not check the answer.
  function redirectQuietly() {
    const ss = sessionStore();
    if (!ss || typeof window.location.assign !== 'function' || typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return false;
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    try {
      ss.setItem(SESSION_KEYS.state, nonce); ss.setItem(SESSION_KEYS.tried, '1');
      if (ss.getItem(SESSION_KEYS.state) !== nonce || ss.getItem(SESSION_KEYS.tried) !== '1') return false;
    } catch (e) { return false; }
    const back = new URL(window.location.href);
    for (const k of ['code', 'state', 'error', 'reset', 'sso']) back.searchParams.delete(k);
    back.hash = '';
    hinted = false;
    window.location.assign(`${config.authBase}/authorize?game=${HANDOFF_GAME}&return=${encodeURIComponent(back.href)}&state=${nonce}&prompt=none`);
    return true;
  }

  // One quiet look for a login made on the hub or in another world. Resolves false when nothing happened; otherwise the
  // browser leaves. `expired`: the token kept here has just been refused, so this browser session's one look may be spent again.
  async function trySilent(expired) {
    const ss = sessionStore();
    if (!hubHandoff() || !ss || !hasWin() || !window.location || resetToken || returned) return false;
    for (const k of query().keys()) if (!QUIET_OK.test(k)) return false;
    if (window.top && window.top !== window) return false;                 // /authorize never renders in a frame
    if (typeof navigator !== 'undefined' && navigator && (navigator.webdriver || navigator.onLine === false)) return false;   // automated journeys keep their one page load
    if (!hinted && readJson(KEYS.signedOut, null)) return false;
    try { if (!hinted && !expired && ss.getItem(SESSION_KEYS.tried)) return false; } catch (e) { return false; }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? unref(setTimeout(() => ctrl.abort(), SILENT_WAIT_MS)) : null;
    try {
      const res = await fetch(`${config.authBase}/health`, { mode: 'cors', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined });
      const h = res.ok ? await res.json() : null;
      if (!h || !Array.isArray(h.games) || !h.games.includes(HANDOFF_GAME)) return false;
    } catch (e) { return false; } finally { if (timer) clearTimeout(timer); }
    return redirectQuietly();
  }
  // boot()'s quiet look: while the browser leaves there is nothing to draw, so the title waits; if it is still here after
  // that, the navigation is cancelled, or a slow answer would pull the player out of the game they start meanwhile.
  async function quietLook(expired) {
    if (!(await trySilent(expired))) return false;
    await new Promise(done => unref(setTimeout(done, SILENT_GIVE_UP_MS)));
    try { if (typeof window.stop === 'function') window.stop(); } catch (e) { /* nothing to cancel */ }
    return true;
  }

  // ---------------------------------------------------------- public API (A2.1)
  const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/.test(String(e || '').trim());
  const cleanEmail = e => String(e || '').trim().toLowerCase();
  const unavailable = () => fail(NOT_CONNECTED, { code: 'unavailable' });
  const netFail = err => fail(err.message, { code: err.code, status: err.status || 0, retryAfter: err.data && err.data.retryAfter });

  /*qa:L4*/ // The title waits for this. A cloud that has stalled must not hold it for the full request time twice over (16 s
  // measured): while starting, each request gets 6 s, and the game then plays locally and syncs when the cloud answers.
  async function boot() {
    const full = config.timeoutMs;
    config.timeoutMs = full > 0 ? Math.min(full, 6000) : full;
    try { return await bootNow(); } finally { config.timeoutMs = full; }
  }
  async function bootNow() {
    bindOnce();
    if (!state.available) return { status: 'none', why: NOT_CONNECTED };
    if (returned) { const r = await finishHandoff(); if (r) return r; }
    if (!loadSession()) { await quietLook(false); return { status: 'none' }; }
    const r = await reconcile();
    if (r.why === 'expired' && !state.signedIn) await quietLook(true);   // the hub's login may still be good
    return r;
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
    if (hubHandoff()) writeJson(KEYS.signedOut, true);       // the accounts host still knows this browser: no quiet sign-in back
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

  // ---------------------------------------------------------- the Treasury (TREASURY.md section 5): one per account, every game's
  // Signed in only; store.js decides what goes in and out. Never throws: {ok:false, code} on any failure, and a 401 signs out
  // as everywhere else.
  async function treasuryCall(path, body) {
    if (!state.available) return unavailable();
    if (!state.signedIn || !session) return fail('Not signed in', { code: 'signed-out' });
    try { const data = await call(path, body === undefined ? {} : { method: 'POST', body }); return { ...data, ok: data.ok !== false }; }
    catch (err) { if (err.status === 401) setSignedOut('expired'); return netFail(err); }
  }

  const api = {
    ui: { choose: null },                                     // H sets Account.ui.choose({local, cloud}) -> Promise<'local'|'cloud'>
    configure,
    boot,
    takeHandoffError() { /*qa:L9api*/ const e = handoffError; handoffError = null; return e; },
    signup, login, logout, recover, deleteAccount,
    forgot, reset,
    get resetToken() { return resetToken; },                 // the token from ?reset=<token>, until it is used or cleared
    clearResetToken() { resetToken = null; return api; },
    syncNow,
    treasury: () => treasuryCall('/treasury'),                                   // -> {ok, gold, hours, items, log}
    deposit: body => treasuryCall('/treasury/deposit', body),                    // {game, playerId, sessionId | sandbox} -> {ok, deposited, treasury, duplicate?}
    withdraw: body => treasuryCall('/treasury/withdraw', body),                  // {game, playerId, gold, hours} -> {ok, giftId, treasury}
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
  captureHandoff();
  if (hasDoc() && document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => configure(readTagConfig()), { once: true });
  }
  return api;
})();

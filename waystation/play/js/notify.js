// ============================================================
// WAYSTATION — notify: opt-in push notifications for finished timers (DESIGN2.md Addendum A3)
// Classic script; exposes the `Notify` global. Loads after store.js and before main.js (0.1).
//
// What it does
//   When the player turns "Notify me when something finishes" on in Settings, this module asks the browser
//   for permission, registers play/sw.js, subscribes to Web Push with the backend's VAPID key and posts the
//   subscription to workers/push (POST /subscribe). From then on it keeps the backend's copy of the player's
//   pending timers current: every build, upgrade, expedition, plot clearing and (optionally) the next daily
//   reward, posted as one list (POST /schedule) whenever the set changes, debounced, and flushed at once
//   when the tab is hidden or closed. The worker's cron sends the notification; sw.js shows it.
//
// Sources (0.5): Sim.state.cells[k].readyAt (+ .up for upgrades) in every sector of Meta.profile.sectors,
//   Meta.expeditions() with status 'out', Meta.plot().clearing, Meta.daily().nextAt. Meta.nextUp() is the
//   HUD's three-row view of the same data; the schedule carries the whole list (up to 64 timers).
//   While the tab is visible, timers due within NEAR_MS are left out (the player is watching them finish);
//   the flush on hide or close posts everything.
//
// Configuration: <meta name="waystation-push" content='{"apiBase":"https://…workers.dev"}'> in index.html
//   (optional "publicKey" skips the GET /key round trip). Without an http(s) apiBase the module is in sandbox
//   mode: the Settings switch shows "Not connected" and nothing is ever requested or registered.
//   localStorage['waystation.push'] = {"apiBase":"http://127.0.0.1:8789"} overrides the tag for local testing.
//
// Settings (Meta.profile.settings): notify (bool), notifyDaily (bool, default off).
// Everything fails quietly: a missing backend, a refused permission or a network error never throws into
// the game; Notify.state() tells the Settings panel what to show.
// ============================================================
'use strict';

const Notify = (() => {
  const KEYS = { config: 'waystation.push', local: 'waystation.push.sub' };   // local: {apiBase, playerId, endpoint, token}
  const SW_URL = 'sw.js';
  const DEBOUNCE_MS = 4000;
  const NEAR_MS = 120e3;                // visible tab: timers this close are the player's to watch
  const MAX_TIMERS = 64;
  const DAILY_HOUR = 9;                 // the daily reminder lands at 09:00 local, not at the midnight the reward unlocks
  const TEST_WINDOW_MS = 150e3;         // a test timer stays in the schedule long enough for the next cron minute
  const RETRY_AFTER = 3;                // consecutive failed posts before the panel says "Offline"
  const EVENTS = ['change', 'build-start', 'build-done', 'upgrade', 'expedition', 'plot', 'daily', 'sector', 'offline'];

  const config = { apiBase: '', publicKey: '' };
  let status = 'off';                   // unsupported | unconfigured | off | pending | on | blocked | error
  let detail = '';
  let local = null;                     // what the backend knows about this browser
  let registration = null;
  let lastSig = '';
  let lastSync = 0;
  let failures = 0;
  let timer = 0;
  let bound = false;
  let resubscribing = false;
  let resubCount = 0;                   // bounded: KV behind the backend is eventually consistent, so a fresh subscription may 404 once
  let testAt = 0;

  // ---------------------------------------------------------- environment
  const hasDoc = () => typeof document !== 'undefined' && !!document;
  const hasWin = () => typeof window !== 'undefined' && !!window;
  function supported() {
    return hasWin() && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined' &&
      typeof Notification !== 'undefined' && (window.isSecureContext !== false);
  }
  const configured = () => /^https?:\/\/\S+$/.test(config.apiBase);
  const storage = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } };
  const readJson = (k, dflt) => { try { const s = storage(); const v = s && s.getItem(k); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } };
  const writeJson = (k, v) => { try { const s = storage(); if (!s) return; if (v == null) s.removeItem(k); else s.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };

  function readTagConfig() {
    if (!hasDoc() || typeof document.querySelector !== 'function') return {};
    const tag = document.querySelector('meta[name="waystation-push"]');
    const content = tag && (typeof tag.getAttribute === 'function' ? tag.getAttribute('content') : tag.content);
    if (!content) return {};
    try { const v = JSON.parse(content); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
  }
  function configure(opts) {
    const apply = o => {
      if (!o || typeof o !== 'object') return;
      if (o.apiBase !== undefined) config.apiBase = String(o.apiBase || '').trim().replace(/\/+$/, '');
      if (o.publicKey !== undefined) config.publicKey = String(o.publicKey || '').trim();
    };
    apply(readTagConfig());
    apply(opts);
    apply(readJson(KEYS.config, null));        // the local override always wins (testing against wrangler dev)
    if (!configured()) config.apiBase = '';
    if (status === 'unconfigured' || status === 'unsupported' || status === 'off') status = !supported() ? 'unsupported' : !configured() ? 'unconfigured' : 'off';
    return { ...config };
  }

  // ---------------------------------------------------------- game state access (every global is optional)
  const meta = () => (typeof Meta !== 'undefined' && Meta && Meta.profile) ? Meta : null;
  const sim = () => (typeof Sim !== 'undefined' && Sim) ? Sim : null;
  const settings = () => { const m = meta(); if (!m) return {}; m.profile.settings = m.profile.settings || {}; return m.profile.settings; };
  const wanted = () => settings().notify === true;
  const dailyWanted = () => settings().notifyDaily === true;
  function setSetting(key, value) { const m = meta(); if (!m) return; settings()[key] = value; if (typeof m.save === 'function') { try { m.save(); } catch (e) { /* quota */ } } }
  function playerId() {
    const m = meta();
    if (m && m.profile.playerId) return String(m.profile.playerId);
    if (typeof Store !== 'undefined' && Store && typeof Store.playerId === 'function') { try { return String(Store.playerId()); } catch (e) { /* fall through */ } }
    return '';
  }
  const stationName = () => { const s = sim(); return s && s.state && s.state.name ? String(s.state.name).slice(0, 28) : ''; };
  const sectorName = id => (typeof SECTORS !== 'undefined' && SECTORS && SECTORS[id] && SECTORS[id].name) || id;
  const moduleName = id => (typeof MODULES !== 'undefined' && MODULES && MODULES[id] && MODULES[id].name) || id;

  // The whole pending list: [{id, kind, title, dueAt}] sorted by dueAt, the soonest MAX_TIMERS.
  function collect({ all = false, now = Date.now() } = {}) {
    const m = meta(), s = sim();
    if (!m || !s || !s.state) return [];
    const p = m.profile, out = [];
    const sectors = p.sectors && typeof p.sectors === 'object' ? p.sectors : { [s.state.sector || 'home']: s.state };
    for (const sid in sectors) {
      const st = sid === p.activeSector ? s.state : sectors[sid];
      if (!st || !st.cells) continue;
      const suffix = sid === p.activeSector ? '' : ` · ${sectorName(sid)}`;
      for (const k in st.cells) {
        const cell = st.cells[k];
        if (!cell || cell.readyAt == null) continue;
        const i = k.indexOf(','), r = +k.slice(0, i), c = +k.slice(i + 1);
        const mod = st.grid && st.grid[r] && st.grid[r][c];
        if (!mod) continue;
        if (cell.up) out.push({ id: `upgrade:${sid}:${k}`, kind: 'upgrade', title: `${moduleName(mod.id)} is now level ${cell.up}${suffix}`, dueAt: cell.readyAt });
        else out.push({ id: `build:${sid}:${k}`, kind: 'build', title: `${moduleName(mod.id)} online${suffix}`, dueAt: cell.readyAt });
      }
      const C = st.plot && st.plot.clearing;
      if (C && C.endsAt != null) out.push({ id: `plot:${sid}:${C.ring}`, kind: 'plot', title: `Ring ${C.ring} cleared${suffix}`, dueAt: C.endsAt });
    }
    if (typeof m.expeditions === 'function') {
      for (const x of m.expeditions() || []) {
        if (!x || x.status !== 'out' || x.endsAt == null) continue;
        out.push({ id: `expedition:${x.id}`, kind: 'expedition', title: `Expedition back from ${(x.def && x.def.name) || sectorName(x.sector)}`, dueAt: x.endsAt });
      }
    }
    if (dailyWanted() && typeof m.daily === 'function') {
      const d = m.daily();
      if (d && !d.claimable && d.nextAt > now) {
        const at = new Date(d.nextAt); at.setHours(DAILY_HOUR, 0, 0, 0);
        out.push({ id: 'daily', kind: 'daily', title: 'Daily reward ready', dueAt: at.getTime() });
      }
    }
    if (testAt && now - testAt < TEST_WINDOW_MS) out.push({ id: 'test', kind: 'test', title: 'Test notification', dueAt: testAt });
    const visible = !all && hasDoc() && document.visibilityState === 'visible';
    const horizon = now + (visible ? NEAR_MS : 1000);
    const list = out.filter(t => Number.isFinite(t.dueAt) && (t.dueAt > horizon || t.kind === 'test'));
    list.sort((a, b) => a.dueAt - b.dueAt);
    return list.slice(0, MAX_TIMERS);
  }

  // ---------------------------------------------------------- backend
  async function api(path, body, { keepalive } = {}) {
    const res = await fetch(config.apiBase + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      mode: 'cors', credentials: 'omit', cache: 'no-store', keepalive: !!keepalive,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.message) || `The notification service answered ${res.status}.`);
      err.code = (data && data.error) || `http-${res.status}`; err.status = res.status;
      throw err;
    }
    return data || {};
  }
  function keyBytes(b64) {
    const s = String(b64).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const bin = atob(s + (s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function publicKey() {
    if (config.publicKey) return keyBytes(config.publicKey);
    const data = await api('/key');
    if (!data || !data.publicKey) throw Object.assign(new Error('The notification service has no VAPID key yet.'), { code: 'no-key' });
    config.publicKey = String(data.publicKey);
    return keyBytes(config.publicKey);
  }
  function sameKey(sub, bytes) {
    const cur = sub && sub.options && sub.options.applicationServerKey;
    if (!cur) return true;                                   // nothing to compare against
    const a = new Uint8Array(cur);
    if (a.length !== bytes.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
    return true;
  }
  function askPermission() {
    return new Promise(resolve => {
      let p;
      try { p = Notification.requestPermission(r => resolve(r)); } catch (e) { resolve(Notification.permission); return; }
      if (p && typeof p.then === 'function') p.then(resolve, () => resolve(Notification.permission));
    });
  }
  // register the service worker (idempotent) and make sure a subscription for our VAPID key exists
  async function ensureSubscription() {
    registration = await navigator.serviceWorker.register(SW_URL);
    await navigator.serviceWorker.ready;
    const key = await publicKey();
    let sub = await registration.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) { try { await sub.unsubscribe(); } catch (e) { /* replaced below */ } sub = null; }
    if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    return sub;
  }
  async function register(sub) {
    const pid = playerId();
    if (!pid) throw Object.assign(new Error('No player id yet.'), { code: 'no-player' });
    if (local && local.token && local.apiBase === config.apiBase && local.playerId === pid && local.endpoint === sub.endpoint) return local;
    const data = await api('/subscribe', { playerId: pid, subscription: sub.toJSON() });
    local = { apiBase: config.apiBase, playerId: pid, endpoint: sub.endpoint, token: String(data.token || '') };
    writeJson(KEYS.local, local);
    tellWorker();
    return local;
  }
  function tellWorker(clear) {
    const w = registration && (registration.active || registration.waiting || registration.installing);
    if (!w || typeof w.postMessage !== 'function') return;
    try { w.postMessage(clear ? { type: 'waystation-push-config' } : { type: 'waystation-push-config', apiBase: config.apiBase, playerId: local ? local.playerId : playerId(), publicKey: config.publicKey }); } catch (e) { /* no-op */ }
  }
  function fail(e, where) {
    const perm = typeof Notification !== 'undefined' ? Notification.permission : 'default';
    status = perm === 'denied' ? 'blocked' : 'error';
    detail = perm === 'denied' ? '' : (e && e.message) || 'The notification service could not be reached.';
    if (typeof console !== 'undefined' && console.warn) console.warn(`[notify] ${where} failed: ${detail}`);
  }

  // ---------------------------------------------------------- lifecycle
  function bind() {
    if (bound) return;
    bound = true;
    const s = sim();
    if (s && typeof s.on === 'function') for (const ev of EVENTS) s.on(ev, queue);
    if (hasDoc()) document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else queue(); });
    if (hasWin()) window.addEventListener('pagehide', flush);
  }
  const active = () => (status === 'on' || status === 'error') && !!local && !!local.token;
  function queue() {
    if (!active()) return;
    clearTimeout(timer);
    timer = setTimeout(() => sync(false), DEBOUNCE_MS);
  }
  function flush() {
    if (!active()) return;
    clearTimeout(timer); timer = 0;
    return sync(false, { keepalive: true, all: true });
  }
  function sync(force, { keepalive, all } = {}) {
    clearTimeout(timer); timer = 0;
    if (!active()) return Promise.resolve(false);
    if (!wanted()) { status = 'off'; return Promise.resolve(false); }   // an imported profile with notifications off
    const pid = playerId();
    if (pid && local.playerId !== pid) return resubscribe(local);      // a new or imported profile: move the subscription over
    let list, station;
    try { list = collect({ all: !!all }); station = stationName(); } catch (e) { return Promise.resolve(false); }
    const sig = JSON.stringify([station, list.map(t => [t.id, t.dueAt])]);
    if (!force && sig === lastSig) return Promise.resolve(false);
    lastSig = sig;
    return api('/schedule', { playerId: local.playerId, token: local.token, station, timers: list }, { keepalive })
      .then(() => { lastSync = Date.now(); failures = 0; resubCount = 0; if (status === 'error') { status = 'on'; detail = ''; } return true; })
      .catch(err => {
        lastSig = '';
        if (err && (err.code === 'no-subscription' || err.code === 'bad-token') && resubCount < 3) return resubscribe(null);
        failures++;
        if (failures >= RETRY_AFTER) { status = 'error'; detail = 'The notification service could not be reached. It keeps trying.'; }
        return false;
      });
  }
  // the backend forgot us, or the profile changed under us: subscribe again (no prompt: permission is already granted)
  async function resubscribe(previous) {
    if (resubscribing) return false;
    resubscribing = true; resubCount++;
    try {
      if (previous && previous.token) api('/unsubscribe', { playerId: previous.playerId, token: previous.token }).catch(() => {});
      local = null; writeJson(KEYS.local, null);
      if (!wanted()) { status = 'off'; return false; }
      const sub = await ensureSubscription();
      await register(sub);
      status = 'on'; detail = ''; failures = 0; lastSig = '';
      resubscribing = false;
      return sync(true);
    } catch (e) { fail(e, 'resubscribe'); return false; }
    finally { resubscribing = false; }
  }

  // called once by main.js after Meta.init(): re-attach when the player opted in earlier
  async function boot() {
    configure();
    if (!supported()) { status = 'unsupported'; return false; }
    if (!configured()) { status = 'unconfigured'; return false; }
    bind();
    local = readJson(KEYS.local, null);
    if (!wanted()) { status = 'off'; return false; }
    const perm = Notification.permission;
    if (perm !== 'granted') { status = perm === 'denied' ? 'blocked' : 'off'; return false; }
    status = 'pending'; detail = '';
    try {
      const sub = await ensureSubscription();
      await register(sub);
      status = 'on'; failures = 0; lastSig = '';
      tellWorker();
      sync(true);
      return true;
    } catch (e) { fail(e, 'boot'); return false; }
  }

  // the Settings switch: must be called from the click itself so the permission prompt counts as user-initiated
  async function enable() {
    configure();
    if (!supported()) { status = 'unsupported'; return false; }
    if (!configured()) { status = 'unconfigured'; return false; }
    bind();
    status = 'pending'; detail = '';
    try {
      const perm = await askPermission();
      if (perm !== 'granted') { setSetting('notify', false); status = perm === 'denied' ? 'blocked' : 'off'; return false; }
      const sub = await ensureSubscription();
      local = null;                                            // a fresh opt-in always registers again
      await register(sub);
      setSetting('notify', true);
      status = 'on'; failures = 0; lastSig = '';
      sync(true);
      return true;
    } catch (e) { setSetting('notify', false); fail(e, 'enable'); return false; }
  }
  async function disable() {
    setSetting('notify', false);
    status = configured() ? 'off' : 'unconfigured'; detail = ''; lastSig = ''; failures = 0; testAt = 0;
    clearTimeout(timer); timer = 0;
    const l = local; local = null; writeJson(KEYS.local, null);
    try {
      if (l && l.token && configured()) api('/unsubscribe', { playerId: l.playerId, token: l.token }, { keepalive: true }).catch(() => {});   // keepalive: survives the tab closing right after
      const reg = registration || (navigator.serviceWorker.getRegistration ? await navigator.serviceWorker.getRegistration() : null);
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
        tellWorker(true);
        await reg.unregister();
      }
      registration = null;
      if (typeof caches !== 'undefined' && caches && caches.delete) caches.delete('waystation-push-config').catch(() => {});
    } catch (e) { /* the backend prunes dead subscriptions on its own */ }
    return true;
  }
  function setDaily(on) {
    setSetting('notifyDaily', !!on);
    lastSig = '';
    if (active()) sync(true);
  }
  // a real end-to-end test: a timer due now goes into the schedule, the cron sends it within a minute
  function test() {
    if (status !== 'on' || !local) return Promise.resolve(false);
    testAt = Date.now() - 1000;
    lastSig = '';
    return sync(true).then(ok => !!ok);
  }
  function state() {
    return {
      status, detail,
      supported: supported(), configured: configured(), wanted: wanted(), daily: dailyWanted(),
      permission: typeof Notification !== 'undefined' ? Notification.permission : 'default',
      subscribed: !!(local && local.token), lastSync, apiBase: config.apiBase,
    };
  }

  return { boot, enable, disable, setDaily, test, state, configure, timers: collect, sync: () => sync(true), flush,
    constants: { DEBOUNCE_MS, NEAR_MS, MAX_TIMERS, DAILY_HOUR } };
})();

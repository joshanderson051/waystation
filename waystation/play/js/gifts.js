// ============================================================
// PORT SOLACE — Gifts: presence check-ins and Port Authority gifts (DESIGN2.md Addendum A9, spec section 4)
// Classic script; exposes the `Gifts` global (also window.Gifts). Loads after account.js, before ui/admin.js.
//
// Presence: POST {apiBase}/presence {playerId, summary:{name, day, level, rank, credits, am, sectors}, platform, version}
//   on boot, every 10 minutes while the page is visible, and when the page becomes visible again after 10+ minutes
//   hidden (or after a scheduled check-in was skipped because the page was hidden). The account apiBase is the one
//   Account parsed from <meta name="portsolace-account"> (with its localStorage override). The Bearer token goes
//   along only while Account is signed in. Every failure is silent: presence never disturbs play.
//   It also says accepts:['tokens','title'], so the worker may hand over gifts that carry livery tokens or a title (the
//   Build the Ages reward center's: workers/account/src/rewards.js); a page without this line never receives those.
// Gifts: the presence answer lists {id, credits, am, note, createdAt, tokens?, title?}. Each is applied once (the
//   profile.entitlements.history check), recorded with Meta.grantEntitlement('gift', {grantId, mode:'gift', ...}),
//   saved, then acked with POST {apiBase}/gifts/ack {playerId, ids}. The history entry carries acked:false until the
//   ack succeeds; every check-in re-sends outstanding acks (from memory and from the stored history, so they survive a
//   reload), also when presence returned no gifts, because a gift revoked after it reached the game is no longer
//   offered. A gift whose profile save failed is not acked, so the server offers it again; the history check never
//   grants twice.
// The Treasury (TREASURY.md section 6): accepts also says 'hours' and 'items'. A gift's hours become money here at
//   max(hours * 60 * Meta.totalRate(), hours * 5000 * Sim.priceMul()); its items (keepsakes: sector_pass, founder, liveries)
//   get what their skus grant today, through Store.grantItems, each recorded under its own sku. Applied once and acked like
//   every gift. A gift from the Treasury (one this page asked for with Bring here, Gifts.expect(id), or noted "From your
//   Treasury") and a keepsake-only gift go to Gifts.ui.arrived(info) when the HUD set it (a reward card or a notice); the
//   rest, and everything without the hook, keep the modal.
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
  const MAX_TOKENS = 10, TITLE_MAX = 40;         // a reward's livery tokens and title
  const MAX_HOURS = 10000, MAX_ITEMS = 10;       // a Treasury gift's hours of income and keepsakes (store.js MAX_HOURS, MAX_ITEMS)
  const ITEM_RE = /^[a-z][a-z0-9_]{0,39}$/;
  const TREASURY_NOTE = 'From your Treasury';    // the account worker's note on a withdrawal
  // keepsakes without store.js (a harness): what each sku grants besides its Antimatter
  const KEEPSAKES = { sector_pass: { unlockAll: true }, founder: { livery: 'founder', title: 'Founder' }, liveries: { liveries: ['sable', 'kessler', 'thessaly', 'marrow', 'oros', 'keth'] } };
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
  const expected = new Set();               // gift ids this page asked the Treasury for (Bring here): the player's own arrival

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
      tokens: int(g.tokens, MAX_TOKENS), title: typeof g.title === 'string' ? g.title.trim().slice(0, TITLE_MAX) : '',
      hours: hoursOf(g), items: itemsOf(g.items),
    };
  }
  // hours with one decimal (TREASURY.md: `hours`; hours_tenths is read too); items as an array (or the stored comma list)
  function hoursOf(g) {
    const h = g.hours != null ? num(g.hours) : num(g.hoursTenths != null ? g.hoursTenths : g.hours_tenths) / 10;
    return Math.min(MAX_HOURS, Math.max(0, Math.round(h * 10) / 10));
  }
  function itemsOf(v) {
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
    return [...new Set(raw.filter(i => typeof i === 'string' && ITEM_RE.test(i)))].slice(0, MAX_ITEMS);
  }
  // TREASURY.md section 2, the same formula as Store.hoursToMoney (used when store.js is there)
  function hoursToMoney(m, hours) {
    if (typeof Store !== 'undefined' && Store && typeof Store.hoursToMoney === 'function') return Store.hoursToMoney(hours, m);
    const rate = typeof m.totalRate === 'function' ? num(m.totalRate()) : 0;
    let mul = 1;
    try { if (typeof Sim !== 'undefined' && Sim && typeof Sim.priceMul === 'function') mul = num(Sim.priceMul()) || 1; } catch (e) { mul = 1; }
    return Math.round(Math.max(hours * 60 * rate, hours * 5000 * mul));
  }
  // keepsakes: Store.grantItems (the skus' own grants), or the table above; returns the items newly granted here
  function grantItems(m, items, giftId) {
    if (typeof Store !== 'undefined' && Store && typeof Store.grantItems === 'function') return Store.grantItems(m, items, giftId, 'keepsake');
    const done = [];
    for (const item of items) {
      if (typeof m.hasEntitlement === 'function' && m.hasEntitlement(item)) continue;
      const { unlockAll, ...payload } = KEEPSAKES[item] || {};
      if (unlockAll && typeof m.unlockAllSectors === 'function') m.unlockAllSectors(`keepsake:${item}`);
      m.grantEntitlement(item, { grantId: `${giftId}:${item}`, mode: 'keepsake', at: Date.now(), sku: item, keepsake: true, granted: { item }, ...payload });
      done.push(item);
    }
    return done;
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
      let money = g.credits;
      if (g.hours > 0) { const n = Math.min(MAX_CREDITS * 100, hoursToMoney(m, g.hours)); if (n > 0) { m.addCredits(n, 'gift'); money += n; } }   // hours of this city's income
      if (g.am > 0) m.addAM(g.am, 'gift');
      if (g.tokens > 0) {                                    // livery tokens, spent in the Liveries panel (Meta.redeemLiveryToken)
        const E = m.profile.entitlements, T = E.tokens && typeof E.tokens === 'object' ? E.tokens : (E.tokens = { livery: 0 });
        T.livery = Math.max(0, (T.livery | 0)) + g.tokens;
      }
      const items = g.items.length ? grantItems(m, g.items, g.id) : [];   // keepsakes, each under its own sku
      const granted = { credits: money, am: g.am, ...(g.tokens ? { tokens: g.tokens } : {}), ...(g.hours ? { hours: g.hours } : {}), ...(items.length ? { items } : {}) };
      // a title rides on the history entry: Meta.grantEntitlement adds it to entitlements.titles
      m.grantEntitlement('gift', { grantId: g.id, mode: 'gift', at: Date.now(), granted, note: g.note, acked: false, ...(g.title ? { title: g.title } : {}) });
      applied.push({ ...g, money, newItems: items });
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
  // a keepsake's name in this world's words: the store's own title for the sku
  const ITEM_NAMES = { sector_pass: 'Sector Pass', founder: 'Founder\'s Charter', liveries: 'Sector Liveries' };
  function itemName(id) {
    try { if (typeof Store !== 'undefined' && Store && typeof Store.item === 'function') { const e = Store.item(id); if (e && e.title) return String(e.title); } } catch (e) { /* the table */ }
    return ITEM_NAMES[id] || id;
  }
  const moneyOf = g => int(g.money != null ? g.money : g.credits, MAX_CREDITS * 100);
  function chipsNode(g) {
    const box = el('div', 'chips');
    // rewardChips builds its markup from the two integers alone (the game's credit and Antimatter icons)
    // (it escapes the token label, the title and the keepsake names it is given)
    const tokens = int(g.tokens, MAX_TOKENS), token = tokens ? (tokens > 1 ? `${tokens} Livery tokens` : 'Livery token') : '';
    const names = (g.newItems || []).map(itemName);
    if (typeof Overlays !== 'undefined' && Overlays && typeof Overlays.rewardChips === 'function') {
      box.innerHTML = Overlays.rewardChips({ credits: moneyOf(g), am: int(g.am, MAX_AM), ...(token ? { livery: token } : {}), ...(g.title ? { title: String(g.title) } : {}), ...(names.length ? { items: names } : {}) });
    } else {
      if (moneyOf(g) > 0) box.appendChild(el('span', 'rchip amber', `${fmtN(moneyOf(g))} cr`));
      if (g.am > 0) box.appendChild(el('span', 'rchip am', `${fmtN(g.am)} AM`));
      if (token) box.appendChild(el('span', 'rchip rose', token));
      if (g.title) box.appendChild(el('span', 'rchip ivory', String(g.title)));
      for (const n of names) box.appendChild(el('span', 'rchip rose', n));
    }
    return box;
  }
  // A Treasury withdrawal or a keepsake goes to the HUD's hook (a reward card when the player asked for it, a notice when it
  // came on its own). A keepsake this world already had says nothing. Returns the gifts still for the modal.
  function arrivals(gifts) {
    const hook = api.ui && typeof api.ui.arrived === 'function' ? api.ui.arrived : null, rest = [];
    for (const g of gifts) {
      const own = expected.has(g.id) || g.note === TREASURY_NOTE;
      const keepsake = !own && g.items.length > 0 && !moneyOf(g) && !g.am && !g.tokens && !g.title;
      if (keepsake && !(g.newItems || []).length) continue;
      if ((own || keepsake) && hook) {
        let done = false;
        try {
          done = hook({ kind: own ? 'treasury' : 'keepsake', asked: expected.has(g.id), id: g.id, credits: moneyOf(g), am: g.am, hours: g.hours,
            items: (g.newItems || []).slice(), names: (g.newItems || []).map(itemName) }) !== false;
        } catch (e) { done = false; }
        expected.delete(g.id);
        if (done) continue;
      }
      rest.push(g);
    }
    return rest;
  }
  function show() {
    const gifts = arrivals(toShow.splice(0, toShow.length));
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
    const body = { playerId: pid, summary: summary(), platform: platform(), version: version(), accepts: ['tokens', 'title', 'hours', 'items'] };
    // the game names itself (as account.js does): an address that is no game's, a local test, must not count as Port Solace
    try { if (typeof GAME_INFO !== 'undefined' && GAME_INFO && GAME_INFO.id) body.game = String(GAME_INFO.id); } catch (e) { /* Port Solace: no GAME_INFO */ }
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
  // o.again: a check-in already running may have started before the gift was made, so one more follows it (Bring here)
  function checkNow(o) {
    if (inflight) return o && o.again ? inflight.then(() => checkNow()) : inflight;
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
    ui: { arrived: null },                                   // the HUD sets Gifts.ui.arrived(info) -> true when it showed the gift
    init,
    checkNow,
    expect(id) { if (typeof id === 'string' && GIFT_ID_RE.test(id)) expected.add(id); return api; },   // Store.withdraw: this gift is the player's Bring here
    get state() { return { ...state, applied: state.applied.slice(), acked: state.acked.slice(), unacked: state.unacked.slice(), inflight: !!inflight }; },
  };
  if (typeof window !== 'undefined' && window) window.Gifts = api;
  return api;
})();

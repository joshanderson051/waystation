// ============================================================
// PORT SOLACE — store: catalog, providers (sandbox | stripe), purchase, claim, restore
// DESIGN2.md section 7 (7.1 catalog, 7.2 client, 7.4 server contract).
// Classic script; exposes the `Store` global (0.2). No framework, no bundler.
//
// Modes (7.2):
//   sandbox  default. Purchases are free and local: a confirm, 600ms of simulated
//            latency, then the grant. Nothing leaves the browser.
//   stripe   POST {apiBase}/checkout then redirect to Stripe Checkout; on return,
//            Store.resume() claims the session once through GET {apiBase}/claim.
//
// Integration (what the other engineers wire up):
//   H  sets Store.ui.confirm({sku, title, priceLabel, testMode}) -> Promise<bool>
//      and listens to Sim 'purchase' {sku, granted, mode, grantId} (0.6).
//   S  provides STORE_CATALOG (7.1) and Meta.addAM / addCredits / totalRate /
//      unlockAllSectors / grantEntitlement / hasEntitlement / profile.playerId.
//   main calls Store.flush() after Meta.init (applies grants queued while Meta was
//      absent, reconciles the player id) and Store.resume() once on load.
// ============================================================
'use strict';

const Store = (() => {
  // ---------------------------------------------------------- constants
  const MODES = new Set(['sandbox', 'stripe']);
  const NON_CONSUMABLE = new Set(['pass', 'cosmetic']);      // bought once, owned forever
  const SIM_EVENTS = new Set(['purchase']);                  // 0.6: only `purchase` crosses to the Sim bus
  const LEDGER_CAP = 300;                                    // local grant history length
  const SECTOR_LIVERIES = ['sable', 'kessler', 'thessaly', 'marrow', 'oros', 'keth'];

  const KEYS = {
    config:   'portsolace.store',            // JSON override of the <meta> config (local testing)
    pending:  'portsolace.store.pending',    // grants waiting for Meta: [{grantId, sku, mode, at}]
    grants:   'portsolace.store.grants',     // local ledger when Meta is absent: [{grantId, sku, mode, at}]
    inflight: 'portsolace.store.inflight',   // the checkout we left the page for: {sku, sessionId, at, unclaimed}
    playerId: 'portsolace.playerId',         // uuid used until Meta.profile.playerId exists
  };

  const DEFAULTS = { mode: 'sandbox', apiBase: '', successPath: '', latencyMs: 600 };

  // ---------------------------------------------------------- 7.1 catalog (inline copy; used when STORE_CATALOG is absent)
  const FALLBACK_CATALOG = [
    { sku: 'am_50',  kind: 'am', title: '50 Antimatter',  desc: 'A pocketful of Antimatter. Skip a build, call an expedition home.',
      amount: 50,  grant: { am: 50 },  priceCents: 199 },
    { sku: 'am_140', kind: 'am', title: '140 Antimatter', desc: '140 Antimatter, 12% more than buying small.',
      amount: 140, grant: { am: 140 }, priceCents: 499, badge: 'Popular' },
    { sku: 'am_320', kind: 'am', title: '320 Antimatter', desc: '320 Antimatter, 28% more than buying small.',
      amount: 320, grant: { am: 320 }, priceCents: 999 },
    { sku: 'am_900', kind: 'am', title: '900 Antimatter', desc: '900 Antimatter, 80% more than buying small.',
      amount: 900, grant: { am: 900 }, priceCents: 2499, badge: 'Best value' },
    { sku: 'credits_s', kind: 'credits', title: 'Relief Convoy', desc: 'Two hours of your whole station\'s income, delivered now (at least 10,000 credits).',
      amount: 2, grant: { credits: { hours: 2, min: 10000 } }, priceCents: 199 },
    { sku: 'credits_l', kind: 'credits', title: 'Trade Fleet', desc: 'Eight hours of your whole station\'s income, delivered now (at least 40,000 credits).',
      amount: 8, grant: { credits: { hours: 8, min: 40000 } }, priceCents: 599 },
    { sku: 'sector_pass', kind: 'pass', title: 'Sector Pass', desc: 'Every sector unlocked for this profile. No charts, no waiting.',
      amount: 0, grant: { unlockAll: true, entitlement: 'sector_pass' }, priceCents: 999 },
    { sku: 'founder', kind: 'cosmetic', title: 'Founder\'s Charter', desc: 'The Founder\'s livery (ivory and amber station strip), the title "Founder" and 100 Antimatter.',
      amount: 100, grant: { am: 100, entitlement: 'founder', payload: { livery: 'founder', title: 'Founder' } }, priceCents: 499 },
    { sku: 'liveries', kind: 'cosmetic', title: 'Sector Liveries', desc: 'The six sector liveries for your station.',
      amount: 0, grant: { entitlement: 'liveries', payload: { liveries: SECTOR_LIVERIES } }, priceCents: 299 },
  ];
  const FALLBACK_BY_SKU = Object.fromEntries(FALLBACK_CATALOG.map(e => [e.sku, e]));

  // ---------------------------------------------------------- state
  const config = { ...DEFAULTS };
  const listeners = {};
  const warnings = [];
  let catalogCache = null;
  let catalogSource = null;      // 'data2' | 'fallback'
  let busy = false;

  class StoreError extends Error {
    constructor(code, message, status) { super(message); this.code = code; this.status = status || 0; }
  }

  // ---------------------------------------------------------- environment helpers (every browser global is optional)
  const hasDoc = () => typeof document !== 'undefined' && !!document;
  const hasLoc = () => typeof location !== 'undefined' && !!location;
  const warn = msg => { if (!warnings.includes(msg)) warnings.push(msg); };
  const delay = ms => new Promise(res => setTimeout(res, ms));
  const enc = v => encodeURIComponent(String(v));

  function storage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
  }
  function readRaw(key) {
    const s = storage(); if (!s) return null;
    try { return s.getItem(key); } catch (e) { return null; }
  }
  function writeRaw(key, value) {
    const s = storage(); if (!s) return false;
    try { if (value === null) s.removeItem(key); else s.setItem(key, value); return true; } catch (e) { return false; }
  }
  function readJson(key, fallback) {
    const raw = readRaw(key); if (raw === null || raw === '') return fallback;
    try { const v = JSON.parse(raw); return v === null ? fallback : v; } catch (e) { return fallback; }
  }
  function writeJson(key, value) { return writeRaw(key, value === null ? null : JSON.stringify(value)); }

  function uuid() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') { try { return c.randomUUID(); } catch (e) { /* insecure context */ } }
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // ---------------------------------------------------------- events: Store bus + the Sim bus (0.6)
  function emit(evt, data) {
    (listeners[evt] || []).slice().forEach(fn => {
      try { fn(data); }
      catch (err) { setTimeout(() => { throw err; }, 0); }   // surface listener bugs without breaking the purchase
    });
    if (SIM_EVENTS.has(evt) && typeof Sim !== 'undefined' && Sim && typeof Sim.emit === 'function') Sim.emit(evt, data);
  }
  function on(evt, fn) { if (typeof fn === 'function') (listeners[evt] ||= []).push(fn); return api; }
  function off(evt, fn) { const l = listeners[evt]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return api; }

  // ---------------------------------------------------------- 7.1 catalog normalisation
  function sourceCatalog() { return (typeof STORE_CATALOG !== 'undefined' && STORE_CATALOG) ? STORE_CATALOG : null; }

  function parseCents(raw, fb) {
    if (Number.isFinite(raw.priceCents)) return Math.round(raw.priceCents);
    if (Number.isFinite(raw.cents)) return Math.round(raw.cents);
    const p = raw.price ?? raw.usd ?? raw.priceUsd;
    if (typeof p === 'string') { const digits = p.replace(/[^0-9.]/g, ''); if (digits) return Math.round(parseFloat(digits) * 100); }
    if (Number.isFinite(p)) return (Number.isInteger(p) && p >= 50) ? p : Math.round(p * 100);   // 199 = cents, 1.99 = dollars
    return fb ? fb.priceCents : 0;
  }
  const priceLabelFor = cents => '$' + (Math.max(0, cents) / 100).toFixed(2);

  // Accepts the grant in whatever shape S ships it; returns {am?, credits?{hours,min,fixed?}, unlockAll?, entitlement?, payload?}.
  function normaliseGrant(g, fb, kind, amount, sku) {
    if (g && typeof g === 'object') {
      const out = {};
      const am = g.am ?? g.antimatter;
      if (Number.isFinite(am) && am > 0) out.am = Math.round(am);
      const cr = g.credits ?? (Number.isFinite(g.hours) ? { hours: g.hours, min: g.min ?? g.floor } : undefined);
      if (cr && typeof cr === 'object') out.credits = { hours: Number(cr.hours) || 0, min: Number(cr.min ?? cr.floor) || 0 };
      else if (Number.isFinite(cr) && cr > 0) out.credits = { hours: 0, min: 0, fixed: Math.round(cr) };
      if (g.unlockAll || g.allSectors || g.sectors === 'all') out.unlockAll = true;
      const ent = g.entitlement ?? g.cosmetic ?? g.unlock;
      if (typeof ent === 'string' && ent) out.entitlement = ent;
      else if (ent === true || (out.unlockAll && !out.entitlement)) out.entitlement = sku;
      const { am: _a, antimatter: _b, credits: _c, hours: _d, min: _e, floor: _f, unlockAll: _g, allSectors: _h, sectors: _i, entitlement: _j, cosmetic: _k, unlock: _l, payload: explicit, ...rest } = g;
      const payload = { ...(explicit && typeof explicit === 'object' ? explicit : {}), ...rest };   // extra keys travel to Meta.grantEntitlement
      if (Object.keys(payload).length) out.payload = payload;
      if (Object.keys(out).length) return out;
    }
    if (fb) return JSON.parse(JSON.stringify(fb.grant));
    switch (kind) {                                          // unknown sku: infer from kind
      case 'am': return { am: Math.max(0, Math.round(amount || 0)) };
      case 'credits': return { credits: { hours: Number(amount) || 0, min: 0 } };
      case 'pass': return { unlockAll: true, entitlement: sku };
      default: return { entitlement: sku };
    }
  }

  function normaliseEntry(raw, key) {
    if (!raw || typeof raw !== 'object') return null;
    const sku = String(raw.sku || raw.id || key || '').trim();
    if (!sku) return null;
    const fb = FALLBACK_BY_SKU[sku] || null;
    const kind = String(raw.kind || raw.type || (fb && fb.kind) || 'cosmetic').toLowerCase();
    const amount = Number(raw.amount ?? raw.am ?? raw.hours ?? (fb ? fb.amount : 0)) || 0;
    const priceCents = parseCents(raw, fb);
    return {
      sku, kind,
      title: String(raw.title || raw.name || (fb && fb.title) || sku),
      desc: String(raw.desc || raw.description || (typeof raw.grants === 'string' ? raw.grants : '') || (fb && fb.desc) || ''),
      amount,
      grant: normaliseGrant(raw.grant ?? raw.grants ?? raw.effect, fb, kind, amount, sku),
      priceCents,
      priceLabel: String(raw.priceLabel || raw.label || priceLabelFor(priceCents)),
      badge: raw.badge ?? raw.tag ?? (fb ? fb.badge : null) ?? null,
    };
  }

  function buildCatalog() {
    const src = sourceCatalog();
    const raws = !src ? [] : Array.isArray(src) ? src.map(r => [null, r]) : Object.entries(src);
    const entries = raws.map(([key, raw]) => normaliseEntry(raw, key)).filter(Boolean);
    if (entries.length) { catalogSource = 'data2'; return entries; }
    catalogSource = 'fallback';
    return FALLBACK_CATALOG.map(e => normaliseEntry(e, e.sku));
  }
  function entries() {
    if (!catalogCache || (catalogSource === 'fallback' && sourceCatalog())) catalogCache = buildCatalog();
    return catalogCache;
  }
  const findEntry = sku => entries().find(e => e.sku === sku) || null;
  const cloneEntry = e => ({ ...e, grant: JSON.parse(JSON.stringify(e.grant)), owned: NON_CONSUMABLE.has(e.kind) ? owned(e.sku) : false });

  // ---------------------------------------------------------- Meta bridge (0.5 / 4.4)
  // Meta counts as ready once it has a profile and the grant functions; before that, grants queue (flush applies them).
  function meta() {
    if (typeof Meta === 'undefined' || !Meta || !Meta.profile) return null;
    return typeof Meta.addAM === 'function' ? Meta : null;
  }

  function historyHas(grantId) {
    const m = (typeof Meta !== 'undefined' && Meta && Meta.profile) ? Meta : null;
    const hist = m && m.profile.entitlements && m.profile.entitlements.history;
    return Array.isArray(hist) && hist.some(h => h === grantId || (h && (h.grantId === grantId || h.id === grantId)));
  }
  const ledger = () => readJson(KEYS.grants, []).filter(g => g && g.grantId);
  const pendingQueue = () => readJson(KEYS.pending, []).filter(g => g && g.grantId);
  function isRecorded(grantId) {
    return historyHas(grantId) || ledger().some(g => g.grantId === grantId) || pendingQueue().some(g => g.grantId === grantId);
  }
  function rememberGrant(record) {
    const list = ledger().filter(g => g.grantId !== record.grantId);
    list.push(record);
    writeJson(KEYS.grants, list.slice(-LEDGER_CAP));
  }

  // 7.1 credits packs: hours of total station rate with a floor. Meta.totalRate() is credits per real minute (0.5).
  function creditsFor(m, c) {
    if (c.fixed) return c.fixed;
    const rate = typeof m.totalRate === 'function' ? Number(m.totalRate()) || 0 : 0;
    return Math.max(c.min || 0, Math.round((c.hours || 0) * 60 * rate));
  }

  // Applies one grant through Meta and records it in profile.entitlements.history via grantEntitlement({grantId}).
  function grantViaMeta(m, entry, grantId, mode) {
    const g = entry.grant, reason = `store:${entry.sku}`, out = {};
    if (g.am > 0) { m.addAM(g.am, reason); out.am = g.am; }
    if (g.credits && typeof m.addCredits === 'function') { const n = creditsFor(m, g.credits); m.addCredits(n, reason); out.credits = n; }
    if (g.unlockAll) { if (typeof m.unlockAllSectors === 'function') m.unlockAllSectors(reason); out.unlockAll = true; }
    if (g.entitlement) out.entitlement = g.entitlement;
    if (typeof m.grantEntitlement === 'function') {
      m.grantEntitlement(entry.sku, { grantId, mode, at: Date.now(), sku: entry.sku, kind: entry.kind, granted: { ...out }, ...(g.payload || {}) });
    }
    rememberGrant({ grantId, sku: entry.sku, mode, at: Date.now() });
    return out;
  }

  // The summary a queued grant will produce once Meta exists (credits are unknown until then).
  function previewGrant(entry) {
    const g = entry.grant, out = {};
    if (g.am > 0) out.am = g.am;
    if (g.credits) out.credits = g.credits.fixed || g.credits.min || 0;
    if (g.unlockAll) out.unlockAll = true;
    if (g.entitlement) out.entitlement = g.entitlement;
    return out;
  }

  // 7.2 Store.grant: idempotent by grantId. Returns {granted, pending?, duplicate?}.
  function applyGrant(entry, grantId, mode) {
    if (isRecorded(grantId)) return { granted: false, duplicate: true };
    const m = meta();
    if (!m) {
      const queue = pendingQueue();
      queue.push({ grantId, sku: entry.sku, mode, at: Date.now() });
      writeJson(KEYS.pending, queue);
      return { granted: previewGrant(entry), pending: true };
    }
    return { granted: grantViaMeta(m, entry, grantId, mode) };
  }

  // Called by the integrator after Meta.init: applies queued grants and reconciles the player id into the profile.
  function flush() {
    const m = meta(); if (!m) return [];
    reconcilePlayerId(m);
    const applied = [], keep = [];
    for (const item of pendingQueue()) {
      const entry = findEntry(item.sku);
      if (!entry) { warn(`Dropped a queued grant for unknown sku "${item.sku}".`); continue; }
      if (historyHas(item.grantId) || ledger().some(g => g.grantId === item.grantId)) continue;
      const granted = grantViaMeta(m, entry, item.grantId, item.mode || 'sandbox');
      applied.push({ sku: entry.sku, granted, grantId: item.grantId, mode: item.mode || 'sandbox', flushed: true });
    }
    writeJson(KEYS.pending, keep);
    if (applied.length) emit('flush', { applied });
    return applied;
  }

  // ---------------------------------------------------------- player id
  function reconcilePlayerId(m) {
    const local = readRaw(KEYS.playerId);
    if (m.profile.playerId) { if (local !== m.profile.playerId) writeRaw(KEYS.playerId, String(m.profile.playerId)); return; }
    const id = local || uuid();
    m.profile.playerId = id;
    if (!local) writeRaw(KEYS.playerId, id);
  }
  function playerId() {
    const m = meta();
    if (m && m.profile.playerId) return String(m.profile.playerId);
    let id = readRaw(KEYS.playerId);
    if (!id) { id = uuid(); writeRaw(KEYS.playerId, id); }
    return id;
  }

  // ---------------------------------------------------------- ownership / entitlements
  function entitlements() {
    const m = (typeof Meta !== 'undefined' && Meta && Meta.profile) ? Meta : null;
    const hist = m && m.profile.entitlements && m.profile.entitlements.history;
    const source = Array.isArray(hist) ? hist : ledger();
    return source.map(h => {
      if (typeof h === 'string') return { grantId: h, sku: null, at: null, mode: null };
      if (!h || typeof h !== 'object') return null;
      return { grantId: h.grantId || h.id || null, sku: h.sku || null, at: h.at || null, mode: h.mode || null };
    }).filter(Boolean);
  }
  function owned(sku) {
    const m = meta();
    if (m && typeof m.hasEntitlement === 'function' && m.hasEntitlement(sku)) return true;
    return entitlements().some(e => e.sku === sku) || pendingQueue().some(p => p.sku === sku);
  }

  // ---------------------------------------------------------- configuration (7.2)
  function readTagConfig() {
    if (!hasDoc() || typeof document.querySelector !== 'function') return {};
    const tag = document.querySelector('meta[name="portsolace-store"]');
    const content = tag && (typeof tag.getAttribute === 'function' ? tag.getAttribute('content') : tag.content);
    if (!content) return {};
    try { const v = JSON.parse(content); return v && typeof v === 'object' ? v : {}; }
    catch (e) { warn('The portsolace-store meta tag is not valid JSON; using sandbox.'); return {}; }
  }
  function readLocalOverride() {
    const v = readJson(KEYS.config, null);
    return v && typeof v === 'object' ? v : {};
  }
  function markBody() { if (hasDoc() && document.body && document.body.dataset) document.body.dataset.store = config.mode; }

  function configure(opts = {}) {
    const next = { ...config };
    const apply = o => {
      if (o.mode !== undefined) next.mode = String(o.mode).toLowerCase();
      if (o.apiBase !== undefined) next.apiBase = String(o.apiBase || '').trim().replace(/\/+$/, '');
      if (o.successPath !== undefined) next.successPath = String(o.successPath || '');
      if (o.latencyMs !== undefined) next.latencyMs = Math.max(0, Number(o.latencyMs) || 0);
    };
    apply(opts || {});
    apply(readLocalOverride());          // localStorage['portsolace.store'] always wins: local testing against another origin
    if (!MODES.has(next.mode)) { warn(`Unknown store mode "${next.mode}"; using sandbox.`); next.mode = 'sandbox'; }
    if (next.mode === 'stripe' && !/^https?:\/\/\S+$/.test(next.apiBase)) { warn('Stripe mode needs an http(s) apiBase; using sandbox.'); next.mode = 'sandbox'; }
    Object.assign(config, next);
    markBody();
    emit('config', { ...config });
    return api;
  }
  function boot() { configure({ ...DEFAULTS, ...readTagConfig() }); }

  // ---------------------------------------------------------- backend calls (7.4 contract)
  async function callApi(path, { method = 'GET', body } = {}) {
    if (!config.apiBase) throw new StoreError('no-backend', 'No store backend is configured.');
    let res;
    try {
      res = await fetch(config.apiBase + path, {
        method, mode: 'cors', credentials: 'omit',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) { throw new StoreError('network', 'Could not reach the store backend.'); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new StoreError((data && data.error) || `http-${res.status}`, (data && data.message) || `The store backend answered ${res.status}.`, res.status);
    return data || {};
  }

  // ---------------------------------------------------------- purchase (7.2)
  async function confirmPurchase(entry) {
    const req = { sku: entry.sku, title: entry.title, desc: entry.desc, priceLabel: entry.priceLabel, testMode: true };
    const hook = api.ui && typeof api.ui.confirm === 'function' ? api.ui.confirm : null;
    try {
      if (hook) return !!(await hook(req));
      if (typeof window !== 'undefined' && window && typeof window.confirm === 'function') {
        return !!window.confirm(`TEST MODE · nothing is charged.\n\nBuy ${entry.title} for ${entry.priceLabel}?`);
      }
      return true;                                           // headless harness: no UI to ask
    } catch (e) { return false; }
  }

  async function sandboxPurchase(entry) {
    const ok = await confirmPurchase(entry);
    if (!ok) {
      const payload = { sku: entry.sku, granted: false, mode: 'sandbox', cancelled: true };
      emit('purchase', payload);
      return { ok: false, ...payload };
    }
    await delay(config.latencyMs);
    const grantId = `sandbox-${uuid()}`;
    const { granted, pending } = applyGrant(entry, grantId, 'sandbox');
    const payload = { sku: entry.sku, granted, mode: 'sandbox', grantId, pending: !!pending };
    emit('purchase', payload);
    return { ok: true, ...payload };
  }

  function returnUrl() {
    const path = config.successPath || location.pathname || '/';
    return location.origin + (path.startsWith('/') ? path : '/' + path);
  }

  async function stripePurchase(entry) {
    if (!hasLoc()) return fail(entry.sku, 'stripe', 'no-window', 'Stripe checkout needs a browser window.');
    try {
      const session = await callApi('/checkout', { method: 'POST', body: { sku: entry.sku, playerId: playerId(), returnUrl: returnUrl() } });
      if (!session || typeof session.url !== 'string' || !/^https:\/\//.test(session.url)) throw new StoreError('bad-session', 'The store backend did not return a checkout link.');
      writeJson(KEYS.inflight, { sku: entry.sku, sessionId: session.id || null, at: Date.now(), unclaimed: false });
      emit('redirect', { sku: entry.sku, url: session.url, sessionId: session.id || null });
      location.assign(session.url);
      return { ok: true, sku: entry.sku, granted: false, mode: 'stripe', redirect: true, sessionId: session.id || null };
    } catch (err) {
      return fail(entry.sku, 'stripe', err.code || 'network', err.message);
    }
  }

  function fail(sku, mode, code, message) {
    const payload = { sku, granted: false, mode, error: code, message };
    emit('purchase', payload);
    return { ok: false, ...payload };
  }

  async function purchase(sku) {
    await readyPromise;
    const entry = findEntry(sku);
    if (!entry) return { ok: false, sku, granted: false, error: 'unknown-sku', message: `Unknown item "${sku}".` };
    if (NON_CONSUMABLE.has(entry.kind) && owned(entry.sku)) return { ok: false, sku, granted: false, error: 'already-owned', message: `${entry.title} is already yours.` };
    if (busy) return { ok: false, sku, granted: false, error: 'busy', message: 'Another purchase is in progress.' };
    busy = true;
    try { return config.mode === 'stripe' ? await stripePurchase(entry) : await sandboxPurchase(entry); }
    finally { busy = false; }
  }

  // ---------------------------------------------------------- resume after Stripe (7.2): ?purchase=success&session_id=… | ?purchase=cancel
  function currentQuery() {
    if (!hasLoc() || typeof location.search !== 'string') return {};
    const p = new URLSearchParams(location.search);
    return { purchase: p.get('purchase'), sessionId: p.get('session_id') };
  }
  function stripQuery(keys) {
    if (!hasLoc() || typeof history === 'undefined' || !history || typeof history.replaceState !== 'function') return;
    try {
      const u = new URL(location.href);
      keys.forEach(k => u.searchParams.delete(k));
      history.replaceState(history.state ?? null, '', u.pathname + u.search + u.hash);
    } catch (e) { /* malformed location: leave the URL alone */ }
  }
  const inflight = () => readJson(KEYS.inflight, null);
  const clearInflight = () => writeJson(KEYS.inflight, null);

  async function claimSession(sessionId, extra) {
    const known = inflight() || {};
    if (isRecorded(sessionId)) { clearInflight(); return { handled: true, ok: true, duplicate: true, sku: known.sku || null, grantId: sessionId, ...extra }; }
    try {
      const data = await callApi(`/claim?session_id=${enc(sessionId)}&playerId=${enc(playerId())}`);
      const entry = findEntry(data.sku);
      if (!entry) throw new StoreError('unknown-sku', `The backend granted an unknown item "${data.sku}".`, 200);
      const { granted, pending } = applyGrant(entry, sessionId, 'stripe');
      clearInflight();
      const payload = { sku: entry.sku, granted, mode: 'stripe', grantId: sessionId, pending: !!pending };
      emit('purchase', payload);
      return { handled: true, ok: true, ...payload, ...extra };
    } catch (err) {
      const transient = err.code === 'network' || err.status >= 500;
      if (transient) writeJson(KEYS.inflight, { ...known, sessionId, unclaimed: true, at: known.at || Date.now() });   // retried on the next resume()
      else clearInflight();
      const payload = { sku: known.sku || null, granted: false, mode: 'stripe', grantId: sessionId, error: err.code || 'network', message: err.message };
      emit('purchase', payload);
      return { handled: true, ok: false, ...payload, ...extra };
    }
  }

  async function resume() {
    await readyPromise;
    flush();
    const q = currentQuery();
    if (q.purchase) stripQuery(['purchase', 'session_id']);
    if (q.purchase === 'cancel') {
      const known = inflight() || {};
      clearInflight();
      const payload = { sku: known.sku || null, granted: false, mode: config.mode, cancelled: true };
      emit('purchase', payload);
      return { handled: true, ok: false, ...payload };
    }
    if (q.purchase === 'success' && q.sessionId) return claimSession(q.sessionId, { fromQuery: true });
    const stale = inflight();
    if (stale && stale.unclaimed && stale.sessionId && config.mode === 'stripe') return claimSession(stale.sessionId, { retry: true });
    return { handled: false };
  }

  // ---------------------------------------------------------- restore (7.2): with an email → /restore, without → /entitlements
  async function restore(email) {
    await readyPromise;
    flush();
    const applied = [];
    if (config.mode !== 'stripe') return { ok: true, mode: config.mode, applied, message: 'Test mode: purchases live in this browser only.' };
    try {
      const pid = enc(playerId());
      const clean = email ? String(email).trim().toLowerCase() : '';
      const data = await callApi(clean ? `/restore?email=${enc(clean)}&playerId=${pid}` : `/entitlements?playerId=${pid}`);
      for (const g of Array.isArray(data.grants) ? data.grants : []) {
        if (!g || !g.grantId || isRecorded(g.grantId)) continue;
        const entry = findEntry(g.sku); if (!entry) continue;
        const { granted, pending } = applyGrant(entry, g.grantId, 'stripe');
        const payload = { sku: entry.sku, granted, mode: 'stripe', grantId: g.grantId, pending: !!pending, restored: true };
        applied.push(payload);
        emit('purchase', payload);
      }
      return { ok: true, mode: 'stripe', applied, found: Array.isArray(data.grants) ? data.grants.length : 0, otherProfile: data.otherProfile || 0 };
    } catch (err) {
      return { ok: false, mode: 'stripe', applied, error: err.code || 'network', message: err.message };
    }
  }

  // ---------------------------------------------------------- public API (7.2)
  const api = {
    ui: { confirm: null },                                   // H sets Store.ui.confirm(req) -> Promise<bool>
    configure,
    catalog: () => entries().map(cloneEntry),
    item: sku => { const e = findEntry(sku); return e ? cloneEntry(e) : null; },
    purchase,
    resume,
    restore,
    grant(sku, opts = {}) {                                  // manual/integrator grant; idempotent by grantId
      const entry = findEntry(sku);
      if (!entry) return { ok: false, sku, granted: false, error: 'unknown-sku' };
      const grantId = opts.grantId || `manual-${uuid()}`;
      const { granted, pending, duplicate } = applyGrant(entry, grantId, opts.mode || config.mode);
      return { ok: !duplicate, sku, granted, grantId, pending: !!pending, duplicate: !!duplicate };
    },
    flush,
    entitlements,
    owned,
    playerId,
    pending: () => pendingQueue(),
    on, off,
    get mode() { return config.mode; },
    get config() { return { ...config }; },
    get catalogSource() { entries(); return catalogSource; },
    get warnings() { return warnings.slice(); },
    get busy() { return busy; },
    ready: null,
  };

  // Boot now (the <meta> lives in <head>, so it is readable from any body script); re-read once the DOM is complete.
  const readyPromise = new Promise(resolve => {
    boot();
    if (hasDoc() && document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', () => { boot(); resolve(api); }, { once: true });
    } else resolve(api);
  });
  api.ready = readyPromise;
  return api;
})();

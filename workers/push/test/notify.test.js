// ============================================================
// PORT SOLACE — push worker tests, part 3: the game client (waystation/play/js/notify.js)
// Loads notify.js into a node:vm context with a fake browser (document with the <meta> tag, localStorage,
// navigator.serviceWorker, PushManager, Notification, fetch, a controllable setTimeout) and a fake Sim / Meta,
// then walks the opt-in, the schedule computation, the debounce, the failure paths and the opt-out.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

import { generateVapidKeys, b64u, decodePoint } from '../src/webpush.js';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, '../../../waystation/play/js/notify.js'), 'utf8');
const API = 'https://waystation-push.example.workers.dev';
const MIN = 60e3;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ---------------------------------------------------------- the fake world
async function makeWorld({ meta = `{"apiBase":"${API}"}`, serviceWorker = true, permission = 'default', answer = 'granted', storage = {}, settings = {}, visibility = 'visible', fetchPlan = {} } = {}) {
  const vapid = await generateVapidKeys();
  const log = { fetch: [], sw: { registered: [], unregistered: 0, messages: [] }, subscribe: [], unsubscribed: 0, saves: 0 };
  const now = Date.now();
  const station = (sector, extra = {}) => ({
    name: sector === 'home' ? 'Harrow Point' : 'Outpost', sector,
    grid: [[{ id: 'hub' }, { id: 'dock' }, null], [null, { id: 'comms' }, { id: 'solar' }]],
    cells: { '0,0': { readyAt: null }, '0,1': { readyAt: now + 5 * MIN }, '1,1': { readyAt: now + 10 * MIN, up: 2 }, '1,2': { readyAt: now + 60e3 } },
    plot: null, ...extra,
  });
  const home = station('home', { plot: { clearing: { ring: 2, endsAt: now + 15 * MIN } } });
  const sable = station('sable', { cells: { '0,1': { readyAt: now + 3 * 3600e3 } } });
  const Sim = {
    state: home, listeners: {},
    on(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    emit(ev, d) { (this.listeners[ev] || []).forEach(fn => fn(d)); },
  };
  const Meta = {
    profile: { playerId: 'pm2k4f9a1xyz', activeSector: 'home', sectors: { home, sable }, settings: { ...settings } },
    expeditions: () => [{ id: 7, sector: 'sable', def: { name: 'Sable Drift' }, status: 'out', endsAt: now + 40 * MIN }, { id: 6, sector: 'home', status: 'claimed', endsAt: now - MIN }],
    daily: () => ({ claimable: false, nextAt: new Date(new Date(now + 86400e3).setHours(0, 0, 0, 0)).getTime() }),
    save() { log.saves++; },
  };
  // localStorage
  const store = new Map(Object.entries(storage).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  // service worker + push
  let subscription = null;
  const pushManager = {
    async getSubscription() { return subscription; },
    async subscribe(opts) {
      log.subscribe.push(opts);
      const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const p256dh = b64u.encode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey)));
      const auth = b64u.encode(crypto.getRandomValues(new Uint8Array(16)));
      const endpoint = `https://push.example.com/send/${log.subscribe.length}`;
      subscription = {
        endpoint, options: { applicationServerKey: opts.applicationServerKey },
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
        async unsubscribe() { log.unsubscribed++; subscription = null; return true; },
      };
      return subscription;
    },
  };
  const registration = { pushManager, active: { postMessage: m => log.sw.messages.push(m) }, async unregister() { log.sw.unregistered++; return true; }, scope: 'https://portsolace.com/play/' };
  const navigator = { userAgent: 'test' };
  if (serviceWorker) {
    navigator.serviceWorker = {
      async register(url) { log.sw.registered.push(url); return registration; },
      ready: Promise.resolve(registration),
      async getRegistration() { return log.sw.registered.length ? registration : null; },
    };
  }
  const Notification = {
    permission,
    requestPermission(cb) { Notification.permission = answer; if (cb) cb(answer); return Promise.resolve(answer); },
  };
  // the backend
  let token = 'tok_' + 'a'.repeat(39);
  const fetch = async (url, init = {}) => {
    const u = new URL(url), path = u.pathname, body = init.body ? JSON.parse(init.body) : null;
    const call = { path, method: init.method || 'GET', body, keepalive: !!init.keepalive };
    log.fetch.push(call);
    const plan = fetchPlan[path];
    const scripted = typeof plan === 'function' ? plan(call, log.fetch.filter(c => c.path === path).length) : plan;
    if (scripted) return { ok: scripted.status < 400, status: scripted.status, async json() { return scripted.data || {}; } };
    if (path === '/key') return { ok: true, status: 200, async json() { return { publicKey: vapid.publicKey }; } };
    if (path === '/subscribe') return { ok: true, status: 200, async json() { return { ok: true, token }; } };
    if (path === '/schedule') return { ok: body.token === token, status: body.token === token ? 200 : 403, async json() { return body.token === token ? { ok: true, count: body.timers.length } : { error: 'bad-token' }; } };
    if (path === '/unsubscribe') return { ok: true, status: 200, async json() { return { ok: true }; } };
    return { ok: false, status: 404, async json() { return { error: 'not-found' }; } };
  };
  // timers under test control
  const timers = [];
  let clock = 0;
  const setTimeout = (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, at: clock + (ms || 0) }); return id; };
  const clearTimeout = id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const advance = async ms => { clock += ms; const due = timers.filter(t => t.at <= clock); for (const t of due) { clearTimeout(t.id); t.fn(); } await tick(); };
  const docListeners = {};
  const document = {
    visibilityState: visibility, get hidden() { return this.visibilityState !== 'visible'; },
    querySelector: sel => (sel.includes('portsolace-push') && meta != null ? { getAttribute: () => meta } : null),
    addEventListener: (ev, fn) => { (docListeners[ev] ||= []).push(fn); },
  };
  const winListeners = {};
  const ctx = {
    console, URL, atob, btoa, Date, Math, JSON, Promise, Number, String, Object, Array, Error, Uint8Array, Map, Set,
    setTimeout, clearTimeout, setImmediate, fetch,
    document, localStorage, navigator, Notification, PushManager: function PushManager() {}, isSecureContext: true,
    addEventListener: (ev, fn) => { (winListeners[ev] ||= []).push(fn); },
    caches: { async delete() { return true; } },
    Sim, Meta,
    SECTORS: { home: { name: 'Varro Reach' }, sable: { name: 'Sable Drift' } },
    MODULES: { hub: { name: 'Core Hub' }, dock: { name: 'Docking Collar' }, comms: { name: 'Comms Relay' }, solar: { name: 'Solar Array' } },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: 'notify.js' });
  const Notify = vm.runInContext('Notify', ctx);
  return {
    Notify, Sim, Meta, log, now, vapid, store, document, Notification,
    advance, token: () => token, setToken: t => { token = t; },
    fire: (ev, where = 'doc') => ((where === 'doc' ? docListeners : winListeners)[ev] || []).forEach(fn => fn()),
    schedules: () => log.fetch.filter(c => c.path === '/schedule'),
    calls: path => log.fetch.filter(c => c.path === path),
  };
}

// ---------------------------------------------------------- the tests
describe('notify: sandbox and support detection', () => {
  test('without an apiBase nothing is registered, requested or asked', async () => {
    const w = await makeWorld({ meta: '{"apiBase":""}' });
    assert.equal(await w.Notify.boot(), false);
    assert.equal(w.Notify.state().status, 'unconfigured');
    assert.equal(await w.Notify.enable(), false);
    assert.equal(w.Notify.state().status, 'unconfigured');
    assert.equal(w.log.fetch.length, 0);
    assert.equal(w.log.sw.registered.length, 0);
    assert.equal(w.Notification.permission, 'default');
    assert.equal(w.Notify.state().configured, false);
    const none = await makeWorld({ meta: null });
    assert.equal(none.Notify.state().status, 'off', 'state before boot');
    await none.Notify.boot();
    assert.equal(none.Notify.state().status, 'unconfigured');
    const broken = await makeWorld({ meta: '{not json' });
    await broken.Notify.boot();
    assert.equal(broken.Notify.state().status, 'unconfigured');
  });
  test('a browser without service workers reports unsupported', async () => {
    const w = await makeWorld({ serviceWorker: false });
    await w.Notify.boot();
    assert.equal(w.Notify.state().status, 'unsupported');
    assert.equal(await w.Notify.enable(), false);
    assert.equal(w.log.fetch.length, 0);
  });
  test('the localStorage override wins over the meta tag', async () => {
    const w = await makeWorld({ meta: '{"apiBase":""}', storage: { 'portsolace.push': { apiBase: 'http://127.0.0.1:8789/' } } });
    await w.Notify.boot();
    assert.equal(w.Notify.state().status, 'off');
    assert.equal(w.Notify.state().apiBase, 'http://127.0.0.1:8789');
  });
  test('configured but not opted in: off, and nothing happens on events', async () => {
    const w = await makeWorld();
    assert.equal(await w.Notify.boot(), false);
    assert.equal(w.Notify.state().status, 'off');
    w.Sim.emit('change'); await w.advance(10e3);
    assert.equal(w.log.fetch.length, 0);
    assert.equal(w.log.sw.registered.length, 0);
  });
});

describe('notify: the schedule', () => {
  test('collects every pending timer across sectors with the agreed ids and titles', async () => {
    const w = await makeWorld({ settings: { notifyDaily: true } });
    const list = plain(w.Notify.timers({ all: true }));
    assert.deepEqual(list.map(t => t.id), ['build:home:1,2', 'build:home:0,1', 'upgrade:home:1,1', 'plot:home:2', 'expedition:7', 'build:sable:0,1', 'daily']);
    const by = Object.fromEntries(list.map(t => [t.id, t]));
    assert.equal(by['build:home:0,1'].title, 'Docking Collar online');
    assert.equal(by['build:home:0,1'].kind, 'build');
    assert.equal(by['upgrade:home:1,1'].title, 'Comms Relay is now level 2');
    assert.equal(by['upgrade:home:1,1'].kind, 'upgrade');
    assert.equal(by['plot:home:2'].title, 'Ring 2 cleared');
    assert.equal(by['expedition:7'].title, 'Expedition back from Sable Drift');
    assert.equal(by['build:sable:0,1'].title, 'Docking Collar online · Sable Drift');
    assert.equal(by.daily.title, 'Daily reward ready');
    const d = new Date(by.daily.dueAt);
    assert.deepEqual([d.getHours(), d.getMinutes()], [9, 0], 'the daily reminder lands at 09:00 local');
    assert.ok(by.daily.dueAt > w.Meta.daily().nextAt);
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].dueAt <= list[i].dueAt, 'sorted');
  });
  test('while the tab is visible the timers about to finish stay out; the daily only when asked', async () => {
    const w = await makeWorld();
    const ids = w.Notify.timers().map(t => t.id);
    assert.ok(!ids.includes('build:home:1,2'), 'due in 60 s: the player is watching it');
    assert.ok(!ids.includes('daily'));
    assert.ok(ids.includes('build:home:0,1'));
    w.document.visibilityState = 'hidden';
    assert.ok(w.Notify.timers().map(t => t.id).includes('build:home:1,2'), 'hidden: everything goes');
  });
});

describe('notify: opting in', () => {
  test('enable() asks permission, registers sw.js, subscribes with the VAPID key, registers and posts the schedule', async () => {
    const w = await makeWorld();
    await w.Notify.boot();
    const ok = await w.Notify.enable();
    assert.equal(ok, true, w.Notify.state().detail);
    assert.equal(w.Notification.permission, 'granted');
    assert.deepEqual(w.log.sw.registered, ['sw.js']);
    assert.equal(w.calls('/key').length, 1);
    assert.equal(w.log.subscribe.length, 1);
    assert.equal(w.log.subscribe[0].userVisibleOnly, true);
    assert.deepEqual([...w.log.subscribe[0].applicationServerKey], [...decodePoint(w.vapid.publicKey)]);
    const sub = w.calls('/subscribe');
    assert.equal(sub.length, 1);
    assert.equal(sub[0].body.playerId, 'pm2k4f9a1xyz');
    assert.equal(sub[0].body.subscription.endpoint, 'https://push.example.com/send/1');
    assert.ok(sub[0].body.subscription.keys.p256dh && sub[0].body.subscription.keys.auth);
    assert.equal(w.Meta.profile.settings.notify, true);
    assert.ok(w.log.saves >= 1);
    assert.equal(w.Notify.state().status, 'on');
    assert.equal(w.Notify.state().subscribed, true);
    const local = JSON.parse(w.store.get('portsolace.push.sub'));
    assert.deepEqual(local, { apiBase: API, playerId: 'pm2k4f9a1xyz', endpoint: 'https://push.example.com/send/1', token: w.token() });
    assert.equal(w.log.sw.messages[0].type, 'portsolace-push-config');
    assert.equal(w.log.sw.messages[0].apiBase, API);
    await tick();
    const posts = w.schedules();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.token, w.token());
    assert.equal(posts[0].body.station, 'Harrow Point');
    assert.deepEqual(posts[0].body.timers.map(t => t.id), ['build:home:0,1', 'upgrade:home:1,1', 'plot:home:2', 'expedition:7', 'build:sable:0,1']);
  });
  test('a refused permission leaves the setting off and reports blocked', async () => {
    const w = await makeWorld({ answer: 'denied' });
    await w.Notify.boot();
    assert.equal(await w.Notify.enable(), false);
    assert.equal(w.Notify.state().status, 'blocked');
    assert.equal(w.Meta.profile.settings.notify, false);
    assert.equal(w.log.subscribe.length, 0);
    assert.equal(w.calls('/subscribe').length, 0);
    const dismissed = await makeWorld({ answer: 'default' });
    await dismissed.Notify.enable();
    assert.equal(dismissed.Notify.state().status, 'off');
  });
  test('a backend failure during enable() reports an error and leaves the setting off', async () => {
    const w = await makeWorld({ fetchPlan: { '/subscribe': { status: 500, data: { error: 'internal', message: 'boom' } } } });
    assert.equal(await w.Notify.enable(), false);
    assert.equal(w.Notify.state().status, 'error');
    assert.match(w.Notify.state().detail, /boom/);
    assert.equal(w.Meta.profile.settings.notify, false);
  });
});

describe('notify: keeping the schedule current', () => {
  test('events are debounced into one post and unchanged schedules are not re-posted', async () => {
    const w = await makeWorld();
    await w.Notify.enable(); await tick();
    assert.equal(w.schedules().length, 1);
    w.Sim.emit('change'); w.Sim.emit('build-start'); w.Sim.emit('change');
    await w.advance(1000);
    assert.equal(w.schedules().length, 1, 'still inside the debounce');
    await w.advance(4000);
    assert.equal(w.schedules().length, 1, 'nothing changed, nothing posted');
    w.Sim.state.cells['0,2'] = { readyAt: w.now + 20 * MIN }; w.Sim.state.grid[0][2] = { id: 'solar' };
    w.Sim.emit('build-start'); w.Sim.emit('change');
    await w.advance(4000);
    assert.equal(w.schedules().length, 2);
    assert.ok(w.schedules()[1].body.timers.some(t => t.id === 'build:home:0,2' && t.title === 'Solar Array online'));
    delete w.Sim.state.cells['0,2'];
    w.Sim.emit('build-done'); await w.advance(4000);
    assert.equal(w.schedules().length, 3);
    assert.ok(!w.schedules()[2].body.timers.some(t => t.id === 'build:home:0,2'));
  });
  test('hiding the tab flushes at once with keepalive and the near timers included', async () => {
    const w = await makeWorld();
    await w.Notify.enable(); await tick();
    w.document.visibilityState = 'hidden';
    w.fire('visibilitychange'); await tick();
    const posts = w.schedules();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].keepalive, true);
    assert.ok(posts[1].body.timers.some(t => t.id === 'build:home:1,2'));
    w.document.visibilityState = 'visible';
    w.fire('visibilitychange'); await w.advance(4000);
    assert.equal(w.schedules().length, 3);
    assert.ok(!w.schedules()[2].body.timers.some(t => t.id === 'build:home:1,2'));
    w.fire('pagehide', 'win'); await tick();
    assert.equal(w.schedules().length, 4, 'closing the tab posts the full list again');
    assert.equal(w.schedules()[3].keepalive, true);
    assert.ok(w.schedules()[3].body.timers.some(t => t.id === 'build:home:1,2'));
    w.fire('pagehide', 'win'); await tick();
    assert.equal(w.schedules().length, 4, 'nothing changed since: no post');
  });
  test('setDaily() re-posts with the daily reminder; test() posts a due test timer', async () => {
    const w = await makeWorld();
    await w.Notify.enable(); await tick();
    w.Notify.setDaily(true); await tick();
    assert.equal(w.Meta.profile.settings.notifyDaily, true);
    assert.ok(w.schedules()[1].body.timers.some(t => t.id === 'daily' && t.kind === 'daily'));
    assert.equal(await w.Notify.test(), true);
    const last = w.schedules().at(-1).body.timers;
    const t = last.find(x => x.id === 'test');
    assert.ok(t && t.kind === 'test' && t.dueAt <= Date.now());
    assert.ok(last.some(x => x.id === 'daily'), 'the rest of the schedule rides along');
  });
  test('when the backend has forgotten the subscription the client subscribes again, once', async () => {
    const w = await makeWorld();
    await w.Notify.enable(); await tick();
    w.setToken('tok_' + 'b'.repeat(39));                      // the backend now holds a different token (subscription replaced)
    w.Sim.state.cells['0,2'] = { readyAt: w.now + 20 * MIN }; w.Sim.state.grid[0][2] = { id: 'solar' };
    w.Sim.emit('change'); await w.advance(4000); await tick(12);
    assert.equal(w.calls('/subscribe').length, 2, 'registered again after the 403');
    const posts = w.schedules();
    assert.equal(posts.at(-1).body.token, w.token());
    assert.equal(posts.at(-1).status, undefined);
    assert.equal(w.Notify.state().status, 'on');
    assert.equal(JSON.parse(w.store.get('portsolace.push.sub')).token, w.token());
  });
  test('three failed posts in a row show Offline; the next success clears it', async () => {
    let fail = true;
    const w = await makeWorld({ fetchPlan: { '/schedule': () => (fail ? { status: 503, data: { error: 'internal' } } : null) } });
    await w.Notify.enable(); await tick();
    assert.equal(w.Notify.state().status, 'on', 'one failure is not news');
    for (let i = 0; i < 2; i++) { w.Sim.emit('change'); await w.advance(4000); }
    assert.equal(w.Notify.state().status, 'error');
    assert.match(w.Notify.state().detail, /could not be reached/);
    assert.equal(w.Meta.profile.settings.notify, true, 'the setting stays on; the backend may just be down');
    fail = false;
    w.Sim.emit('change'); await w.advance(4000);
    assert.equal(w.Notify.state().status, 'on');
  });
  test('a profile change moves the subscription to the new player id', async () => {
    const w = await makeWorld();
    await w.Notify.enable(); await tick();
    w.Meta.profile.playerId = 'pnewplayer0001';
    w.Meta.profile.settings.notify = true;
    w.Sim.emit('sector'); await w.advance(4000); await tick(12);
    assert.equal(w.calls('/unsubscribe').length, 1);
    assert.equal(w.calls('/unsubscribe')[0].body.playerId, 'pm2k4f9a1xyz');
    assert.equal(w.calls('/subscribe').at(-1).body.playerId, 'pnewplayer0001');
    assert.equal(w.schedules().at(-1).body.playerId, 'pnewplayer0001');
  });
});

describe('notify: boot and opting out', () => {
  test('boot() re-attaches silently when the player opted in earlier and permission is granted', async () => {
    const first = await makeWorld();
    await first.Notify.enable(); await tick();
    const saved = JSON.parse(first.store.get('portsolace.push.sub'));
    // the push service handed out a new endpoint since: boot registers it
    const w = await makeWorld({ permission: 'granted', settings: { notify: true }, storage: { 'portsolace.push.sub': { ...saved, endpoint: 'https://push.example.com/send/old' } } });
    assert.equal(await w.Notify.boot(), true);
    assert.equal(w.Notify.state().status, 'on');
    assert.deepEqual(w.log.sw.registered, ['sw.js']);
    assert.equal(w.log.subscribe.length, 1, 'no subscription existed in this fresh fake browser, so one was created');
    assert.equal(w.calls('/subscribe').length, 1, 'the new endpoint is registered');
    await tick();
    assert.equal(w.schedules().length, 1);
    assert.equal(w.Notification.permission, 'granted', 'never prompts on boot');
    // the same endpoint as last time: nothing to register, straight to the schedule
    const same = await makeWorld({ permission: 'granted', settings: { notify: true }, storage: { 'portsolace.push.sub': saved } });
    assert.equal(await same.Notify.boot(), true);
    assert.equal(same.calls('/subscribe').length, 0);
    await tick();
    assert.equal(same.schedules().length, 1);
    assert.equal(same.schedules()[0].body.token, saved.token);
  });
  test('boot() stays off when permission was revoked, and reports blocked', async () => {
    const w = await makeWorld({ permission: 'denied', settings: { notify: true } });
    assert.equal(await w.Notify.boot(), false);
    assert.equal(w.Notify.state().status, 'blocked');
    assert.equal(w.log.sw.registered.length, 0);
    const reset = await makeWorld({ permission: 'default', settings: { notify: true } });
    await reset.Notify.boot();
    assert.equal(reset.Notify.state().status, 'off');
  });
  test('disable() tells the backend, drops the push subscription, unregisters the worker and clears the setting', async () => {
    const w = await makeWorld();
    await w.Notify.enable(); await tick();
    const tok = w.token();
    assert.equal(await w.Notify.disable(), true);
    await tick();
    assert.equal(w.Notify.state().status, 'off');
    assert.equal(w.Meta.profile.settings.notify, false);
    assert.deepEqual(w.calls('/unsubscribe')[0].body, { playerId: 'pm2k4f9a1xyz', token: tok });
    assert.equal(w.log.unsubscribed, 1);
    assert.equal(w.log.sw.unregistered, 1);
    assert.equal(w.store.has('portsolace.push.sub'), false);
    assert.deepEqual(plain(w.log.sw.messages.at(-1)), { type: 'portsolace-push-config' }, 'the worker forgets the backend');
    w.Sim.emit('change'); await w.advance(5000);
    assert.equal(w.schedules().length, 1, 'no more posts');
  });
});

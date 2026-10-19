// ============================================================
// WAYSTATION — service worker for push notifications (DESIGN2.md Addendum A3)
// Registered by js/notify.js only after the player turns notifications on in Settings; never on a
// plain page load. It has one job: show the notification the push worker (workers/push) sends and
// bring the bridge back when it is clicked. No fetch handler, no caching: the site stays plain static.
// ============================================================
'use strict';

const CONFIG_CACHE = 'waystation-push-config';
const CONFIG_URL = '/__waystation-push-config';
const DEFAULT_TITLE = 'Waystation';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

// The page tells us where the backend is (and who the player is) so a subscription the push service
// renews behind our back (pushsubscriptionchange) can register itself again. An empty message clears it.
self.addEventListener('message', e => {
  const d = e.data;
  if (!d || d.type !== 'waystation-push-config') return;
  e.waitUntil(saveConfig(d.apiBase ? { apiBase: d.apiBase, playerId: d.playerId, publicKey: d.publicKey || '' } : null));
});

self.addEventListener('push', e => {
  let data = null;
  try { data = e.data ? e.data.json() : null; } catch (err) { data = { title: DEFAULT_TITLE, body: e.data ? e.data.text() : '' }; }
  if (!data || typeof data !== 'object') data = {};
  const title = String(data.title || DEFAULT_TITLE).slice(0, 80);
  const icon = new URL('../assets/icon-192.png', self.registration.scope).href;
  const options = {
    body: String(data.body || '').slice(0, 200),
    icon,
    tag: String(data.tag || 'waystation').slice(0, 32),      // a newer notice replaces the previous one
    renotify: true,
    timestamp: Number(data.at) || Date.now(),
    data: { url: self.registration.scope, kinds: Array.isArray(data.kinds) ? data.kinds.slice(0, 8) : [] },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Click: focus the bridge if it is open anywhere, otherwise open /play/.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const scope = self.registration.scope;
  const url = (e.notification.data && e.notification.data.url) || scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url && c.url.indexOf(scope) === 0) || null;
    if (open && 'focus' in open) return open.focus();
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return null;
  }));
});

// The push service rotated the subscription: subscribe again with the same key and tell the backend.
// The page will fetch its token again on its next schedule post (the backend answers 403 until it does).
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const cfg = await loadConfig();
    if (!cfg || !cfg.apiBase || !cfg.playerId) return;
    let sub = e.newSubscription || null;
    if (!sub) {
      const old = e.oldSubscription, opts = old && old.options;
      const key = (opts && opts.applicationServerKey) || (cfg.publicKey ? keyBytes(cfg.publicKey) : null);
      if (!key) return;
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    await fetch(`${cfg.apiBase}/subscribe`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, mode: 'cors', credentials: 'omit',
      body: JSON.stringify({ playerId: cfg.playerId, subscription: sub.toJSON() }),
    });
  })().catch(() => { /* the page re-subscribes on its next load */ }));
});

function keyBytes(b64) {
  const s = String(b64).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(s + (s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function saveConfig(cfg) {
  try {
    const c = await caches.open(CONFIG_CACHE);
    if (!cfg) { await c.delete(CONFIG_URL); return; }
    await c.put(CONFIG_URL, new Response(JSON.stringify(cfg), { headers: { 'content-type': 'application/json' } }));
  } catch (e) { /* storage unavailable: nothing to do, the page handles re-subscription */ }
}
async function loadConfig() {
  try { const c = await caches.open(CONFIG_CACHE); const r = await c.match(CONFIG_URL); return r ? await r.json() : null; }
  catch (e) { return null; }
}

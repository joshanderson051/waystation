// ============================================================
// PORT SOLACE — migrate.js: the Waystation -> Port Solace storage rename (migration contract M1)
// Classic script, the very first <script> in play/index.html (before PixiJS). It runs synchronously
// at parse time so every module after it reads the new 'portsolace…' keys.
//
// For each localStorage key that starts with 'waystation' it copies the value to the same key with
// 'portsolace' in its place ('waystation.profile.v2' -> 'portsolace.profile.v2'), only when the new
// key does not exist yet. Old keys are never deleted. The copy runs once per browser: the marker
// 'portsolace.migrated.v1' (ISO time) records it, so a key the game removes later (a claimed store
// grant, a sign-out, a cleared push subscription) is not brought back from its old copy on the next load.
//
// Exposes only window.PortSolaceMigrate = { mapKey(k) } (the same prefix mapping) for import.html and
// tests. Wrapped in try/catch: storage that is blocked or full never breaks boot.
// ============================================================
'use strict';

(function migrate() {
  const OLD = 'waystation', NEW = 'portsolace', MARK = 'portsolace.migrated.v1';
  const mapKey = k => (typeof k === 'string' && k.indexOf(OLD) === 0) ? NEW + k.slice(OLD.length) : k;
  try { window.PortSolaceMigrate = Object.freeze({ mapKey }); } catch (e) { /* no window: nothing to expose */ }
  try {
    const ls = window.localStorage;
    if (!ls || ls.getItem(MARK) !== null) return;
    const keys = [];
    for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (typeof k === 'string' && k.indexOf(OLD) === 0) keys.push(k); }
    for (const k of keys) {
      try {
        const n = mapKey(k), v = ls.getItem(k);
        if (v !== null && ls.getItem(n) === null) ls.setItem(n, v);
      } catch (e) { /* one key failing (quota) does not stop the others */ }
    }
    ls.setItem(MARK, new Date().toISOString());
  } catch (e) { /* storage unavailable: the game starts with whatever it can read */ }
})();

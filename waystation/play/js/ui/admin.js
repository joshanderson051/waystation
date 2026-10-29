// ============================================================
// PORT SOLACE — ui/admin.js: the Bridge Admin testing console
// A passphrase-gated console for the owner: grant Antimatter and credits, finish timers,
// fill banks, unlock sectors, nudge rank and reputation, make the daily claimable, force
// the store mode. Opened from Settings ("Bridge admin") or Ctrl+Shift+A.
//
// Gate: the SHA-256 of the passphrase lives in <meta name="portsolace-admin" content="sha256:…">;
// the passphrase itself is never in the repository. An unlock lasts for the tab (sessionStorage).
// Honesty note: the game runs entirely in the browser, so this is a convenience gate, not a
// security boundary; anyone can open the dev tools and call Meta directly. Every grant made here
// goes through the normal Meta paths and is recorded in profile.entitlements.history with
// mode 'admin', so test profiles can be told apart from real ones.
// Classic script; exposes the `Admin` global. Loads after store.js, before main.js.
// ============================================================
'use strict';

const Admin = (() => {
  const KEY = 'portsolace.admin';
  const has = (o, f) => !!(o && typeof o[f] === 'function');
  const $ = s => document.querySelector(s);
  const fmtN = n => (typeof fmt === 'function' ? fmt(n) : String(n));

  function metaHash() {
    const m = $('meta[name="portsolace-admin"]');
    return m ? String(m.getAttribute('content') || '').replace(/^sha256:/i, '').trim().toLowerCase() : '';
  }
  async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const unlocked = () => { try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } };
  const setUnlocked = v => { try { if (v) sessionStorage.setItem(KEY, '1'); else sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } };
  const toast = (m, k) => { if (typeof UI !== 'undefined' && has(UI, 'toast')) UI.toast(m, k); };
  const refresh = () => { if (typeof UI !== 'undefined' && has(UI, 'refresh')) UI.refresh(); };
  const sound = f => { if (typeof Sound !== 'undefined' && has(Sound, f)) Sound[f](); };

  // ---------------------------------------------------------- open: gate or console
  function open() {
    if (typeof Overlays === 'undefined' || typeof Meta === 'undefined' || !Meta.profile) return;
    if (!metaHash()) { toast('Admin is not configured on this build', 'warn'); return; }
    if (unlocked()) consoleModal(); else gateModal();
  }

  function gateModal() {
    let typed = '';
    Overlays.modal({
      kind: 'confirm', tag: 'Bridge admin', title: 'Admin access',
      html: '<p>Enter the admin passphrase. The console is for testing: every grant is recorded in the profile history as an admin grant.</p>',
      extra: '<input id="adm-pass" class="input" type="password" autocomplete="off" spellcheck="false" placeholder="Passphrase" aria-label="Admin passphrase">',
      actions: [
        { label: 'Unlock', primary: true, fn: () => tryUnlock(typed) },
        { label: 'Cancel', ghost: true },
      ],
    });
    const inp = $('#adm-pass');
    if (inp) {
      inp.focus();
      inp.addEventListener('input', () => { typed = inp.value; });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const v = inp.value; Overlays.closeModal(); tryUnlock(v); } });
    }
  }

  async function tryUnlock(pass) {
    const h = await sha256(String(pass || '').trim());
    if (h && h === metaHash()) { setUnlocked(true); sound('open'); toast('Admin unlocked for this tab', 'good'); consoleModal(); }
    else { sound('error'); toast('Wrong passphrase', 'bad'); }
  }

  // ---------------------------------------------------------- the console
  function statusLine() {
    const s = Sim.state, p = Meta.profile;
    const mode = typeof Store !== 'undefined' && Store.mode ? Store.mode : 'n/a';
    const rank = Meta.rank || { level: 1 };
    return `${fmtN(Math.floor(Meta.am || 0))} AM · ${fmtN(Math.floor(s.credits || 0))} cr · rank ${rank.level} · L${s.level} · ring ${s.plot ? s.plot.ring : '-'} · store ${mode} · profile ${p.playerId ? String(p.playerId).slice(0, 8) : '?'}`;
  }
  function row(label, btns) {
    return `<div class="setting"><div class="setting-main"><span class="setting-lbl">${label}</span></div><div class="actions">` +
      btns.map(([act, l, cls]) => `<button type="button" class="btn ${cls || ''}" data-adm="${act}">${l}</button>`).join('') + '</div></div>';
  }
  function consoleModal() {
    const extra =
      row('Antimatter', [['am:50', '+50', 'am'], ['am:500', '+500', 'am'], ['am:5000', '+5,000', 'am']]) +
      row('Credits', [['cr:10000', '+10k'], ['cr:100000', '+100k'], ['cr:1000000', '+1M']]) +
      row('Timers', [['finish', 'Finish builds and clearings'], ['exp', 'Return expeditions']]) +
      row('Banks', [['fill', 'Fill every bank']]) +
      row('Progress', [['xp:300', '+300 XP'], ['rep:1', '+1 reputation'], ['sectors', 'Unlock all sectors'], ['daily', 'Daily claimable']]) +
      row('Store', [['store:sandbox', 'Force test mode'], ['store:stripe', 'Force live mode'], ['store:clear', 'Page setting']]) +
      row('Session', [['lock', 'Lock admin', 'danger']]) +
      `<p class="fine" id="adm-status">${statusLine()}</p>`;
    Overlays.modal({
      kind: 'store', tag: 'Bridge admin · testing console', title: 'Bridge Admin',
      html: '<p>Grants use the same paths as play and are tagged <b>admin</b> in the profile history. Nothing here leaves this browser.</p>',
      extra, actions: [{ label: 'Close', ghost: true }],
    });
    const host = $('#modal-extra');
    if (host && !host.dataset.admBound) { host.dataset.admBound = '1'; host.addEventListener('click', onClick); }
  }
  function onClick(e) {
    const b = e.target.closest('[data-adm]'); if (!b || !unlocked()) return;
    const [act, arg] = String(b.dataset.adm).split(':');
    try { run(act, arg); } catch (err) { toast('Admin action failed: ' + (err && err.message || err), 'bad'); }
    const st = $('#adm-status'); if (st && Sim.state) st.textContent = statusLine();
    sound('click');
  }

  function record(kind, amount) {
    if (!has(Meta, 'grantEntitlement')) return;
    const grantId = 'admin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    Meta.grantEntitlement('admin_' + kind, { grantId, mode: 'admin', at: Date.now(), sku: 'admin_' + kind, kind: 'admin', granted: { [kind]: amount } });
  }

  function run(act, arg) {
    const s = Sim.state, p = Meta.profile, now = Date.now(), n = Number(arg);
    switch (act) {
      case 'am': Meta.addAM(n, 'admin'); record('am', n); toast(`+${n} Antimatter (admin)`, 'good'); break;
      case 'cr': Meta.addCredits(n, 'admin'); record('credits', n); toast(`+${fmtN(n)} credits (admin)`, 'good'); break;
      case 'finish': {
        let k = 0;
        for (const id of Object.keys(p.sectors || {})) {
          const st = p.sectors[id]; if (!st) continue;
          for (const key of Object.keys(st.cells || {})) { const c = st.cells[key]; if (c && c.readyAt != null) { c.readyAt = now - 1; k++; } }
          if (st.plot && st.plot.clearing) { st.plot.clearing.endsAt = now - 1; k++; }
        }
        if (has(Meta, 'tick')) Meta.tick(now);
        toast(k ? `${k} timer${k === 1 ? '' : 's'} finished` : 'Nothing was building', k ? 'good' : 'info'); break;
      }
      case 'exp': {
        const L = (p.expeditions && p.expeditions.list) || []; let k = 0;
        for (const e of L) if (e.status === 'out') { e.endsAt = now - 1; k++; }
        if (has(Meta, 'tick')) Meta.tick(now);
        toast(k ? `${k} expedition${k === 1 ? '' : 's'} returned` : 'No expedition is out', k ? 'good' : 'info'); break;
      }
      case 'fill': {
        let k = 0;
        for (const { r, c } of Sim.cells()) { const h = Meta.hopper(r, c); if (h) { const cell = s.cells[r + ',' + c]; if (cell) { cell.bank = h.cap; k++; } } }
        Sim.emit('change'); toast(`${k} bank${k === 1 ? '' : 's'} filled`, 'good'); break;
      }
      case 'xp': if (has(Meta, '_addXP')) Meta._addXP(n, 'admin'); else p.rank.xp = (p.rank.xp || 0) + n; Sim.emit('change'); toast(`+${n} XP`, 'good'); break;
      case 'rep': s.rep = Math.min(5, (s.rep || 0) + n); if (has(Sim, 'recomputeLevel')) Sim.recomputeLevel(); Sim.emit('change'); toast(`Reputation ${s.rep.toFixed(1)}`, 'good'); break;
      case 'sectors': { const got = has(Meta, 'unlockAllSectors') ? Meta.unlockAllSectors('admin') : []; toast(`${(got || []).length} sector${(got || []).length === 1 ? '' : 's'} unlocked`, 'good'); break; }
      case 'daily': { const d = p.daily; if (d && d.lastClaimAt) d.lastClaimAt -= 86400e3; Sim.emit('change'); toast('Daily reward is claimable', 'good'); break; }
      case 'store': {
        try { if (arg === 'clear') localStorage.removeItem('portsolace.store'); else localStorage.setItem('portsolace.store', JSON.stringify({ mode: arg })); } catch (e) { /* ignore */ }
        toast(`Store set to ${arg === 'clear' ? 'the page setting' : arg}. Reloading…`, 'info');
        if (has(Meta, 'save')) Meta.save();
        setTimeout(() => location.reload(), 700); return;
      }
      case 'lock': setUnlocked(false); Overlays.closeModal(); toast('Admin locked', 'info'); break;
      default: return;
    }
    if (has(Meta, 'save')) Meta.save();
    refresh();
  }

  // Ctrl+Shift+A opens the gate or the console
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'A' || e.key === 'a')) { e.preventDefault(); open(); }
  });

  return { open, unlocked, lock: () => setUnlocked(false), configured: () => !!metaHash() };
})();

// ============================================================
// WAYSTATION v2 — ui/overlays.js
// Engineer H. Source of truth: DESIGN2.md 2.6 (celebrations), 5.3
// (overlays), DESIGN.md 6.7 / 6.8 / 6.10 (tooltip, modal, toast grammar).
//
// Everything that floats over the bridge and is not a panel: the modal
// (transmissions and confirms), toasts, the anchored tooltip, the
// celebration band queue, the Daily / While-you-were-away / Keys sheets,
// and DOM flights (reward glyphs arcing from a panel to a status-bar
// anchor). Pure DOM; it knows nothing about Sim or Meta. hud.js feeds it.
//
// Exports (global): Overlays
// ============================================================
'use strict';

// Toast chip label from kind and message (first match wins)
const TOAST_CHIP = [
  ['Saved', /saved/i],
  ['Mission', /mission|claimed/i],
  ['Expedition', /expedition|debrief|charted|returned/i],
  ['Store', /purchase|antimatter|restored/i],
  ['Alert', /pirate|raid|fever|debt|default|gave up|lost/i],
  ['Build', /online|placed|scaffold|build|skip|upgrade|level \d|unlock|more credits for|cannot be removed|occupied|touch the station|nothing there/i],
  ['Bank', /collected|banked|hopper/i],
  ['Trade', /office|paid|loan|lend|lent|sold|broker|bank|contract|minimum loan/i],
];
const TOAST_ICON = { good: 'check', warn: 'warn', bad: 'bad', gold: 'rep', info: 'info', '': 'info' };

const Overlays = {
  _modal: null, _sheet: null,
  _celeQueue: [], _celeBusy: false,
  _tip: { key: '' },
  celeMs: 1600,         // how long a celebration band holds (2.6); the harness stretches it for inspection
  sound: null,          // Sound-like object (optional)

  // ---------------------------------------------------------- 0. init
  // index.html / the harness provide the containers; anything missing is created.
  init(o = {}) {
    this.sound = o.sound || null;
    const need = [
      ['modal', `<div id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="box glass cut" data-kind="event"><i class="spine"></i><div class="modal-head"><span class="modal-ic"></span><span id="modal-tag" class="micro"></span></div><div class="modal-body"><h2 id="modal-title"></h2><div id="modal-text" class="body-lg"></div><div id="modal-extra"></div></div><div id="modal-actions"></div></div></div>`],
      ['sheet', `<div id="sheet" role="dialog" aria-modal="true"><div class="sheet-box glass cut"><i class="spine"></i><div class="sheet-content"></div></div></div>`],
      ['celebrate', `<div id="celebrate" aria-live="polite"></div>`],
      ['tooltip', `<div id="tooltip" role="tooltip" class="glass"></div>`],
      ['flights', `<div id="flights" aria-hidden="true"></div>`],
    ];
    for (const [id, html] of need) if (!document.getElementById(id)) document.body.insertAdjacentHTML('beforeend', html);
    if (!document.getElementById('toasts')) {
      const n = document.getElementById('notices') || document.body;
      n.insertAdjacentHTML('afterbegin', '<div id="toasts" aria-live="polite"></div>');
    }
    const modal = $('#modal');
    modal.addEventListener('click', e => {
      const b = e.target.closest('#modal-actions button'); if (b) { this.modalAction(+b.dataset.i); return; }
      if (e.target === modal && this._modal && this._modal.dismissible !== false) this.escModal();
    });
    modal.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && this._modal && this._modal.actions && this._modal.actions.length) { e.preventDefault(); this.modalAction(0); } });
    const sheet = $('#sheet');
    sheet.addEventListener('click', e => {
      const b = e.target.closest('[data-sheet-act]');
      if (b) { this.sheetAction(b.dataset.sheetAct, b); return; }
      if (e.target === sheet && this._sheet && this._sheet.dismissible !== false) this.closeSheet();
    });
    const toasts = $('#toasts');
    toasts.addEventListener('click', e => {
      const t = e.target.closest('.toast'); if (!t) return;
      const act = e.target.closest('[data-toast-act]');
      if (act && t._action) { t._action(); this._removeToast(t); return; }
      if (e.target.closest('.toast-close')) this._removeToast(t);
    });
    toasts.addEventListener('mouseenter', e => { const t = e.target.closest && e.target.closest('.toast'); if (t) this._holdToast(t, true); }, true);
    toasts.addEventListener('mouseleave', e => { const t = e.target.closest && e.target.closest('.toast'); if (t) this._holdToast(t, false); }, true);
  },

  anyOpen() { return !!(this._modal || this._sheet); },

  // ---------------------------------------------------------- 1. modal (6.8, 5.3)
  // o = { kind: 'event'|'alert'|'confirm'|'lend'|'store', tag, title, html, extra,
  //       actions: [{ label, primary, danger, am, fn }], dismissible, onClose }
  modal(o) {
    const m = $('#modal'), box = m.querySelector('.box');
    box.dataset.kind = o.kind || 'confirm';
    box.querySelector('.modal-ic').innerHTML = icon(o.icon || (o.kind === 'store' ? 'am' : o.kind === 'confirm' || o.kind === 'lend' ? 'info' : 'dish'), 16);
    $('#modal-tag').textContent = o.tag || '';
    $('#modal-title').textContent = o.title || '';
    $('#modal-text').innerHTML = o.html || '';
    $('#modal-extra').innerHTML = o.extra || '';
    $('#modal-actions').innerHTML = (o.actions || []).map((a, i) => {
      const cls = ['btn', 'big', a.primary ? 'primary' : '', a.danger ? 'danger' : '', a.am ? 'am' : '', a.ghost ? 'ghost' : ''].filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-i="${i}"${a.disabled ? ' disabled' : ''}>${a.icon ? icon(a.icon, 16) : ''}<span>${esc(a.label)}</span></button>`;
    }).join('');
    this._modal = o;
    m.classList.remove('open'); void m.offsetWidth; m.classList.add('open');
    document.body.setAttribute('data-modal', o.kind || 'confirm');
    const focus = $('#modal-extra input') || $('#modal-actions .btn.primary') || $('#modal-actions .btn');
    if (focus) { focus.focus(); if (focus.select) focus.select(); }
    if (this.sound) this.sound.open();
  },
  modalAction(i) {
    const o = this._modal; if (!o) return;
    const a = (o.actions || [])[i];
    // an explicit action answers the modal: closing it afterwards is not a dismissal, so onClose
    // (which resolves confirm() promises to false) must not run before the action resolves them to true
    this._modal = Object.assign({}, o, { onClose: null });
    this.closeModal();
    if (a && typeof a.fn === 'function') a.fn();
    if (this.sound) this.sound.click();
  },
  closeModal() {
    const m = $('#modal'); if (!m) return;
    const o = this._modal; this._modal = null;
    m.classList.remove('open');
    document.body.removeAttribute('data-modal');
    if (o && typeof o.onClose === 'function') o.onClose();
  },
  // Esc closes confirmations; a transmission (event / alert) must be answered
  escModal() {
    if (this._sheet) { if (this._sheet.dismissible !== false) this.closeSheet(); return; }
    if (this._modal && this._modal.kind !== 'event' && this._modal.kind !== 'alert') this.closeModal();
  },
  // confirm(title, html, onYes, { yes, no, kind, danger, am, tag }) -> Promise<boolean>
  confirm(title, html, fn, o = {}) {
    return new Promise(resolve => {
      this.modal({
        kind: o.kind || 'confirm', tag: o.tag || 'Confirm', title, html,
        actions: [
          { label: o.yes || 'Yes', primary: !o.danger && !o.am, danger: !!o.danger, am: !!o.am, fn: () => { if (fn) fn(); resolve(true); } },
          { label: o.no || 'Cancel', ghost: true, fn: () => resolve(false) },
        ],
        onClose: () => resolve(false),
      });
    });
  },

  // ---------------------------------------------------------- 2. sheets: Daily, While you were away, Keys (5.3)
  // o = { id, hue: 'amber'|'ice'|'am'|'good', html, actions: [{ id, label, primary, am, ghost, fn }], dismissible, onClose, wide }
  sheet(o) {
    const s = $('#sheet'), box = s.querySelector('.sheet-box');
    box.dataset.sheet = o.id || 'sheet';
    box.dataset.hue = o.hue || 'amber';
    box.classList.toggle('wide', !!o.wide);
    box.classList.toggle('locked', o.dismissible === false);
    const acts = (o.actions || []).map(a => {
      const cls = ['btn', 'big', a.primary ? 'primary' : '', a.am ? 'am' : '', a.ghost ? 'ghost' : '', a.danger ? 'danger' : ''].filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-sheet-act="${esc(a.id)}"${a.disabled ? ' disabled' : ''}>${a.icon ? icon(a.icon, 16) : ''}<span>${esc(a.label)}</span></button>`;
    }).join('');
    box.querySelector('.sheet-content').innerHTML =
      `<button type="button" class="btn icon ghost sheet-close" data-sheet-act="__close" title="Close" aria-label="Close">${icon('close', 16)}</button>` +
      o.html + (acts ? `<div class="sheet-actions">${acts}</div>` : '');
    this._sheet = o;
    s.classList.remove('open'); void s.offsetWidth; s.classList.add('open');
    document.body.setAttribute('data-sheet', o.id || 'sheet');
    const f = box.querySelector('.sheet-actions .btn.primary, .sheet-actions .btn.am, .sheet-actions .btn');
    if (f) f.focus();
    if (this.sound) this.sound.open();
  },
  sheetAction(id, btn) {
    const o = this._sheet; if (!o) return;
    if (id === '__close') { if (o.dismissible !== false) this.closeSheet(); return; }
    const a = (o.actions || []).find(x => x.id === id);
    // an action closes the sheet unless its fn returns true; a plain Later / Close (no fn) closes it too
    if (a) { const keep = typeof a.fn === 'function' ? a.fn(btn) : undefined; if (keep !== true) this.closeSheet(); }
    if (this.sound) this.sound.click();
  },
  closeSheet() {
    const s = $('#sheet'); if (!s) return;
    const o = this._sheet; this._sheet = null;
    s.classList.remove('open');
    document.body.removeAttribute('data-sheet');
    if (o && typeof o.onClose === 'function') o.onClose();
  },

  // Reward chips shared by daily, missions, expeditions and celebrations.
  // reward: { credits?, am?, xp?, goods?: {id: qty} | string, chart?, livery?, label? } | number (credits)
  rewardChips(reward, size = '') {
    if (reward == null) return '';
    if (typeof reward === 'number') reward = { credits: reward };
    if (typeof reward === 'string') reward = { label: reward };
    // DAILY_REWARDS shape { kind: 'credits'|'am'|'goods', min, amount, units, token, label } (4.8)
    if (reward.kind) {
      const r = {};
      if (reward.kind === 'credits') r.creditsMin = reward.min || reward.amount || 0;
      else if (reward.kind === 'am') r.am = reward.amount || 0;
      else if (reward.kind === 'goods') r.goods = `${reward.units ? reward.units + ' units' : 'Goods'} crate`;
      if (reward.token) r.livery = reward.token === 'livery' ? 'Livery token' : reward.token;
      if (!Object.keys(r).length && reward.label) r.label = reward.label;
      reward = r;
    }
    const out = [], px = size ? 14 : 16;
    // A6.3: chips carry the pack's icons (credits, antimatter, chart, cargo), the goods renders and the badges; the glyph is the fallback
    const chip = (cls, ic, text, art) => `<span class="rchip ${cls}${size ? ' ' + size : ''}">${art ? Art.img(art[0], art[1], px, { alt: '', fallback: icon(ic, 14) }) : icon(ic, 14)}<span>${text}</span></span>`;
    if (reward.creditsMin) out.push(chip('amber', 'credits', `${Fmt.n(reward.creditsMin)}+ cr`, ['icons', 'credits']));
    if (reward.credits) out.push(chip('amber', 'credits', `${Fmt.n(reward.credits)} cr`, ['icons', 'credits']));
    if (reward.am) out.push(chip('am', 'am', `${Fmt.n(reward.am)} AM`, ['icons', 'antimatter']));
    if (reward.xp) out.push(chip('ice', 'xp', `${Fmt.n(reward.xp)} XP`));
    if (reward.chart) out.push(chip('ice', 'chart', reward.chart === true ? 'Chart' : `${reward.chart} chart${reward.chart === 1 ? '' : 's'}`, ['icons', 'chart']));
    if (reward.goods) {
      if (typeof reward.goods === 'string') out.push(chip('sage', 'warehouse', esc(reward.goods), ['icons', 'cargo']));
      else for (const [g, q] of Object.entries(reward.goods)) {
        const name = (typeof GOODS !== 'undefined' && GOODS[g]) ? GOODS[g].name : g;
        out.push(chip('sage', (typeof ICONS !== 'undefined' && ICONS[g]) ? g : 'warehouse', `${Fmt.n(q)} ${esc(name)}`, ['goods', g]));
      }
    }
    if (reward.livery) out.push(chip('rose', 'ship', esc(typeof reward.livery === 'string' ? reward.livery : 'Livery token')));
    if (reward.title) out.push(chip('ivory', 'rep', esc(reward.title)));
    if (reward.tier) out.push(`<span class="rchip tier ${esc(reward.tier)}${size ? ' ' + size : ''}">${Art.img('badges', Art.achId(reward.tier), px, { alt: '', fallback: icon('award', 14) })}<span>${esc(Fmt.cap(reward.tier))}</span></span>`);
    if (reward.discover) {
      const dk = reward.discover.kind, grp = dk === 'species' ? 'species' : (dk === 'ships' || dk === 'ship') ? 'ships' : 'artifacts';
      out.push(chip('rose', grp === 'species' ? 'species' : grp === 'ships' ? 'ship' : 'artifact', esc(reward.discover.name || 'Discovery'), reward.discover.id && Art.has(grp, reward.discover.id) ? [grp, reward.discover.id] : ['icons', 'discovery']));
    }
    if (reward.label && !out.length) out.push(chip('ink', 'info', esc(reward.label)));
    return out.join('');
  },

  // Daily overlay (4.8, 5.3): d = { streak, dayIndex, claimable, rewards, repairable, repairAM }
  daily(d, o = {}) {
    const html = () => {
      const rewards = d.rewards || [];
      const strip = rewards.slice(0, 7).map((rw, i) => {
        const state = i < d.dayIndex ? 'done' : i === d.dayIndex ? (d.claimable ? 'today' : 'claimed') : 'next';
        return `<div class="day-cell ${state}"><span class="day-n">Day ${i + 1}</span><div class="day-reward">${this.rewardChips(rw, 'sm') || '<span class="rchip ink sm">?</span>'}</div>${state === 'done' || state === 'claimed' ? `<span class="day-check">${icon('check', 14)}</span>` : ''}</div>`;
      }).join('');
      return `<div class="sheet-kicker">Daily reward</div>` +
        `<h2 class="sheet-title">${d.claimable ? 'Welcome back, Commander' : 'Claimed for today'}</h2>` +
        `<p class="sheet-lead">${d.claimable ? `Day ${d.dayIndex + 1} of your streak is ready.` : `Day ${d.dayIndex + 1} claimed. Next reward at midnight.`} ` +
        `Streak <span class="num">${Fmt.n(d.streak)}</span> day${d.streak === 1 ? '' : 's'}.${d.repairable ? ` Your streak lapsed: repair it for <span class="num c-am">${d.repairAM || 5} AM</span>.` : ''}</p>` +
        `<div class="day-strip">${strip}</div>`;
    };
    const actions = [];
    if (d.claimable) actions.push({ id: 'claim', label: 'Claim reward', primary: true, icon: 'collect', fn: () => { if (o.onClaim) o.onClaim(); } });
    if (d.repairable) actions.push({ id: 'repair', label: `Repair streak ${GLYPH.mid} ${d.repairAM || 5} AM`, am: true, icon: 'am', fn: () => { if (o.onRepair) o.onRepair(); } });
    actions.push({ id: 'later', label: d.claimable ? 'Later' : 'Close', ghost: true });
    this.sheet({ id: 'daily', hue: 'amber', html: html(), actions, onClose: o.onClose });
  },

  // While you were away (4.2): a = { ms, credits, builds, expeditions, ships, events, banked }
  away(a, o = {}) {
    const row = (ic, label, val, cls) => `<div class="away-row"><span class="away-ic ${cls || ''}">${icon(ic, 18)}</span><span class="away-lbl">${label}</span><span class="away-val num ${cls || ''}">${val}</span></div>`;
    let rows = '';
    rows += row('credits', 'Credits banked in hoppers', `${Fmt.n(a.banked != null ? a.banked : a.credits || 0)} cr`, 'c-amber-hi');
    if (a.ships) rows += row('ship', 'Ships served', Fmt.n(a.ships), 'c-ice');
    if (a.builds) rows += row('build', 'Builds finished', Fmt.n(a.builds), 'c-good');
    if (a.expeditions) rows += row('expeditions', 'Expeditions returned', Fmt.n(a.expeditions), 'c-ice');
    if (a.events && a.events.length) rows += `<div class="away-events">${a.events.slice(0, 4).map(e => `<div class="away-ev">${esc(e)}</div>`).join('')}</div>`;
    const html = `<div class="sheet-kicker">Station report</div><h2 class="sheet-title">While you were away</h2>` +
      `<p class="sheet-lead">You were gone <span class="num">${Fmt.ago(a.ms || 0)}</span>. The station kept working.</p><div class="away-rows">${rows}</div>`;
    const actions = [];
    if ((a.banked || a.credits) && o.onCollect) actions.push({ id: 'collect', label: 'Collect all', primary: true, icon: 'collect', fn: () => o.onCollect() });
    actions.push({ id: 'ok', label: actions.length ? 'Later' : 'Back to the bridge', ghost: !!actions.length, primary: !actions.length });
    this.sheet({ id: 'away', hue: 'ice', html, actions, onClose: o.onClose });
  },

  // Keys overlay (5.1)
  keys() {
    const rows = [
      ['Space', 'Pause / resume'], ['1', 'Run'], ['B', 'Build'], ['S', 'Station'], ['M', 'Market'], ['F', 'Fleet'],
      ['E', 'Expeditions'], ['G', 'Galaxy map'], ['J', 'Missions'], ['R', 'Registry'], ['Esc', 'Close panel · cancel placing · deselect'],
      ['Arrows', 'Pan the camera'], ['+ · −', 'Zoom'], ['0', 'Fit the station'], ['Shift-click', 'Collect every ready bank nearby'], ['?', 'This reference'], ['Tour', 'Settings > Replay the tour'],
    ].map(([k, v]) => `<div class="key-row"><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`).join('');
    this.sheet({ id: 'keys', hue: 'ice', html: `<div class="sheet-kicker">Reference</div><h2 class="sheet-title">Keys</h2><div class="key-grid">${rows}</div>`, actions: [{ id: 'ok', label: 'Close', ghost: true }] });
  },

  // ---------------------------------------------------------- 3. toasts (6.10 → v2 glass)
  // kind: good warn bad gold info ('' = amber). o = { action: { label, fn }, ms, icon, chip }
  toast(msg, kind = '', o = {}) {
    const box = $('#toasts'); if (!box) return null;
    while (box.children.length >= 4) this._removeToast(box.firstElementChild, true);
    const el = document.createElement('div');
    el.className = 'toast glass' + (kind ? ' ' + kind : '');
    const chip = o.chip || TOAST_CHIP.find(([, re]) => re.test(msg))?.[0] || (kind === 'bad' ? 'Alert' : kind === 'gold' ? 'Event' : 'Notice');
    // A6.3: o.img (a render URL) replaces the glyph with a 40px picture (discoveries, trade notices)
    el.innerHTML = `<i class="spine"></i><span class="toast-ic${o.img ? ' has-img' : ''}">${o.img ? `<img class="toast-img" src="${esc(o.img)}" width="40" height="40" alt="" loading="lazy" decoding="async" draggable="false">` : icon(o.icon || TOAST_ICON[kind] || 'info', 16)}</span>` +
      `<div class="toast-main"><span class="toast-chip">${esc(chip)}</span><span class="toast-msg">${esc(msg)}</span></div>` +
      (o.action ? `<button type="button" class="btn toast-act" data-toast-act="1">${esc(o.action.label)}</button>` : '') +
      `<button type="button" class="toast-close" aria-label="Dismiss">${icon('close', 12)}</button><i class="toast-drain"></i>`;
    el.title = msg;
    if (o.action) el._action = o.action.fn;
    el._ms = o.ms || 4000; el._born = performance.now();
    box.appendChild(el);
    el._timer = setTimeout(() => this._removeToast(el), el._ms);
    return el;
  },
  _holdToast(el, hold) {
    if (!el || !el.isConnected) return;
    if (hold) { clearTimeout(el._timer); el._timer = 0; el.classList.add('hold'); }
    else { el.classList.remove('hold'); const left = Math.max(1200, el._ms - (performance.now() - el._born)); el._timer = setTimeout(() => this._removeToast(el), left); }
  },
  _removeToast(el, now) {
    if (!el || !el.isConnected) return;
    clearTimeout(el._timer);
    if (now) { el.remove(); return; }
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  },

  // ---------------------------------------------------------- 4. tooltip (6.7 → glass, 14px)
  // at(x, y, html, hue): follows the cursor (+14,+14), clamped inside the viewport
  tooltipAt(x, y, html, hue, key) {
    const el = $('#tooltip'); if (!el) return;
    if (key && key !== this._tip.key) { this._tip.key = key; el.classList.remove('more'); }
    if (el._html !== html) { el._html = html; el.innerHTML = html; }
    el.style.setProperty('--hue', hue || 'var(--ivory)');
    el.classList.add('show');
    const W = window.innerWidth, H = window.innerHeight;
    const px = Math.max(8, Math.min(x + 14, W - el.offsetWidth - 8));
    const py = Math.max(8, Math.min(y + 14, H - el.offsetHeight - 8));
    el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
  },
  // for(el, html, hue): anchored under (or above) a HUD element, centred
  tooltipFor(target, html, hue) {
    const el = $('#tooltip'); if (!el || !target) return;
    if (el._html !== html) { el._html = html; el.innerHTML = html; }
    el.style.setProperty('--hue', hue || 'var(--ivory)');
    el.classList.add('show');
    const r = target.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
    let x = r.left + r.width / 2 - el.offsetWidth / 2, y = r.bottom + 8;
    if (y + el.offsetHeight > H - 8) y = r.top - el.offsetHeight - 8;
    if (r.left < 90) { x = r.right + 10; y = Math.max(8, Math.min(r.top + r.height / 2 - el.offsetHeight / 2, H - el.offsetHeight - 8)); }   // rail buttons: to the right
    x = Math.max(8, Math.min(x, W - el.offsetWidth - 8));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  },
  hideTooltip() { const el = $('#tooltip'); if (el) { el.classList.remove('show', 'more'); this._tip.key = ''; } },

  // ---------------------------------------------------------- 5. celebrations (2.6): one at a time, queued
  // kind: 'rank' 'level' 'unlock' 'mission' 'expedition' 'purchase' 'daily'
  // data: { kicker, title, sub, reward, hue, fx: fn }
  celebrate(kind, data = {}) {
    this._celeQueue.push({ kind, data });
    if (!this._celeBusy) this._nextCele();
  },
  // deferred celebrations (A2.2: the tour holds them) resume through flushCelebrations()
  flushCelebrations() { if (!this._celeBusy && this._celeQueue.length) this._nextCele(); },
  _nextCele() {
    const item = this._celeQueue.shift();
    if (!item) { this._celeBusy = false; return; }
    if (typeof Tutorial !== 'undefined' && Tutorial && Tutorial.active) { this._celeQueue.unshift(item); this._celeBusy = false; return; }
    this._celeBusy = true;
    const host = $('#celebrate'); if (!host) { this._celeBusy = false; return; }
    const { kind, data } = item;
    const reduced = document.body.getAttribute('data-motion') === 'reduced';
    host.innerHTML = `<div class="cele-wrap"><div class="cele-band glass" data-kind="${esc(kind)}" data-hue="${esc(data.hue || 'amber')}"><i class="spine"></i>` +
      `<div class="cele-inner">${data.img ? `<img class="cele-img${data.imgCls ? ' ' + data.imgCls : ''}" src="${esc(data.img)}" width="96" height="96" alt="${esc(data.imgAlt || '')}" decoding="async" draggable="false">` : ''}<div class="cele-kicker">${esc(data.kicker || '')}</div><div class="cele-title">${esc(data.title || '')}</div>` +
      (data.sub ? `<div class="cele-sub">${esc(data.sub)}</div>` : '') +
      `<div class="cele-rewards">${this.rewardChips(data.reward)}</div></div></div></div>`;
    void host.offsetWidth;
    host.classList.add('show');
    // once the sweep has landed, drop the finished animation so the band is committed as a static layer
    const wrap = host.firstElementChild;
    wrap.addEventListener('animationend', () => { wrap.style.animation = 'none'; }, { once: true });
    for (const row of wrap.querySelectorAll('.cele-inner > *')) row.addEventListener('animationend', () => { row.style.animation = 'none'; }, { once: true });
    if (this.sound) { this.sound.duck(1700); if (kind === 'rank' || kind === 'level' || kind === 'unlock') this.sound.rankUp(); else if (kind === 'purchase') this.sound.purchase(); else this.sound.built(); }
    if (typeof data.fx === 'function') { try { data.fx(); } catch (e) { /* fx is decoration */ } }
    const ms = reduced ? Math.min(1200, this.celeMs) : this.celeMs;
    setTimeout(() => { wrap.style.animation = ''; host.classList.remove('show'); host.classList.add('out'); }, ms);
    setTimeout(() => { host.classList.remove('out'); host.innerHTML = ''; this._nextCele(); }, ms + 320);
  },

  // ---------------------------------------------------------- 6. flights: glyphs arcing from a DOM point to an anchor
  // from: element | {x, y}; to: element. o = { n, hue, icon, onHit(i), ms }. Resolves when the last glyph lands.
  fly(from, to, o = {}) {
    return new Promise(resolve => {
      const layer = $('#flights');
      if (!layer || !to || document.body.getAttribute('data-motion') === 'reduced') { if (o.onHit) o.onHit(0); resolve(); return; }
      const fr = from && from.getBoundingClientRect ? from.getBoundingClientRect() : null;
      const sx = fr ? fr.left + fr.width / 2 : from.x, sy = fr ? fr.top + fr.height / 2 : from.y;
      const tr = to.getBoundingClientRect(), tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;
      const n = Math.max(1, Math.min(14, o.n || 8)), ms = o.ms || 700;
      let landed = 0;
      for (let i = 0; i < n; i++) {
        const g = document.createElement('i');
        g.className = 'flight ' + (o.hue || 'amber');
        g.innerHTML = icon(o.icon || 'credits', 14);
        layer.appendChild(g);
        const jx = (Math.random() - 0.5) * 60, jy = (Math.random() - 0.5) * 40;
        const cx = (sx + tx) / 2 + jx, cy = Math.min(sy, ty) - 90 - Math.random() * 60 + jy;
        const delay = i * 45;
        const anim = g.animate([
          { transform: `translate(${sx}px, ${sy}px) scale(.6)`, opacity: 0, offset: 0 },
          { transform: `translate(${sx + jx * .4}px, ${sy - 10}px) scale(1)`, opacity: 1, offset: 0.12 },
          { transform: `translate(${cx}px, ${cy}px) scale(1)`, opacity: 1, offset: 0.55 },
          { transform: `translate(${tx}px, ${ty}px) scale(.5)`, opacity: 1, offset: 1 },
        ], { duration: ms, delay, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'forwards' });
        anim.onfinish = () => { g.remove(); landed++; if (o.onHit) o.onHit(landed); if (landed === n) resolve(); };
      }
    });
  },
};

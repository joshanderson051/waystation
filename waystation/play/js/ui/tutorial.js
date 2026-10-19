// ============================================================
// WAYSTATION v2 — ui/tutorial.js
// Engineer H. Source of truth: DESIGN2.md Addendum A2.2.
//
// A guided tour of coach marks: a full-screen dim with a spotlight cut
// around the target (evenodd clip-path, 8 px padding, 6 px radius; the
// target stays clickable), a glass callout anchored beside it that flips
// to stay on screen, Next / Skip tour (Enter / Esc), and steps that wait
// for the player to do something (a panel opening, a module built, the
// first collect) before they advance. Runs once on the first commission
// of a profile, replays from Settings, never blocks the simulation.
//
// Loads after panels.js and before hud.js: it reads UI, MetaAdapter,
// EngineAdapter and Overlays at call time only, through typeof guards.
//
// Exports (global): Tutorial
// ============================================================
'use strict';

const TOUR_STEPS = [
  { id: 'welcome', title: 'Welcome, Commander', text: 'This is the Core Hub, and everything around it is yours to grow. Drag to pan the view and roll the wheel to zoom in on the plating.', target: 'hub' },
  { id: 'status', title: 'The status bar', text: 'Credits, Antimatter, power, residents and reputation at a glance, with your Commander rank at the right. Readouts move when something changes and stay still when nothing does.', target: '#statusbar', place: 'below' },
  { id: 'build-open', title: 'Open Build', text: 'Every module on the station starts here. Open the Build panel from the command rail.', target: '.rail-btn[data-panel="build"]', waitFor: { panel: 'build' } },
  { id: 'dock', title: 'Place a Docking Bay', text: 'Ships need a berth before they can trade with you. Pick the Docking Bay, then click one of the bracketed cells beside the hub.', target: ['#panel .card[data-mod="dock"]', '.rail-btn[data-panel="build"]'], ensurePanel: 'build', waitFor: { built: 'dock' } },
  { id: 'solar', title: 'Power', text: 'Every module draws power and the hub only covers the first few. A Solar Array is cheap and quick: place one now.', target: ['#panel .card[data-mod="solar"]', '.rail-btn[data-panel="build"]'], ensurePanel: 'build', waitFor: { built: 'solar' } },
  { id: 'warehouse', title: 'Storage', text: 'Cargo needs somewhere to sit. A Cargo Warehouse holds what ships sell you and what you sell back to them.', target: ['#panel .card[data-mod="warehouse"]', '.rail-btn[data-panel="build"]'], ensurePanel: 'build', waitFor: { built: 'warehouse' } },
  { id: 'timers', title: 'Builds take time', text: 'From here on, builds and upgrades run on real time: a timer under the scaffold, a ring that closes, and Antimatter if you would rather not wait. Hoppers keep filling meanwhile.', target: ['#panel .card[data-mod="dock"] .card-meta', '#panel .card[data-mod="dock"]', '.rail-btn[data-panel="build"]'], ensurePanel: 'build' },
  { id: 'banks', title: 'Banks', text: 'Modules earn credits into a bank while you are away. A glowing coin above a module means its bank is ready: tap it to collect.', target: 'hub', waitFor: { collect: true }, allowNext: true, waitLabel: 'Collect one when it glows, or Next' },
  { id: 'fleet', title: 'Ships and trade', text: 'Fleet shows who is docked, on approach or holding for a berth. Market shows what their worlds buy and sell, and lets you set a policy per good.', target: '.rail-btn[data-panel="fleet"]' },
  { id: 'missions', title: 'Missions and achievements', text: 'Goals pay credits, Antimatter and rank. When one lights up, come here and claim it.', target: '.rail-btn[data-panel="missions"]' },
  { id: 'map', title: 'Territory and the galaxy', text: 'Unclaimed space around the station is cleared ring by ring. Beyond it, eight sectors wait on the galaxy map, each with its own world and its own station.', target: '.rail-btn[data-panel="map"]' },
  { id: 'expeditions', title: 'Expeditions', text: 'Send a crew out and they come back hours later with charts, cargo and discoveries for the Registry.', target: '.rail-btn[data-panel="expeditions"]' },
  { id: 'finish', title: 'You have the bridge.', text: 'A reward waits here every day, the Store sells Antimatter when you are in a hurry, and the manual covers everything in depth.', target: '#btn-daily', place: 'below', finish: true, manual: true },
];

const Tutorial = {
  active: false,
  step: -1,
  steps: TOUR_STEPS,
  onEnd: null,            // set by hud.js: deferred daily sheet and celebrations resume here
  _el: null, _timer: 0, _satisfied: false, _advancing: 0, _counts: null, _unsub: [], _replay: false,

  // persisted in Meta.profile.settings.tutorialDone through the HUD's settings adapter
  settings() { return (typeof MetaAdapter !== 'undefined' && MetaAdapter) ? MetaAdapter.settings() : (this._local || (this._local = {})); },
  get done() { return !!this.settings().tutorialDone; },
  markDone() { this.settings().tutorialDone = true; if (typeof MetaAdapter !== 'undefined' && MetaAdapter) MetaAdapter.saveSettings(); },

  // ---------------------------------------------------------- lifecycle
  start(o = {}) {
    if (this.active) return true;
    if (!o.replay && this.done) return false;
    this._replay = !!o.replay;
    this.build();
    this.active = true;
    document.body.setAttribute('data-tour', '');
    this.bind();
    this.go(0);
    return true;
  },
  skip() { this.end(false); },
  finish() { this.end(true); },
  end(finished) {
    if (!this.active) return;
    this.active = false;
    this.markDone();
    this.unbind();
    document.body.removeAttribute('data-tour');
    if (this._el) { this._el.classList.add('out'); const el = this._el; this._el = null; setTimeout(() => el.remove(), 260); }
    this.step = -1;
    if (typeof Sound !== 'undefined' && Sound) Sound.close();
    if (typeof this.onEnd === 'function') this.onEnd(finished);
  },

  build() {
    if (this._el) return;
    const el = document.createElement('div');
    el.id = 'tour';
    el.innerHTML = `<div class="tour-dim"></div><i class="tour-ring"></i>` +
      `<div class="tour-callout glass cut" role="dialog" aria-labelledby="tour-title" aria-describedby="tour-text"><i class="spine"></i>` +
      `<div class="tour-kicker" id="tour-kicker"></div><h3 class="tour-title" id="tour-title"></h3><p class="tour-text" id="tour-text"></p>` +
      `<div class="tour-wait" id="tour-wait" hidden><i class="pulse-dot"></i><span id="tour-wait-text">Do it to continue</span></div>` +
      `<div class="tour-actions"><a class="btn ghost tour-manual" id="tour-manual" href="../manual/" target="_blank" rel="noopener" hidden>${icon('registry', 14)}<span>Read the manual</span></a>` +
      `<span class="tour-spacer"></span><button type="button" class="btn ghost" data-tour="skip">Skip tour</button><button type="button" class="btn primary" data-tour="next" id="tour-next"><span>Next</span>${icon('chevron-right', 14)}</button></div></div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-tour]'); if (!b) return;
      if (b.dataset.tour === 'next') this.next(); else if (b.dataset.tour === 'skip') this.skip();
    });
    this._el = el;
  },
  bind() {
    this._onKey = e => {
      if (!this.active) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (typeof Overlays !== 'undefined' && Overlays.anyOpen()) return;
      if (e.key === 'Escape') {
        // Esc still cancels placement first (the tour asks the player to place things); a second Esc skips the tour
        if (typeof EngineAdapter !== 'undefined' && EngineAdapter.placing()) return;
        e.preventDefault(); e.stopPropagation(); this.skip();
      } else if (e.key === 'Enter') {
        const nx = this._el && this._el.querySelector('#tour-next');
        if (nx && !nx.hidden) { e.preventDefault(); this.next(); }
      }
    };
    window.addEventListener('keydown', this._onKey, true);
    this._onResize = () => this.place();
    window.addEventListener('resize', this._onResize);
    if (typeof Sim !== 'undefined' && Sim && typeof Sim.on === 'function') {
      const sub = (evt, fn) => { Sim.on(evt, fn); this._unsub.push([evt, fn]); };
      sub('built', d => this.onBuilt(d));
      sub('build-start', d => this.onBuilt(d));
      sub('collect', () => this.onEvent('collect'));
    }
    this._timer = setInterval(() => this.tick(), 120);
  },
  unbind() {
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('resize', this._onResize);
    if (typeof Sim !== 'undefined' && Sim && typeof Sim.off === 'function') for (const [evt, fn] of this._unsub) Sim.off(evt, fn);
    this._unsub = [];
    clearInterval(this._timer); this._timer = 0;
  },

  // ---------------------------------------------------------- steps
  go(i) {
    if (!this.active && this._el == null) return;
    if (i >= this.steps.length) { this.finish(); return; }
    this.step = Math.max(0, i);
    const st = this.steps[this.step];
    this._satisfied = false; clearTimeout(this._advancing); this._advancing = 0;
    if (st.ensurePanel && typeof UI !== 'undefined' && UI.panel !== st.ensurePanel) UI.openPanel(st.ensurePanel);
    // waitFor steps already satisfied on entry keep Next visible instead of advancing past their explanation
    if (st.waitFor) {
      this._counts = this.counts();
      if (st.waitFor.panel && typeof UI !== 'undefined' && UI.panel === st.waitFor.panel) this._satisfied = true;
      if (st.waitFor.built && this._counts[st.waitFor.built] > 0) this._satisfied = true;
    }
    this.render();
    this.place(true);
    if (typeof Sound !== 'undefined' && Sound) Sound.open();
  },
  next() { if (!this.active) return; const st = this.steps[this.step]; if (st && st.finish) this.finish(); else this.go(this.step + 1); },

  render() {
    const el = this._el, st = this.steps[this.step]; if (!el || !st) return;
    el.querySelector('#tour-kicker').textContent = `Tour ${GLYPH.mid} ${this.step + 1} of ${this.steps.length}`;
    el.querySelector('#tour-title').textContent = st.title;
    el.querySelector('#tour-text').textContent = st.text;
    const waiting = !!st.waitFor && !this._satisfied;
    el.querySelector('#tour-wait').hidden = !waiting;
    el.querySelector('#tour-wait-text').textContent = st.waitLabel || 'Do it to continue';
    const nx = el.querySelector('#tour-next');
    nx.hidden = waiting && !st.allowNext;
    nx.innerHTML = st.finish ? `<span>Finish</span>${icon('check', 14)}` : `<span>Next</span>${icon('chevron-right', 14)}`;
    el.querySelector('#tour-manual').hidden = !st.manual;
    el.querySelector('.tour-callout').dataset.step = st.id;
  },

  // ---------------------------------------------------------- targets and placement
  // the hub cell through Engine.cellToScreen; everything else is a selector (first match wins)
  targetRect() {
    const st = this.steps[this.step]; if (!st) return null;
    if (st.target === 'hub') return this.hubRect();
    const sels = Array.isArray(st.target) ? st.target : [st.target];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetWidth) { const r = el.getBoundingClientRect(); if (r.width && r.height) return { x: r.left, y: r.top, w: r.width, h: r.height, el }; }
    }
    return null;
  },
  hubRect() {
    if (typeof Sim === 'undefined' || !Sim || !Sim.state || !Sim.state.hub) return null;
    const { r, c } = Sim.state.hub;
    const p = (typeof EngineAdapter !== 'undefined' && EngineAdapter) ? EngineAdapter.cellToScreen(r, c) : null;
    if (!p) return null;
    const q = EngineAdapter.cellToScreen(r, c + 1);
    const cell = q && Math.abs(q.x - p.x) > 8 ? Math.abs(q.x - p.x) : 56;
    const host = document.getElementById('world'), hr = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: hr.left + p.x - cell / 2, y: hr.top + p.y - cell / 2, w: cell, h: cell };
  },
  // evenodd polygon: the viewport minus a rounded rectangle (8 px padding, 6 px radius)
  cutout(r) {
    const pad = 8, rad = 6, x0 = r.x - pad, y0 = r.y - pad, x1 = r.x + r.w + pad, y1 = r.y + r.h + pad;
    const pts = [];
    const arc = (cx, cy, a0, a1) => { for (let i = 0; i <= 4; i++) { const a = a0 + (a1 - a0) * i / 4; pts.push(`${(cx + Math.cos(a) * rad).toFixed(1)}px ${(cy + Math.sin(a) * rad).toFixed(1)}px`); } };
    arc(x0 + rad, y0 + rad, Math.PI, Math.PI * 1.5); arc(x1 - rad, y0 + rad, Math.PI * 1.5, Math.PI * 2); arc(x1 - rad, y1 - rad, 0, Math.PI * .5); arc(x0 + rad, y1 - rad, Math.PI * .5, Math.PI);
    return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${pts.join(', ')}, ${pts[0]})`;
  },
  place(fresh) {
    const el = this._el; if (!el) return;
    const st = this.steps[this.step] || {}, rect = this.targetRect();
    const dim = el.querySelector('.tour-dim'), ring = el.querySelector('.tour-ring'), call = el.querySelector('.tour-callout');
    const W = window.innerWidth, H = window.innerHeight;
    if (fresh && rect && rect.el && typeof rect.el.scrollIntoView === 'function' && rect.el.closest('.panel-body')) { rect.el.scrollIntoView({ block: 'nearest' }); }
    const r2 = fresh && rect && rect.el ? this.targetRect() : rect;
    if (r2) {
      dim.style.clipPath = this.cutout(r2);
      ring.hidden = false;
      ring.style.transform = `translate(${Math.round(r2.x - 8)}px, ${Math.round(r2.y - 8)}px)`; ring.style.width = Math.round(r2.w + 16) + 'px'; ring.style.height = Math.round(r2.h + 16) + 'px';
    } else { dim.style.clipPath = ''; ring.hidden = true; }
    // callout: beside the target, flipping to whichever side has room; centred when there is no target
    const cw = call.offsetWidth || 380, ch = call.offsetHeight || 200, gap = 18, m = 12;
    let x, y, side;
    if (!r2) { x = (W - cw) / 2; y = (H - ch) / 2; side = 'centre'; }
    else {
      const order = st.place === 'below' ? ['below', 'above', 'right', 'left'] : st.place === 'above' ? ['above', 'below', 'right', 'left'] : ['right', 'left', 'below', 'above'];
      const fits = { right: r2.x + r2.w + gap + cw <= W - m, left: r2.x - gap - cw >= m, below: r2.y + r2.h + gap + ch <= H - m, above: r2.y - gap - ch >= m };
      side = order.find(s => fits[s]) || order[0];
      if (side === 'right') { x = r2.x + r2.w + gap; y = r2.y + r2.h / 2 - ch / 2; }
      else if (side === 'left') { x = r2.x - gap - cw; y = r2.y + r2.h / 2 - ch / 2; }
      else if (side === 'below') { x = r2.x + r2.w / 2 - cw / 2; y = r2.y + r2.h + gap; }
      else { x = r2.x + r2.w / 2 - cw / 2; y = r2.y - gap - ch; }
    }
    x = Math.max(m, Math.min(x, W - cw - m)); y = Math.max(m, Math.min(y, H - ch - m));
    call.dataset.side = side;
    call.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (fresh) { call.classList.remove('in'); void call.offsetWidth; call.classList.add('in'); }
  },

  // ---------------------------------------------------------- waitFor
  counts() { const out = {}; if (typeof Sim !== 'undefined' && Sim && Sim.state && typeof Sim.cells === 'function') for (const { m } of Sim.cells()) out[m.id] = (out[m.id] || 0) + 1; return out; },
  onBuilt(d) { const st = this.steps[this.step]; if (!this.active || !st || !st.waitFor || !st.waitFor.built || !d) return; if (d.id === st.waitFor.built) this.satisfy(); },
  onEvent(kind) { const st = this.steps[this.step]; if (!this.active || !st || !st.waitFor) return; if (kind === 'collect' && st.waitFor.collect) this.satisfy(); },
  satisfy() {
    if (this._satisfied) return;
    this._satisfied = true;
    this.render();
    if (typeof Sound !== 'undefined' && Sound) Sound.click();
    clearTimeout(this._advancing);
    this._advancing = setTimeout(() => { if (this.active) this.go(this.step + 1); }, 700);
  },
  tick() {
    if (!this.active) return;
    const st = this.steps[this.step];
    if (st && st.waitFor && !this._satisfied) {
      if (st.waitFor.panel && typeof UI !== 'undefined' && UI.panel === st.waitFor.panel) this.satisfy();
      else if (st.waitFor.built) { const c = this.counts(); if ((c[st.waitFor.built] || 0) > (this._counts[st.waitFor.built] || 0)) this.satisfy(); }
    }
    this.place(false);
  },
};

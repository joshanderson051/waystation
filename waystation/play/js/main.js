// ============================================================
// WAYSTATION v2 — main.js (integrator)
// Boot order (DESIGN2.md 0.1; S §5; E §2; H §6):
//   PAL.load() -> Meta.init() (create or resume the profile, migrate a v1 save, offline pass,
//   bind Sim.state) -> Store.flush() -> await Engine.init(#world) (the engine reads Sim.state
//   and sets its own sector) -> UI.init() -> title screen -> COMMISSION or RESUME -> UI.start()
//   -> frame loop -> Store.resume() (a return trip from checkout).
//
// Everything event-driven lives behind the facades: the HUD handles every Engine event
// (clicks, banks, hover) and every Sim event (collect flights, celebrations, toasts), the
// engine subscribes to the Sim bus for its own beats (built, build-done, levelup, sector).
// main.js keeps only what no facade owns: the title flow over the profile, the frame loop,
// saving, the audio unlock, two world beats nobody else fires (pirate shock, expedition
// flash), the per-glyph HUD pulse for coin flights, and the WebGL failure screen.
// ============================================================
'use strict';

(function main() {
  const body = document.body;
  const $ = (sel, root = document) => root.querySelector(sel);
  const has = (obj, fn) => !!(obj && typeof obj[fn] === 'function');
  const call = (obj, fn, ...args) => (has(obj, fn) ? obj[fn](...args) : undefined);
  const sectorDef = id => (typeof SECTORS !== 'undefined' && SECTORS && SECTORS[id]) || { id, name: id };

  // ---------------------------------------------------------- 1. title screen (5.4)
  const T = {
    open: true, mode: 'boot', booted: false,
    el: $('#title'), resume: $('#title-resume'), form: $('#title-form'),
    name: $('#title-name'), registry: $('#title-registry'), confirm: $('#title-confirm'),
  };
  const regOf = typeof registryOf === 'function' ? registryOf : (() => 'WS-0000');

  function sectorNames(id) {
    const def = sectorDef(id);
    if (def.names && def.names.length) return def.names;
    return typeof STATION_NAMES !== 'undefined' ? STATION_NAMES : ['Waystation'];
  }
  function randomName(not) {
    const list = sectorNames(Sim.state ? Sim.state.sector : 'home');
    let n = pick(list), guard = 0;
    while (n === not && list.length > 1 && guard++ < 10) n = pick(list);
    return n;
  }
  function updateRegistry() {
    if (!T.registry || !T.name) return;
    const n = T.name.value.trim();
    T.registry.textContent = `Registry ${regOf(n || ' ')} will be assigned on commission`;
  }
  function setTitleName(name) { if (!T.name) return; T.name.value = name; updateRegistry(); }

  function fillResumeCard() {
    const s = Sim.state; if (!s) return;
    let thumb = null;
    try { thumb = has(Engine, 'thumbnail') ? Engine.thumbnail(s, 200, 120) : null; } catch (e) { thumb = null; }
    const data = {
      name: s.name, day: s.day, level: s.level || 1, credits: Math.floor(s.credits || 0),
      am: Number(Meta.am) || 0, banked: Math.floor(has(Meta, 'bankedTotal') ? Meta.bankedTotal() : 0),
      rank: Meta.rank || { level: 1, title: 'Ensign' }, sector: s.sector || 'home', thumb,
    };
    if (has(UI, 'setTitleResume')) { UI.setTitleResume(data); return; }
    const meta = $('#resume-meta');
    if (meta) meta.textContent = `${data.name} · DAY ${data.day} · L${data.level} · ${fmt(data.credits)} CR · ${data.am} AM`;
  }

  // mode 'boot': first load (RESUME card when a profile existed); mode 'new': NEW PROFILE from the title
  function showTitle(mode, resumable) {
    T.open = true; T.mode = mode;
    body.setAttribute('data-screen', 'title');
    body.setAttribute('data-title-mode', mode);
    if (T.el) { T.el.hidden = false; T.el.classList.remove('out'); }
    if (T.resume) T.resume.hidden = !resumable;
    if (T.form) T.form.hidden = !!resumable;
    if (T.confirm) T.confirm.hidden = mode !== 'new';
    if (Engine.camera) call(Engine.camera, 'drift', true);
    if (resumable) {
      fillResumeCard();
      const b = $('#btn-resume'); if (b) b.focus();
    } else {
      setTitleName(mode === 'new' ? randomName() : (Sim.state ? Sim.state.name : randomName()));
      if (T.name) { T.name.focus(); T.name.select(); }
    }
  }
  function hideTitle() {
    T.open = false;
    if (T.el) { T.el.classList.add('out'); setTimeout(() => { if (!T.open) T.el.hidden = true; }, 420); }
    body.removeAttribute('data-screen');
    body.removeAttribute('data-title-mode');
    if (Engine.camera) call(Engine.camera, 'drift', false);
  }

  function commission() {
    const name = ((T.name && T.name.value.trim()) || randomName()).slice(0, 28);
    if (T.mode === 'new') {
      // NEW PROFILE: Meta rebuilds a fresh profile and home station and emits sector 'switched',
      // which the engine and the HUD both follow.
      call(Meta, 'resetProfile');
    }
    if (has(Meta, 'renameStation')) Meta.renameStation(name); else Sim.state.name = name;
    call(UI, 'resetProgress');
    Engine.placing = null; Engine.selected = null;
    Sim.emit('change');
    call(Meta, 'save');
    startGame(true);
  }
  function resume() {
    Engine.placing = null; Engine.selected = null;
    Sim.emit('change');
    startGame(false);
  }
  function titleBack() { showTitle('boot', true); }

  let last = performance.now();
  function startGame(fresh) {
    hideTitle();
    T.booted = true;
    // the engine measures the station on its next frame; fit after that so a fresh hub is framed, not the whole grid
    if (Engine.camera) requestAnimationFrame(() => requestAnimationFrame(() => call(Engine.camera, 'fit', { ms: fresh ? 900 : 600 })));
    call(UI, 'start');                       // removes data-screen, boot sweep, speed, daily or away sheet
    last = performance.now();
  }

  // ---------------------------------------------------------- 2. the few world beats nobody else fires
  function wireBeats() {
    if (has(Engine, 'on')) {
      // one HUD pulse per coin landing (E emits fx-arrive; H exposes anchorHit)
      Engine.on('fx-arrive', e => { if (e && e.index > 1) call(UI, 'anchorHit', 'credits'); });
    }
    Sim.on('event', () => {
      const p = Sim.state && Sim.state.pending;
      if (!p || T.open || body.getAttribute('data-motion') === 'reduced') return;
      if (p.id === 'pirates') {
        const host = $('#world'); const w = host ? host.clientWidth : innerWidth, h = host ? host.clientHeight : innerHeight;
        if (Engine.fx) { call(Engine.fx, 'shock', w / 2, h / 2, 0.6); }
        if (Engine.camera) call(Engine.camera, 'shake', 6);
      }
    });
    Sim.on('expedition', e => {
      if (e && e.state === 'launched' && !T.open && body.getAttribute('data-motion') !== 'reduced' && Engine.fx) call(Engine.fx, 'flash', '#8FD3E8', 0.10, 420);
    });
  }

  // ---------------------------------------------------------- 3. audio unlock on the first gesture (9)
  const unlockAudio = () => { call(Sound, 'init'); window.removeEventListener('pointerdown', unlockAudio); window.removeEventListener('keydown', unlockAudio); };
  window.addEventListener('pointerdown', unlockAudio); window.addEventListener('keydown', unlockAudio);

  // ---------------------------------------------------------- 4. frame loop
  let uiAcc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const live = !!Sim.state && !T.open;
    if (live) Sim.tick(dt);                                   // game time
    if (Sim.state && has(Meta, 'tick')) Meta.tick(Date.now()); // real-time timers run on the title too
    if (live) { uiAcc += dt; if (uiAcc >= 0.25) { uiAcc = 0; call(UI, 'tick'); } }
    requestAnimationFrame(frame);
  }

  const saveNow = () => { if (Sim.state) call(Meta, 'save'); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('beforeunload', saveNow);

  // ---------------------------------------------------------- 5. boot
  async function boot() {
    if (typeof PAL !== 'undefined' && has(PAL, 'load')) { try { PAL.load(); } catch (e) { /* fallbacks stay */ } }

    const had = !!(safeGet('waystation.profile.v2') || safeGet('waystation-save-v1'));
    const r = Meta.init() || {};
    call(Store, 'flush');

    const host = $('#world') || body;
    try { await Engine.init(host); }
    catch (e) { console.error('Engine failed to start', e); showEngineFailure(e); return; }

    call(UI, 'init');
    wireBeats();

    on('#btn-commission', 'click', commission);
    on('#btn-resume', 'click', resume);
    on('#btn-newstation', 'click', () => showTitle('new', false));
    on('#btn-title-back', 'click', titleBack);
    on('#btn-reroll', 'click', () => { setTitleName(randomName(T.name ? T.name.value.trim() : '')); if (T.name) T.name.focus(); });
    if (T.name) {
      T.name.addEventListener('input', updateRegistry);
      T.name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commission(); } });
    }
    window.addEventListener('keydown', e => { if (T.open && T.mode === 'new' && e.key === 'Escape') { e.preventDefault(); titleBack(); } });

    showTitle('boot', had && (r.resumed || r.migrated || true));
    if (r.migrated) setTimeout(() => call(UI, 'toast', 'Your station was brought forward to the new bridge.', 'good'), 1200);

    requestAnimationFrame(frame);
    if (has(Store, 'resume')) Store.resume().catch(() => {});
  }

  function on(sel, evt, fn) { const el = $(sel); if (el) el.addEventListener(evt, fn); }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function showEngineFailure(e) {
    const el = document.createElement('div');
    el.className = 'engine-failure';
    el.innerHTML = '<div class="box"><h2>The bridge display could not start</h2><p>Waystation needs WebGL. Try a current Chrome, Edge, Firefox or Safari with hardware acceleration on.</p><p class="micro"></p></div>';
    el.querySelector('.micro').textContent = String((e && e.message) || e);
    body.appendChild(el);
  }

  boot();
})();

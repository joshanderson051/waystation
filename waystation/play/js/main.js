// ============================================================
// WAYSTATION — bootstrap, title screen, input, body state, game loop
// Engineer H2. Source of truth: DESIGN.md (0.6, 11.1, 12.1, 14.2).
//
// Flow (12.1): PAL.load() -> Render.init(#station) so #bg is baked -> read the
// save WITHOUT committing it -> #title (RESUME card or commissioning form) ->
// COMMISSION: Sim.newGame(); Sim.state.name = name; Sim.save()  |  RESUME: Sim.load()
// -> fade #title, play boot once per session, run the loop.
// ============================================================
'use strict';

(function main() {
  const body = document.body;
  const canvas = document.getElementById('station');

  // ---------------------------------------------------------- 1. palette + renderer first (title shows the live #bg)
  if (typeof PAL !== 'undefined' && PAL && typeof PAL.load === 'function') { try { PAL.load(); } catch (e) { /* fallbacks stay */ } }
  Render.init(canvas);
  UI.init();

  // ---------------------------------------------------------- 2. body[data-motion] from matchMedia (0.6)
  let mq = null;
  try { mq = matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { mq = null; }
  const reduced = () => !!(mq && mq.matches);
  function syncMotion() {
    if (reduced()) body.setAttribute('data-motion', 'reduced'); else body.removeAttribute('data-motion');
    Ticker.reduced = reduced();
    Ticker.invalidate();
  }
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', syncMotion); else if (mq.addListener) mq.addListener(syncMotion); }
  syncMotion();

  // ---------------------------------------------------------- 3. title screen (12.1)
  const T = {
    open: true, mode: 'boot', booted: false,
    el: $('#title'), resume: $('#title-resume'), form: $('#title-form'),
    name: $('#title-name'), registry: $('#title-registry'), confirm: $('#title-confirm'),
    thumb: $('#title-thumb'), meta: $('#resume-meta'),
  };

  // The save is read but NOT committed: Sim.load() runs only when the player chooses RESUME.
  function readSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY); if (!raw) return null;
      const s = JSON.parse(raw);
      return s && s.grid && s.companies ? s : null;
    } catch (e) { return null; }
  }
  function randomName(not) {
    let n = pick(STATION_NAMES), guard = 0;
    while (n === not && STATION_NAMES.length > 1 && guard++ < 10) n = pick(STATION_NAMES);
    return n;
  }
  // re-bake the nebula / planet for a name (Render debounces 120ms); feature-tested per 0.3
  function rebake(name) {
    const fn = typeof Render.rebake === 'function' ? Render.rebake : typeof Render.bakeBackground === 'function' ? Render.bakeBackground : null;
    if (fn) { try { fn.call(Render, name); } catch (e) { /* ignore */ } }
  }
  function updateRegistry() {
    const n = T.name.value.trim();
    T.registry.textContent = `Registry ${regOf(n || ' ')} will be assigned on commission`;
  }
  function setTitleName(name) { T.name.value = name; updateRegistry(); rebake(name); }

  function drawThumb(saved) {
    if (!T.thumb || typeof Render.thumbnail !== 'function') return;
    try {
      const src = Render.thumbnail(saved, 120, 72);
      T.thumb.width = src.width; T.thumb.height = src.height;
      T.thumb.getContext('2d').drawImage(src, 0, 0);
    } catch (e) { /* the card still reads without its plan */ }
  }

  // mode 'boot': first load (RESUME card when a save exists); mode 'new': NEW from the top rail or NEW STATION on the title
  function showTitle(mode) {
    T.open = true; T.mode = mode;
    const saved = readSave();
    body.setAttribute('data-screen', 'title');
    body.setAttribute('data-title-mode', mode);   // 'new' dims the running station behind the form
    T.el.hidden = false; T.el.classList.remove('out');
    const resumable = mode === 'boot' && !!saved;
    T.resume.hidden = !resumable;
    T.form.hidden = resumable;
    T.confirm.hidden = !(mode === 'new' && (Sim.state || saved));
    if (resumable) {
      const lvl = saved.level || 1;
      T.meta.textContent = `${saved.name} ${'·'} DAY ${saved.day} ${'·'} L${lvl} ${String(TIER_NAMES[lvl] || 'Galactic Hub').toUpperCase()} ${'·'} ${fmt(saved.credits)} CR`;
      drawThumb(saved);
      rebake(saved.name);
      $('#btn-resume').focus();
    } else {
      setTitleName(randomName(Sim.state ? Sim.state.name : null));
      T.name.focus(); T.name.select();
    }
  }
  function hideTitle() {
    T.open = false;
    T.el.classList.add('out');
    setTimeout(() => { if (!T.open) T.el.hidden = true; }, 300);
    body.removeAttribute('data-screen');
    body.removeAttribute('data-title-mode');
  }

  function commission() {
    const name = (T.name.value.trim() || randomName()).slice(0, 28);
    Sim.newGame();
    Sim.state.name = name;      // newGame picks a random name; overwrite before the first save
    Sim.save();
    UI.resetProgress();         // ws.orders / ws.evt come back for the new station
    Render.placing = null; Render.selected = null;
    Sim.emit('change');         // final name reaches Render's bake and the HUD signatures
    startGame();
  }
  function resume() {
    if (!Sim.load()) { Sim.newGame(); Sim.save(); }
    Render.placing = null; Render.selected = null;
    Sim.emit('change');         // Sim.load() emits nothing; rebuild trusses, signatures, bake
    startGame();
  }
  function startGame() {
    hideTitle();
    body.setAttribute('data-level', String(Sim.state.level));
    // 11.1 boot: once per session, 600ms, skipped under reduced motion
    if (!T.booted) {
      T.booted = true;
      if (!reduced()) {
        Ticker.boot = true; body.setAttribute('data-boot', '');
        setTimeout(() => { body.removeAttribute('data-boot'); Ticker.boot = false; }, 600);
      }
    }
    UI.setSpeed(Sim.state.speed || 1);
    UI.start();
    if (Sim.state.pending) UI.showEvent();
    last = performance.now();
  }
  function titleBack() {
    if (T.mode === 'new' && Sim.state) { hideTitle(); rebake(Sim.state.name); return; }   // back to the running game: its own nebula again
    showTitle('boot');                                              // back to the RESUME card
  }

  $('#btn-commission').addEventListener('click', commission);
  $('#btn-resume').addEventListener('click', resume);
  $('#btn-newstation').addEventListener('click', () => showTitle('new'));
  $('#btn-title-back').addEventListener('click', titleBack);
  $('#btn-reroll').addEventListener('click', () => { setTitleName(randomName(T.name.value.trim())); T.name.focus(); });
  T.name.addEventListener('input', () => { updateRegistry(); rebake(T.name.value.trim() || ' '); });
  T.name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commission(); } });
  // NEW in the top rail routes through the title screen's confirm step (12.1)
  $('#btn-new').addEventListener('click', () => showTitle('new'));

  showTitle('boot');

  // ---------------------------------------------------------- 4. mouse on the station canvas
  canvas.addEventListener('mousemove', e => {
    if (T.open) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    Render.hover = Render.cellAt(mx, my);
    if (typeof Render.mouse === 'function') Render.mouse(mx, my);
    const ship = Render.shipAt(mx, my);
    UI.tooltip(mx, my, Render.placing ? null : Render.hover, ship);   // placing suppresses module tooltips
  });
  canvas.addEventListener('mouseleave', () => {
    Render.hover = null;
    if (typeof Render.mouse === 'function') Render.mouse(null, null);
    UI.hideTooltip();
  });
  canvas.addEventListener('click', e => {
    if (T.open || !Sim.state) return;
    const rect = canvas.getBoundingClientRect();
    const cell = Render.cellAt(e.clientX - rect.left, e.clientY - rect.top);
    if (Render.placing) {
      if (!cell) return;
      const id = Render.placing;
      if (Sim.place(id, cell.r, cell.c)) {
        // keep placing while affordable; otherwise drop out of build mode
        if (Sim.state.credits < MODULES[id].cost) Render.placing = null;
        UI.refresh();
      }
      return;
    }
    if (cell && Sim.occupied(cell.r, cell.c)) { Render.selected = cell; UI.setTab('station'); }
    else { Render.selected = null; UI.refresh(); }
  });
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (T.open) return;
    Render.placing = null; Render.selected = null; UI.refresh();
  });

  // ---------------------------------------------------------- 5. keyboard (13): Space, 1/2/4, B, M, Esc; arrows live on the tab row
  window.addEventListener('keydown', e => {
    if (T.open) { if (e.key === 'Escape' && T.mode === 'new' && Sim.state) titleBack(); return; }
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (UI.modalOpen()) { if (e.key === 'Escape') UI.escModal(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || !Sim.state) return;
    if (e.code === 'Escape') { Render.placing = null; Render.selected = null; UI.refresh(); }
    else if (e.code === 'Space') { e.preventDefault(); UI.togglePause(); }
    else if (e.key === '1') UI.setSpeed(1);
    else if (e.key === '2') UI.setSpeed(2);
    else if (e.key === '4') UI.setSpeed(4);
    else if (e.key === 'b' || e.key === 'B') UI.setTab('build');
    else if (e.key === 'm' || e.key === 'M') UI.setTab('market');
  });

  // ---------------------------------------------------------- 6. body data attributes from Sim / Render (0.6)
  // data-condition is maintained by UI.refreshTop (it owns the 6s alert timer and the banner text);
  // data-motion above; data-level and data-placing here.
  let lastPlacing = null;
  function syncBody() {
    const placing = !!Render.placing;
    if (placing !== lastPlacing) { lastPlacing = placing; if (placing) body.setAttribute('data-placing', ''); else body.removeAttribute('data-placing'); }
    if (Sim.state) { const lvl = String(Sim.state.level); if (body.getAttribute('data-level') !== lvl) body.setAttribute('data-level', lvl); }
  }

  // Credits flash (6.2 / 9.5): good when a ship departs having paid, bad when a module is bought
  Sim.on('depart', sh => { if (sh && sh.earned > 0) UI.flash('#s-credits', 'good'); });
  Sim.on('built', () => UI.flash('#s-credits', 'bad'));

  // ---------------------------------------------------------- 7. frame loop
  let last = performance.now(), topAcc = 0, saveAcc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const live = !!Sim.state && !T.open;
    if (live) Sim.tick(dt);
    Render.draw(dt);                       // draws the ambient field behind the title too
    if (live) {
      syncBody();
      topAcc += dt; saveAcc += dt;
      if (topAcc >= 0.25) { topAcc = 0; UI.tick(); }
      if (saveAcc >= 10) { saveAcc = 0; Sim.save(); }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // auto-save on hide / unload (never while the title is deciding what to do with the save)
  const saveNow = () => { if (Sim.state && !T.open) Sim.save(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('beforeunload', saveNow);
})();

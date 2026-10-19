// ============================================================
// WAYSTATION v2 — engine/index.js (Engineer E)
// The Engine facade (DESIGN2.md 0.3): init, setSector, setPaused, resize,
// placing / selected / hover, camera, cellAt / cellToScreen, events,
// fx, thumbnail, perf. Wires the engine modules into one frame loop and
// subscribes to the Sim bus (0.6). The engine never mutates Sim or Meta.
//
// Additions beyond 0.3 (marked): Engine.emit (used by fx for
// 'fx-arrive'), Engine.perf.setTier(t|null) (harness / settings
// override), Engine.ready, the 'fx-arrive' event, and the A1.2
// 'plot-click' {r, c, ring} event for unclaimed cells.
// Classic script: exports the global `Engine`.
// ============================================================
'use strict';

const Engine = (() => {
  const U = EngineUtil, ST = EngineStage, CAM = EngineCamera;
  const listeners = new Map();
  const S = { ready: false, sector: null, initPromise: null };

  // ---------------------------------------------------------------- events
  function on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, []); listeners.get(evt).push(fn); }
  function off(evt, fn) { const l = listeners.get(evt); if (!l) return; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  function emit(evt, data) {
    const l = listeners.get(evt); if (!l) return;
    for (const fn of l.slice()) { try { fn(data); } catch (e) { ST.reportError('event ' + evt, e); } }
  }

  // ---------------------------------------------------------------- init
  async function init(hostEl) {
    if (S.initPromise) return S.initPromise;
    S.initPromise = (async () => {
      await ST.init(hostEl);
      CAM.init();
      EngineSpace.init();
      EngineWorld.init();
      EngineTraffic.init();
      EngineFX.init();
      EnginePost.init();
      EngineInput.init(emit);
      // frame order: camera -> space -> world -> traffic -> fx -> post -> input (hover uses the final camera)
      ST.onFrame(dt => CAM.update(dt));
      ST.onFrame(dt => EngineSpace.update(dt));
      ST.onFrame(dt => EngineWorld.update(dt));
      ST.onFrame(dt => EngineTraffic.update(dt));
      ST.onFrame(dt => EngineFX.update(dt));
      ST.onFrame(dt => EnginePost.update(dt));
      ST.onFrame(dt => EngineInput.update(dt));
      CAM.onChange(ev => emit('camera', ev));
      subscribeSim();
      const s = (typeof Sim !== 'undefined' && Sim) ? Sim.state : null;
      setSector((s && s.sector) || 'home', s);
      S.ready = true;
    })();
    return S.initPromise;
  }

  function subscribeSim() {
    if (typeof Sim === 'undefined' || !Sim || typeof Sim.on !== 'function') return;
    Sim.on('change', () => EngineWorld.rebuild());
    Sim.on('built', d => EngineWorld.onBuilt(d));
    Sim.on('demolished', d => EngineWorld.onDemolished(d));
    Sim.on('dock', ship => EngineTraffic.onDock(ship));
    Sim.on('depart', ship => EngineTraffic.onDepart(ship));
    Sim.on('spawn', ship => EngineTraffic.onSpawn(ship));
    Sim.on('levelup', () => EngineFX.facade.levelUp());
    Sim.on('collect', d => { if (d && d.r != null) EngineFX.facade.pulse(d.r, d.c, U.pal('amber')); });
    Sim.on('build-done', d => EngineWorld.onBuildDone(d));
    Sim.on('upgrade', d => EngineWorld.onUpgrade(d));
    Sim.on('hopper', d => EngineWorld.onHopper(d));
    Sim.on('plot', d => EngineWorld.onPlot(d));            // A1.2: {state:'start'|'done'|'skip', ring, bounds}
    Sim.on('sector', d => { if (d && d.state === 'switched') { const s = Sim.state; setSector((s && s.sector) || d.id || 'home', s); } });
  }

  // ---------------------------------------------------------------- facade
  // sectorDef: a SECTORS entry or its id; state: that sector's station state (Sim.state shape).
  function setSector(sectorDef, state) {
    S.sector = sectorDef;
    EngineWorld.rebuild();
    EngineSpace.setTheme(sectorDef || (state && state.sector) || 'home');
    CAM.snapFit();
    EngineSpace.setStation();
    EngineFX.clear();
  }
  function setPaused(b) { ST.paused = !!b; }
  function resize() { ST.resize(); }
  function cellAt(sx, sy) { const w = CAM.screenToWorld(sx, sy); return EngineWorld.cellAt(w.x, w.y); }
  function cellToScreen(r, c) { const p = EngineWorld.cellCentre(r, c); return CAM.worldToScreen(p.x, p.y); }
  function thumbnail(state, w, h) { return EngineWorld.thumbnail(state, w, h); }

  const perf = {
    get fps() { return Math.round(ST.fps); },
    get tier() { return ST.tier; },
    setTier(t) { ST.setTier(t); },                      // addition: explicit override, null = automatic
    get frameMs() { return +ST.frameMs.toFixed(2); },  // addition: CPU ms per frame (updates + render submission)
    get bloom() { return EnginePost.bloomActive; },
    get particles() { return EngineFX.count; },
  };

  return {
    init, setSector, setPaused, resize,
    get placing() { return EngineWorld.placing; },
    set placing(v) { EngineWorld.placing = v; },          // body[data-placing] stays with UI/main (0.7)
    get selected() { return EngineWorld.selected; },
    set selected(v) { EngineWorld.selected = v; },
    get hover() { return EngineWorld.hover; },
    get camera() { return CAM.facade; },
    cellAt, cellToScreen,
    on, off, emit,                                        // emit is an addition (fx uses it for 'fx-arrive')
    get fx() { return EngineFX.facade; },
    thumbnail,
    perf,
    get ready() { return S.ready; },                      // addition
    get sector() { return S.sector; },                    // addition
  };
})();

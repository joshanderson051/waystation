// ============================================================
// WAYSTATION v2 — engine/input.js (Engineer E)
// Pointer, wheel, pinch and keyboard on the world canvas (DESIGN2.md 3.8,
// 3.2 keyboard). A 4-px drag threshold separates pans from clicks;
// right-click emits `context`; hover is resolved once per frame (the
// camera may move under a still pointer); keyboard only when no input
// element is focused and no modal is open (UI.modalOpen()).
// Emits Engine events through the `emit` function given to init().
// Classic script: exports the global `EngineInput`.
// ============================================================
'use strict';

const EngineInput = (() => {
  const U = EngineUtil, ST = EngineStage, CAM = EngineCamera;
  const DRAG_PX = 4, DBL_MS = 320, LONG_MS = 520, PAN_SPEED = 900;

  const S = {
    emit: null, canvas: null,
    pointers: new Map(),           // pointerId -> {x, y}
    down: null,                    // {id, x, y, t, moved, shift, button}
    dragging: false, pinch: null,  // {d0, mx, my}
    lastPos: null,                 // last pointer position in host px (null when the pointer left)
    lastClick: { t: 0, key: '' },
    longTimer: 0,
    keys: new Set(),
    hoverKey: '',
  };

  // ---------------------------------------------------------------- helpers
  function hostPoint(ev) {
    const r = S.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function uiBlocks() {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return true;
    try { if (typeof UI !== 'undefined' && UI && typeof UI.modalOpen === 'function' && UI.modalOpen()) return true; } catch (e) { /* no UI */ }
    return false;
  }
  function cellKey(c) { return c ? c.r + ',' + c.c : ''; }

  // Touch (2.4 phone, A4): a fingertip is wider than a cursor and the chips shrink with the zoom, so a
  // touch tap also probes a TOUCH_RING px ring around the point for a bank chip (bankAt tests a 16-unit
  // disc, so eight probes cover the ring) and, on an empty cell, snaps to a scaffold whose centre is
  // within TOUCH_SNAP px: 32 px targets at any zoom.
  const TOUCH_RING = 16, TOUCH_SNAP = 22;
  function bankNearScreen(sx, sy, w) {
    let b = EngineWorld.bankAt(w.x, w.y); if (b) return b;
    const rho = TOUCH_RING / Math.max(0.05, CAM.zoom);
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; b = EngineWorld.bankAt(w.x + Math.cos(a) * rho, w.y + Math.sin(a) * rho); if (b) return b; }
    return null;
  }
  function scaffoldNearScreen(sx, sy, cell) {
    const half = EngineStage.ISO.EDGE * CAM.zoom / 2;
    let best = null, bd = Infinity;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = cell.r + dr, c = cell.c + dc;
      if (!EngineWorld.isScaffold(r, c)) continue;
      const q = EngineWorld.cellCentre(r, c), p = CAM.worldToScreen(q.x, q.y), d = Math.hypot(p.x - sx, p.y - sy);
      if (d <= half + TOUCH_SNAP && d < bd) { bd = d; best = { r, c }; }
    }
    return best;
  }

  // Classify a click at host px (sx, sy) and emit the matching Engine event. `touch` widens the targets.
  function click(sx, sy, shift, touch) {
    const w = CAM.screenToWorld(sx, sy);
    const cell = EngineWorld.cellAt(w.x, w.y);
    // placement is modal: the cell wins; otherwise bank chips (floating above plates), then ships, then cells
    if (!EngineWorld.placing) {
      const bank = touch ? bankNearScreen(sx, sy, w) : EngineWorld.bankAt(w.x, w.y);
      if (bank) { emitBanks(bank, shift); return; }
      if (shift && cell) { const near = EngineWorld.readyBanksNear(cell.r, cell.c, 3); if (near.length) { for (const b of near) S.emit('bank-click', b); return; } }
      const ship = EngineTraffic.shipAt(w.x, w.y);
      if (ship) { S.emit('ship-click', { ship, x: sx, y: sy }); return; }
    }
    if (cell) {
      // unclaimed space (A1.2): the ring that cell belongs to, so the HUD can offer to clear it
      if (!EngineWorld.inPlot(cell.r, cell.c)) { S.emit('plot-click', { r: cell.r, c: cell.c, ring: EngineWorld.ringOf(cell.r, cell.c) }); return; }
      if (EngineWorld.isScaffold(cell.r, cell.c)) { S.emit('scaffold-click', { r: cell.r, c: cell.c }); return; }
      const occupied = EngineWorld.occupied(cell.r, cell.c);
      if (touch && !occupied && !EngineWorld.placing) { const sc = scaffoldNearScreen(sx, sy, cell); if (sc) { S.emit('scaffold-click', sc); return; } }
      // double-click a module: focus at zoom 1.6
      const key = cellKey(cell), now = U.nowMs();
      if (occupied && S.lastClick.key === key && now - S.lastClick.t < DBL_MS) { CAM.focusCell(cell.r, cell.c, { zoom: 1.6, ms: 600 }); S.lastClick.t = 0; return; }
      S.lastClick = { t: now, key };
      S.emit('cell-click', { r: cell.r, c: cell.c, occupied, x: sx, y: sy });
      return;
    }
    S.emit('empty-click', { x: sx, y: sy });
  }
  function emitBanks(bank, shift) {
    if (shift) { for (const b of EngineWorld.readyBanksNear(bank.r, bank.c, 3)) S.emit('bank-click', b); }
    else S.emit('bank-click', bank);
  }

  // ---------------------------------------------------------------- pointer
  function onDown(ev) {
    if (ev.button !== 0 && ev.button !== 2 && ev.pointerType === 'mouse') return;
    const p = hostPoint(ev);
    S.pointers.set(ev.pointerId, p);
    try { S.canvas.setPointerCapture(ev.pointerId); } catch (e) { /* capture unsupported */ }
    if (S.pointers.size === 2) {
      // pinch: two pointers; cancel any pending click
      const pts = [...S.pointers.values()];
      S.pinch = { d0: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y), mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2 };
      S.down = null; clearLong();
      if (S.dragging) { CAM.endDrag(); S.dragging = false; }
      return;
    }
    if (ev.button === 2) { S.down = null; return; }
    S.down = { id: ev.pointerId, x: p.x, y: p.y, t: U.nowMs(), moved: false, shift: ev.shiftKey, touch: ev.pointerType === 'touch' };
    S.lastPos = p;
    clearLong();
    if (ev.pointerType === 'touch') {
      S.longTimer = setTimeout(() => {
        if (!S.down || S.down.moved) return;
        const w = CAM.screenToWorld(S.down.x, S.down.y), cell = EngineWorld.cellAt(w.x, w.y);
        if (cell) { const near = EngineWorld.readyBanksNear(cell.r, cell.c, 3); for (const b of near) S.emit('bank-click', b); }
        S.down = null;
      }, LONG_MS);
    }
  }
  function onMove(ev) {
    const p = hostPoint(ev);
    S.lastPos = p;
    if (S.pointers.has(ev.pointerId)) S.pointers.set(ev.pointerId, p);
    if (S.pinch && S.pointers.size >= 2) {
      const pts = [...S.pointers.values()];
      const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y), mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      if (S.pinch.d0 > 0 && d > 0) CAM.zoomAt(mx, my, d / S.pinch.d0);
      CAM.panBy(mx - S.pinch.mx, my - S.pinch.my);
      S.pinch = { d0: d, mx, my };
      return;
    }
    const d = S.down;
    if (!d || d.id !== ev.pointerId) return;
    const dx = p.x - d.x, dy = p.y - d.y;
    if (!d.moved && Math.hypot(dx, dy) >= DRAG_PX) { d.moved = true; S.dragging = true; CAM.beginDrag(); d.lx = d.x; d.ly = d.y; d.lt = U.nowMs(); clearLong(); }
    if (d.moved) {
      const now = U.nowMs(), dt = Math.max(0.001, (now - d.lt) / 1000);
      CAM.dragTo(p.x - d.lx, p.y - d.ly, dt);
      d.lx = p.x; d.ly = p.y; d.lt = now;
    }
  }
  function onUp(ev) {
    S.pointers.delete(ev.pointerId);
    if (S.pinch) { if (S.pointers.size < 2) S.pinch = null; return; }
    const d = S.down;
    if (!d || d.id !== ev.pointerId) return;
    S.down = null; clearLong();
    if (d.moved) { S.dragging = false; CAM.endDrag(); return; }
    if (ev.type === 'pointerup') click(d.x, d.y, d.shift || ev.shiftKey, d.touch);
  }
  function onLeave() { S.lastPos = null; }
  function clearLong() { if (S.longTimer) { clearTimeout(S.longTimer); S.longTimer = 0; } }

  function onContext(ev) {
    ev.preventDefault();
    const p = hostPoint(ev), w = CAM.screenToWorld(p.x, p.y);
    const cell = EngineWorld.cellAt(w.x, w.y);
    S.emit('context', { r: cell ? cell.r : null, c: cell ? cell.c : null, x: p.x, y: p.y });
  }
  function onWheel(ev) {
    ev.preventDefault();
    const p = hostPoint(ev);
    let dy = ev.deltaY;
    if (ev.deltaMode === 1) dy *= 16; else if (ev.deltaMode === 2) dy *= 120;
    dy = U.clamp(dy, -120, 120);
    CAM.zoomAt(p.x, p.y, Math.exp(-dy * 0.0016));
  }

  // ---------------------------------------------------------------- keyboard (3.2)
  function onKeyDown(ev) {
    if (uiBlocks()) return;
    const k = ev.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') { S.keys.add(k); ev.preventDefault(); return; }
    if (k === '+' || k === '=') { CAM.zoomAt(ST.w / 2, ST.h / 2, 1.2); ev.preventDefault(); }
    else if (k === '-' || k === '_') { CAM.zoomAt(ST.w / 2, ST.h / 2, 1 / 1.2); ev.preventDefault(); }
    else if (k === '0') { CAM.fit({ ms: 600 }); }
    else if (k === 'f' || k === 'F') { const sel = EngineWorld.selected; if (sel) CAM.focusCell(sel.r, sel.c, { zoom: Math.max(CAM.zoom, 1.4), ms: 600 }); }
  }
  function onKeyUp(ev) { S.keys.delete(ev.key); }
  function onBlur() { S.keys.clear(); }

  // ---------------------------------------------------------------- frame: held keys, hover
  function update(dt) {
    if (S.keys.size) {
      let dx = 0, dy = 0;
      if (S.keys.has('ArrowLeft')) dx += 1; if (S.keys.has('ArrowRight')) dx -= 1;
      if (S.keys.has('ArrowUp')) dy += 1; if (S.keys.has('ArrowDown')) dy -= 1;
      if (dx || dy) CAM.panBy(dx * PAN_SPEED * dt, dy * PAN_SPEED * dt);
    }
    // hover: resolved every frame from the last pointer position
    let cell = null, ship = null, pointerWorld = null;
    if (S.lastPos && !S.pinch) {
      const w = CAM.screenToWorld(S.lastPos.x, S.lastPos.y);
      pointerWorld = w;
      cell = EngineWorld.cellAt(w.x, w.y);
      if (!S.dragging) ship = EngineTraffic.shipAt(w.x, w.y);
    }
    EngineWorld.setPointer(pointerWorld);
    EngineTraffic.hover = ship;
    EngineWorld.hover = cell;
    const key = cellKey(cell);
    if (key !== S.hoverKey) { S.hoverKey = key; S.emit('cell-hover', cell ? { r: cell.r, c: cell.c } : null); }
    const overChip = !EngineWorld.placing && pointerWorld && (ship || EngineWorld.bankAt(pointerWorld.x, pointerWorld.y));
    const overUnclaimed = cell && !EngineWorld.inPlot(cell.r, cell.c);
    S.canvas.style.cursor = S.dragging ? 'grabbing' : (overChip || overUnclaimed) ? 'pointer' : EngineWorld.placing ? 'crosshair' : 'default';
  }

  function init(emit) {
    S.emit = emit;
    S.canvas = ST.canvas;
    const c = S.canvas;
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('pointerleave', onLeave);
    c.addEventListener('contextmenu', onContext);
    c.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
  }

  return { init, update };
})();

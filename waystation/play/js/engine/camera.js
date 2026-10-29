// ============================================================
// WAYSTATION v2 — engine/camera.js (Engineer E)
// Pan, zoom-to-cursor, inertia, bounds, focus/fit tweens, title drift,
// shake, panel avoidance, world<->screen (DESIGN2.md 3.2).
//
// World units are CSS px at zoom 1; since A7 cell (r, c) is a diamond centred at
// EngineStage.ISO.centre(r, c) (the art pack's projection). The camera state is the
// world point under the viewport centre (x, y) plus the zoom. Space layers
// follow with a fraction of the camera (parallax).
// Classic script: exports the global `EngineCamera`.
// ============================================================
'use strict';

const EngineCamera = (() => {
  const U = EngineUtil, ST = EngineStage;
  const CELL = ST.CELL;
  const ZOOM_MIN = 0.55, ZOOM_MAX = 2.6, FIT_ZOOM_MAX = 1.9;   // fit() never frames tighter than 1.9 (3.2; A7: the diamond grid packs modules closer)
  const FRICTION = 0.92;                 // per frame at 60 fps
  const DRIFT_RADIUS = 1.2 * CELL, DRIFT_PERIOD = 90, BREATHE_PERIOD = 16;

  const S = {
    x: 0, y: 0, zoom: 1,
    vx: 0, vy: 0, dragging: false,
    tween: null,
    bounds: null,                        // inflated station box, world px {x0,y0,x1,y1}
    station: null,                       // occupied-cell bbox, world px
    gridBox: null,                       // whole grid, world px
    drift: false, driftK: 0,             // driftK eases 0..1 so toggling never jumps
    shakeAmp: 0, shakeT0: 0,
    avoidShift: 0, avoidZoom: 0, userMoved: false,
    changed: true, listeners: [],
    lastEmit: { zoom: 0, x: 0, y: 0 },
  };

  // ---------------------------------------------------------------- transforms
  // Effective state = base + drift offset + shake offset (ambient offsets never touch the base).
  function effective() {
    let x = S.x, y = S.y, z = S.zoom;
    if (S.driftK > 0) {
      const a = ST.time * U.TAU / DRIFT_PERIOD;
      x += Math.cos(a) * DRIFT_RADIUS * S.driftK;
      y += Math.sin(a) * DRIFT_RADIUS * 0.6 * S.driftK;
      z *= 1 + 0.02 * Math.sin(ST.time * U.TAU / BREATHE_PERIOD) * S.driftK;
    }
    if (S.shakeAmp > 0) {
      const k = Math.min(1, (U.nowMs() - S.shakeT0) / 420);
      const amp = S.shakeAmp * (1 - k) * (1 - k);
      const t = ST.time * 47;
      x += Math.sin(t) * amp / z; y += Math.cos(t * 1.3) * amp / z;
      if (k >= 1) S.shakeAmp = 0;
    }
    return { x, y, z };
  }
  let E = { x: 0, y: 0, z: 1 };

  function worldToScreen(wx, wy) {
    return { x: ST.w / 2 + (wx - E.x) * E.z, y: ST.h / 2 + (wy - E.y) * E.z };
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - ST.w / 2) / E.z + E.x, y: (sy - ST.h / 2) / E.z + E.y };
  }
  // Parallax transform for a space layer: zoom and offset so world (0,0) moves at fraction k.
  function parallax(k) {
    const zk = 1 + (E.z - 1) * k;
    return { zk, x: ST.w / 2 - E.x * k * zk, y: ST.h / 2 - E.y * k * zk };
  }
  function applyTransforms() {
    E = effective();
    const L = ST.layers;
    L.cam.scale.set(E.z);
    L.cam.position.set(ST.w / 2 - E.x * E.z, ST.h / 2 - E.y * E.z);
    const far = parallax(0.08), mid = parallax(0.25);
    L.space.far.moving.scale.set(far.zk); L.space.far.moving.position.set(far.x, far.y);
    L.space.mid.moving.scale.set(mid.zk); L.space.mid.moving.position.set(mid.x, mid.y);
  }

  // ---------------------------------------------------------------- bounds
  function clampToBounds() {
    const b = S.bounds; if (!b) return;
    S.x = U.clamp(S.x, b.x0, b.x1);
    S.y = U.clamp(S.y, b.y0, b.y1);
  }
  // station: bbox of occupied cells (world px); grid: whole grid (world px).
  // Bounds = the station box inflated by 6 cells, widened to the full grid (A1.2: unclaimed space stays reachable).
  function setStation(station, grid) {
    S.station = station; S.gridBox = grid;
    const inf = 6 * CELL, g1 = CELL;
    let b = station ? { x0: station.x0 - inf, y0: station.y0 - inf, x1: station.x1 + inf, y1: station.y1 + inf } : null;
    if (grid) b = b ? { x0: Math.min(b.x0, grid.x0 - g1), y0: Math.min(b.y0, grid.y0 - g1), x1: Math.max(b.x1, grid.x1 + g1), y1: Math.max(b.y1, grid.y1 + g1) }
      : { x0: grid.x0 - g1, y0: grid.y0 - g1, x1: grid.x1 + g1, y1: grid.y1 + g1 };
    S.bounds = b;
    clampToBounds();
    S.changed = true;
  }

  // ---------------------------------------------------------------- interaction
  function zoomAt(sx, sy, factor) {
    killTween();
    // keep the world point under the cursor fixed; drift/shake offsets ride on top of the base
    const before = screenToWorld(sx, sy);
    const oldZoom = S.zoom, offX = E.x - S.x, offY = E.y - S.y, ratio = oldZoom > 0 ? E.z / oldZoom : 1;
    S.zoom = U.clamp(oldZoom * factor, ZOOM_MIN, ZOOM_MAX);
    const ez = S.zoom * ratio;
    S.x = before.x - (sx - ST.w / 2) / ez - offX;
    S.y = before.y - (sy - ST.h / 2) / ez - offY;
    S.userMoved = true;
    clampToBounds();
    S.changed = true;
  }
  function setZoom(z, sx, sy) {
    z = U.clamp(+z || 1, ZOOM_MIN, ZOOM_MAX);
    zoomAt(sx == null ? ST.w / 2 : sx, sy == null ? ST.h / 2 : sy, z / S.zoom);
  }
  function panBy(dxScreen, dyScreen) {
    killTween();
    S.x -= dxScreen / E.z; S.y -= dyScreen / E.z;
    S.userMoved = true;
    clampToBounds();
    S.changed = true;
  }
  function beginDrag() { killTween(); S.dragging = true; S.vx = S.vy = 0; }
  function dragTo(dxScreen, dyScreen, dt) {
    panBy(dxScreen, dyScreen);
    if (dt > 0) { const k = 0.6; S.vx = S.vx * (1 - k) + (-dxScreen / E.z / dt) * k; S.vy = S.vy * (1 - k) + (-dyScreen / E.z / dt) * k; }
  }
  function endDrag() {
    S.dragging = false;
    const sp = Math.hypot(S.vx, S.vy);
    if (sp < 40) { S.vx = S.vy = 0; }
    if (sp > 4000) { const f = 4000 / sp; S.vx *= f; S.vy *= f; }
  }
  // ---------------------------------------------------------------- tweens
  function killTween() { S.tween = null; }
  function tweenTo(x, y, zoom, ms, ease) {
    zoom = U.clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    if (S.bounds) { x = U.clamp(x, S.bounds.x0, S.bounds.x1); y = U.clamp(y, S.bounds.y0, S.bounds.y1); }
    S.vx = S.vy = 0;
    if (!(ms > 0) || ST.reduced) { S.x = x; S.y = y; S.zoom = zoom; S.tween = null; S.changed = true; return; }
    S.tween = { x0: S.x, y0: S.y, z0: S.zoom, x1: x, y1: y, z1: zoom, t0: U.nowMs(), ms, ease: ease || U.easeInOutCubic };
  }
  function focusCell(r, c, opts) {
    const o = opts || {};
    const p = ST.ISO.centre(r, c);
    tweenTo(p.x, p.y - ST.ISO.HH * 0.6, o.zoom != null ? o.zoom : S.zoom, o.ms != null ? o.ms : 600);
    S.userMoved = true;
  }
  // Frame the station with a 15% margin; `extra` is a screen rect to keep clear (panel).
  function fitTarget() {
    const b = S.station || S.gridBox;
    if (!b) return { x: S.x, y: S.y, zoom: 1 };
    const pad = 0.5 * CELL;
    const w = (b.x1 - b.x0) + pad * 2, h = (b.y1 - b.y0) + pad * 2;
    // a young station (one hub, a few plates) frames at a readable zoom with space around it, not at the maximum
    const zoom = U.clamp(Math.min(ST.w * 0.7 / w, ST.h * 0.7 / h), ZOOM_MIN, Math.min(ZOOM_MAX, FIT_ZOOM_MAX));
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, zoom };
  }
  function fit(opts) {
    const o = opts || {}, t = fitTarget();
    tweenTo(t.x, t.y, t.zoom, o.ms != null ? o.ms : 600);
    S.avoidShift = 0; S.avoidZoom = 0; S.userMoved = false;
  }
  function snapFit() { const t = fitTarget(); S.x = t.x; S.y = t.y; S.zoom = t.zoom; S.tween = null; S.changed = true; S.avoidShift = 0; S.avoidZoom = 0; S.userMoved = false; }

  // Panel avoidance: shift so the station clears `rect` (host CSS px {x,y,width,height} or a DOMRect).
  function avoid(rect) {
    if (!rect) {
      if (S.avoidShift && !S.userMoved) tweenTo(S.x - S.avoidShift, S.y, S.avoidZoom || S.zoom, 360);
      S.avoidShift = 0; S.avoidZoom = 0;
      return;
    }
    // accepts a DOMRect ({x,y,width,height}) or the HUD's short form ({x,y,w,h})
    const rx = +(rect.x != null ? rect.x : rect.left), ry = +(rect.y != null ? rect.y : rect.top);
    const rw = +(rect.width != null ? rect.width : rect.w), rh = +(rect.height != null ? rect.height : rect.h);
    if (![rx, ry, rw, rh].every(Number.isFinite) || rw <= 0 || rh <= 0) return;
    const b = S.station; if (!b) return;
    const a = worldToScreen(b.x0, b.y0), bb = worldToScreen(b.x1, b.y1);
    const hit = !(bb.x < rx || a.x > rx + rw || bb.y < ry || a.y > ry + rh);
    if (!hit) return;
    // A7: centre the station in the free space beside the panel, zooming out when it cannot fit there; closing the
    // panel restores both the position and the zoom
    const leftSide = rx + rw / 2 < ST.w / 2, margin = 28;
    const fx0 = leftSide ? rx + rw + margin : margin, fx1 = leftSide ? ST.w - margin : rx - margin;
    if (fx1 - fx0 <= 40) return;
    const z = Math.min(S.zoom, Math.max(ZOOM_MIN, (fx1 - fx0) / Math.max(1, b.x1 - b.x0)));
    const camX = (b.x0 + b.x1) / 2 - ((fx0 + fx1) / 2 - ST.w / 2) / z;
    if (!S.avoidZoom) S.avoidZoom = S.zoom;
    S.avoidShift += camX - S.x;
    tweenTo(camX, S.y, z, 360);
    S.userMoved = false;
  }

  function drift(on) { S.drift = !!on; }
  function shake(px) { S.shakeAmp = Math.max(S.shakeAmp, +px || 0); S.shakeT0 = U.nowMs(); }

  // ---------------------------------------------------------------- frame
  function update(dt) {
    // tween
    if (S.tween) {
      const tw = S.tween, k = Math.min(1, (U.nowMs() - tw.t0) / tw.ms), e = tw.ease(k);
      S.x = U.lerp(tw.x0, tw.x1, e); S.y = U.lerp(tw.y0, tw.y1, e); S.zoom = U.lerp(tw.z0, tw.z1, e);
      if (k >= 1) S.tween = null;
      S.changed = true;
    }
    // inertia
    if (!S.dragging && (S.vx !== 0 || S.vy !== 0)) {
      S.x += S.vx * dt; S.y += S.vy * dt;
      const f = Math.pow(FRICTION, dt * 60);
      S.vx *= f; S.vy *= f;
      if (Math.hypot(S.vx, S.vy) < 2) S.vx = S.vy = 0;
      clampToBounds();
      S.changed = true;
    }
    // drift ease in/out
    const target = (S.drift && !ST.reduced) ? 1 : 0;
    if (S.driftK !== target) { S.driftK = U.clamp(S.driftK + (target - S.driftK) * Math.min(1, dt * 1.5), 0, 1); if (Math.abs(S.driftK - target) < 0.002) S.driftK = target; S.changed = true; }
    if (S.driftK > 0 || S.shakeAmp > 0) S.changed = true;

    applyTransforms();
    if (S.changed) {
      S.changed = false;
      const ev = { zoom: E.z, x: E.x, y: E.y };
      if (Math.abs(ev.zoom - S.lastEmit.zoom) > 1e-4 || Math.abs(ev.x - S.lastEmit.x) > 0.01 || Math.abs(ev.y - S.lastEmit.y) > 0.01) {
        S.lastEmit = ev;
        for (const fn of S.listeners) { try { fn(ev); } catch (e) { ST.reportError('camera', e); } }
      }
    }
  }
  function onChange(fn) { S.listeners.push(fn); }
  function onResize() { S.changed = true; applyTransforms(); }

  function init() {
    ST.onResize(onResize);
    applyTransforms();
  }

  // Facade object (0.3 Engine.camera): zoom / x / y are live properties.
  const facade = {
    get zoom() { return S.zoom; }, set zoom(v) { setZoom(v); },
    get x() { return S.x; }, set x(v) { killTween(); S.x = +v || 0; clampToBounds(); S.changed = true; },
    get y() { return S.y; }, set y(v) { killTween(); S.y = +v || 0; clampToBounds(); S.changed = true; },
    get min() { return ZOOM_MIN; }, get max() { return ZOOM_MAX; },
    focusCell, fit, drift, shake, avoid,
    get bounds() { return S.bounds; },
    get drifting() { return S.drift; },
  };

  return {
    CELL, ZOOM_MIN, ZOOM_MAX,
    init, update, onChange, facade,
    worldToScreen, screenToWorld, parallax,
    zoomAt, panBy, beginDrag, dragTo, endDrag,
    focusCell, fit, snapFit, fitTarget, shake, setStation,
    get zoom() { return E.z; }, get x() { return E.x; }, get y() { return E.y; },
    get station() { return S.station; }, get gridBox() { return S.gridBox; },
  };
})();

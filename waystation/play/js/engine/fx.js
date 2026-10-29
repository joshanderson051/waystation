// ============================================================
// PORT SOLACE v2 — engine/fx.js (Engineer E)
// Particles, rings, floaters, coin flights to the HUD, shockwaves,
// level-up bursts and the warp transition (DESIGN2.md 3.6, 0.3 Engine.fx).
//
// Particles are pooled Sprites over a handful of baked textures in two
// containers: `fx` (world space, inside the camera) and `fxScreen`
// (screen space, for warp streaks and shockwaves). Caps by tier:
// 250 / 800 / 2000. Coin flights re-target every frame because the
// camera may move while they fly.
// Classic script: exports the global `EngineFX`.
// ============================================================
'use strict';

const EngineFX = (() => {
  const U = EngineUtil, ST = EngineStage, CAM = EngineCamera;
  const CELL = ST.CELL, TAU = U.TAU;
  const CAPS = [250, 800, 2000];
  const K_SPARK = 0, K_MOTE = 1, K_EXHAUST = 2, K_STREAK = 3, K_BURST = 4;

  const S = {
    live: [], pool: [],
    rings: [], floaters: [], flights: [], warp: null,
    tex: null,
  };

  // ---------------------------------------------------------------- textures and pool
  function textures() {
    if (S.tex) return S.tex;
    S.tex = {
      dot: ST.glowTexture('#FFFFFF', 8, 'soft'),
      spark: ST.glowTexture('#FFFFFF', 6, 'hard'),
      burst: ST.glowTexture('#FFFFFF', 64, 'soft'),
      streak: ST.bake('fx|streak', 64, 6, g => {
        const gr = g.createLinearGradient(0, 0, 64, 0);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,1)');
        g.fillStyle = gr; g.beginPath(); g.ellipse(32, 3, 32, 3, 0, 0, TAU); g.fill();
      }).texture,
      coin: ST.bake('fx|coin', 28, 28, g => {
        const c = 14, r = 12;
        g.beginPath(); g.arc(c, c, r, 0, TAU);
        const gr = g.createRadialGradient(c - 4, c - 4, 1, c, c, r);
        gr.addColorStop(0, U.pal('amber-hi')); gr.addColorStop(0.75, U.pal('amber')); gr.addColorStop(1, '#B9781E');
        g.fillStyle = gr; g.fill();
        g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1; g.stroke();
        const path = (typeof Icons !== 'undefined' && Icons && typeof Icons.path === 'function') ? Icons.path('credits') : null;
        g.save(); g.translate(c - 7, c - 7); g.scale(14 / 24, 14 / 24);
        g.strokeStyle = U.pal('on-accent'); g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round';
        if (path) g.stroke(path); else { g.beginPath(); g.arc(12, 12, 8, 0, TAU); g.stroke(); }
        g.restore();
      }).texture,
    };
    return S.tex;
  }
  function cap() { const c = CAPS[ST.tier]; return ST.reduced ? Math.max(24, Math.floor(c * 0.3)) : c; }

  function acquire(kind, texture, screen) {
    if (S.live.length >= cap()) return null;
    let p = S.pool.pop();
    if (!p) { p = { sp: new PIXI.Sprite(), kind, x: 0, y: 0, vx: 0, vy: 0, t0: 0, life: 1, size: 1, drag: 0, extra: 0, path: null, ease: null, screen: false, alpha: 1 }; p.sp.anchor.set(0.5); p.sp.eventMode = 'none'; p.sp.blendMode = 'add'; }
    p.kind = kind; p.sp.texture = texture; p.screen = !!screen; p.path = null; p.ease = null; p.sp.rotation = 0; p.sp.visible = true; p.alpha = 1;
    (screen ? ST.layers.fxScreen : ST.layers.fx).addChild(p.sp);
    S.live.push(p);
    return p;
  }
  function release(i) {
    const p = S.live[i];
    p.sp.removeFromParent(); p.sp.visible = false;
    S.live[i] = S.live[S.live.length - 1]; S.live.pop();
    if (S.pool.length < 2200) S.pool.push(p);
  }
  const resolveEase = e => typeof e === 'function' ? e : e === 'in' ? U.easeInQuad : e === 'out' ? U.easeOutCubic : e === 'inout' ? U.easeInOutCubic : null;

  // ---------------------------------------------------------------- emitters (world px unless noted)
  function sparks(x, y, color, count, ms, speedScale) {
    const T = textures(), n = count > 0 ? count | 0 : 8, life = (ms > 0 ? ms : 300) / 1000, tint = U.int(color), ss = speedScale || 1;
    for (let i = 0; i < n; i++) {
      const p = acquire(K_SPARK, T.spark, false); if (!p) return;
      const a = Math.random() * TAU, sp = (40 + Math.random() * 110) * ss;
      p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp; p.t0 = ST.time; p.life = life * (0.8 + Math.random() * 0.4); p.drag = 3;
      p.size = 0.22 + (Math.random() < 0.4 ? 0.12 : 0); p.sp.tint = tint;
    }
  }
  // Directional sparks (debris blown outward on a plot reveal): a cone of ±0.5 rad around `angle`.
  function blow(x, y, angle, color, count, ms) {
    const T = textures(), n = count > 0 ? count | 0 : 3, life = (ms > 0 ? ms : 800) / 1000, tint = U.int(color);
    for (let i = 0; i < n; i++) {
      const p = acquire(K_SPARK, T.dot, false); if (!p) return;
      const a = angle + (Math.random() - 0.5), sp = 50 + Math.random() * 110;
      p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp; p.t0 = ST.time + Math.random() * 0.12; p.life = life * (0.7 + Math.random() * 0.6); p.drag = 1.6;
      p.size = 0.25 + Math.random() * 0.2; p.sp.tint = tint;
    }
  }
  function motes(points, color, count, ms, ease) {
    if (!points || points.length < 2) return;
    const T = textures(), n = count > 0 ? count | 0 : 3, life = (ms > 0 ? ms : 600) / 1000, tint = U.int(color);
    const cum = [0]; for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    const path = { pts: points, cum, total: cum[cum.length - 1] || 1 };
    for (let i = 0; i < n; i++) {
      const p = acquire(K_MOTE, T.dot, false); if (!p) return;
      p.path = path; p.ease = resolveEase(ease); p.t0 = ST.time + i * life * 0.08; p.life = life; p.extra = (Math.random() - 0.5) * 6; p.size = 0.3; p.sp.tint = tint;
      p.x = points[0].x; p.y = points[0].y;
    }
  }
  function exhaust(x, y, angle, color, count) {
    const T = textures(), tint = U.int(color), n = count || 2;
    if (S.live.length + n > cap() - (cap() >> 3)) return;        // exhaust yields to everything else
    for (let i = 0; i < n; i++) {
      const p = acquire(K_EXHAUST, T.dot, false); if (!p) return;
      const a = angle + Math.PI + (Math.random() - 0.5) * 0.5, sp = 30 + Math.random() * 40;
      p.x = x + (Math.random() - 0.5) * 1.5; p.y = y + (Math.random() - 0.5) * 1.5; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.t0 = ST.time; p.life = 0.4; p.size = 0.22; p.sp.tint = tint;
    }
  }
  // Soft additive burst that expands and fades (completion flashes, collect bursts)
  function burst(x, y, color, r0, r1, ms, alpha) {
    const p = acquire(K_BURST, textures().burst, false); if (!p) return;
    p.x = x; p.y = y; p.t0 = ST.time; p.life = (ms || 400) / 1000; p.size = r0 / 64; p.extra = r1 / 64; p.alpha = alpha || 0.6; p.sp.tint = U.int(color);
  }
  function ring(x, y, r0, r1, color, ms, width, screen) {
    if (S.rings.length >= 48) return;
    const g = new PIXI.Graphics(); g.eventMode = 'none'; g.blendMode = 'add';
    (screen ? ST.layers.fxScreen : ST.layers.fx).addChild(g);
    S.rings.push({ g, x, y, r0: r0 || 0, r1: r1 || r0 + 8, color: U.int(color), t0: ST.time, life: (ms > 0 ? ms : 400) / 1000, width: width || 1.5, screen: !!screen });
  }

  // Floater: rising text with a dark pill behind it, 1.2 s, 28 px rise (world space).
  function floaterWorld(x, y, text, color) {
    const size = Math.max(12, Math.round(CELL * 0.3));
    const t = ST.makeText(String(text), { size, color: color || U.pal('ink') });
    t.anchor.set(0.5, 0.5);
    const bg = new PIXI.Graphics(); bg.eventMode = 'none';
    const pad = 4, w = t.width + pad * 2, h = t.height + pad;
    bg.roundRect(-w / 2, -h / 2, w, h, 3).fill({ color: 0x04050A, alpha: 0.55 });
    const root = new PIXI.Container(); root.eventMode = 'none';
    root.addChild(bg, t); root.position.set(x, y);
    ST.layers.fx.addChild(root);
    S.floaters.push({ root, text: t, bg, x, y, t0: ST.time, life: 1.2 });
    // the caller may rewrite the text (coalescing); keep the pill sized
    return {
      get text() { return t.text; },
      set text(v) { t.text = v; const w2 = t.width + pad * 2; bg.clear(); bg.roundRect(-w2 / 2, -h / 2, w2, h, 3).fill({ color: 0x04050A, alpha: 0.55 }); },
    };
  }

  // ---------------------------------------------------------------- Engine.fx (0.3)
  // A7: a cell's effects centre on the module's body, a little above the deck point
  const cellXY = (r, c) => { const p = ST.ISO.centre(r, c); return { x: p.x, y: p.y - ST.ISO.HH * 0.5 }; };

  // Anchor centre in world coordinates (recomputed every frame while coins fly).
  function anchorWorld(el) {
    let sx = 16, sy = 16;
    if (el && typeof el.getBoundingClientRect === 'function') {
      try { const r = el.getBoundingClientRect(), h = ST.host.getBoundingClientRect(); sx = r.left + r.width / 2 - h.left; sy = r.top + r.height / 2 - h.top; } catch (e) { /* detached element */ }
    }
    return CAM.screenToWorld(sx, sy);
  }

  function collect(r, c, amount, targetEl) {
    const o = cellXY(r, c), amber = U.pal('amber'), hi = U.pal('amber-hi');
    sparks(o.x, o.y, hi, 14, 420, 0.8);
    burst(o.x, o.y, amber, 6, CELL * 0.9, 420, 0.5);
    ring(o.x, o.y, CELL * 0.2, CELL * 0.8, amber, 420, 2);
    const n = U.clamp(Math.round((amount || 0) / 50), 8, 14);
    return new Promise(resolve => {
      if (ST.reduced) { resolve(); return; }
      const T = textures(), t0 = ST.time;
      const flight = { coins: [], target: targetEl || null, resolve, done: 0, n, arrived: 0 };
      for (let i = 0; i < n; i++) {
        const sp = new PIXI.Sprite(T.coin); sp.anchor.set(0.5); sp.eventMode = 'none';
        sp.scale.set(0.6 + Math.random() * 0.3);
        ST.layers.fx.addChild(sp);
        const a = Math.random() * TAU, d = 6 + Math.random() * 14;
        flight.coins.push({ sp, x0: o.x + Math.cos(a) * d, y0: o.y + Math.sin(a) * d, t0: t0 + i * 0.03, ms: (0.6 + Math.random() * 0.2), side: (Math.random() - 0.5) * 2, lift: 40 + Math.random() * 80, done: false });
      }
      S.flights.push(flight);
    });
  }
  function buildStart(r, c) {
    const o = cellXY(r, c);
    sparks(o.x, o.y, U.pal('ice-hi'), 14, 380);
    ring(o.x, o.y, CELL * 0.3, CELL * 0.8, U.pal('ice'), 360, 1.5);
  }
  function buildDone(r, c) {
    const o = cellXY(r, c);
    ring(o.x, o.y, CELL * 0.4, CELL * 1.4, U.pal('ivory'), 520, 2);
    sparks(o.x, o.y, U.pal('lamp'), 18, 420);
    burst(o.x, o.y, U.pal('lamp'), 10, CELL * 1.2, 480, 0.55);
    EnginePost.flash(U.pal('lamp'), 0.08, 220);
  }
  function floater(r, c, text, color) { const o = cellXY(r, c); return floaterWorld(o.x, o.y - CELL * 0.2, text, color); }
  function pulse(r, c, color) { const o = cellXY(r, c); ring(o.x, o.y, CELL * 0.3, CELL * 0.95, color || U.pal('ivory'), 520, 2); }
  function shock(sx, sy, strength) {
    const k = U.clamp(strength || 1, 0.2, 3);
    ring(sx, sy, 10, 180 * k, U.pal('ivory'), 700, 3, true);
    ring(sx, sy, 4, 110 * k, U.pal('warn'), 560, 2, true);
    const w = CAM.screenToWorld(sx, sy);
    sparks(w.x, w.y, U.pal('warn'), Math.round(24 * k), 600, 1.6);
    CAM.shake(6 * k);
  }
  function levelUp() {
    const st = EngineWorld.station || CAM.gridBox;
    const cx = st ? (st.x0 + st.x1) / 2 : 0, cy = st ? (st.y0 + st.y1) / 2 : 0;
    const T = textures(), n = ST.reduced ? 40 : 180;
    for (let i = 0; i < n; i++) {
      const p = acquire(K_SPARK, T.dot, false); if (!p) break;
      const a = (i / n) * TAU + Math.random() * 0.1, sp = 160 + Math.random() * 260;
      p.x = cx; p.y = cy; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp; p.t0 = ST.time + Math.random() * 0.1; p.life = 1.1 + Math.random() * 0.4; p.drag = 1.4;
      p.size = 0.3 + Math.random() * 0.2; p.sp.tint = U.int(i % 3 ? U.pal('amber-hi') : U.pal('lamp'));
    }
    ring(cx, cy, CELL * 0.5, CELL * 6, U.pal('amber'), 1100, 3);
    ring(cx, cy, CELL * 0.3, CELL * 4, U.pal('ivory'), 900, 1.5);
    burst(cx, cy, U.pal('amber'), 20, CELL * 5, 900, 0.35);
    EnginePost.flash(U.pal('amber'), 0.14, 420);
  }
  function flash(color, alpha, ms) { EnginePost.flash(color, alpha, ms); }
  function warp() {
    return new Promise(resolve => {
      const dur = 0.9;
      if (ST.reduced) { EnginePost.flash('#FFFFFF', 0.5, 500); setTimeout(resolve, 500); return; }
      const T = textures(), n = Math.min(400, Math.max(80, cap() - S.live.length - 20));
      const cx = ST.w / 2, cy = ST.h / 2;
      for (let i = 0; i < n; i++) {
        const p = acquire(K_STREAK, T.streak, true); if (!p) break;
        const a = Math.random() * TAU;
        p.x = cx; p.y = cy; p.vx = Math.cos(a); p.vy = Math.sin(a);
        p.extra = 20 + Math.random() * 120;                       // start radius
        p.t0 = ST.time + Math.random() * 0.25; p.life = dur - (p.t0 - ST.time); p.size = 0.4 + Math.random() * 0.6;
        p.sp.tint = U.int(Math.random() < 0.7 ? '#FFFFFF' : U.pal('ice-hi')); p.sp.rotation = a;
      }
      S.warp = { t0: ST.time, dur, resolve, flashed: false };
    });
  }

  // ---------------------------------------------------------------- frame
  function update(dt) {
    const t = ST.time, zoom = CAM.zoom;
    // particles
    for (let i = S.live.length - 1; i >= 0; i--) {
      const p = S.live[i], age = t - p.t0;
      if (age >= p.life) { release(i); continue; }
      if (age < 0) { p.sp.visible = false; continue; }
      p.sp.visible = true;
      const k = age / p.life;
      if (p.kind === K_SPARK) {
        const d = Math.max(0, 1 - p.drag * dt); p.vx *= d; p.vy *= d; p.x += p.vx * dt; p.y += p.vy * dt;
        p.sp.alpha = (1 - k) * (1 - k) * 0.95 + 0.05; p.sp.scale.set(p.size * (1 + k * 0.3));
      } else if (p.kind === K_EXHAUST) {
        p.x += p.vx * dt; p.y += p.vy * dt; p.sp.alpha = (1 - k) * 0.7; p.sp.scale.set(p.size * (1 + k));
      } else if (p.kind === K_MOTE) {
        const pa = p.path, e = p.ease ? p.ease(k) : k, d = e * pa.total;
        let j = 1; while (j < pa.pts.length - 1 && pa.cum[j] < d) j++;
        const c0 = pa.cum[j - 1], c1 = pa.cum[j], seg = c1 - c0, f = seg > 0 ? (d - c0) / seg : 1;
        const a = pa.pts[j - 1], b = pa.pts[j];
        let nx = 0, ny = 0; if (seg > 0) { nx = -(b.y - a.y) / seg; ny = (b.x - a.x) / seg; }
        const lat = p.extra * Math.sin(k * Math.PI);
        p.x = a.x + (b.x - a.x) * f + nx * lat; p.y = a.y + (b.y - a.y) * f + ny * lat;
        p.sp.alpha = k < 0.15 ? k / 0.15 : k > 0.85 ? (1 - k) / 0.15 : 1; p.sp.scale.set(p.size);
      } else if (p.kind === K_BURST) {
        p.sp.alpha = p.alpha * (1 - k) * (1 - k); p.sp.scale.set(U.lerp(p.size, p.extra, U.easeOutCubic(k)));
      } else if (p.kind === K_STREAK) {
        // accelerating outward from the screen centre, stretching with speed
        const r = p.extra + 900 * k * k * p.size * 1.6;
        p.x = ST.w / 2 + p.vx * r; p.y = ST.h / 2 + p.vy * r;
        p.sp.scale.set(0.4 + k * 4.5 * p.size, 0.5 + k * 0.5);
        p.sp.alpha = k < 0.1 ? k / 0.1 : 1;
      }
      p.sp.position.set(p.x, p.y);
    }
    // rings
    for (let i = S.rings.length - 1; i >= 0; i--) {
      const r = S.rings[i], k = (t - r.t0) / r.life;
      if (k >= 1) { r.g.destroy(); S.rings.splice(i, 1); continue; }
      const e = 1 - (1 - k) * (1 - k), rad = r.r0 + (r.r1 - r.r0) * e;
      r.g.clear();
      r.g.circle(r.x, r.y, rad).stroke({ width: r.width / (r.screen ? 1 : Math.max(0.6, Math.sqrt(zoom))), color: r.color, alpha: 1 - k });
    }
    // floaters: rise 28 px over 1.2 s, fade over the last 30%
    for (let i = S.floaters.length - 1; i >= 0; i--) {
      const f = S.floaters[i], k = (t - f.t0) / f.life;
      if (k >= 1) { f.root.destroy({ children: true }); S.floaters.splice(i, 1); continue; }
      f.root.position.set(f.x, f.y - 28 * U.easeOutCubic(k));
      f.root.alpha = k > 0.7 ? Math.max(0, 1 - (k - 0.7) / 0.3) : 1;
    }
    // coin flights: Bezier arcs to the anchor's current world position
    for (let i = S.flights.length - 1; i >= 0; i--) {
      const fl = S.flights[i], tgt = anchorWorld(fl.target);
      let alive = 0;
      for (const c of fl.coins) {
        if (c.done) continue;
        const k = (t - c.t0) / c.ms;
        if (k < 0) { alive++; c.sp.visible = false; continue; }
        if (k >= 1) {
          c.done = true; c.sp.destroy(); fl.arrived++;
          Engine.emit('fx-arrive', { target: fl.target, index: fl.arrived, count: fl.n });
          continue;
        }
        alive++;
        c.sp.visible = true;
        const e = U.easeInOutCubic(k);
        const mx = (c.x0 + tgt.x) / 2, my = (c.y0 + tgt.y) / 2;
        const dx = tgt.x - c.x0, dy = tgt.y - c.y0, L = Math.hypot(dx, dy) || 1;
        const cxp = mx - dy / L * c.side * c.lift / zoom, cyp = my + dx / L * c.side * c.lift / zoom - c.lift * 0.6 / zoom;
        const mt = 1 - e;
        c.sp.position.set(mt * mt * c.x0 + 2 * mt * e * cxp + e * e * tgt.x, mt * mt * c.y0 + 2 * mt * e * cyp + e * e * tgt.y);
        c.sp.scale.set((0.75 + 0.25 * Math.sin(k * Math.PI)) / Math.max(0.8, zoom) * 0.9);
        c.sp.rotation = k * 6 * c.side;
        c.sp.alpha = k > 0.9 ? (1 - k) / 0.1 : 1;
      }
      if (!alive) { S.flights.splice(i, 1); fl.resolve(); }
    }
    // warp: white flash near the end, resolve at the end
    if (S.warp) {
      const w = S.warp, k = (t - w.t0) / w.dur;
      if (k > 0.7 && !w.flashed) { w.flashed = true; EnginePost.flash('#FFFFFF', 0.85, 420); }
      if (k >= 1) { S.warp = null; w.resolve(); }
    }
  }

  function clear() {
    while (S.live.length) release(S.live.length - 1);
    for (const r of S.rings) r.g.destroy(); S.rings = [];
    for (const f of S.floaters) f.root.destroy({ children: true }); S.floaters = [];
    for (const fl of S.flights) { for (const c of fl.coins) if (!c.done) c.sp.destroy(); fl.resolve(); } S.flights = [];
  }
  function init() { textures(); }

  return {
    init, update, clear,
    sparks, blow, motes, exhaust, ring, burst, floaterWorld,
    facade: { collect, buildStart, buildDone, floater, pulse, shock, levelUp, flash, warp },
    get count() { return S.live.length; }, get cap() { return cap(); },
  };
})();

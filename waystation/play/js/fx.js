// ============================================================
// WAYSTATION — FX: fixed-size particle pool (DESIGN.md 14.1 "FX")
// ============================================================
// A 512-slot pool held in typed arrays with swap-remove. Five kinds:
//   spark   additive  1px burst, drag, fades
//   mote    additive  2px dot that follows a polyline of waypoints
//   ring    normal    1px stroked circle expanding r0 -> r1, fading
//   exhaust additive  1px dot drifting opposite a heading, 400ms
//   dot     normal    small filled square, fading
// Coordinates are CSS px on the #station canvas (Render converts from grid
// units before calling). Colors are strings; each distinct string is parsed
// once into a small palette table (index stored per particle), and alpha
// fades are applied through ctx.globalAlpha against a cached opaque
// 'rgb(r,g,b)' fillStyle so update/draw never allocate.
// Classic script: exports the global `FX`.
'use strict';

const FX = (() => {
  // ---------------------------------------------------------- constants
  const N = 512;                       // hard pool size
  const K_SPARK = 0, K_MOTE = 1, K_RING = 2, K_EXHAUST = 3, K_DOT = 4;
  const ADDITIVE = new Uint8Array([1, 1, 0, 1, 0]);   // indexed by kind

  // ---------------------------------------------------------- pool arrays
  const px = new Float32Array(N), py = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N);
  const t0 = new Float64Array(N);      // spawn time (ms, internal clock); may be in the future (stagger)
  const life = new Float32Array(N);    // ms
  const kind = new Uint8Array(N);
  const colorIdx = new Uint8Array(N);
  const size = new Float32Array(N);    // px (spark/exhaust/dot/mote) or r0 (ring)
  const extra = new Float32Array(N);   // ring: r1; mote: path slot; spark: drag
  let n = 0;                           // live count
  let now = 0;                         // ms, advanced by update(dt)

  // ---------------------------------------------------------- caps
  let tier = 0, reduced = false, cap = N;
  function recomputeCap() {
    let c = N;
    if (tier === 1) c = N >> 1; else if (tier >= 2) c = N >> 2;
    if (reduced) c = Math.floor(c * 0.3);
    cap = Math.max(8, c);
    while (n > cap) removeAt(n - 1);
  }

  // ---------------------------------------------------------- palette
  // distinct color string -> index; parsed once to r,g,b (+ base alpha)
  const PAL_MAX = 255;
  const palMap = new Map();
  const palStr = [];                   // 'rgb(r,g,b)' opaque fill/stroke strings
  const palA = [];                     // base alpha carried by the source string (rgba(...,a))
  const FALLBACK_RGB = [243, 233, 214];

  function parseColor(str) {
    // returns [r,g,b,a]; supports #rgb #rgba #rrggbb #rrggbbaa rgb() rgba()
    const s = String(str || '').trim();
    if (s[0] === '#') {
      const h = s.slice(1);
      if (h.length === 3 || h.length === 4) {
        const r = parseInt(h[0] + h[0], 16), g = parseInt(h[1] + h[1], 16), b = parseInt(h[2] + h[2], 16);
        const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
        if (r === r && g === g && b === b) return [r, g, b, a];
      } else if (h.length === 6 || h.length === 8) {
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        if (r === r && g === g && b === b) return [r, g, b, a];
      }
    } else if (s.slice(0, 3) === 'rgb') {
      const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
      if (m) return [+m[1] | 0, +m[2] | 0, +m[3] | 0, m[4] === undefined ? 1 : +m[4]];
      const m2 = s.match(/rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.%]+)\s*)?\)/i);
      if (m2) {
        let a = 1;
        if (m2[4] !== undefined) a = m2[4].endsWith('%') ? parseFloat(m2[4]) / 100 : +m2[4];
        return [+m2[1] | 0, +m2[2] | 0, +m2[3] | 0, a];
      }
    }
    return [FALLBACK_RGB[0], FALLBACK_RGB[1], FALLBACK_RGB[2], 1];
  }

  function colorIndex(str) {
    let i = palMap.get(str);
    if (i !== undefined) return i;
    if (palStr.length >= PAL_MAX) return 0;        // palette full: reuse the first entry
    const c = parseColor(str);
    i = palStr.length;
    palStr.push('rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')');
    palA.push(c[3] > 1 ? 1 : c[3] < 0 ? 0 : c[3]);
    palMap.set(str, i);
    return i;
  }
  colorIndex('#F3E9D6');   // index 0: ivory fallback

  // ---------------------------------------------------------- mote paths
  // Polylines live in fixed slots; a mote stores its slot in `extra`.
  const PATH_SLOTS = 32, MAX_PTS = 48;
  const pathX = new Float32Array(PATH_SLOTS * MAX_PTS);
  const pathY = new Float32Array(PATH_SLOTS * MAX_PTS);
  const pathCum = new Float32Array(PATH_SLOTS * MAX_PTS);   // cumulative length at each point
  const pathN = new Uint8Array(PATH_SLOTS);
  const pathRef = new Uint16Array(PATH_SLOTS);              // live motes using the slot
  const pathTotal = new Float32Array(PATH_SLOTS);
  const pathEase = new Array(PATH_SLOTS).fill(null);

  const easeIn = t => t * t;
  const easeOut = t => 1 - (1 - t) * (1 - t) * (1 - t);
  const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2;
  function resolveEase(e) {
    if (typeof e === 'function') return e;
    if (e === 'in') return easeIn;
    if (e === 'out') return easeOut;
    if (e === 'inout' || e === 'in-out') return easeInOut;
    return null;
  }

  function allocPath(points, ease) {
    if (!points || points.length < 2) return -1;
    let slot = -1;
    for (let i = 0; i < PATH_SLOTS; i++) if (pathRef[i] === 0) { slot = i; break; }
    if (slot < 0) return -1;
    const base = slot * MAX_PTS;
    const cnt = Math.min(points.length, MAX_PTS);
    let acc = 0;
    for (let i = 0; i < cnt; i++) {
      const p = points[i];
      pathX[base + i] = p.x; pathY[base + i] = p.y;
      if (i > 0) acc += Math.hypot(p.x - pathX[base + i - 1], p.y - pathY[base + i - 1]);
      pathCum[base + i] = acc;
    }
    pathN[slot] = cnt;
    pathTotal[slot] = acc;
    pathEase[slot] = resolveEase(ease);
    return slot;
  }

  // ---------------------------------------------------------- pool ops
  function removeAt(i) {
    if (kind[i] === K_MOTE) {
      const slot = extra[i] | 0;
      if (slot >= 0 && slot < PATH_SLOTS && pathRef[slot] > 0) pathRef[slot]--;
    }
    n--;
    if (i !== n) {
      px[i] = px[n]; py[i] = py[n]; vx[i] = vx[n]; vy[i] = vy[n];
      t0[i] = t0[n]; life[i] = life[n]; kind[i] = kind[n];
      colorIdx[i] = colorIdx[n]; size[i] = size[n]; extra[i] = extra[n];
    }
  }

  // returns the new index or -1 when the active cap is reached
  function spawn(k, x, y, dx, dy, ms, ci, sz, ex, delay) {
    if (n >= cap) return -1;
    const i = n++;
    kind[i] = k; px[i] = x; py[i] = y; vx[i] = dx; vy[i] = dy;
    t0[i] = now + (delay || 0); life[i] = ms > 1 ? ms : 1;
    colorIdx[i] = ci; size[i] = sz; extra[i] = ex;
    return i;
  }

  // ---------------------------------------------------------- emitters
  function sparks(x, y, color, count, ms) {
    const ci = colorIndex(color);
    const cnt = count > 0 ? count | 0 : 8, dur = ms > 0 ? ms : 300;
    for (let i = 0; i < cnt; i++) {
      const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 110;
      const l = dur * (0.8 + Math.random() * 0.4);
      // extra = drag coefficient (per second); size 1..1.5 px
      spawn(K_SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp, l, ci, 1 + (Math.random() < 0.4 ? 0.5 : 0), 3, 0);
    }
  }

  function motes(points, color, count, ms, ease) {
    const slot = allocPath(points, ease);
    if (slot < 0) return;
    const ci = colorIndex(color);
    const cnt = count > 0 ? count | 0 : 3, dur = ms > 0 ? ms : 600;
    const stagger = dur * 0.08;
    const base = slot * MAX_PTS;
    for (let i = 0; i < cnt; i++) {
      // vx carries a lateral offset (px) so motes do not stack; vy unused
      const lat = (Math.random() - 0.5) * 4;
      const idx = spawn(K_MOTE, pathX[base], pathY[base], lat, 0, dur, ci, 2, slot, i * stagger);
      if (idx < 0) break;
      pathRef[slot]++;
    }
  }

  function ring(x, y, r0, r1, color, ms) {
    spawn(K_RING, x, y, 0, 0, ms > 0 ? ms : 400, colorIndex(color), r0 > 0 ? r0 : 0, r1 > 0 ? r1 : r0 + 8, 0);
  }

  function exhaust(x, y, angle, color) {
    // two 1px particles drifting opposite the heading for 400ms.
    // Exhaust is the lowest-priority kind: it yields the last 1/8 of the
    // active cap so sparks, motes, rings and dots are never starved by traffic.
    if (n + 2 > cap - (cap >> 3)) return;
    const ci = colorIndex(color);
    const back = angle + Math.PI;
    for (let i = 0; i < 2; i++) {
      const a = back + (Math.random() - 0.5) * 0.5, sp = 30 + Math.random() * 40;
      spawn(K_EXHAUST, x + (Math.random() - 0.5) * 1.5, y + (Math.random() - 0.5) * 1.5,
        Math.cos(a) * sp, Math.sin(a) * sp, 400, ci, 1, 0, 0);
    }
  }

  function dot(x, y, color, ms) {
    spawn(K_DOT, x, y, 0, 0, ms > 0 ? ms : 500, colorIndex(color), 2, 0, 0);
  }

  // ---------------------------------------------------------- update
  function update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    now += dt * 1000;
    for (let i = n - 1; i >= 0; i--) {
      const age = now - t0[i];
      if (age >= life[i]) { removeAt(i); continue; }
      if (age < 0) continue;                       // staggered: not born yet
      const k = kind[i];
      if (k === K_SPARK) {
        const d = 1 - extra[i] * dt;               // linear drag per second
        vx[i] *= d > 0 ? d : 0; vy[i] *= d > 0 ? d : 0;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt;
      } else if (k === K_EXHAUST) {
        px[i] += vx[i] * dt; py[i] += vy[i] * dt;
      } else if (k === K_MOTE) {
        const slot = extra[i] | 0, cnt = pathN[slot], base = slot * MAX_PTS;
        let p = age / life[i];
        const ez = pathEase[slot];
        if (ez) p = ez(p);
        const d = p * pathTotal[slot];
        // find segment containing distance d
        let j = 1;
        while (j < cnt - 1 && pathCum[base + j] < d) j++;
        const c0 = pathCum[base + j - 1], c1 = pathCum[base + j];
        const seg = c1 - c0;
        const f = seg > 0 ? (d - c0) / seg : 1;
        const x0 = pathX[base + j - 1], y0 = pathY[base + j - 1];
        const x1 = pathX[base + j], y1 = pathY[base + j];
        let nx = 0, ny = 0;
        if (seg > 0) { nx = -(y1 - y0) / seg; ny = (x1 - x0) / seg; }
        const lat = vx[i] * Math.sin(p * Math.PI);  // lateral wobble, zero at both ends
        px[i] = x0 + (x1 - x0) * f + nx * lat;
        py[i] = y0 + (y1 - y0) * f + ny * lat;
      }
      // rings and dots are stationary
    }
  }

  // ---------------------------------------------------------- draw
  function draw(ctx) {
    if (n === 0) return;
    let last = -1;
    // pass 1: additive kinds (spark, mote, exhaust) as fillRect
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const k = kind[i];
      if (!ADDITIVE[k]) continue;
      const age = now - t0[i];
      if (age < 0) continue;
      const p = age / life[i];
      const ci = colorIdx[i];
      if (ci !== last) { ctx.fillStyle = palStr[ci]; last = ci; }
      let a;
      if (k === K_SPARK) a = (1 - p) * (1 - p) * 0.95 + 0.05;
      else if (k === K_EXHAUST) a = (1 - p) * 0.85;
      else a = p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1;      // mote: quick in/out
      ctx.globalAlpha = a * palA[ci];
      const s = size[i], h = s * 0.5;
      ctx.fillRect(px[i] - h, py[i] - h, s, s);
    }
    ctx.restore();
    // pass 2: normal kinds (ring as 1px arc, dot as fillRect)
    ctx.save();
    ctx.lineWidth = 1;
    last = -1;
    for (let i = 0; i < n; i++) {
      const k = kind[i];
      if (ADDITIVE[k]) continue;
      const age = now - t0[i];
      if (age < 0) continue;
      const p = age / life[i];
      const ci = colorIdx[i];
      if (k === K_RING) {
        if (ci !== last) { ctx.strokeStyle = palStr[ci]; ctx.fillStyle = palStr[ci]; last = ci; }
        const e = 1 - (1 - p) * (1 - p);                 // ease-out expansion
        const r = size[i] + (extra[i] - size[i]) * e;
        ctx.globalAlpha = (1 - p) * palA[ci];
        ctx.beginPath();
        ctx.arc(px[i], py[i], r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        if (ci !== last) { ctx.strokeStyle = palStr[ci]; ctx.fillStyle = palStr[ci]; last = ci; }
        ctx.globalAlpha = (1 - p) * palA[ci];
        const s = size[i], h = s * 0.5;
        ctx.fillRect(px[i] - h, py[i] - h, s, s);
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------- control
  function setTier(t) { tier = t === 1 ? 1 : t >= 2 ? 2 : 0; recomputeCap(); }
  function setReduced(b) { reduced = !!b; recomputeCap(); }
  function clear() { n = 0; pathRef.fill(0); }
  function count() { return n; }

  return {
    update, draw,
    sparks, motes, ring, exhaust, dot,
    setTier, setReduced, clear, count,
    get cap() { return cap; },
    get tier() { return tier; },
    get reduced() { return reduced; },
    MAX: N,
  };
})();

// ============================================================
// WAYSTATION v2 — engine/space.js (Engineer E)
// Sector-themed deep space (DESIGN2.md 3.3): far and mid star fields
// with parallax and twinkle, nebula clouds, the planet (baked band
// texture scrolling under a circular mask, terminator, atmosphere rim,
// rings, polar caps, storms, lava cracks), the Kessler asteroid belt,
// the Aurelia white dwarf, shipping lanes with light pulses, comets.
//
// Themes come from SECTORS[id].theme when data2.js supplies them and
// fall back to the local table below (same field names).
// Classic script: exports the global `EngineSpace`.
// ============================================================
'use strict';

const EngineSpace = (() => {
  const U = EngineUtil, ST = EngineStage, CAM = EngineCamera;
  const CELL = ST.CELL, TAU = U.TAU;

  // ---------------------------------------------------------------- themes (4.5 / 3.3)
  // planet.kind: temperate | dust | ocean | volcanic | gas | garden | dwarf | null (asteroids)
  // light: angle (rad) of the lit limb; pos: corner the planet favours at the fit framing.
  const THEMES = {
    home: {
      id: 'home', name: 'Varro Reach', nebula: ['#2C2454', '#124654', '#4A3048'], nebulaAlpha: 0.12, starTint: '#ECE8DE', lane: '#8FD3E8',
      planet: { kind: 'temperate', ramp: ['#5A3420', '#A8703E', '#D4A66A', '#F0E2C4'], caps: true, rim: '#F3E9D6', rimAlpha: 0.55, light: -2.35, size: 0.38, pos: 'ne', spin: 5 },
    },
    sable: {
      id: 'sable', name: 'Sable Drift', nebula: ['#4A2E18', '#2C2454', '#3A1E2A'], nebulaAlpha: 0.13, starTint: '#EAE0D0', lane: '#E9A23B',
      planet: { kind: 'dust', ramp: ['#4A2410', '#9A5E28', '#CC9450', '#E8C38A'], storms: true, rim: '#E9A23B', rimAlpha: 0.5, light: -2.0, size: 0.4, pos: 'nw', spin: 7 },
    },
    kessler: {
      id: 'kessler', name: 'Kessler Belt', nebula: ['#1C2436', '#2A2E48', '#123A44'], nebulaAlpha: 0.1, starTint: '#E0E6EE', lane: '#8FD3E8',
      planet: null, asteroids: true,
    },
    thessaly: {
      id: 'thessaly', name: 'Thessaly Deep', nebula: ['#0E2A5A', '#124654', '#2C2454'], nebulaAlpha: 0.13, starTint: '#DDE8F2', lane: '#8FD3E8',
      planet: { kind: 'ocean', ramp: ['#071E44', '#133E7A', '#2572B8', '#5CB0E4'], swirls: true, rim: '#BFE8F4', rimAlpha: 0.6, light: -2.4, size: 0.4, pos: 'ne', spin: 6 },
    },
    marrow: {
      id: 'marrow', name: 'Marrow Verge', nebula: ['#4A1414', '#2C1424', '#3A2010'], nebulaAlpha: 0.12, starTint: '#F0DCD0', lane: '#FF8F3D',
      planet: { kind: 'volcanic', ramp: ['#060202', '#1C0806', '#361410', '#4C1E16'], cracks: true, rim: '#FF8F3D', rimAlpha: 0.45, light: -2.2, size: 0.36, pos: 'nw', spin: 4 },
    },
    oros: {
      id: 'oros', name: 'Oros Halo', nebula: ['#3A2A14', '#2C2454', '#4A3A20'], nebulaAlpha: 0.11, starTint: '#F0E8D8', lane: '#FFE28A',
      planet: { kind: 'gas', ramp: ['#8A5A2A', '#C89A5A', '#E8C890', '#F6E6C8'], rings: true, rim: '#FFE28A', rimAlpha: 0.5, light: -2.3, size: 0.42, pos: 'e', spin: 10 },
    },
    keth: {
      id: 'keth', name: 'Keth Meridian', nebula: ['#124634', '#1E3A5A', '#2C2454'], nebulaAlpha: 0.12, starTint: '#E4EEE4', lane: '#A8C8A0',
      planet: { kind: 'garden', ramp: ['#133C66', '#2E6A4A', '#4E9A66', '#B8D8A8'], clouds: true, rim: '#BFE8F4', rimAlpha: 0.6, light: -2.4, size: 0.4, pos: 'ne', spin: 5 },
    },
    aurelia: {
      id: 'aurelia', name: 'Aurelia Gate', nebula: ['#4A1A7A', '#7A2AAA', '#2A1A5A'], nebulaAlpha: 0.17, starTint: '#EEE4FF', lane: '#C084FF',
      planet: { kind: 'dwarf', core: '#FFFFFF', halo: '#C084FF', rim: '#DDB8FF', size: 0.12, pos: 'nw' },
    },
  };

  const S = {
    theme: THEMES.home, seed: 1,
    far: null, mid: null,                 // containers (ST.layers.space.*.moving)
    twinkle: [], nebula: [],
    planet: null,                         // { root, bands, mask, shade, rim, rings, r, spin }
    asteroids: [],
    comet: null, cometNext: 0,
    lanes: [], pulses: [],
  };

  // ---------------------------------------------------------------- theme lookup
  function themeFor(sectorDef) {
    let def = sectorDef;
    if (typeof def === 'string') {
      def = null;
      if (typeof SECTORS !== 'undefined' && SECTORS) {
        def = Array.isArray(SECTORS) ? SECTORS.find(s => s && s.id === sectorDef) : SECTORS[sectorDef];
      }
      if (!def) def = { id: sectorDef };
    }
    const id = (def && def.id) || 'home';
    const local = THEMES[id] || THEMES.home;
    const dt = def && def.theme;
    if (!dt) return Object.assign({}, local, { id });
    // data2.js shape: { planet: { kind, color, rim, caps, storms, swirls, cracks, rings, oceans, none, asteroids },
    //                  nebula: [hues], stars: { count, tint }, light: { angle } }
    const t = Object.assign({}, local, { id });
    if (Array.isArray(dt.nebula) && dt.nebula.length) t.nebula = dt.nebula.slice(0, 3);
    if (dt.stars) { if (dt.stars.tint) t.starTint = dt.stars.tint; if (dt.stars.count) t.starCount = dt.stars.count; }
    if (dt.lane) t.lane = dt.lane;
    const dp = dt.planet;
    if (dp === null || (dp && (dp.none || dp.kind === 'none'))) {
      t.planet = null; t.asteroids = true;
      if (dp && dp.asteroids) t.asteroidCount = dp.asteroids;
      return t;
    }
    if (!dp) return t;
    const KIND = { terrestrial: 'temperate', temperate: 'temperate', dust: 'dust', ocean: 'ocean', volcanic: 'volcanic', gas: 'gas', garden: 'garden', dwarf: 'dwarf' };
    const kind = KIND[dp.kind] || (local.planet && local.planet.kind) || 'temperate';
    const base = local.planet && local.planet.kind === kind ? local.planet : (Object.values(THEMES).map(x => x.planet).find(p => p && p.kind === kind) || THEMES.home.planet);
    const P = Object.assign({}, base, { kind });
    if (dp.color) {
      if (kind === 'dwarf') P.core = dp.color;
      else if (kind === 'garden') P.ramp = [U.mix(dp.oceans || '#2A5FA0', '#000000', 0.45), dp.oceans || '#2A5FA0', dp.color, U.mix(dp.color, '#FFFFFF', 0.5)];
      else if (kind === 'volcanic') P.ramp = [U.mix(dp.color, '#000000', 0.75), U.mix(dp.color, '#000000', 0.4), dp.color, U.mix(dp.color, '#FFFFFF', 0.12)];
      else P.ramp = [U.mix(dp.color, '#000000', 0.6), U.mix(dp.color, '#000000', 0.25), dp.color, U.mix(dp.color, '#FFFFFF', 0.45)];
    }
    if (dp.rim) { P.rim = dp.rim; if (kind === 'dwarf') P.halo = dp.rim; }
    for (const k of ['caps', 'storms', 'swirls', 'cracks', 'rings', 'clouds']) if (dp[k] != null) P[k] = !!dp[k];
    if (kind === 'garden' && dp.caps != null) P.clouds = true;
    if (dt.light && typeof dt.light.angle === 'number') P.light = dt.light.angle;
    t.planet = P;
    return t;
  }

  // ---------------------------------------------------------------- textures
  function starTexture(size) {
    const r = size;
    return ST.bake('star|' + size, r * 2 + 2, r * 2 + 2, g => {
      const c = r + 1;
      const gr = g.createRadialGradient(c, c, 0, c, c, r);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, r * 2 + 2, r * 2 + 2);
      if (r >= 4) {
        // faint cross flare on the brightest stars
        g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(c - r, c); g.lineTo(c + r, c); g.moveTo(c, c - r); g.lineTo(c, c + r); g.stroke();
      }
    }).texture;
  }

  // Cloud texture: fbm density shaped into soft structure, two theme hues mixed by a second noise.
  function cloudTexture(theme, seed) {
    const key = 'cloud|' + theme.id + '|' + seed;
    const N = 320;
    return ST.bake(key, N, N, g => {
      const img = g.createImageData(N, N), d = img.data;
      // theme hues are deep (they are meant for glass and space); lift them so additive clouds read on black
      const lift = h => U.parse(U.mix(h, '#FFFFFF', 0.22));
      const c0 = lift(theme.nebula[0]), c1 = lift(theme.nebula[1] || theme.nebula[0]), c2 = lift(theme.nebula[2] || theme.nebula[0]);
      const rr = U.rng(seed), ox = rr() * 100, oy = rr() * 100;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const nx = x / N, ny = y / N;
        const n1 = U.fbm(nx * 3.1 + ox, ny * 3.1 + oy, seed, 5);
        const n2 = U.fbm(nx * 1.9 + ox + 40, ny * 1.9 + oy + 20, seed + 91, 3);
        const dx = nx - 0.5, dy = ny - 0.5, falloff = Math.max(0, 1 - Math.hypot(dx, dy) * 2.1);
        const dens = Math.pow(Math.max(0, (n1 - 0.38) / 0.62), 1.7) * falloff;
        const k = U.smooth(U.clamp((n2 - 0.35) / 0.3, 0, 1));
        const k2 = U.smooth(U.clamp((n1 - 0.6) / 0.3, 0, 1));
        let r = U.lerp(c0[0], c1[0], k), gg = U.lerp(c0[1], c1[1], k), b = U.lerp(c0[2], c1[2], k);
        r = U.lerp(r, c2[0], k2 * 0.5); gg = U.lerp(gg, c2[1], k2 * 0.5); b = U.lerp(b, c2[2], k2 * 0.5);
        // brighten the densest filaments so the cloud has depth
        const bright = 1 + dens * 1.3;
        const i = (y * N + x) * 4;
        d[i] = Math.min(255, r * bright); d[i + 1] = Math.min(255, gg * bright); d[i + 2] = Math.min(255, b * bright); d[i + 3] = Math.min(255, dens * 330);
      }
      g.putImageData(img, 0, 0);
    }).texture;
  }

  // Elongated streak (for lane pulses and comet tails): bright at x=0 fading to the right.
  function streakTexture(len, thick, color) {
    return ST.bake('streak|' + len + '|' + thick + '|' + color, len, thick, g => {
      const gr = g.createLinearGradient(0, 0, len, 0);
      gr.addColorStop(0, U.rgba(color, 1)); gr.addColorStop(0.25, U.rgba(color, 0.55)); gr.addColorStop(1, U.rgba(color, 0));
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(len / 2, thick / 2, len / 2, thick / 2, 0, 0, TAU); g.fill();
      // hot core
      const gr2 = g.createLinearGradient(0, 0, len * 0.5, 0);
      gr2.addColorStop(0, 'rgba(255,255,255,.9)'); gr2.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr2;
      g.beginPath(); g.ellipse(len * 0.2, thick / 2, len * 0.2, thick * 0.22, 0, 0, TAU); g.fill();
    }).texture;
  }

  // ---------------------------------------------------------------- planet bake
  // 512x256 band texture, seamless in x. Each kind paints its own surface.
  function bandTexture(theme, seed) {
    const P = theme.planet, key = 'planet|' + theme.id + '|' + seed;
    const W = 512, H = 256, PER = 6;      // noise period across the width (lattice units)
    return ST.bake(key, W, H, g => {
      const img = g.createImageData(W, H), d = img.data;
      const ramp = P.ramp.map(U.parse);
      const rampAt = v => {
        v = 0.5 + (v - 0.5) * 1.7;                        // contrast: fbm sits around .5, spread it over the ramp
        v = U.clamp(v, 0, 0.9999) * (ramp.length - 1);
        const i = Math.floor(v), f = v - i, a = ramp[i], b = ramp[Math.min(ramp.length - 1, i + 1)];
        return [U.lerp(a[0], b[0], f), U.lerp(a[1], b[1], f), U.lerp(a[2], b[2], f)];
      };
      const sx = PER / W;
      for (let y = 0; y < H; y++) {
        const ny = y / H, lat = Math.abs(ny - 0.5) * 2;      // 0 equator .. 1 pole
        for (let x = 0; x < W; x++) {
          const nx = x * sx, nyl = ny * (PER / 2);
          let col;
          const n = U.fbmWrap(nx, nyl, seed, 5, PER);
          const n2 = U.fbmWrap(nx * 2.3 + 7, nyl * 2.3 + 3, seed + 31, 3, PER * 2.3);
          if (P.kind === 'temperate') {
            col = rampAt(n * 1.1 - 0.05 + (n2 - 0.5) * 0.25);
          } else if (P.kind === 'dust') {
            const band = 0.5 + 0.5 * Math.sin(ny * 26 + (n - 0.5) * 6);
            col = rampAt(0.25 + band * 0.45 + (n - 0.5) * 0.5);
          } else if (P.kind === 'ocean') {
            const land = n > 0.74;
            col = land ? [U.lerp(140, 190, n2), U.lerp(120, 160, n2), 90] : rampAt((n - 0.15) * 1.2 + (n2 - 0.5) * 0.2);
          } else if (P.kind === 'volcanic') {
            col = rampAt(n * 0.9 + (n2 - 0.5) * 0.2);
            const ridge = 1 - Math.abs(2 * U.fbmWrap(nx * 1.6 + 3, nyl * 1.6 + 9, seed + 77, 4, PER * 1.6) - 1);
            if (ridge > 0.86) {
              const k = Math.pow((ridge - 0.86) / 0.14, 1.4);
              col = [U.lerp(col[0], 255, k), U.lerp(col[1], 120, k * 0.9), U.lerp(col[2], 40, k * 0.9)];
            }
          } else if (P.kind === 'gas') {
            const yy = ny + (n - 0.5) * 0.06 + (n2 - 0.5) * 0.02;
            const band = 0.5 + 0.5 * Math.sin(yy * 42) * 0.7 + 0.3 * Math.sin(yy * 97 + 1.3);
            col = rampAt(0.15 + band * 0.7 + (n2 - 0.5) * 0.15);
          } else if (P.kind === 'garden') {
            const land = n > 0.54;
            col = land ? rampAt(0.35 + (n - 0.54) * 1.6 + (n2 - 0.5) * 0.2) : rampAt((n - 0.1) * 0.6);
          } else col = rampAt(n);
          // polar caps with a noisy edge
          if (P.caps) { const edge = 0.74 + (n2 - 0.5) * 0.1; if (lat > edge) { const k = U.clamp((lat - edge) / 0.08, 0, 1); col = [U.lerp(col[0], 240, k), U.lerp(col[1], 236, k), U.lerp(col[2], 228, k)]; } }
          const i = (y * W + x) * 4;
          d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      // overlays: clouds / swirls / storms as soft strokes so they read as weather over the surface
      if (P.clouds || P.swirls) {
        const rr = U.rng(seed + 5);
        g.globalCompositeOperation = 'source-over';
        for (let i = 0; i < 70; i++) {
          const x = rr() * W, y = H * (0.12 + rr() * 0.76), len = 30 + rr() * 110, th = 2 + rr() * 5;
          g.strokeStyle = `rgba(255,255,255,${(0.18 + rr() * 0.32).toFixed(2)})`; g.lineWidth = th; g.lineCap = 'round';
          g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + len * 0.3, y - th * 1.5, x + len * 0.6, y + th * 1.5, x + len, y);
          g.stroke();
          if (x + len > W) { g.beginPath(); g.moveTo(x - W, y); g.bezierCurveTo(x - W + len * 0.3, y - th * 1.5, x - W + len * 0.6, y + th * 1.5, x - W + len, y); g.stroke(); }
        }
      }
      if (P.storms) {
        const rr = U.rng(seed + 9);
        for (let i = 0; i < 5; i++) {
          const x = rr() * W, y = H * (0.25 + rr() * 0.5), R = 14 + rr() * 22;
          for (let k = 0; k < 3; k++) {
            g.strokeStyle = k % 2 ? 'rgba(255,230,190,.35)' : 'rgba(60,30,10,.4)'; g.lineWidth = 2.5;
            g.beginPath();
            for (let a = 0; a < TAU * 2.2; a += 0.15) { const rad = R * (0.2 + a / (TAU * 2.2) * 0.8) + k * 3; const px = x + Math.cos(a) * rad * 1.6, py = y + Math.sin(a) * rad * 0.7; if (a === 0) g.moveTo(px, py); else g.lineTo(px, py); }
            g.stroke();
          }
        }
      }
      if (P.kind === 'gas') {
        // great storm oval
        g.fillStyle = 'rgba(120,60,30,.45)'; g.beginPath(); g.ellipse(W * 0.62, H * 0.6, 46, 16, 0, 0, TAU); g.fill();
        g.strokeStyle = 'rgba(255,230,190,.35)'; g.lineWidth = 3; g.beginPath(); g.ellipse(W * 0.62, H * 0.6, 40, 12, 0, 0, TAU); g.stroke();
      }
    }).texture;
  }

  // Terminator / limb shading: a disc whose darkness grows away from the lit limb (bake-time gradient).
  function shadeTexture(light, id) {
    const N = 256, c = N / 2, r = N / 2;
    return ST.bake('pshade|' + id + '|' + light.toFixed(2), N, N, g => {
      const lx = c + Math.cos(light) * r * 0.55, ly = c + Math.sin(light) * r * 0.55;
      const gr = g.createRadialGradient(lx, ly, r * 0.15, lx, ly, r * 1.75);
      gr.addColorStop(0, 'rgba(255,255,255,.14)'); gr.addColorStop(0.3, 'rgba(3,4,10,0)'); gr.addColorStop(0.58, 'rgba(3,4,10,.5)'); gr.addColorStop(0.8, 'rgba(3,4,10,.9)'); gr.addColorStop(1, 'rgba(3,4,10,.97)');
      g.fillStyle = gr; g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill();
      // limb darkening all round
      const lg = g.createRadialGradient(c, c, r * 0.8, c, c, r);
      lg.addColorStop(0, 'rgba(3,4,10,0)'); lg.addColorStop(1, 'rgba(3,4,10,.45)');
      g.fillStyle = lg; g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill();
    }).texture;
  }

  // Ring system (gas giant): tilted ellipse bands, back half cleared where the disc occludes it.
  function ringTexture(id, color) {
    const W = 1024, H = 420, cx = W / 2, cy = H / 2, R = W / 2 - 4, tilt = 0.26;
    return ST.bake('prings|' + id, W, H, g => {
      const bands = [[0.56, 0.62, 0.35], [0.63, 0.74, 0.7], [0.75, 0.78, 0.25], [0.8, 0.95, 0.55], [0.96, 1.0, 0.2]];
      g.save(); g.translate(cx, cy);
      for (const [a, b, al] of bands) {
        g.beginPath();
        g.ellipse(0, 0, R * b, R * b * tilt, 0, 0, TAU);
        g.ellipse(0, 0, R * a, R * a * tilt, 0, 0, TAU, true);
        g.fillStyle = U.rgba(color, al); g.fill('evenodd');
      }
      // fine grooves
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1.2;
      for (let i = 0; i < 14; i++) { const k = 0.58 + i * 0.03; g.beginPath(); g.ellipse(0, 0, R * k, R * k * tilt, 0, 0, TAU); g.stroke(); }
      g.restore();
      // the planet disc occludes the far half (above the centre line): clear a disc there
      const pr = R * 0.5;
      g.save(); g.globalCompositeOperation = 'destination-out';
      g.beginPath(); g.rect(0, 0, W, cy); g.clip();
      g.beginPath(); g.arc(cx, cy, pr, 0, TAU); g.fill();
      g.restore();
      // the planet's shadow on the near rings (right of the disc, soft)
      g.save(); g.globalCompositeOperation = 'destination-out';
      const sg = g.createRadialGradient(cx + pr * 0.9, cy + pr * 0.3, pr * 0.2, cx + pr * 0.9, cy + pr * 0.3, pr * 1.1);
      sg.addColorStop(0, 'rgba(0,0,0,.8)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sg; g.beginPath(); g.rect(cx, cy, W / 2, cy); g.fill();
      g.restore();
    }).texture;
  }

  function rockTexture(i) {
    return ST.bake('rock|' + i, 48, 48, g => {
      const rr = U.rng(1000 + i), n = 7 + Math.floor(rr() * 4), pts = [];
      for (let k = 0; k < n; k++) { const a = k / n * TAU, rad = 14 + rr() * 8; pts.push([24 + Math.cos(a) * rad, 24 + Math.sin(a) * rad]); }
      g.beginPath(); pts.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
      const gr = g.createLinearGradient(8, 8, 40, 40);
      gr.addColorStop(0, '#9AA0AA'); gr.addColorStop(0.5, '#5E646E'); gr.addColorStop(1, '#2A2E36');
      g.fillStyle = gr; g.fill();
      g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1; g.stroke();
      g.fillStyle = 'rgba(0,0,0,.35)';
      for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(16 + rr() * 16, 16 + rr() * 16, 1.5 + rr() * 2.5, 0, TAU); g.fill(); }
    }).texture;
  }

  // ---------------------------------------------------------------- build
  function clear(container) {
    for (const ch of container.removeChildren()) { try { ch.destroy({ children: true }); } catch (e) { /* already destroyed */ } }
  }

  function build(theme) {
    S.theme = theme;
    S.seed = U.registryNumber(theme.id) >>> 0;
    const L = ST.layers;
    S.far = L.space.far.moving; S.mid = L.space.mid.moving;
    if (!S.laneRoot) { S.laneRoot = new PIXI.Container(); S.laneRoot.eventMode = 'none'; L.lanes.addChildAt(S.laneRoot, 0); }
    clear(S.far); clear(S.mid); clear(S.laneRoot);
    S.twinkle = []; S.nebula = []; S.asteroids = []; S.planet = null; S.comet = null; S.lanes = [];
    for (const p of S.pulses) p.sprite.destroy();
    S.pulses = [];
    S.cometNext = ST.time + 70 + Math.random() * 70;

    // containers in draw order
    S.nebulaRoot = new PIXI.Container(); S.farStarRoot = new PIXI.Container();
    S.far.addChild(S.nebulaRoot, S.farStarRoot);
    S.midStarRoot = new PIXI.Container(); S.planetRoot = new PIXI.Container(); S.beltRoot = new PIXI.Container(); S.cometRoot = new PIXI.Container();
    S.mid.addChild(S.midStarRoot, S.planetRoot, S.beltRoot, S.cometRoot);
    for (const c of [S.nebulaRoot, S.farStarRoot, S.midStarRoot, S.planetRoot, S.beltRoot, S.cometRoot]) c.eventMode = 'none';

    buildNebula(theme);
    buildStars(theme);
    if (theme.planet) buildPlanet(theme);
    if (theme.asteroids) buildBelt(theme);
    layout();
  }

  // Field rectangle in layer coordinates that stays covered for every camera inside the bounds.
  function fieldRect(k) {
    const t = CAM.fitTarget();
    const zk = 1 + (t.zoom - 1) * k;
    const ox = ST.w / 2 - t.x * k * zk, oy = ST.h / 2 - t.y * k * zk;
    const x0 = (0 - ox) / zk, y0 = (0 - oy) / zk, x1 = (ST.w - ox) / zk, y1 = (ST.h - oy) / zk;
    const mx = ST.w * 0.9 + 300, my = ST.h * 0.9 + 300;
    return { x0: x0 - mx, y0: y0 - my, x1: x1 + mx, y1: y1 + my, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zk, ox, oy };
  }

  function buildStars(theme) {
    const rr = U.rng(S.seed ^ 0x9E3779B9);
    const tint = U.int(theme.starTint || '#ECE8DE');
    const texS = starTexture(2), texM = starTexture(3), texL = starTexture(5);
    const F = fieldRect(0.08), M = fieldRect(0.25);
    const area = (F.x1 - F.x0) * (F.y1 - F.y0);
    const nFar = Math.round(U.clamp(area / (1440 * 900 * 4.2) * (theme.starCount || 1400), 900, 2800));
    for (let i = 0; i < nFar; i++) {
      const u = rr();
      const tex = u < 0.72 ? texS : u < 0.95 ? texM : texL;
      const sp = ST.sprite(tex);
      sp.position.set(F.x0 + rr() * (F.x1 - F.x0), F.y0 + rr() * (F.y1 - F.y0));
      sp.alpha = 0.3 + rr() * 0.6;
      const s = (u < 0.72 ? 0.55 : u < 0.95 ? 0.75 : 1) * (0.8 + rr() * 0.5);
      sp.scale.set(s);
      // a little colour variety: 10% blue-white, 8% amber
      const cv = rr();
      sp.tint = cv < 0.1 ? 0xBFD8FF : cv < 0.18 ? 0xFFD9A8 : tint;
      S.farStarRoot.addChild(sp);
      if (rr() < 0.02) S.twinkle.push({ sp, base: sp.alpha, w: TAU * (0.2 + rr() * 0.8), ph: rr() * TAU });
    }
    const nMid = Math.round(U.clamp(area / (1440 * 900 * 4.2) * 300, 200, 600));
    for (let i = 0; i < nMid; i++) {
      const u = rr();
      const sp = ST.sprite(u < 0.6 ? texM : texL);
      sp.position.set(M.x0 + rr() * (M.x1 - M.x0), M.y0 + rr() * (M.y1 - M.y0));
      sp.alpha = 0.45 + rr() * 0.5;
      sp.scale.set((u < 0.6 ? 0.8 : 1.05) * (0.85 + rr() * 0.4));
      sp.tint = rr() < 0.12 ? 0xBFD8FF : tint;
      S.midStarRoot.addChild(sp);
      if (rr() < 0.04) S.twinkle.push({ sp, base: sp.alpha, w: TAU * (0.3 + rr() * 0.7), ph: rr() * TAU });
    }
  }

  function buildNebula(theme) {
    const rr = U.rng(S.seed ^ 0x51A7F00D);
    const F = fieldRect(0.08);
    const span = Math.max(ST.w, ST.h);
    // 1. two structured clouds, big and slow, centred away from the station so hull contrast holds
    const a0 = rr() * TAU;
    const cloud = ST.sprite(cloudTexture(theme, S.seed), { blend: 'add' });
    cloud.position.set(F.cx + Math.cos(a0) * span * 0.45, F.cy + Math.sin(a0) * span * 0.35);
    const cs = span * 2.4 / 320;
    cloud.scale.set(cs * (0.9 + rr() * 0.3), cs * (0.7 + rr() * 0.3));
    cloud.rotation = rr() * TAU;
    cloud.alpha = Math.min(1, (theme.nebulaAlpha || 0.12) * 8);
    S.nebulaRoot.addChild(cloud);
    S.nebula.push({ sp: cloud, w: 0.0025 });
    const cloud2 = ST.sprite(cloudTexture(theme, S.seed + 17), { blend: 'add' });
    cloud2.position.set(F.cx - Math.cos(a0 + 0.9) * span * 0.55, F.cy - Math.sin(a0 + 0.9) * span * 0.45);
    cloud2.scale.set(cs * 0.85, cs * 0.6); cloud2.rotation = rr() * TAU; cloud2.alpha = cloud.alpha * 0.75;
    S.nebulaRoot.addChild(cloud2);
    S.nebula.push({ sp: cloud2, w: -0.0018 });
    // 2. 6–9 soft radial blobs in lifted theme hues (elliptical so their rotation reads)
    const n = 6 + Math.floor(rr() * 4);
    for (let i = 0; i < n; i++) {
      const hue = U.mix(theme.nebula[i % theme.nebula.length], '#FFFFFF', 0.3);
      const sp = ST.sprite(ST.glowTexture(hue, 128), { blend: 'add' });
      const size = 600 + rr() * 800;
      const ang = rr() * TAU, dist = span * (0.25 + rr() * 0.55);
      sp.position.set(F.cx + Math.cos(ang) * dist, F.cy + Math.sin(ang) * dist * 0.8);
      sp.scale.set(size / 256, size / 256 * (0.55 + rr() * 0.45));
      sp.rotation = rr() * TAU;
      sp.alpha = 0.08 + rr() * 0.1;
      S.nebulaRoot.addChild(sp);
      S.nebula.push({ sp, w: (rr() < 0.5 ? 1 : -1) * 0.004 });
    }
  }

  function buildPlanet(theme) {
    const P = theme.planet;
    const root = new PIXI.Container(); root.eventMode = 'none';
    const rec = { root, r: 100, spin: P.spin || 5, kind: P.kind, bands: null, mask: null, shade: null, rim: null, rings: null, halo: null, core: null };
    if (P.kind === 'dwarf') {
      // white dwarf: a crisp hot disc inside a corona, violet halo far out
      rec.halo = ST.sprite(ST.glowTexture(P.halo, 128), { blend: 'add', alpha: 0.75 });
      rec.halo2 = ST.sprite(ST.glowTexture(P.rim, 128), { blend: 'add', alpha: 0.6 });
      rec.core = ST.sprite(ST.glowTexture(P.core, 64, 'core'), { blend: 'add', alpha: 1 });
      rec.disc = ST.sprite(ST.glowTexture(P.core, 64, 'hard'), { blend: 'add', alpha: 1 });
      root.addChild(rec.halo, rec.halo2, rec.core, rec.disc);
    } else {
      // atmosphere glow behind the disc (only the halo outside the disc shows), plus a wider soft haze
      rec.rim = ST.sprite(ST.glowTexture(P.rim, 128, 'hard'), { blend: 'add', alpha: P.rimAlpha != null ? P.rimAlpha : 0.5 });
      rec.haze = ST.sprite(ST.glowTexture(P.rim, 128, 'soft'), { blend: 'add', alpha: 0.22 });
      const base = new PIXI.Graphics().circle(0, 0, 100).fill(U.int(P.ramp[1]));
      base.eventMode = 'none';
      const mask = new PIXI.Graphics().circle(0, 0, 100).fill(0xffffff);
      const bands = new PIXI.TilingSprite({ texture: bandTexture(theme, S.seed), width: 200, height: 200 });
      bands.anchor.set(0.5); bands.eventMode = 'none';
      bands.mask = mask;
      rec.shade = ST.sprite(shadeTexture(P.light, theme.id));
      // thin bright rim along the lit limb
      const limb = new PIXI.Graphics();
      const a0 = P.light - 1.5, a1 = P.light - 1.0;   // moveTo first: a v8 arc with no current point draws a line from the origin
      limb.moveTo(99 * Math.cos(a0), 99 * Math.sin(a0)).arc(0, 0, 99, a0, P.light + 1.5).stroke({ width: 2.2, color: U.int(P.rim), alpha: 0.5 });
      limb.moveTo(97.5 * Math.cos(a1), 97.5 * Math.sin(a1)).arc(0, 0, 97.5, a1, P.light + 1.0).stroke({ width: 3, color: U.int(P.rim), alpha: 0.18 });
      limb.eventMode = 'none';
      root.addChild(rec.haze, rec.rim, base, bands, mask, rec.shade, limb);
      rec.bands = bands; rec.mask = mask; rec.base = base; rec.limb = limb;
      if (P.rings) {
        rec.rings = ST.sprite(ringTexture(theme.id, P.rim));
        rec.rings.alpha = 0.9;
        root.addChild(rec.rings);
      }
    }
    S.planetRoot.addChild(root);
    S.planet = rec;
  }

  function sizePlanet(r) {
    const p = S.planet; if (!p) return;
    p.r = r;
    if (p.kind === 'dwarf') {
      p.core.scale.set(r * 2.6 / 128); p.disc.scale.set(r * 0.9 / 128);
      p.halo.scale.set(r * 9 / 256); p.halo2.scale.set(r * 4.5 / 256);
      return;
    }
    const k = r / 100;
    p.base.scale.set(k); p.mask.scale.set(k); p.shade.scale.set(r * 2 / 256); p.limb.scale.set(k);
    p.rim.scale.set(r * 2 * 1.13 / 256);
    p.haze.scale.set(r * 2 * 1.6 / 256);
    p.bands.width = r * 2; p.bands.height = r * 2;
    p.bands.tileScale.set(r * 2 / 256);       // texture height (256) spans the disc; width wraps every two disc widths
    if (p.rings) { p.rings.scale.set(r * 4 / 1024); p.rings.rotation = -0.18; }
  }

  function buildBelt(theme) {
    const rr = U.rng(S.seed ^ 0xA57E);
    const M = fieldRect(0.25);
    // two diagonal belts through the field, either side of the station (clear of the inflated box)
    const cx = M.cx, cy = M.cy, span = Math.max(ST.w, ST.h), h = ST.h;
    const dir = -0.35, nx = -Math.sin(dir), ny = Math.cos(dir);
    const count = theme.asteroidCount || 120;
    for (let i = 0; i < count; i++) {
      const along = (rr() - 0.5) * span * 2.0;
      const side = rr() < 0.5 ? -1 : 1;
      const off = side * (h * 0.36 + rr() * h * 0.3);
      const sp = ST.sprite(rockTexture(i % 6));
      sp.position.set(cx + Math.cos(dir) * along + nx * off, cy + Math.sin(dir) * along + ny * off);
      const sc = 0.25 + Math.pow(rr(), 2) * 1.4;
      sp.scale.set(sc); sp.rotation = rr() * TAU; sp.alpha = 0.55 + rr() * 0.45;
      sp.tint = rr() < 0.3 ? 0xB8A890 : 0xffffff;
      S.beltRoot.addChild(sp);
      S.asteroids.push({ sp, vx: (rr() - 0.5) * 6, vy: (rr() - 0.5) * 3, vr: (rr() - 0.5) * 0.25, x0: sp.x, y0: sp.y, span: span * 1.3 });
    }
  }

  // ---------------------------------------------------------------- layout: planet placement, lanes
  // Place the planet in the mid layer so that, at the fit framing, it sits in the theme's corner
  // and never overlaps the station box inflated by 0.75 cell (shrinks, then slides away).
  function layout() {
    if (S.planet) {
      const P = S.theme.planet, M = fieldRect(0.25);
      const W = ST.w, H = ST.h;
      let R = (P.size || 0.38) * H;
      const floor = (P.kind === 'dwarf' ? 0.08 : 0.16) * H;
      const pos = P.pos || 'ne';
      const corner = () => {
        if (pos === 'nw') return { x: 0.46 * R, y: 0.46 * R };
        if (pos === 'e') return { x: W - 0.55 * R, y: H * 0.5 };
        return { x: W - 0.46 * R, y: 0.46 * R };
      };
      // station box in screen px at the fit framing
      const st = CAM.station || CAM.gridBox;
      const t = CAM.fitTarget();
      const box = st ? {
        x0: W / 2 + (st.x0 - 0.75 * CELL - t.x) * t.zoom, y0: H / 2 + (st.y0 - 0.75 * CELL - t.y) * t.zoom,
        x1: W / 2 + (st.x1 + 0.75 * CELL - t.x) * t.zoom, y1: H / 2 + (st.y1 + 0.75 * CELL - t.y) * t.zoom,
      } : null;
      const overlap = (c, r) => {
        if (!box) return 0;
        const qx = U.clamp(c.x, box.x0, box.x1), qy = U.clamp(c.y, box.y0, box.y1);
        const inside = c.x >= box.x0 && c.x <= box.x1 && c.y >= box.y0 && c.y <= box.y1;
        const rr = P.rings ? r * 2 : r * 1.12;
        return inside ? rr + 1 : rr - Math.hypot(c.x - qx, c.y - qy);
      };
      let c = corner();
      while (overlap(c, R) > 0 && R * 0.96 >= floor) { R *= 0.96; c = corner(); }
      let guard = 0;
      while (overlap(c, R) > 0 && guard++ < 200) { c.y -= 4; if (pos === 'nw') c.x -= 2; else c.x += 2; }
      // screen -> mid-layer coordinates at the fit camera
      S.planet.root.position.set((c.x - M.ox) / M.zk, (c.y - M.oy) / M.zk);
      sizePlanet(R / M.zk);
    }
    buildLanes();
  }

  function buildLanes() {
    const L = S.laneRoot;
    clear(L);
    for (const p of S.pulses) p.sprite.destroy();
    S.pulses = []; S.lanes = [];
    const st = CAM.station; if (!st) return;
    const rr = U.rng(S.seed ^ 0x1A4E5);
    const hx = (st.x0 + st.x1) / 2, hy = (st.y0 + st.y1) / 2;
    const n = 3 + Math.floor(rr() * 3);
    const color = S.theme.lane || '#8FD3E8';
    const g = new PIXI.Graphics(); g.eventMode = 'none';
    const far = 16 * CELL;
    for (let i = 0; i < n; i++) {
      const a = rr() * TAU;
      const sx = hx + Math.cos(a) * far * (1 + rr() * 0.4), sy = hy + Math.sin(a) * far * 0.7 * (1 + rr() * 0.4);
      // end on the inflated station box boundary along the ray toward the centre
      const dx = hx - sx, dy = hy - sy, len = Math.hypot(dx, dy) || 1;
      const bx0 = st.x0 - CELL * 0.9, by0 = st.y0 - CELL * 0.9, bx1 = st.x1 + CELL * 0.9, by1 = st.y1 + CELL * 0.9;
      let tHit = 1;
      for (let k = 0; k <= 200; k++) { const tt = k / 200, px = sx + dx * tt, py = sy + dy * tt; if (px >= bx0 && px <= bx1 && py >= by0 && py <= by1) { tHit = tt; break; } }
      const ex = sx + dx * tHit, ey = sy + dy * tHit;
      const perp = (rr() - 0.5) * len * 0.5;
      const cx = (sx + ex) / 2 - dy / len * perp, cy = (sy + ey) / 2 + dx / len * perp;
      const lane = { sx, sy, cx, cy, ex, ey, next: ST.time + 1 + rr() * 6 };
      S.lanes.push(lane);
      g.moveTo(sx, sy).quadraticCurveTo(cx, cy, ex, ey).stroke({ width: 1.5, color: U.int(color), alpha: 0.085 });
      g.moveTo(sx, sy).quadraticCurveTo(cx, cy, ex, ey).stroke({ width: 5, color: U.int(color), alpha: 0.025 });
    }
    L.addChild(g);
  }
  function lanePoint(l, t) {
    const mt = 1 - t;
    return { x: mt * mt * l.sx + 2 * mt * t * l.cx + t * t * l.ex, y: mt * mt * l.sy + 2 * mt * t * l.cy + t * t * l.ey };
  }

  // ---------------------------------------------------------------- comets
  function spawnComet() {
    // a chord through a random point in the central 60% of the viewport (mid-layer coords at the current camera)
    const rr = Math.random, P = CAM.parallax(0.25);
    const tx = (ST.w * (0.2 + rr() * 0.6) - P.x) / P.zk, ty = (ST.h * (0.2 + rr() * 0.6) - P.y) / P.zk;
    const span = Math.max(ST.w, ST.h) / P.zk;
    const a = rr() * TAU, dist = span * 0.8;
    const x0 = tx - Math.cos(a) * dist, y0 = ty - Math.sin(a) * dist;
    const x1 = tx + Math.cos(a) * dist, y1 = ty + Math.sin(a) * dist;
    const dur = 4 + rr() * 3;
    const color = Math.random() < 0.5 ? '#BFE8F4' : '#FFE9B8';
    const root = new PIXI.Container(); root.eventMode = 'none';
    const tail = ST.sprite(streakTexture(220, 22, color), { blend: 'add', alpha: 0.9 });
    tail.anchor.set(0, 0.5);
    const head = ST.sprite(ST.glowTexture(color, 24, 'core'), { blend: 'add' });
    head.scale.set(0.9);
    root.addChild(tail, head);
    root.rotation = Math.atan2(y0 - y1, x0 - x1);     // tail points back along the travel direction
    S.cometRoot.addChild(root);
    S.comet = { root, x0, y0, x1, y1, t0: ST.time, dur };
  }

  // ---------------------------------------------------------------- frame
  function update(dt) {
    const tier = ST.tier, reduced = ST.reduced, t = ST.time;
    // nebula rotation
    for (const n of S.nebula) n.sp.rotation += n.w * dt;
    // twinkle (2% of stars) — off at tier 0 and under reduced motion
    if (tier > 0 && !reduced) {
      for (const tw of S.twinkle) tw.sp.alpha = tw.base * (0.55 + 0.45 * Math.sin(t * tw.w + tw.ph));
    }
    // planet rotation
    const p = S.planet;
    if (p && p.bands) p.bands.tilePosition.x -= p.spin * dt * (p.r / 100);
    if (p && p.kind === 'dwarf') { p.core.alpha = 0.92 + 0.08 * Math.sin(t * 2.1); p.halo.alpha = 0.7 + 0.08 * Math.sin(t * 0.7); }
    // asteroids drift and wrap along the belt
    if (S.asteroids.length) {
      for (const a of S.asteroids) {
        a.sp.x += a.vx * dt; a.sp.y += a.vy * dt; a.sp.rotation += a.vr * dt;
        if (Math.abs(a.sp.x - a.x0) > a.span) a.sp.x = a.x0 - Math.sign(a.sp.x - a.x0) * a.span;
        if (Math.abs(a.sp.y - a.y0) > a.span) a.sp.y = a.y0 - Math.sign(a.sp.y - a.y0) * a.span;
      }
    }
    // comets (tier >= 1)
    if (S.comet) {
      const c = S.comet, k = (t - c.t0) / c.dur;
      if (k >= 1) { c.root.destroy({ children: true }); S.comet = null; S.cometNext = t + 70 + Math.random() * 70; }
      else {
        c.root.position.set(U.lerp(c.x0, c.x1, k), U.lerp(c.y0, c.y1, k));
        c.root.alpha = k < 0.15 ? k / 0.15 : k > 0.8 ? (1 - k) / 0.2 : 1;
      }
    } else if (tier > 0 && !reduced && t >= S.cometNext) spawnComet();
    // lane pulses: light travelling inward every 4–9 s per lane (emissive layer, so they bloom)
    const em = ST.layers.world.emissive;
    for (const l of S.lanes) {
      if (t >= l.next) {
        l.next = t + 4 + Math.random() * 5;
        if (tier > 0) {
          const sp = ST.sprite(streakTexture(64, 10, S.theme.lane || '#8FD3E8'), { blend: 'add', alpha: 0 });
          sp.anchor.set(0.15, 0.5);
          em.addChild(sp);
          S.pulses.push({ sprite: sp, lane: l, t0: t, dur: 2.6 + Math.random() * 0.8 });
        }
      }
    }
    for (let i = S.pulses.length - 1; i >= 0; i--) {
      const pu = S.pulses[i], k = (t - pu.t0) / pu.dur;
      if (k >= 1) { pu.sprite.destroy(); S.pulses.splice(i, 1); continue; }
      const e = U.easeInQuad(k);
      const a = lanePoint(pu.lane, e), b = lanePoint(pu.lane, Math.max(0, e - 0.02));
      pu.sprite.position.set(a.x, a.y);
      pu.sprite.rotation = Math.atan2(a.y - b.y, a.x - b.x);
      pu.sprite.alpha = (k < 0.2 ? k / 0.2 : k > 0.85 ? (1 - k) / 0.15 : 1) * 0.55;
      pu.sprite.scale.set(0.6 + e * 0.5, 0.6);
    }
  }

  // ---------------------------------------------------------------- public
  function setTheme(sectorDef) { build(themeFor(sectorDef)); }
  // Re-lay lanes and the planet for a new station box (no-op until the first theme is built).
  function setStation() { if (S.laneRoot) layout(); }
  function onResize() { if (S.laneRoot) build(S.theme); }

  function init() {
    ST.onResize(onResize);
  }

  return {
    THEMES,
    init, setTheme, setStation, update,
    comet: spawnComet,
    get theme() { return S.theme; },
  };
})();

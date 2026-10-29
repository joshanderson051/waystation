// ============================================================
// PORT SOLACE v2 — engine/post.js (Engineer E)
// Post layer (DESIGN2.md 3.7): bloom on the emissive + traffic group
// only (never on plates or text), a vignette, full-screen flashes.
// The pixi-filters namespace is resolved at runtime (PIXI.filters, then
// window.filters, then PIXI itself); without AdvancedBloomFilter the
// engine runs with no bloom. Tier 1 lowers bloom quality, tier 0 drops it.
// Bloom pulses only through the content under it, never by animating
// the filter.
// Classic script: exports the global `EnginePost`.
// ============================================================
'use strict';

const EnginePost = (() => {
  const U = EngineUtil, ST = EngineStage;

  const S = { F: null, bloom: null, vignette: null, flashG: null, flashes: [], tier: -1 };

  // Resolve the filter namespace wherever the build attached it.
  function filtersNS() {
    if (S.F !== null) return S.F;
    let F = null;
    try {
      if (typeof PIXI !== 'undefined' && PIXI.filters && PIXI.filters.AdvancedBloomFilter) F = PIXI.filters;
      else if (typeof window !== 'undefined' && window.filters && window.filters.AdvancedBloomFilter) F = window.filters;
      else if (typeof PIXI !== 'undefined' && PIXI.AdvancedBloomFilter) F = PIXI;
    } catch (e) { F = null; }
    S.F = F || false;
    return S.F;
  }

  function makeBloom(quality) {
    const F = filtersNS();
    if (!F) return null;
    try {
      const f = new F.AdvancedBloomFilter({ threshold: 0.42, bloomScale: 1.1, brightness: 1.0, blur: 6, quality });
      f.padding = 32;
      return f;
    } catch (e) { ST.reportError('bloom', e); return null; }
  }

  function applyTier(t) {
    if (t === S.tier) return;
    S.tier = t;
    const group = ST.layers.bloomGroup;
    if (t === 0 || !filtersNS()) { group.filters = null; S.bloom = null; return; }
    S.bloom = makeBloom(t === 1 ? 2 : 4);
    group.filters = S.bloom ? [S.bloom] : null;
  }

  function buildVignette() {
    const tex = ST.bake('post|vignette', 512, 512, g => {
      const gr = g.createRadialGradient(256, 256, 256 * 0.5, 256, 256, 256 * 1.02);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.6, 'rgba(0,0,0,.14)'); gr.addColorStop(1, 'rgba(0,0,0,.38)');
      g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
    }).texture;
    const sp = new PIXI.Sprite(tex); sp.eventMode = 'none';
    S.vignette = sp;
    ST.layers.post.addChild(sp);
    S.flashG = new PIXI.Graphics(); S.flashG.eventMode = 'none'; S.flashG.visible = false;
    ST.layers.post.addChild(S.flashG);
    onResize();
  }
  function onResize() {
    if (!S.vignette) return;
    // stretch the square gradient over the viewport (corners reach the full 38%)
    S.vignette.width = ST.w * 1.15; S.vignette.height = ST.h * 1.15;
    S.vignette.position.set(-ST.w * 0.075, -ST.h * 0.075);
  }

  // Full-screen flash quad: colour at `alpha` fading out over `ms`.
  function flash(color, alpha, ms) {
    if (ST.reduced && alpha > 0.3) alpha = 0.3;
    S.flashes.push({ color: U.int(color || '#FFFFFF'), alpha: U.clamp(alpha == null ? 0.2 : alpha, 0, 1), t0: ST.time, life: (ms > 0 ? ms : 240) / 1000 });
  }

  function update() {
    if (ST.tier !== S.tier) applyTier(ST.tier);
    const g = S.flashG; if (!g) return;
    g.clear();
    let any = false;
    for (let i = S.flashes.length - 1; i >= 0; i--) {
      const f = S.flashes[i], k = (ST.time - f.t0) / f.life;
      if (k >= 1) { S.flashes.splice(i, 1); continue; }
      any = true;
      g.rect(0, 0, ST.w, ST.h).fill({ color: f.color, alpha: f.alpha * (1 - k) * (1 - k) });
    }
    g.visible = any;
  }

  function init() {
    buildVignette();
    ST.onResize(onResize);
    applyTier(ST.tier);
  }

  return {
    init, update, flash,
    get bloomActive() { return !!S.bloom; },
  };
})();

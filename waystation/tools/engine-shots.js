// Screenshots the engine harness (play/dev/engine-preview.html) with the system Chrome/Edge through
// puppeteer-core: every sector theme, the effects, placement, selection, zoom 2.0, and an fps sample
// per perf tier. Prints console errors, page errors and failed requests as `errs`.
//   node engine-shots.js <base url ending in /> <out dir> [only]
//   e.g. node engine-shots.js http://localhost:8792/waystation/ ../play/dev/shots themes
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path');
const [, , BASE, OUT, ONLY] = process.argv;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const PAGE = BASE + 'play/dev/engine-preview.html';
const W = 1440, H = 900;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const errs = []; globalThis.__errs = errs;
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type().toUpperCase() + ' ' + m.text()); });
  page.on('requestfailed', r => errs.push('REQFAIL ' + r.url() + ' ' + (r.failure() ? r.failure().errorText : '')));
  page.on('response', r => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url()); });

  async function open(params) {
    await page.goto(PAGE + (params ? '?' + params : ''), { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__engineReady === true, { timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
  }
  async function shot(name) {
    const file = path.join(OUT, 'engine-' + name + '.png');
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W, height: H } });
    console.log('shot', file);
  }
  const want = k => !ONLY || ONLY.split(',').includes(k);

  if (want('renderer')) {
    await open('panel=0');
    const info = await page.evaluate(() => ({ renderer: EngineStage.app.renderer.name, type: EngineStage.app.renderer.type, bloom: Engine.perf.bloom, filters: !!(PIXI.filters && PIXI.filters.AdvancedBloomFilter), dpr: EngineStage.dpr, fonts: EngineStage.fontsReady }));
    console.log('renderer', JSON.stringify(info));
  }
  if (want('themes')) {
    for (const id of ['home', 'sable', 'kessler', 'thessaly', 'marrow', 'oros', 'keth', 'aurelia']) {
      await open('sector=' + id + '&panel=0');
      await sleep(3500);
      await shot('theme-' + id);
    }
  }
  if (want('zoom')) {
    await open('sector=home&zoom=2&select=4,10&panel=0');
    await sleep(2500);
    await shot('zoom-2.0-selected');
    await open('sector=home&zoom=0.55&panel=0');
    await sleep(2000);
    await shot('zoom-0.55');
    await open('sector=home&zoom=2.6&panel=0');
    await page.evaluate(() => Engine.camera.focusCell(4, 7, { zoom: 2.6, ms: 0 }));
    await sleep(2000);
    await shot('zoom-2.6-hub');
  }
  if (want('ui')) {
    await open('sector=home&placing=dock');
    await page.mouse.move(W / 2 + 140, H / 2 + 60);
    await sleep(1200);
    await shot('placing-dock');
    await open('sector=home&panel=0');
    await page.evaluate(() => { Engine.camera.zoom = 1.3; });
    await page.mouse.move(W / 2 - 60, H / 2 - 20);
    await sleep(1200);
    await shot('hover-panel-open');
  }
  if (want('fx')) {
    await open('sector=home&panel=0');
    await sleep(1500);
    await page.evaluate(() => harness.fire('collect'));
    await sleep(380);
    await shot('fx-collect-midair');
    await page.evaluate(() => { harness.fire('buildDone'); harness.fire('buildStart'); harness.fire('floater'); harness.fire('pulse'); });
    await sleep(220);
    await shot('fx-build');
    await page.evaluate(() => harness.fire('levelUp'));
    await sleep(450);
    await shot('fx-levelup');
    await page.evaluate(() => harness.fire('shock'));
    await sleep(250);
    await shot('fx-shock');
    await page.evaluate(() => harness.fire('warp'));
    await sleep(500);
    await shot('fx-warp');
    await page.evaluate(() => harness.fire('comet'));
    await sleep(1800);
    await shot('fx-comet');
  }
  if (want('fps')) {
    for (const tier of [2, 1, 0]) {
      await open('sector=home&tier=' + tier + '&panel=0');
      await sleep(2500);
      const samples = [];
      for (let i = 0; i < 10; i++) { await sleep(400); samples.push(await page.evaluate(() => Math.round(EngineStage.fps))); }
      const info = await page.evaluate(() => ({ tier: Engine.perf.tier, bloom: Engine.perf.bloom, particles: Engine.perf.particles, ships: Sim.state.ships.length }));
      console.log('fps tier', tier, 'samples', samples.join(' '), JSON.stringify(info));
    }
  }
  if (want('idle')) {
    await open('sector=home&panel=0&drift=1');
    await sleep(14000);
    await shot('idle-14s');
  }
  console.log('errs', errs.length ? '\n' + [...new Set(errs)].join('\n') : 'none');
  await browser.close();
})().catch(e => { console.error(e); console.log('errs-at-failure', [...new Set(globalThis.__errs || [])].join('\n')); process.exit(1); });

// A4 phone layout: drives the REAL game (play/, PixiJS engine) with puppeteer touch emulation at a phone
// viewport and checks what a phone player does first: the title screen and commission by tap, the tour's
// first steps (open Build from the dock, pick the Docking Bay, the sheet peeks, tap a bracketed cell), the
// status-bar menu and the daily sheet by tap, drag-pan and pinch-zoom on the world, and a tap on a bank chip
// through the widened touch targets (input.js). Prints a step log, console / page errors and screenshots.
//   start the server:  MSYS_NO_PATHCONV=1 node waystation/serve.js --port 8791 --base waystation
//   run:               node tools/phone-touch.js [baseUrl] [outDir] [WxH]
//     baseUrl default http://localhost:8791/waystation/   outDir default play/dev/shots   size default 390x844
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path');
const [, , BASE = 'http://localhost:8791/waystation/', OUT = path.join(__dirname, '..', 'play', 'dev', 'shots'), SIZE = '390x844'] = process.argv;
const [W, H] = SIZE.split('x').map(Number);
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const frames = (page, ms) => page.evaluate(ms => new Promise(res => { const t0 = performance.now(); const f = () => (performance.now() - t0 >= ms ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), ms);

(async () => {
  if (!CHROME) { console.error('No Chrome or Edge found'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--hide-scrollbars', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = [], log = [];
  const ok = (name, pass, detail) => { log.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`); console.log(log[log.length - 1]); };
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type().toUpperCase() + ' ' + m.text()); });
  page.on('requestfailed', r => errs.push('REQFAIL ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));
  page.on('response', r => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url()); });
  const shot = async name => { const file = path.join(OUT, `touch-${SIZE}-${name}.png`); await page.screenshot({ path: file }); console.log('shot', path.relative(process.cwd(), file)); };
  const centre = async sel => page.$eval(sel, el => { if (el.closest('.sheet-box, .panel-body, .modal-body')) el.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });
  const tap = async sel => { const c = await centre(sel); await page.touchscreen.tap(c.x, c.y); return c; };

  // ---- title screen and commission by tap (a fresh browser context: no profile)
  await page.goto(BASE + 'play/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btn-commission', { visible: true, timeout: 30000 });
  await page.waitForFunction(() => typeof Engine !== 'undefined' && Engine.ready === true, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await sleep(800);
  const phone = await page.evaluate(() => UI.phone && getComputedStyle(document.getElementById('rail')).position === 'fixed');
  ok('phone layout active', phone);
  await shot('title');
  const titleFits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('title').scrollWidth <= innerWidth);
  ok('title fits the width', titleFits);
  await tap('#btn-commission');
  await page.waitForFunction(() => !document.body.hasAttribute('data-screen'), { timeout: 5000 }).catch(() => {});
  ok('commission by tap', await page.evaluate(() => !document.body.hasAttribute('data-screen') && UI.started));
  // the fresh station opens the tour after ~1 s
  await page.waitForSelector('#tour .tour-callout', { visible: true, timeout: 8000 }).catch(() => {});
  const tourOn = await page.evaluate(() => Tutorial.active && Tutorial.step === 0);
  ok('tour started on the fresh station', tourOn);
  await frames(page, 600);
  await shot('tour-1');
  const callFits = await page.evaluate(() => { const r = document.querySelector('.tour-callout').getBoundingClientRect(); const d = getComputedStyle(document.querySelector('.tour-dim')).clipPath; return r.left >= 0 && r.right <= innerWidth && d.startsWith('polygon'); });
  ok('tour callout fits and the spotlight is cut', callFits);

  // ---- tour steps 1..3 by tap, then Build from the dock (step 3 waits for the panel)
  await tap('#tour-next'); await frames(page, 450);
  await tap('#tour-next'); await frames(page, 450);
  ok('tour at step 3 (Open Build)', await page.evaluate(() => Tutorial.step === 2));
  await shot('tour-3');
  await tap('.rail-btn[data-panel="build"]');
  await page.waitForFunction(() => UI.panel === 'build', { timeout: 3000 }).catch(() => {});
  ok('Build sheet opened from the dock by tap', await page.evaluate(() => UI.panel === 'build' && !document.getElementById('panel-host').hidden));
  await page.waitForFunction(() => Tutorial.step === 3, { timeout: 3000 }).catch(() => {});
  ok('tour advanced to step 4 (Docking Bay)', await page.evaluate(() => Tutorial.step === 3));
  await frames(page, 500);
  await shot('tour-4-sheet');
  // ---- pick the Docking Bay card: the sheet peeks, the placing strip shows, the spotlight moves to the dock
  await tap('#panel .card[data-mod="dock"]');
  await frames(page, 500);
  const peek = await page.evaluate(() => ({ placing: Engine.placing, peek: document.getElementById('panel-host').hasAttribute('data-peek'), strip: getComputedStyle(document.getElementById('contextbar')).display !== 'none', hint: document.getElementById('hint').textContent }));
  ok('card tap enters placing and peeks the sheet', peek.placing === 'dock' && peek.peek && peek.strip, JSON.stringify(peek));
  await shot('placing-peek');
  // ---- tap a bracketed cell beside the hub (through the engine's touch path)
  const cellPt = await page.evaluate(() => { const { r, c } = Sim.state.hub; const p = Engine.cellToScreen(r, c + 1); const hr = document.getElementById('world').getBoundingClientRect(); return { x: hr.left + p.x, y: hr.top + p.y }; });
  const before = await page.evaluate(() => Sim.cells().length);
  await page.touchscreen.tap(cellPt.x, cellPt.y);
  await frames(page, 600);
  const after = await page.evaluate(() => Sim.cells().length);
  ok('bracketed cell tap places the Docking Bay', after === before + 1, `${before} -> ${after}`);
  await page.waitForFunction(() => Tutorial.step === 4, { timeout: 3000 }).catch(() => {});
  ok('tour advanced to step 5 and lifted the sheet', await page.evaluate(() => Tutorial.step === 4 && !document.getElementById('panel-host').hasAttribute('data-peek')));
  await shot('tour-5');
  // ---- skip the rest of the tour by tap, close the sheet by dragging its head down
  await frames(page, 500);   // the card slides to its place on each step (320 ms)
  await tap('[data-tour="skip"]');
  await frames(page, 400);
  ok('tour skipped by tap', await page.evaluate(() => !Tutorial.active && Tutorial.done));
  // the tour's end releases the deferred daily sheet (A2.2): it rises as a bottom sheet; Later closes it by tap
  await page.waitForSelector('#sheet.open [data-sheet="daily"]', { visible: true, timeout: 4000 }).catch(() => {});
  ok('daily sheet rises after the tour', await page.evaluate(() => !!document.querySelector('#sheet.open [data-sheet="daily"]')));
  await shot('daily-after-tour');
  if (await page.$('#sheet.open [data-sheet-act="later"]')) { await tap('#sheet.open [data-sheet-act="later"]'); await frames(page, 400); }
  ok('Later closes the daily sheet by tap', await page.evaluate(() => !document.querySelector('#sheet.open')));
  if (await page.evaluate(() => Engine.placing)) { await tap('#ctx-actions [data-act="cancel"]'); await frames(page, 300); }
  ok('Stop placing by tap', await page.evaluate(() => !Engine.placing && !document.body.hasAttribute('data-placing')));
  const head = await centre('#panel .panel-head');
  const t = await page.touchscreen.touchStart(head.x, head.y);
  for (let i = 1; i <= 8; i++) { await t.move(head.x, head.y + i * 22); await sleep(16); }
  await t.end();
  await frames(page, 500);
  ok('drag the head down peeks the sheet', await page.evaluate(() => UI.panel === 'build' && document.getElementById('panel-host').hasAttribute('data-peek')));
  await shot('peek-after-drag');
  const head2 = await centre('#panel .panel-head');
  const t2 = await page.touchscreen.touchStart(head2.x, head2.y);
  for (let i = 1; i <= 4; i++) { await t2.move(head2.x, head2.y + i * 18); await sleep(16); }
  await t2.end();
  await frames(page, 400);
  ok('drag down again closes the sheet', await page.evaluate(() => UI.panel === null));

  // ---- the world by touch: drag-pan and pinch-zoom
  const cam0 = await page.evaluate(() => ({ x: Engine.camera.x, y: Engine.camera.y, z: Engine.camera.zoom }));
  const p0 = { x: W / 2, y: H / 2 };
  const d = await page.touchscreen.touchStart(p0.x, p0.y);
  for (let i = 1; i <= 10; i++) { await d.move(p0.x + i * 9, p0.y + i * 6); await sleep(16); }
  await d.end();
  await frames(page, 300);
  const cam1 = await page.evaluate(() => ({ x: Engine.camera.x, y: Engine.camera.y, z: Engine.camera.zoom }));
  ok('one-finger drag pans the camera', Math.hypot(cam1.x - cam0.x, cam1.y - cam0.y) > 20, `moved ${Math.round(Math.hypot(cam1.x - cam0.x, cam1.y - cam0.y))} world px`);
  const a = await page.touchscreen.touchStart(W / 2 - 30, H / 2), b = await page.touchscreen.touchStart(W / 2 + 30, H / 2);
  for (let i = 1; i <= 10; i++) { await a.move(W / 2 - 30 - i * 8, H / 2); await b.move(W / 2 + 30 + i * 8, H / 2); await sleep(16); }
  await a.end(); await b.end();
  await frames(page, 300);
  const cam2 = await page.evaluate(() => Engine.camera.zoom);
  ok('two-finger pinch zooms in', cam2 > cam1.z * 1.15, `zoom ${cam1.z.toFixed(2)} -> ${cam2.toFixed(2)}`);
  await shot('world-after-pinch');
  ok('pan and pinch opened no sheet', await page.evaluate(() => UI.panel === null && !document.querySelector('#sheet.open')));

  // ---- tap a module: the Station sheet opens on its card with the actions (the pinch left the hub off-screen: frame it first)
  await page.evaluate(() => { const { r, c } = Sim.state.hub; Engine.camera.focusCell(r, c, { zoom: 1.6, ms: 0 }); });
  await frames(page, 250);
  const hubPt = await page.evaluate(() => { const { r, c } = Sim.state.hub; const p = Engine.cellToScreen(r, c); const hr = document.getElementById('world').getBoundingClientRect(); return { x: hr.left + p.x, y: hr.top + p.y }; });
  await page.touchscreen.tap(hubPt.x, hubPt.y);
  await frames(page, 500);
  // A6: the selected module shows as a picture header (.mod-hero) rather than a card
  ok('tapping the hub opens the Station sheet on its card', await page.evaluate(() => { const s = Engine.selected, h = Sim.state.hub; return UI.panel === 'station' && !!s && s.r === h.r && s.c === h.c && !!document.querySelector('#panel .mod-hero[data-fam="hub"], #panel .card[data-mod="hub"]'); }), JSON.stringify(hubPt));
  await shot('station-selected');
  if (await page.$('#panel .panel-close')) { await tap('#panel .panel-close'); await frames(page, 300); }
  ok('the close control shuts the sheet by tap', await page.evaluate(() => UI.panel === null));

  // ---- a bank chip by touch (widened hit area): make the hub's bank ready, tap 16px beside the chip
  const bankReady = await page.evaluate(() => {
    const { r, c } = Sim.state.hub, key = `${r},${c}`, cell = Sim.state.cells && Sim.state.cells[key];
    if (!cell) return null;
    const hp = Meta.hopper(r, c); if (!hp) return null;
    cell.bank = Math.max(cell.bank || 0, Math.max(50, Math.ceil(hp.cap * 0.6)));
    Sim.emit('hopper', { r, c }); Sim.emit('change');
    return Meta.hopper(r, c);
  });
  await frames(page, 700);
  if (bankReady && bankReady.ready) {
    // find the chip through the engine's own hit test (projection-independent): scan screen pixels around the hub for
    // EngineWorld.bankAt hits, take the hit disc's centre and its radius on screen, then tap 10 px beyond that disc:
    // a mouse click there misses, a touch lands (input.js probes a 16 px ring)
    const chip = await page.evaluate(() => {
      const { r, c } = Sim.state.hub, z = Engine.camera.zoom, hr = document.getElementById('world').getBoundingClientRect();
      const p = Engine.cellToScreen(r, c), hits = [];
      for (let dy = -160; dy <= 60; dy += 2) for (let dx = -110; dx <= 110; dx += 2) {
        const w = EngineCamera.screenToWorld(p.x + dx, p.y + dy), b = EngineWorld.bankAt(w.x, w.y);
        if (b && b.r === r && b.c === c) hits.push([p.x + dx, p.y + dy]);
      }
      if (!hits.length) return null;
      const cx = hits.reduce((a, h) => a + h[0], 0) / hits.length, cy = hits.reduce((a, h) => a + h[1], 0) / hits.length;
      const rad = Math.max(...hits.map(h => Math.hypot(h[0] - cx, h[1] - cy)));
      return { x: hr.left + cx, y: hr.top + cy, z, rad: Math.round(rad), off: Math.round(rad + 10) };
    });
    if (!chip) ok('bank chip found on screen', false, 'no bankAt hit around the hub');
    else {
      const credits0 = await page.evaluate(() => Sim.state.credits);
      await page.touchscreen.tap(chip.x + chip.off, chip.y);
      await frames(page, 600);
      const credits1 = await page.evaluate(() => Sim.state.credits);
      ok(`bank chip collected by a touch ${chip.off}px off its centre (disc ${chip.rad}px)`, credits1 > credits0, `credits ${credits0} -> ${credits1} at zoom ${chip.z.toFixed(2)}`);
    }
  } else ok('bank chip test staged', false, 'could not stage a ready bank: ' + JSON.stringify(bankReady));

  // ---- the status-bar menu and the daily sheet by tap
  await tap('#sb-menu');
  await page.waitForSelector('#sheet.open .menu-wrap', { visible: true, timeout: 3000 }).catch(() => {});
  ok('menu sheet opens from the status bar', await page.evaluate(() => !!document.querySelector('#sheet.open .menu-wrap')));
  await frames(page, 400);
  await shot('menu');
  await tap('#sheet .menu-row[data-go="daily"]');
  await page.waitForSelector('#sheet.open [data-sheet="daily"]', { visible: true, timeout: 3000 }).catch(() => {});
  const daily = await page.evaluate(() => ({ open: !!document.querySelector('#sheet.open [data-sheet="daily"]'), claimable: !!(Meta.daily() && Meta.daily().claimable), fits: document.querySelector('#sheet .sheet-box').scrollWidth <= innerWidth }));
  ok('daily sheet opens from the menu by tap', daily.open && daily.fits, JSON.stringify(daily));
  await frames(page, 400);
  await shot('daily');
  if (daily.claimable) {
    const am0 = await page.evaluate(() => ({ am: Meta.am, credits: Sim.state.credits }));
    await tap('#sheet [data-sheet-act="claim"]');
    await frames(page, 800);
    const am1 = await page.evaluate(() => ({ am: Meta.am, credits: Sim.state.credits, claimable: !!(Meta.daily() && Meta.daily().claimable), closed: !document.querySelector('#sheet.open') }));
    ok('daily reward claimed by tap', !am1.claimable && am1.closed && (am1.am > am0.am || am1.credits > am0.credits), JSON.stringify({ before: am0, after: am1 }));
    await frames(page, 900);
    await shot('daily-celebration');
  } else { await tap('#sheet [data-sheet-act="later"], #sheet .sheet-close'); }

  // ---- More sheet and a panel under it
  await tap('.rail-btn[data-more]');
  await page.waitForSelector('#sheet.open .more-grid', { visible: true, timeout: 3000 }).catch(() => {});
  await frames(page, 300);
  await shot('more');
  await tap('#sheet .more-row[data-go="expeditions"]');
  await frames(page, 500);
  ok('Expeditions opens from More and the More button lights', await page.evaluate(() => UI.panel === 'expeditions' && document.querySelector('.rail-btn[data-more]').classList.contains('active')));
  await shot('expeditions');
  const layout = await page.evaluate(() => {
    const W = innerWidth, out = [];
    for (const el of document.querySelectorAll('#statusbar *, .rail-btn, #panel *')) { const r = el.getBoundingClientRect(); if (r.width && (r.right > W + 1 || r.left < -1)) out.push((el.id || el.className || el.tagName) + ' ' + Math.round(r.right)); }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: W, wide: [...new Set(out)].slice(0, 8) };
  });
  ok('no horizontal overflow on the live bridge', layout.scrollWidth <= layout.innerWidth && !layout.wide.length, JSON.stringify(layout));

  await browser.close();
  console.log('summary', JSON.stringify({ pass: log.filter(l => l.startsWith('PASS')).length, fail: log.filter(l => l.startsWith('FAIL')).length }));
  console.log('errs', JSON.stringify([...new Set(errs)], null, 1));
})().catch(e => { console.error(e); process.exit(1); });

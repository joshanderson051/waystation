// Screenshots of the v2 HUD harness (DESIGN2.md 5.5 gates) with the system Chrome or Edge.
//   start the server:  MSYS_NO_PATHCONV=1 node waystation/serve.js --port 8791 --base waystation
//   run:               node tools/hud2-shots.js [baseUrl] [outDir] [only]
//     baseUrl  default http://localhost:8791/waystation/     outDir default play/dev/shots
//     only     optional substring filter on shot names (e.g. "panel-build")
// Prints console errors, page errors and failed requests as `errs`, the harness contrast table, and every file written.
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path');
const [, , BASE = 'http://localhost:8791/waystation/', OUT = path.join(__dirname, '..', 'play', 'dev', 'shots'), ONLY = ''] = process.argv;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const PAGE = BASE + 'play/dev/hud2-preview.html?toolbar=0&hold=1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// headless Chrome throttles a page that nobody is talking to, which freezes its animation timeline: settle in page
// time by running requestAnimationFrame until the requested milliseconds of performance.now() have passed (1:1 with the timeline)
const frames = (page, ms) => page.evaluate(ms => new Promise(res => { const t0 = performance.now(); const f = () => (performance.now() - t0 >= ms ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), ms);
const PANELS = ['build', 'station', 'market', 'fleet', 'expeditions', 'map', 'missions', 'registry', 'store', 'settings'];

// each shot: [name, viewport, steps(page) -> void, settleMs (page time, rAF-driven)]
const click = sel => async page => { await page.$eval(sel, el => el.click()); };
const fire = key => async page => { await page.evaluate(k => window.HARNESS.fire(k), key); };
const SHOTS = [
  ['bridge', [1440, 900], async () => {}, 900],
  ...PANELS.map(id => [`panel-${id}`, [1440, 900], click(`[data-h="panel:${id}"]`), 700]),
  ['panel-station-selected', [1440, 900], async p => { await click('[data-h="select:bank"]')(p); }, 700],
  ['panel-station-scaffold', [1440, 900], async p => { await click('[data-h="select:scaffold"]')(p); }, 700],
  ['placing', [1440, 900], async p => { await click('[data-h="panel:build"]')(p); await frames(p, 300); await click('[data-h="place:dock"]')(p); }, 700],
  ['toasts', [1440, 900], async p => { await click('[data-h="panel:build"]')(p); await click('[data-h="toast:all"]')(p); await frames(p, 200); await click('[data-h="toast:action"]')(p); }, 900],
  ['modal-event', [1440, 900], click('[data-h="modal:event"]'), 600],
  ['modal-alert', [1440, 900], async p => { await click('[data-h="ev:alert"]')(p); await click('[data-h="modal:alert"]')(p); }, 600],
  ['modal-confirm', [1440, 900], click('[data-h="modal:confirm"]'), 600],
  ['modal-store', [1440, 900], async p => { await click('[data-h="panel:store"]')(p); await frames(p, 300); await click('[data-h="modal:store"]')(p); }, 600],
  ['sheet-daily', [1440, 900], click('[data-h="sheet:daily"]'), 600],
  ['sheet-away', [1440, 900], click('[data-h="sheet:away"]'), 600],
  ['sheet-keys', [1440, 900], click('[data-h="sheet:keys"]'), 600],
  // celebrations are held open (hold=1) and shot once the sweep has settled
  ['celebrate-rank', [1440, 900], click('[data-h="cele:rank"]'), 1200],
  ['celebrate-purchase', [1440, 900], async p => { await click('[data-h="panel:store"]')(p); await frames(p, 300); await click('[data-h="cele:purchase"]')(p); }, 1200],
  ['celebrate-expedition', [1440, 900], async p => { await click('[data-h="panel:expeditions"]')(p); await frames(p, 300); await click('[data-h="cele:expedition"]')(p); }, 1200],
  ['collect-flight', [1440, 900], async p => { await click('[data-h="panel:station"]')(p); await frames(p, 300); await click('[data-h="ev:collect"]')(p); }, 260],
  ['tooltip', [1440, 900], click('[data-h="tooltip"]'), 700],
  ['condition-flare', [1440, 900], async p => { await click('[data-h="ev:flare"]')(p); await click('[data-h="panel:station"]')(p); }, 700],
  ['title', [1440, 900], click('[data-h="title"]'), 1800],
  ['reduced-build', [1440, 900], async p => { await click('[data-h="motion"]')(p); await click('[data-h="panel:build"]')(p); }, 400],
  ['1180-bridge', [1180, 700], async () => {}, 800],
  ['1180-build', [1180, 700], click('[data-h="panel:build"]'), 700],
  ['1180-map', [1180, 700], click('[data-h="panel:map"]'), 700],
  ['1180-expeditions', [1180, 700], click('[data-h="panel:expeditions"]'), 700],
  ['1024-bridge', [1024, 768], async () => {}, 800],
  ['1024-build', [1024, 768], click('[data-h="panel:build"]'), 700],
  ['1024-store', [1024, 768], click('[data-h="panel:store"]'), 700],
  ['phone', [720, 1200], async () => {}, 500],
];

(async () => {
  if (!CHROME) { console.error('No Chrome or Edge found'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const page = await browser.newPage();
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type().toUpperCase() + ' ' + m.text()); });
  page.on('requestfailed', r => errs.push('REQFAIL ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));
  page.on('response', r => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url()); });
  let contrast = null, lastVp = '';
  for (const [name, [w, h], steps, settle] of SHOTS) {
    if (ONLY && !name.includes(ONLY)) continue;
    const vp = `${w}x${h}`;
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(PAGE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    await sleep(lastVp === vp ? 350 : 700);
    lastVp = vp;
    if (!contrast) contrast = await page.evaluate(() => window.HARNESS && window.HARNESS.contrast);
    try { await steps(page); } catch (e) { errs.push(`STEP ${name}: ${e.message}`); }
    await frames(page, settle);
    const file = path.join(OUT, `hud-${name}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
    console.log('shot', path.relative(process.cwd(), file));
  }
  // layout gate: nothing overflows the viewport at 1180x700 (2.4) — report any element wider than the window
  await page.setViewport({ width: 1180, height: 700, deviceScaleFactor: 1 });
  await page.goto(PAGE + '&panel=build', { waitUntil: 'networkidle0' });
  await sleep(600);
  const overflow = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#statusbar, #statusbar *, #contextbar, #rail, #panel, #notices')) {
      const r = el.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1)) out.push(`${el.id || el.className} right=${Math.round(r.right)}`);
    }
    const sb = document.getElementById('statusbar'); if (sb && sb.scrollWidth > sb.clientWidth + 1) out.push(`statusbar scrollWidth ${sb.scrollWidth} > ${sb.clientWidth}`);
    return out;
  });
  await browser.close();
  console.log('contrast', JSON.stringify(contrast));
  console.log('overflow@1180', JSON.stringify(overflow));
  console.log('errs', JSON.stringify([...new Set(errs)], null, 1));
})().catch(e => { console.error(e); process.exit(1); });

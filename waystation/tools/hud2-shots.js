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
  // A1.2 territory and A1.3 achievements
  ['plot-territory', [1440, 900], click('[data-h="panel:station"]'), 700],
  ['plot-confirm', [1440, 900], click('[data-h="plot:confirm"]'), 600],
  ['plot-clearing', [1440, 900], async p => { await click('[data-h="plot:start"]')(p); await frames(p, 300); await click('[data-h="panel:station"]')(p); }, 700],
  ['plot-clearing-confirm', [1440, 900], async p => { await click('[data-h="plot:start"]')(p); await frames(p, 200); await click('[data-h="plot:confirm"]')(p); }, 600],
  ['plot-build-tight', [1440, 900], async p => { await click('[data-h="plot:tight"]')(p); await click('[data-h="panel:build"]')(p); }, 700],
  ['plot-hint', [1440, 900], click('[data-h="hover:unclaimed"]'), 400],
  ['achievements', [1440, 900], click('[data-h="panel:achievements"]'), 700],
  ['celebrate-achievement', [1440, 900], async p => { await click('[data-h="panel:achievements"]')(p); await frames(p, 300); await click('[data-h="cele:achievement"]')(p); }, 1200],
  ['celebrate-plot', [1440, 900], click('[data-h="cele:plot"]'), 1200],
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
  // A2.1 accounts
  ['title-signedin', [1440, 900], async p => { await click('[data-h="acct:signed-in"]')(p); await click('[data-h="title"]')(p); }, 1800],
  ['portal-login', [1440, 900], click('[data-h="acct:portal-login"]'), 600],
  ['portal-signup', [1440, 900], click('[data-h="acct:portal-signup"]'), 600],
  ['portal-recover', [1440, 900], click('[data-h="acct:portal-recover"]'), 600],
  ['portal-error', [1440, 900], click('[data-h="acct:portal-error"]'), 1300],
  ['portal-busy', [1440, 900], click('[data-h="acct:portal-busy"]'), 250],
  ['portal-unavailable', [1440, 900], async p => { await click('[data-h="acct:unavailable"]')(p); await click('[data-h="acct:portal-login"]')(p); }, 600],
  ['account-recovery', [1440, 900], click('[data-h="acct:recovery"]'), 600],
  ['account-chooser', [1440, 900], click('[data-h="acct:chooser"]'), 600],
  ['account-cloud-synced', [1440, 900], click('[data-h="acct:signed-in"]'), 500],
  ['account-cloud-syncing', [1440, 900], async p => { await click('[data-h="acct:signed-in"]')(p); await click('[data-h="acct:syncing"]')(p); }, 500],
  ['account-cloud-offline', [1440, 900], async p => { await click('[data-h="acct:signed-in"]')(p); await click('[data-h="acct:offline"]')(p); }, 600],
  ['account-settings-signedout', [1440, 900], click('[data-h="panel:settings"]'), 600],
  ['account-settings-signedin', [1440, 900], async p => { await click('[data-h="acct:signed-in"]')(p); await click('[data-h="panel:settings"]')(p); }, 600],
  ['account-settings-unavailable', [1440, 900], async p => { await click('[data-h="acct:unavailable"]')(p); await click('[data-h="panel:settings"]')(p); }, 600],
  // A2.2 the tour: launched by UI.start on a fresh station (hub only), then step by step on the staged station
  ['tour-fresh', [1440, 900], async () => {}, 2200, 'fresh=1'],
  ['tour-fresh-dock', [1440, 900], click('[data-h="tour:4"]'), 700, 'fresh=1'],
  ...Array.from({ length: 13 }, (_, i) => [`tour-${i + 1}`, [1440, 900], click(`[data-h="tour:${i + 1}"]`), 700]),
  ['reduced-build', [1440, 900], async p => { await click('[data-h="motion"]')(p); await click('[data-h="panel:build"]')(p); }, 400],
  ['1180-bridge', [1180, 700], async () => {}, 800],
  ['1180-build', [1180, 700], click('[data-h="panel:build"]'), 700],
  ['1180-map', [1180, 700], click('[data-h="panel:map"]'), 700],
  ['1180-expeditions', [1180, 700], click('[data-h="panel:expeditions"]'), 700],
  ['1180-territory', [1180, 700], click('[data-h="panel:station"]'), 700],
  ['1180-achievements', [1180, 700], click('[data-h="panel:achievements"]'), 700],
  ['1180-tour-4', [1180, 700], click('[data-h="tour:4"]'), 700],
  ['1180-portal', [1180, 700], click('[data-h="acct:portal-signup"]'), 600],
  ['1024-bridge', [1024, 768], async () => {}, 800],
  ['1024-build', [1024, 768], click('[data-h="panel:build"]'), 700],
  ['1024-store', [1024, 768], click('[data-h="panel:store"]'), 700],
  // A4 phone layout: 390x844 (iPhone 14 class) in full, 430x932 (Pro Max class) as a spot check
  ...phoneShots('phone', [390, 844]),
  ...phoneShots('phone430', [430, 932], true),
];
function phoneShots(tag, vp, brief) {
  const all = [
    [`${tag}-bridge`, vp, async () => {}, 900],
    ...PANELS.map(id => [`${tag}-panel-${id}`, vp, click(`[data-h="panel:${id}"]`), 700]),
    [`${tag}-achievements`, vp, click('[data-h="panel:achievements"]'), 700],
    [`${tag}-station-selected`, vp, click('[data-h="select:bank"]'), 700],
    [`${tag}-station-scaffold`, vp, click('[data-h="select:scaffold"]'), 700],
    [`${tag}-placing`, vp, async p => { await click('[data-h="panel:build"]')(p); await frames(p, 300); await click('[data-h="place:dock"]')(p); }, 800],
    [`${tag}-peek`, vp, async p => { await click('[data-h="panel:station"]')(p); await frames(p, 300); await click('[data-h="phone:peek"]')(p); }, 700],
    [`${tag}-more`, vp, click('[data-h="phone:more"]'), 600],
    [`${tag}-menu`, vp, click('[data-h="phone:menu"]'), 600],
    [`${tag}-toasts`, vp, async p => { await click('[data-h="toast:all"]')(p); await frames(p, 200); await click('[data-h="toast:action"]')(p); }, 900],
    [`${tag}-condition`, vp, async p => { await click('[data-h="ev:flare"]')(p); await click('[data-h="toast:good"]')(p); }, 700],
    [`${tag}-modal-event`, vp, click('[data-h="modal:event"]'), 600],
    [`${tag}-modal-confirm`, vp, click('[data-h="modal:confirm"]'), 600],
    [`${tag}-plot-confirm`, vp, click('[data-h="plot:confirm"]'), 600],
    [`${tag}-modal-store`, vp, async p => { await click('[data-h="panel:store"]')(p); await frames(p, 300); await click('[data-h="modal:store"]')(p); }, 600],
    [`${tag}-sheet-daily`, vp, click('[data-h="sheet:daily"]'), 600],
    [`${tag}-sheet-away`, vp, click('[data-h="sheet:away"]'), 600],
    [`${tag}-sheet-keys`, vp, click('[data-h="sheet:keys"]'), 600],
    [`${tag}-celebrate-rank`, vp, click('[data-h="cele:rank"]'), 1200],
    [`${tag}-celebrate-unlock`, vp, click('[data-h="cele:unlock"]'), 1200],
    [`${tag}-celebrate-expedition`, vp, async p => { await click('[data-h="panel:expeditions"]')(p); await frames(p, 300); await click('[data-h="cele:expedition"]')(p); }, 1200],
    [`${tag}-title`, vp, click('[data-h="title"]'), 1800],
    [`${tag}-title-signedin`, vp, async p => { await click('[data-h="acct:signed-in"]')(p); await click('[data-h="title"]')(p); }, 1800],
    [`${tag}-portal-signup`, vp, click('[data-h="acct:portal-signup"]'), 600],
    [`${tag}-account-recovery`, vp, click('[data-h="acct:recovery"]'), 600],
    [`${tag}-account-chooser`, vp, click('[data-h="acct:chooser"]'), 600],
    [`${tag}-tour-fresh`, vp, async () => {}, 2200, 'fresh=1'],
    ...Array.from({ length: 13 }, (_, i) => [`${tag}-tour-${i + 1}`, vp, click(`[data-h="tour:${i + 1}"]`), 700]),
    // step 4 after the card is picked: the sheet peeks, the spotlight falls back to the dock's Build button
    [`${tag}-tour-4-placing`, vp, async p => { await click('[data-h="tour:4"]')(p); await frames(p, 400); await p.$eval('#panel .card[data-mod="dock"]', el => el.click()); }, 800],
  ];
  if (!brief) return all;
  const keep = new Set(['bridge', 'panel-build', 'panel-station', 'panel-map', 'panel-missions', 'panel-store', 'more', 'menu', 'placing', 'sheet-daily', 'celebrate-rank', 'title', 'tour-4', 'tour-13']);
  return all.filter(([name]) => keep.has(name.slice(tag.length + 1)));
}

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
  for (const [name, [w, h], steps, settle, query] of SHOTS) {
    if (ONLY && !name.includes(ONLY)) continue;
    const vp = `${w}x${h}`;
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(PAGE + (query ? '&' + query : ''), { waitUntil: 'networkidle0' });
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
  // A4 phone gates at 390x844: nothing wider than the viewport (page, bridge, each panel, the sheets, the title, the tour),
  // no horizontal scroll inside a panel body, and every visible control at least 32px tall (the list is informational)
  const phoneGate = {};
  const PHONE_STATES = [['bridge', ''], ...PANELS.map(id => [`panel-${id}`, `panel:${id}`]), ['achievements', 'panel:achievements'], ['station-selected', 'select:bank'], ['placing', 'place:dock'], ['more', 'phone:more'], ['menu', 'phone:menu'],
    ['daily', 'sheet:daily'], ['away', 'sheet:away'], ['modal-event', 'modal:event'], ['plot-confirm', 'plot:confirm'], ['portal', 'acct:portal-signup'], ['chooser', 'acct:chooser'], ['title', 'title'], ['tour-1', 'tour:1'], ['tour-4', 'tour:4'], ['tour-13', 'tour:13']];
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  for (const [name, h] of PHONE_STATES) {
    await page.goto(PAGE, { waitUntil: 'networkidle0' });
    await sleep(500);
    // the chooser's handler returns a promise that settles on a pick: fire without returning it
    if (h) { try { if (/^tour:\d+$/.test(h) || h.startsWith('panel:')) await page.$eval(`[data-h="${h}"]`, el => el.click()); else await page.evaluate(k => { window.HARNESS.fire(k); }, h); } catch (e) { errs.push(`PHONEGATE ${name}: ${e.message}`); } }
    await frames(page, 700);
    phoneGate[name] = await page.evaluate(() => {
      const out = { wide: [], hscroll: [], short: [] }, W = innerWidth;
      if (document.documentElement.scrollWidth > W + 1) out.wide.push(`document scrollWidth ${document.documentElement.scrollWidth}`);
      const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      for (const el of document.querySelectorAll('#statusbar, #statusbar *, #rail, .rail-btn, #panel, #panel *, #contextbar, #notices, .toast, #sheet .sheet-box, #sheet .sheet-box *, #modal .box, #modal .box *, #title, #title *, .tour-callout, .tour-callout *, .cele-band, .cele-inner *')) {
        if (!vis(el) || el.classList.contains('sweep')) continue;   // the title band's light sweep lives off-canvas by design (clipped)
        const r = el.getBoundingClientRect();
        if (r.right > W + 1 || r.left < -1) out.wide.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} left=${Math.round(r.left)} right=${Math.round(r.right)}`);
      }
      for (const el of document.querySelectorAll('.panel-body, .sheet-box, .modal-body, #statusbar')) if (vis(el) && el.scrollWidth > el.clientWidth + 1) out.hscroll.push(`${el.id || el.className} ${el.scrollWidth} > ${el.clientWidth}`);
      for (const el of document.querySelectorAll('#app button, #panel button, #panel .card, #sheet button, #sheet .nu-row, #modal button, #title button, .tour-callout .btn, .toast button')) {
        if (!vis(el)) continue; const r = el.getBoundingClientRect();
        if (r.height < 31.5) out.short.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${(el.className || '').toString().trim().split(/\s+/).slice(0, 2).join('.')} h=${Math.round(r.height)}`);
      }
      out.wide = [...new Set(out.wide)].slice(0, 12); out.short = [...new Set(out.short)].slice(0, 12);
      return out;
    });
  }
  await browser.close();
  console.log('contrast', JSON.stringify(contrast));
  console.log('overflow@1180', JSON.stringify(overflow));
  const bad = Object.entries(phoneGate).filter(([, g]) => g.wide.length || g.hscroll.length);
  console.log('phone@390 overflow', bad.length ? JSON.stringify(Object.fromEntries(bad), null, 1) : 'none');
  const short = Object.entries(phoneGate).filter(([, g]) => g.short.length);
  console.log('phone@390 controls under 32px', short.length ? JSON.stringify(Object.fromEntries(short), null, 1) : 'none');
  console.log('errs', JSON.stringify([...new Set(errs)], null, 1));
})().catch(e => { console.error(e); process.exit(1); });

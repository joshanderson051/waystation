// The integrated journey: the real game (play/index.html) in the system Chrome or Edge through puppeteer-core, a fresh
// profile from the title screen to a dressed station, with zero console errors as the gate. Steps: commission -> skip the
// tour -> place a Docking Bay by clicking the world -> open every panel -> a day-7 daily reward (livery token) -> spend the
// token in Settings > Livery -> buy the Sector Liveries and the Founder's Charter in the sandbox store -> apply a livery and
// check the engine rebaked -> reload -> the resume card names the livery and the station comes back dressed.
//   start the server:  MSYS_NO_PATHCONV=1 node waystation/serve.js --port 8792 --base waystation
//   run:               node tools/journey.js [baseUrl] [outDir]
//     baseUrl default http://localhost:8792/waystation/     outDir default play/dev/shots (journey-*.png)
// The store is forced into sandbox mode through localStorage['portsolace.store'] (store.js honours it), so nothing reaches Stripe.
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path');
const [, , BASE = 'http://localhost:8792/waystation/', OUT = path.join(__dirname, '..', 'play', 'dev', 'shots')] = process.argv;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const PAGE = BASE + 'play/';
const W = 1440, H = 900;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const steps = [];
function step(name, ok, detail) { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); }

(async () => {
  if (!CHROME) { console.error('No Chrome or Edge found'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type().toUpperCase() + ' ' + m.text()); });
  page.on('requestfailed', r => errs.push('REQFAIL ' + r.url() + ' ' + (r.failure() ? r.failure().errorText : '')));
  page.on('response', r => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url()); });
  const shot = async name => { const file = path.join(OUT, 'journey-' + name + '.png'); await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W, height: H } }); console.log('shot', path.relative(process.cwd(), file)); };
  const ev = (fn, ...args) => page.evaluate(fn, ...args);
  const settle = ms => page.evaluate(ms => new Promise(res => { const t0 = performance.now(); const f = () => (performance.now() - t0 >= ms ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), ms);
  const clear = async () => { await ev(() => { if (typeof Overlays !== 'undefined' && Overlays.anyOpen()) Overlays.escModal(); }); await settle(200); };

  // 1. a fresh profile, sandbox store
  // the first load of this tab wipes the profile before any script runs (boot would save a fresh one otherwise); the reload in step 8 keeps it
  await page.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('journey')) { localStorage.clear(); localStorage.setItem('portsolace.store', JSON.stringify({ mode: 'sandbox' })); sessionStorage.setItem('journey', '1'); } });
  await page.goto(PAGE, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.getAttribute('data-screen') === 'title' && typeof Engine !== 'undefined' && Engine.ready, { timeout: 30000 });
  await ev(() => document.fonts.ready);
  step('title screen for a new profile (name form)', await ev(() => !document.getElementById('title-form').hidden && document.getElementById('title-resume').hidden));
  step('store runs in sandbox for the journey', (await ev(() => Store.mode)) === 'sandbox');
  await page.$eval('#btn-commission', b => b.click());
  await page.waitForFunction(() => document.body.getAttribute('data-screen') !== 'title' && UI.started, { timeout: 15000 });
  await settle(1200);
  await ev(() => { if (typeof Tutorial !== 'undefined' && Tutorial.active) Tutorial.skip(); });
  await settle(400); await clear(); await clear();
  step('commissioned, tour skipped, hub on the grid', await ev(() => Sim.state && Sim.state.grid[Sim.state.hub.r][Sim.state.hub.c].id === 'hub' && !(typeof Tutorial !== 'undefined' && Tutorial.active)));

  // 2. place a Docking Bay by clicking the world
  const cell = await ev(() => { const s = Sim.state, h = s.hub; for (const [r, c] of [[h.r, h.c + 1], [h.r, h.c - 1], [h.r + 1, h.c], [h.r - 1, h.c]]) if (Sim.canPlace('dock', r, c).ok) return { r, c }; return null; });
  step('a cell next to the hub takes a dock', !!cell, cell);
  if (cell) {
    await ev(() => UI.place('dock'));
    await settle(300);
    const pt = await ev((r, c) => Engine.cellToScreen(r, c), cell.r, cell.c);
    await page.mouse.move(pt.x, pt.y); await settle(120);
    await page.mouse.click(pt.x, pt.y);
    await settle(600);
    step('dock placed by a world click (instant tutorial build)', await ev((r, c) => { const m = Sim.state.grid[r][c]; return !!m && m.id === 'dock'; }, cell.r, cell.c));
    await ev(() => UI.place(null));
  }

  // 3. every panel opens
  for (const id of ['build', 'station', 'market', 'fleet', 'expeditions', 'map', 'missions', 'registry', 'store', 'settings']) {
    await ev(id => UI.openPanel(id), id);
    await settle(350);
    step(`panel ${id}`, await ev(id => UI.panel === id && !!document.querySelector('#panel .panel-body'), id));
  }
  await ev(() => UI.closePanel()); await settle(300);

  // 4. the standard livery: engine default, Settings shelf shows eight cards with only Standard owned
  await ev(() => UI.openPanel('settings')); await settle(400);
  const shelf0 = await ev(() => ({ cards: document.querySelectorAll('.livery-card').length, owned: document.querySelectorAll('.livery-card.owned').length, active: (document.querySelector('.livery-card.active') || {}).dataset?.livery, engine: Engine.livery.id, tag: (document.querySelector('#livery-shelf .shelf-tag') || {}).textContent }));
  step('Settings > Livery: 8 cards, Standard owned and active, engine on default', shelf0.cards === 8 && shelf0.owned === 1 && shelf0.active === 'default' && shelf0.engine === 'default' && shelf0.tag === 'Standard', shelf0);
  await shot('livery-settings-locked');
  // a locked card points at the store (toast), nothing changes
  await page.$eval('.livery-card[data-livery="thessaly"]', b => b.click()); await settle(400);
  const lk = await ev(() => ({ engine: Engine.livery.id, toast: (document.querySelector('#toasts .toast .toast-msg') || {}).textContent || '' }));
  step('a locked card leaves the livery alone and shows the store hint', lk.engine === 'default' && /Store/.test(lk.toast), lk);

  // 5. a day-7 daily reward grants a livery token; spend it on Keth Meridian through the confirm
  await ev(() => { Meta.profile.daily = { streak: 6, lastClaimAt: Date.now() - 86400e3, lastClaimKey: null }; });
  const r7 = await ev(() => { const r = Meta.claimDaily(); return r && { day: r.day, token: r.token, tokens: Meta.liveryTokens() }; });
  step('day 7 reward grants a livery token', r7 && r7.token === 'livery' && r7.tokens === 1, r7);
  await settle(2200); await clear(); await clear();
  await ev(() => UI.refresh()); await settle(300);
  step('the shelf now offers Token chips on the sector liveries', await ev(() => document.querySelectorAll('.livery-card .chip.ivory').length === 6));
  await shot('livery-settings-token');
  await page.$eval('.livery-card[data-livery="keth"]', b => b.click()); await settle(400);
  step('a confirm asks to spend the token', await ev(() => document.body.getAttribute('data-modal') != null && /livery token/i.test(document.getElementById('modal-title').textContent)));
  await shot('livery-token-confirm');
  await page.$$eval('#modal-actions button', bs => { const b = bs.find(x => /spend/i.test(x.textContent)); if (b) b.click(); });
  await settle(700);
  const tok = await ev(() => ({ owned: Meta.ownsLivery('keth'), source: Meta.liveries().find(l => l.id === 'keth').source, tokens: Meta.liveryTokens(), engine: Engine.livery.id, setting: Meta.profile.settings.livery }));
  step('token spent: Keth Meridian owned (source token), applied, engine rebaked', tok.owned && tok.source === 'token' && tok.tokens === 0 && tok.engine === 'keth' && tok.setting === 'keth', tok);
  await ev(() => UI.closePanel()); await settle(600);
  await ev(() => Engine.camera.focusCell(Sim.state.hub.r, Sim.state.hub.c, { zoom: 2, ms: 0 })); await settle(900);
  await shot('livery-keth-world');

  // 6. the store sells the set and the Founder's Charter again (sandbox confirm -> grant -> celebration)
  await ev(() => UI.openPanel('store')); await settle(500);
  const rows = await ev(() => ({ liveries: !!document.querySelector('.sku button[data-sku="liveries"]'), founder: !!document.querySelector('.sku button[data-sku="founder"]'), soon: document.querySelectorAll('.sku.soon, .chip:not(.good)').length && [...document.querySelectorAll('#panel .chip')].some(c => /coming soon/i.test(c.textContent)) }));
  step('store: Sector Liveries and Founder rows carry Buy buttons, no "Coming soon"', rows.liveries && rows.founder && !rows.soon, rows);
  await page.$eval('#panel .panel-body', el => { el.scrollTop = el.scrollHeight; }); await settle(200);
  await shot('store-cosmetics');
  for (const sku of ['liveries', 'founder']) {
    await page.$eval(`.sku button[data-sku="${sku}"]`, b => b.click()); await settle(500);
    step(`${sku}: sandbox confirm`, await ev(() => document.body.getAttribute('data-modal') != null));
    await page.$$eval('#modal-actions button', bs => { const b = bs.find(x => /buy/i.test(x.textContent)); if (b) b.click(); });
    await settle(1500);
    step(`${sku}: owned after the sandbox purchase`, await ev(s => Meta.hasEntitlement(s), sku));
  }
  await settle(2500); await clear(); await clear();
  await ev(() => UI.openPanel('store')); await settle(400);
  step('store rows read Owned with a Choose link', await ev(() => document.querySelectorAll('.sku.owned [data-act="liveries"]').length === 2));
  await page.$eval('#panel .panel-body', el => { el.scrollTop = el.scrollHeight; }); await settle(200);
  await shot('store-cosmetics-owned');

  // 7. Settings > Livery: everything owned; apply Founder's Ivory, check the engine and the Station overview
  await page.$eval('.sku.owned [data-act="liveries"]', b => b.click()); await settle(700);
  const shelf1 = await ev(() => ({ panel: UI.panel, owned: document.querySelectorAll('.livery-card.owned').length, sable: Meta.liveries().find(l => l.id === 'sable').source }));
  step('Choose opens Settings on the Livery shelf with all 8 owned', shelf1.panel === 'settings' && shelf1.owned === 8 && shelf1.sable === 'store', shelf1);
  await page.$eval('.livery-card[data-livery="founder"]', b => b.click()); await settle(600);
  const fd = await ev(() => ({ engine: Engine.livery.id, active: (document.querySelector('.livery-card.active') || {}).dataset?.livery, tag: (document.querySelector('#livery-shelf .shelf-tag') || {}).textContent, saved: JSON.parse(localStorage.getItem('portsolace.profile.v2')).settings.livery }));
  step("Founder's Ivory applied: engine, card, shelf tag and the saved profile agree", fd.engine === 'founder' && fd.active === 'founder' && fd.tag === "Founder's Ivory" && fd.saved === 'founder', fd);
  await shot('livery-settings-founder');
  await ev(() => UI.openPanel('station')); await settle(500);
  step('Station overview names the livery', await ev(() => /Founder's Ivory/.test(document.querySelector('#panel .panel-body').textContent)));
  await shot('livery-station-overview');
  await ev(() => UI.closePanel()); await settle(400);
  await ev(() => Engine.camera.focusCell(Sim.state.hub.r, Sim.state.hub.c, { zoom: 2, ms: 0 })); await settle(900);
  await shot('livery-founder-world');
  // a bake-cache round trip: switching back and forth must not take frames' worth of time
  const rt = await ev(() => { const t0 = performance.now(); Meta.setLivery('keth'); Meta.setLivery('founder'); return +(performance.now() - t0).toFixed(1); });
  step('two livery switches through Meta.setLivery take under 50 ms (bake keys, no per-frame tint)', rt < 50, rt + ' ms');

  // 8. reload: the resume card names the livery and the station comes back dressed
  await page.goto(PAGE, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.getAttribute('data-screen') === 'title' && typeof Engine !== 'undefined' && Engine.ready, { timeout: 30000 });
  await ev(() => document.fonts.ready); await settle(1200);
  const rc = await ev(() => ({ resume: !document.getElementById('title-resume').hidden, text: document.getElementById('resume-meta').textContent, engine: Engine.livery.id }));
  step("resume card shows \"Founder's Ivory livery\" and the engine boots dressed", rc.resume && /Founder's Ivory livery/.test(rc.text) && rc.engine === 'founder', rc);
  await shot('livery-title-resume');
  await page.$eval('#btn-resume', b => b.click());
  await page.waitForFunction(() => document.body.getAttribute('data-screen') !== 'title' && UI.started, { timeout: 15000 });
  await settle(1500); await clear(); await clear();
  step('resumed with the livery intact', await ev(() => Engine.livery.id === 'founder' && Meta.livery().id === 'founder'));

  await browser.close();
  const failed = steps.filter(s => !s.ok);
  console.log(`\n${steps.length - failed.length} of ${steps.length} steps ok`);
  console.log('errs', errs.length ? '\n' + [...new Set(errs)].join('\n') : 'none');
  process.exit(failed.length || errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

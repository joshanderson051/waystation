// Phone layout audit: drives the real game by touch at each phone size and audits the title, the first tour step, the
// world, the menu and More sheets and every panel with its tabs: no sideways scroll, tap targets of at least 44 px
// (measured by hit-testing outward from the centre, so widened hit areas count), nothing off screen, no text cut off.
// tools/phone-touch.js checks what the touches do; this checks that every screen fits.
//   start the server:  MSYS_NO_PATHCONV=1 node waystation/serve.js --port 8791 --base waystation
//   run:               node tools/phone-panels.js [baseUrl] [outDir] [WxH,WxH,...]
//     baseUrl default http://localhost:8791/waystation/   outDir default play/dev/shots
//     sizes default 320x568,360x640,375x667,375x812,430x932,568x320,667x375,812x375
// Exits 1 when any size has a problem. A localhost page cannot reach the live account service (/presence): that console
// error is left out.
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path');
const [, , BASE = 'http://localhost:8791/waystation/', OUT = path.join(__dirname, '..', 'play', 'dev', 'shots'), SIZES = '320x568,360x640,375x667,375x812,430x932,568x320,667x375,812x375'] = process.argv;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN_TAP = 44;
fs.mkdirSync(OUT, { recursive: true });

function auditScreen(minTap, scope) {
  const W = innerWidth, H = innerHeight, out = { overflow: 0, small: [], off: [], cut: [] };
  const name = el => { const id = el.id ? `#${el.id}` : '', cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '', act = el.dataset && (el.dataset.act || el.dataset.go || el.dataset.tab || el.dataset.sku || el.dataset.panel) || ''; return `${el.tagName.toLowerCase()}${id}${cls}${act ? `[${act}]` : ''}`; };
  const shown = el => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e); if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity === 0 || c.pointerEvents === 'none' && e === el) return false; } return true; };
  if (document.documentElement.scrollWidth > W + 1) out.overflow = document.documentElement.scrollWidth;
  const hit = (el, x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return false; const e = document.elementFromPoint(x, y); return !!e && (e === el || el.contains(e) || (e.closest('label') && e.closest('label').contains(el))); };
  const reach = (el, cx, cy, dx, dy) => { let n = 0; while (n < 40 && hit(el, cx + dx * (n + 1), cy + dy * (n + 1))) n++; return n; };
  const seen = new Set();
  for (const el of document.querySelectorAll(`${scope || ''} button, ${scope || ''} a[href], ${scope || ''} input:not([type=hidden]), ${scope || ''} select, ${scope || ''} textarea, ${scope || ''} [role="button"], ${scope || ''} [role="tab"], ${scope || ''} [tabindex="0"]`)) {
    if (!minTap) break;
    if (el.disabled || !shown(el)) continue;
    if (el.closest('.panel-body, .sheet-box, .modal-body, .sheet-body')) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H || !hit(el, r.left + r.width / 2, r.top + r.height / 2)) {
      if (r.left < -1 || r.right > W + 1) out.off.push(`${name(el)} x ${Math.round(r.left)}..${Math.round(r.right)}`);
      continue;
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const w = reach(el, cx, cy, -1, 0) + reach(el, cx, cy, 1, 0) + 1, h = reach(el, cx, cy, 0, -1) + reach(el, cx, cy, 0, 1) + 1;
    if (Math.min(w, h) < minTap - 1) { const k = `${name(el)} ${w}x${h} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}"`; if (!seen.has(k)) { seen.add(k); out.small.push(k); } }
  }
  for (const root of document.querySelectorAll(scope || '#statusbar, #rail, #contextbar, #panel, #sheet.open, #modal, #title, #tour')) {
    if (!shown(root)) continue;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.right > W + 1) { if (!el.closest('[data-scroll-x], .panel-tabs') && !el.closest('svg')) out.off.push(`${name(el)} x ${Math.round(r.left)}..${Math.round(r.right)}`); continue; }
      if (el.childElementCount || !el.textContent.trim()) continue;
      const c = getComputedStyle(el);
      if (c.textOverflow === 'ellipsis' && minTap === 0 && el.closest('[title]')) continue;
      if (c.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) out.cut.push(`${name(el)} "${el.textContent.trim().slice(0, 40)}"`);
    }
  }
  for (const id of ['statusbar', 'rail']) { const e = document.getElementById(id); if (e && shown(e)) { const r = e.getBoundingClientRect(); if (r.bottom > H + 1 || r.top < -1) out.off.push(`#${id} y ${Math.round(r.top)}..${Math.round(r.bottom)}`); } }
  out.off = [...new Set(out.off)].slice(0, 20); out.cut = [...new Set(out.cut)].slice(0, 20);
  return out;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  let total = 0;
  for (const size of SIZES.split(',')) {
    const [W, H] = size.split('x').map(Number);
    const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const errs = [], problems = []; let audits = 0;
    page.on('pageerror', e => errs.push('page error: ' + e.message.slice(0, 160)));
    page.on('console', m => { if (m.type() === 'error' && !/presence|CORS|ERR_FAILED/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });
    const shot = async name => page.screenshot({ path: path.join(OUT, `panels-${size}-${name}.png`) });
    const audit = async (where, scope) => {
      await page.evaluate(() => { const t = document.getElementById('toasts'); if (t) t.style.visibility = 'hidden'; });
      const a = await page.evaluate(auditScreen, MIN_TAP, scope || ''); audits++;
      await page.evaluate(() => { const t = document.getElementById('toasts'); if (t) t.style.visibility = ''; });
      if (a.overflow) problems.push(`${where}: horizontal overflow, ${a.overflow} px wide`);
      for (const s of a.small) problems.push(`${where}: small target ${s}`);
      for (const s of a.off) problems.push(`${where}: off screen ${s}`);
      for (const s of a.cut) problems.push(`${where}: cut off ${s}`);
    };
    const tap = async sel => { const c = await page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); await page.touchscreen.tap(c.x, c.y); };
    try {
      await page.goto(BASE + 'play/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#btn-commission', { visible: true, timeout: 30000 });
      await page.waitForFunction(() => typeof Engine !== 'undefined' && Engine.ready === true, { timeout: 30000, polling: 100 });
      await page.evaluate(() => document.fonts.ready); await sleep(800);
      if (!await page.evaluate(() => UI.phone)) problems.push('the phone layout is not active');
      await shot('title'); await audit('title');
      await tap('#btn-commission');
      await page.waitForFunction(() => !document.body.hasAttribute('data-screen') && UI.started, { timeout: 8000, polling: 100 });
      await page.waitForSelector('#tour .tour-callout', { visible: true, timeout: 8000 }).catch(() => {});
      await sleep(600); await shot('tour-1'); await audit('tour step 1', '#tour');
      await page.evaluate(() => { if (typeof Tutorial !== 'undefined' && Tutorial.active) Tutorial.skip(); });
      await sleep(900);
      await page.evaluate(() => { if (typeof Overlays !== 'undefined') { Overlays.closeSheet && Overlays.closeSheet(); Overlays.closeModal && Overlays.closeModal(); } });
      await sleep(400); await shot('world'); await audit('world');
      for (const [name, sel] of [['menu', '#sb-menu'], ['more', '.rail-btn[data-more]']]) {
        if (!await page.$(sel)) { problems.push(`${name}: no ${sel}`); continue; }
        await tap(sel);
        await page.waitForSelector('#sheet.open', { visible: true, timeout: 4000 }).catch(() => problems.push(`${name}: the sheet did not open by tap`));
        await sleep(450); await shot(name); await audit(name);
        await page.evaluate(() => { Overlays.closeSheet && Overlays.closeSheet(); }); await sleep(350);
      }
      const defs = await page.evaluate(() => PANEL_DEFS.map(p => p.id));
      for (const id of defs) {
        await page.evaluate(id => UI.openPanel(id), id); await sleep(450);
        if (!await page.evaluate(id => UI.panel === id, id)) { problems.push(`panel ${id}: did not open`); continue; }
        await page.evaluate(() => UI.setPeek && UI.setPeek(false)); await sleep(250);
        await shot(`panel-${id}`); await audit(`panel ${id}`);
        const tabs = await page.$$eval('#panel .ptab', els => els.map(e => e.dataset.tab));
        for (const t of tabs.slice(1)) { await page.$eval(`#panel .ptab[data-tab="${t}"]`, b => b.click()); await sleep(280); await audit(`panel ${id} tab ${t}`); }
      }
      await page.evaluate(() => UI.closePanel()); await sleep(300);
    } catch (e) { problems.push('stopped: ' + (e.stack || e.message).split('\n').slice(0, 2).join(' | ')); }
    const all = [...new Set([...problems, ...errs])]; total += all.length;
    console.log(`[${all.length ? 'FAIL' : 'PASS'}] Port Solace ${size}: ${audits} screens audited, ${all.length} problems`);
    for (const p of all.slice(0, 60)) console.log('    ' + p);
    await ctx.close();
  }
  await browser.close();
  process.exit(total ? 1 : 0);
})();

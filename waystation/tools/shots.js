// Renders the production images in waystation/assets with the system Chrome or Edge (no browser download):
//   hero.png (1440x900 console screenshot of a staged mid-game station), og.png (1440x756 crop) and the icon PNGs.
// Setup once: `npm install` in this folder. Run: start `node ../serve.js --port 8788 --base /waystation`, then `npm run shots`
// (or `node shots.js <base url ending in /> <assets dir>`).
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path');
const [, , BASE, OUT] = process.argv;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));

const MARK = (size, rx, scale, bg) => `<!doctype html><html><body style="margin:0;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" style="display:block">
  ${bg ? `<rect width="32" height="32" rx="${rx}" fill="#04050A"/>` : ''}
  <g transform="translate(16 16) scale(${scale}) translate(-12 -12)" fill="none" stroke="#E9A23B" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2.5 20.23 7.25v9.5L12 21.5l-8.23-4.75v-9.5Z"/><path d="M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"/>
  </g>
  <circle cx="16" cy="16" r="${1.5 * scale}" fill="#FFE9B8"/>
</svg></body></html>`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--force-device-scale-factor=1'] });
  const page = await browser.newPage();

  // ---- icons ----
  const icons = [
    ['icon-32.png', 32, 6, 1, true], ['icon-192.png', 192, 6, 1, true], ['icon-512.png', 512, 6, 1, true],
    ['icon-512-maskable.png', 512, 0, 0.78, true], ['apple-touch-icon.png', 180, 0, 1, true],
  ];
  for (const [name, size, rx, scale, bg] of icons) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(MARK(size, rx, scale, bg));
    await page.screenshot({ path: path.join(OUT, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('icon', name);
  }

  // ---- console screenshot ----
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await page.goto(BASE + 'play/', { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('#btn-commission', { visible: true });

  const staged = await page.evaluate(() => {
    document.getElementById('title-name').value = 'Lantern Reach';
    document.getElementById('btn-commission').click();
    const S = Sim.state;
    S.credits = 500000; S.level = 3; S.nextEventDay = 9999; S.pending = null;
    const plan = [
      ['warehouse', 4, 6], ['fuel', 4, 5], ['dock', 4, 4],
      ['market', 4, 8], ['warehouse', 4, 9], ['dock', 4, 10],
      ['comms', 3, 7], ['dock', 2, 7],
      ['quarters', 5, 7], ['cantina', 6, 7], ['habitat', 7, 7],
      ['solar', 3, 6], ['solar', 3, 8], ['hydro', 5, 6], ['clinic', 5, 8],
      ['reactor', 3, 5], ['rec', 5, 5], ['customs', 3, 9], ['security', 5, 9],
      ['quarters', 6, 6], ['habitat', 6, 8], ['dock', 6, 5],
    ];
    const placed = [], failed = [];
    for (const [id, r, c] of plan) { if (Sim.place(id, r, c)) placed.push(id); else failed.push(id + '@' + r + ',' + c); }
    S.level = 2; S.day = 41; S.credits = 12480; S.rep = 2.6; S.residents = 18;
    S.income.yesterday = 380; S.income.today = 210;
    for (const g of Object.keys(S.stock)) S.stock[g] = Math.floor(Math.random() * 40);
    S.stats.shipsServed = 63;
    Sim.recomputeLevel(); S.nextEventDay = 9999;
    for (let i = 0; i < 4; i++) Sim.spawnShip();
    Sim.emit('change');
    if (typeof UI !== 'undefined' && UI.refresh) UI.refresh();
    const nc = document.querySelector('.note-close'); if (nc) nc.click();
    return { placed: placed.length, failed };
  });
  console.log('staged', JSON.stringify(staged));

  // let ships fly in and the boot animation finish, then rest the pointer on a module for the hover chip? keep it clean
  await new Promise(r => setTimeout(r, 7000));
  await page.evaluate(() => { const nc = document.querySelector('.note-close'); if (nc) nc.click(); });
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, 'hero.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } });
  await page.screenshot({ path: path.join(OUT, 'og.png'), clip: { x: 0, y: 0, width: 1440, height: 756 } });
  console.log('screens done');
  await browser.close();
  for (const f of fs.readdirSync(OUT)) console.log(f, fs.statSync(path.join(OUT, f)).size);
})().catch(e => { console.error(e); process.exit(1); });

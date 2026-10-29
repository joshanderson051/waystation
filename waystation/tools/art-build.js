// Builds the web art pack from the generated master PNGs (DESIGN2.md Addendum A6.1).
//   node art-build.js <source pack folder> [<out folder = ../play/assets/art>]
// Reads <source>/manifest.json, converts the 512 / 256 variants (and the 64 px people sheets, the
// 128 px loader sheet, the gangway and the key art) to WebP at the sizes each screen needs, names
// every file by its GAME ID, and writes play/js/artpack.js (the ARTPACK descriptor: paths, sizes,
// sprite-sheet metadata, key art focal point). Needs puppeteer-core (npm install in this folder) and
// the system Chrome: the conversion runs in a headless page's <canvas> (premultiplied alpha, WebP).
'use strict';
const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');

const SRC = process.argv[2];
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '..', 'play', 'assets', 'art'));
if (!SRC || !fs.existsSync(path.join(SRC, 'manifest.json'))) { console.error('usage: node art-build.js <pack folder with manifest.json> [out]'); process.exit(2); }
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

// group -> [{ size, from (variant folder), quality }]
const PLAN = {
  modules:   [{ size: 512, from: '512', q: 0.86 }, { size: 256, from: '256', q: 0.86 }],
  ships:     [{ size: 512, from: '512', q: 0.86 }, { size: 256, from: '256', q: 0.86 }],
  species:   [{ size: 512, from: '512', q: 0.84 }, { size: 256, from: '256', q: 0.84 }],
  artifacts: [{ size: 512, from: '512', q: 0.84 }, { size: 256, from: '256', q: 0.84 }],
  sectors:   [{ size: 512, from: '512', q: 0.82 }, { size: 256, from: '256', q: 0.82 }],
  goods:     [{ size: 128, from: '256', q: 0.86 }],
  icons:     [{ size: 128, from: '256', q: 0.88 }],
  badges:    [{ size: 256, from: '256', q: 0.86 }, { size: 128, from: '256', q: 0.86 }],
};

function variantPath(group, file, from) {
  const base = path.basename(file);
  const p = path.join(SRC, group, from, base);
  return fs.existsSync(p) ? p : path.join(SRC, file);
}
const b64 = file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.WS_CHROME || CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><canvas id="c"></canvas>');
  // draws a data URL onto a square (or sized) canvas with high-quality smoothing and returns WebP base64
  const convert = (dataUrl, w, h, q, fit) => page.evaluate(async (dataUrl, w, h, q, fit) => {
    const img = new Image(); img.src = dataUrl; await img.decode();
    const c = document.getElementById('c'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    if (fit === 'cover') {
      const s = Math.max(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/webp', q));
    return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  }, dataUrl, w, h, q, fit || 'stretch');

  const pack = { base: 'assets/art/', groups: {}, sheets: {}, keyart: null, built: new Date().toISOString().slice(0, 10) };
  let files = 0, bytes = 0;
  const write = async (outFile, dataUrl, w, h, q, fit) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const webp = Buffer.from(await convert(dataUrl, w, h, q, fit), 'base64');
    fs.writeFileSync(outFile, webp); files++; bytes += webp.length;
  };

  for (const group of Object.keys(PLAN)) {
    const ids = manifest[group] || {};
    pack.groups[group] = { ids: Object.keys(ids), sizes: PLAN[group].map(p => p.size) };
    for (const id of Object.keys(ids)) {
      for (const p of PLAN[group]) {
        const src = variantPath(group, ids[id], p.from);
        await write(path.join(OUT, group, String(p.size), id + '.webp'), b64(src), p.size, p.size, p.q);
      }
    }
    console.log(group, Object.keys(ids).length, 'ids x', PLAN[group].length, 'sizes');
  }

  // people: 64 px sheets with their descriptors (kept as PNG-quality WebP, lossless-ish quality)
  for (const id of Object.keys(manifest.people || {})) {
    const png = path.join(SRC, 'people', '64', id + '.png'), json = path.join(SRC, 'people', '64', id + '.json');
    const meta = JSON.parse(fs.readFileSync(json, 'utf8'));
    await write(path.join(OUT, 'people', id + '.webp'), b64(png), meta.sheet.w, meta.sheet.h, 0.92);
    pack.sheets[id] = { file: 'people/' + id + '.webp', cols: meta.cols, rows: meta.rows, cell: meta.cell, baseline: meta.baseline_y, animations: meta.animations, kind: 'person' };
  }
  // props: loader sheet at 128 px cells and the gangway at 256
  {
    const meta = JSON.parse(fs.readFileSync(path.join(SRC, 'props', 'loader_128.json'), 'utf8'));
    const png = path.join(SRC, 'props', 'loader_128.png');
    await write(path.join(OUT, 'props', 'loader.webp'), b64(png), meta.sheet.w, meta.sheet.h, 0.9);
    pack.sheets.loader = { file: 'props/loader.webp', cols: meta.cols, rows: meta.rows, cell: meta.cell, baseline: meta.baseline_y, animations: meta.animations || null, facings: meta.facings || ['front_left', 'front_right', 'back_left', 'back_right'], kind: 'vehicle' };
    await write(path.join(OUT, 'props', 'gangway.webp'), b64(path.join(SRC, 'props', '256', 'gangway.png')), 256, 256, 0.88);
    pack.groups.props = { ids: ['gangway'], sizes: [256] };
  }
  // key art: full (1536x1024), a 1024-wide copy for phones, and the 1200x630 link preview crop
  {
    const src = b64(path.join(SRC, manifest.keyart.hero || 'keyart/waystation_keyart.png'));
    await write(path.join(OUT, 'keyart', 'hero-1536.webp'), src, 1536, 1024, 0.84);
    await write(path.join(OUT, 'keyart', 'hero-1024.webp'), src, 1024, 683, 0.84);
    pack.keyart = { full: 'keyart/hero-1536.webp', small: 'keyart/hero-1024.webp', w: 1536, h: 1024, calm: { x: 0, y: 0, w: 0.33, h: 0.4 } };
  }
  const js = `// Generated by tools/art-build.js on ${pack.built} from the generated art pack. Do not hand-edit.
// ARTPACK.url(group, id, size) -> 'assets/art/<group>/<size>/<id>.webp'; sheets carry their grid metadata.
'use strict';
const ARTPACK = ${JSON.stringify(pack, null, 1)};
ARTPACK.url = function (group, id, size) {
  const g = this.groups[group]; if (!g || !g.ids.includes(id)) return null;
  const s = size && g.sizes.includes(size) ? size : g.sizes[0];
  return this.base + group + '/' + s + '/' + id + '.webp';
};
ARTPACK.sheet = function (id) { const s = this.sheets[id]; return s ? Object.assign({ url: this.base + s.file }, s) : null; };
ARTPACK.keyartUrl = function (small) { return this.base + (small ? this.keyart.small : this.keyart.full); };
`;
  fs.writeFileSync(path.join(__dirname, '..', 'play', 'js', 'artpack.js'), js);
  console.log(`wrote ${files} files, ${(bytes / 1048576).toFixed(1)} MB, and play/js/artpack.js`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

// Builds the redesigned space art (painted nebulae, planets, the Aurelia star, ships in eight headings) from the masters
// the Build the Ages art pipeline makes (buildtheages/masters/portsolace), and writes play/js/artpack-space.js, which adds
// them to ARTPACK. The masters stay outside the repository, like the first pack's.
//   node tools/space-art.js <masters/portsolace folder>
// nebula/<sector>.png  1536x1024 opaque          -> assets/art/nebula/{1536,960}/<sector>.webp
// planet/<sector>.png  transparent sphere         -> assets/art/planet/{1024,512}/<sector>.webp, trimmed, with its disc
//                                                    (centre and radius in the picture) measured from the alpha: the
//                                                    tallest column of solid pixels is the sphere's diameter, so a ring
//                                                    that reaches past the sphere at the sides does not count
// star/<sector>.png    on black (drawn additive)   -> assets/art/star/512/<sector>.webp
// turn/<ship>/<dir>.png  (tools/turnaround.mjs)   -> assets/art/shipturn/{512,256}/<ship>.<dir>.webp, plus each ship's
//                                                    scale: how much wider than its frame the sw view must be drawn to
//                                                    match the first pack's render (which fills its square)
// Needs puppeteer-core (npm install in this folder) and the system Chrome, like art-build.js.
'use strict';
const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(path.join(SRC, 'raw'))) { console.error('usage: node tools/space-art.js <masters/portsolace folder>'); process.exit(2); }
const OUT = path.join(__dirname, '..', 'play', 'assets', 'art');
const JS = path.join(__dirname, '..', 'play', 'js', 'artpack-space.js');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const HEADINGS = ['sw', 's', 'se', 'e', 'ne', 'n', 'nw', 'w'];
const list = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4)).sort() : []);
const dataUrl = file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
const write = (rel, url) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); return fs.statSync(f).size; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  await page.evaluate(() => {
    window.load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('bad png')); i.src = src; });
    window.canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    window.alphaOf = img => { const c = canvas(img.width, img.height), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
    window.bbox = (a, w, h, t) => { let x0 = w, y0 = h, x1 = -1, y1 = -1; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (a[(y * w + x) * 4 + 3] > t) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; };
    window.webp = (img, sx, sy, sw, sh, w, h, q) => { const c = canvas(w, h), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, sx, sy, sw, sh, 0, 0, w, h); return c.toDataURL('image/webp', q); };
  });
  const desc = { groups: {}, planets: {}, shipturn: {}, headings: HEADINGS };
  let bytes = 0;

  const nebulae = list(path.join(SRC, 'raw', 'nebula'));
  for (const id of nebulae) {
    const out = await page.evaluate(async src => { const i = await load(src); return { a: webp(i, 0, 0, i.width, i.height, 1536, 1024, 0.86), b: webp(i, 0, 0, i.width, i.height, 960, 640, 0.84) }; }, dataUrl(path.join(SRC, 'raw', 'nebula', `${id}.png`)));
    bytes += write(`nebula/1536/${id}.webp`, out.a) + write(`nebula/960/${id}.webp`, out.b);
  }
  if (nebulae.length) desc.groups.nebula = { ids: nebulae, sizes: [1536, 960] };

  const planets = list(path.join(SRC, 'raw', 'planet'));
  for (const id of planets) {
    const out = await page.evaluate(async src => {
      const i = await load(src), a = alphaOf(i), W = i.width, H = i.height, b = bbox(a, W, H, 24);
      // the sphere: the tallest column of solid pixels
      let best = 0, bx = 0, by0 = 0, by1 = 0;
      for (let x = b.x0; x <= b.x1; x++) { let t = -1, u = -1; for (let y = b.y0; y <= b.y1; y++) if (a[(y * W + x) * 4 + 3] > 128) { if (t < 0) t = y; u = y; } if (t >= 0 && u - t > best) { best = u - t; bx = x; by0 = t; by1 = u; } }
      const pad = 6, sx = Math.max(0, b.x0 - pad), sy = Math.max(0, b.y0 - pad), sw = Math.min(W, b.x1 + pad + 1) - sx, sh = Math.min(H, b.y1 + pad + 1) - sy;
      const k = 1024 / Math.max(sw, sh), w1 = Math.round(sw * k), h1 = Math.round(sh * k);
      return { a: webp(i, sx, sy, sw, sh, w1, h1, 0.88), b: webp(i, sx, sy, sw, sh, Math.round(w1 / 2), Math.round(h1 / 2), 0.86), w: sw, h: sh, cx: bx - sx, cy: (by0 + by1) / 2 - sy, r: best / 2 };
    }, dataUrl(path.join(SRC, 'raw', 'planet', `${id}.png`)));
    bytes += write(`planet/1024/${id}.webp`, out.a) + write(`planet/512/${id}.webp`, out.b);
    // the disc as fractions of the picture, so any size of it can be placed
    desc.planets[id] = { cx: +(out.cx / out.w).toFixed(4), cy: +(out.cy / out.h).toFixed(4), r: +(out.r / out.w).toFixed(4), aspect: +(out.h / out.w).toFixed(4) };
  }
  if (planets.length) desc.groups.planet = { ids: planets, sizes: [1024, 512] };

  const stars = list(path.join(SRC, 'raw', 'star'));
  for (const id of stars) {
    const out = await page.evaluate(async src => { const i = await load(src); return webp(i, 0, 0, i.width, i.height, 512, 512, 0.88); }, dataUrl(path.join(SRC, 'raw', 'star', `${id}.png`)));
    bytes += write(`star/512/${id}.webp`, out);
  }
  if (stars.length) desc.groups.star = { ids: stars, sizes: [512] };

  // props/<id>.png: rocks and scrap for the unclaimed plot's debris and the Kessler belt, trimmed and padded to a square
  const debris = list(path.join(SRC, 'raw', 'props'));
  for (const id of debris) {
    const out = await page.evaluate(async src => {
      const i = await load(src), a = alphaOf(i), b = bbox(a, i.width, i.height, 40), w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, side = Math.ceil(Math.max(w, h) * 1.08);
      const sq = canvas(side, side); sq.getContext('2d').drawImage(i, b.x0, b.y0, w, h, (side - w) / 2, (side - h) / 2, w, h);
      return { a: webp(sq, 0, 0, side, side, 128, 128, 0.86), b: webp(sq, 0, 0, side, side, 64, 64, 0.86) };
    }, dataUrl(path.join(SRC, 'raw', 'props', `${id}.png`)));
    bytes += write(`debris/128/${id}.webp`, out.a) + write(`debris/64/${id}.webp`, out.b);
  }
  if (debris.length) desc.groups.debris = { ids: debris, sizes: [128, 64] };

  const ships = fs.existsSync(path.join(SRC, 'turn')) ? fs.readdirSync(path.join(SRC, 'turn')).filter(d => HEADINGS.every(h => fs.existsSync(path.join(SRC, 'turn', d, `${h}.png`)))).sort() : [];
  const ids = [];
  for (const ship of ships) {
    let swWidth = 1;
    for (const h of HEADINGS) {
      const out = await page.evaluate(async src => { const i = await load(src), a = alphaOf(i), b = bbox(a, i.width, i.height, 40); return { a: webp(i, 0, 0, i.width, i.height, 512, 512, 0.86), b: webp(i, 0, 0, i.width, i.height, 256, 256, 0.86), wf: (b.x1 - b.x0 + 1) / i.width }; }, dataUrl(path.join(SRC, 'turn', ship, `${h}.png`)));
      bytes += write(`shipturn/512/${ship}.${h}.webp`, out.a) + write(`shipturn/256/${ship}.${h}.webp`, out.b);
      if (h === 'sw') swWidth = out.wf;
      ids.push(`${ship}.${h}`);
    }
    desc.shipturn[ship] = { scale: +(1 / swWidth).toFixed(4) };
  }
  if (ids.length) desc.groups.shipturn = { ids, sizes: [512, 256] };
  await browser.close();

  const js = `// Generated by tools/space-art.js on ${new Date().toISOString().slice(0, 10)} from the redesigned space masters. Do not hand-edit.
// Adds groups to ARTPACK: nebula and planet per sector, the Aurelia star, ships in eight headings (shipturn, ids
// <ship>.<heading>, headings ${HEADINGS.join(' ')} named for where the nose points on screen). ARTPACK.planets holds each
// planet's disc as fractions of its picture; ARTPACK.shipturn each ship's draw scale against its frame.
'use strict';
(function () {
  if (typeof ARTPACK === 'undefined' || !ARTPACK || !ARTPACK.groups) return;
  const add = ${JSON.stringify(desc, null, 1)};
  Object.assign(ARTPACK.groups, add.groups);
  ARTPACK.planets = add.planets; ARTPACK.shipturn = add.shipturn; ARTPACK.headings = add.headings;
})();
`;
  fs.writeFileSync(JS, js);
  console.log(`space art: ${nebulae.length} nebulae, ${planets.length} planets, ${stars.length} stars, ${ships.length} ships in ${HEADINGS.length} headings; ${(bytes / 1048576).toFixed(1)} MB of WebP; wrote ${path.relative(process.cwd(), JS)}`);
})().catch(e => { console.error(e); process.exit(1); });

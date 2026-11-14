// Adds the level pictures (a module's own photograph at level 2 and at level 3) to the art pack.
//   node tools/level-art.js <folder holding levels.json and art/modules/{512,256}>
// The folder is what Build the Ages' tools/level-art-finish.mjs portsolace writes (masters/portsolace-levels/web): a
// whole set that has passed its checks, never a part of one. This copies the WebP files into play/assets/art/modules
// and adds <id>@2 and <id>@3 to ARTPACK's module list in play/js/artpack.js. The engine loads one when a module
// reaches that level and falls back to the level below. tools/art-build.js rewrites artpack.js from the pack, so run
// this again after it.
'use strict';
const fs = require('fs'), path = require('path');
const SRC = process.argv[2], PLAY = path.join(__dirname, '..', 'play');
if (!SRC || !fs.existsSync(path.join(SRC, 'levels.json'))) { console.error('usage: node tools/level-art.js <folder with levels.json>'); process.exit(2); }
const lv = JSON.parse(fs.readFileSync(path.join(SRC, 'levels.json'), 'utf8'));
const file = path.join(PLAY, 'js', 'artpack.js'), src = fs.readFileSync(file, 'utf8'), NL = src.includes('\r\n') ? '\r\n' : '\n';
const a = src.indexOf('const ARTPACK = '), b = src.indexOf(';' + NL + 'ARTPACK.url', a);
if (a < 0 || b < 0) { console.error('artpack.js no longer has the shape the level pictures are added to'); process.exit(1); }
const pack = JSON.parse(src.slice(a + 16, b)), have = new Set(pack.groups.modules.ids);
const stray = lv.ids.filter(id => !have.has(id.replace(/@[23]$/, '')));
if (stray.length) { console.error(`level pictures for modules this game does not have: ${stray.join(', ')}`); process.exit(1); }
const whole = [...have].filter(id => !id.includes('@')).every(id => lv.ids.includes(`${id}@2`) && lv.ids.includes(`${id}@3`));
if (!whole) { console.error('not a whole set: every module needs its level 2 and its level 3 picture'); process.exit(1); }
let files = 0;
for (const size of ['512', '256']) for (const id of lv.ids) {
  const from = path.join(SRC, 'art', 'modules', size, `${id}.webp`);
  if (!fs.existsSync(from)) { console.error(`missing ${from}`); process.exit(1); }
  fs.copyFileSync(from, path.join(PLAY, 'assets', 'art', 'modules', size, `${id}.webp`)); files++;
}
pack.groups.modules.ids.push(...lv.ids.filter(id => !have.has(id)));
fs.writeFileSync(file, src.slice(0, a + 16) + JSON.stringify(pack, null, 1).split('\n').join(NL) + src.slice(b));
console.log(`added ${lv.ids.length} level pictures (${files} files) to the pack`);

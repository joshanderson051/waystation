// Emit an SVG <symbol> sprite from the ICONS library in play/js/art.js so the landing page
// uses the exact same paths as the game. Usage: node sprite.js <art.js> <ids,comma,separated>
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
const m = src.match(/const ICONS = \{[\s\S]*?\n\};/);
const ctx = {}; vm.createContext(ctx); vm.runInContext(m[0].replace('const ICONS', 'ICONS'), ctx);
const ids = process.argv[3].split(',');
const out = ids.map(id => {
  const ic = ctx.ICONS[id]; if (!ic) throw new Error('no icon ' + id);
  const paint = ic.fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  return `  <symbol id="i-${id}" viewBox="0 0 24 24"><path d="${ic.d}" ${paint}/></symbol>`;
}).join('\n');
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">\n${out}\n</svg>\n`);

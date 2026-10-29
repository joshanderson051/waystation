// Tiny static server for local play. No dependencies.
//   node serve.js                            -> http://localhost:8787/          (landing)  /play/ (game)
//   node serve.js --port 8788 --base /waystation
//       serves the same folder under a path prefix, the way a GitHub Pages project site does,
//       so relative links can be checked before deploying.
// Directories resolve to their index.html; missing files get 404.html.
const http = require('http'), fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const root = __dirname;
const port = Number(opt('--port', process.env.PORT || 8787));
let base = String(opt('--base', process.env.BASE || '/')).replace(/^\/+|\/+$/g, '');
base = base ? `/${base}/` : '/';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
function send(res, status, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(status, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (base !== '/') {
    if (p === base.slice(0, -1)) { res.writeHead(302, { Location: base }); return res.end(); }
    if (!p.startsWith(base)) return send(res, 404, path.join(root, '404.html'));
    p = '/' + p.slice(base.length);
  }
  let file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(302, { Location: base.slice(0, -1) + p + '/' }); return res.end(); }
      file = path.join(file, 'index.html');
    }
    fs.access(file, e => e ? send(res, 404, path.join(root, '404.html')) : send(res, 200, file));
  });
}).listen(port, () => console.log(`Port Solace running at http://localhost:${port}${base}`));

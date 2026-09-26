// Static server for bench/ (harness page + engine builds). POST /save?path=<rel> writes the body under bench/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { encodePNG } from './png.mjs';
import { fileURLToPath } from 'node:url';

export const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.css': 'text/css' };

function safe(rel) {
  const p = path.resolve(BENCH, '.' + path.sep + rel);
  if (!p.startsWith(BENCH + path.sep)) throw new Error('path escapes bench/: ' + rel);
  return p;
}

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'POST' && url.pathname === '/save') {
        const file = safe(url.searchParams.get('path'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (url.searchParams.has('w')) { // raw top-down RGBA8 rows, encoded here
          const parts = [];
          req.on('data', (d) => parts.push(d));
          req.on('end', () => { fs.writeFileSync(file, encodePNG(Buffer.concat(parts), +url.searchParams.get('w'), +url.searchParams.get('h'))); res.writeHead(200); res.end('ok'); });
          return;
        }
        const out = fs.createWriteStream(file);
        req.pipe(out);
        out.on('finish', () => { res.writeHead(200); res.end('ok'); });
        out.on('error', (e) => { res.writeHead(500); res.end(String(e)); });
        return;
      }
      const file = safe(decodeURIComponent(url.pathname));
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store',
        // cross-origin isolation gives performance.now() 5 us resolution instead of 100 us
        'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(404); res.end(String(e.message));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://localhost:${server.address().port}` })));
}

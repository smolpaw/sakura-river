// The service worker (registered by ui.js on the built site; vite.config.js writes it into dist/ as sw.js with this
// build's VERSION and ASSETS filled in). It makes a repeat visit fetch next to nothing without ever serving an old page:
// - the page (a navigation) from the network every time, revalidated past the browser's cache; the copy kept is used
//   only when the network fails (offline);
// - the files from public/ that the page asks for by a versioned URL (`?v=<content hash>`, assets.js) from the cache,
//   fetched once. A deploy that changes a file changes its URL, so a new page never gets an old copy, even from this
//   worker's previous version while it still runs the page; the new version, once active, drops whatever its build
//   no longer lists. Unchanged files keep their hash and stay cached across deploys;
// - requests for a byte range (the music, streamed by media elements) and anything else to the network as usual.
const VERSION = '__SR_VERSION__'; // this build's (the page's and its files' hash): every deploy installs a new worker
const ASSETS = __SR_ASSETS__; // path under the scope -> content hash
const PAGE = 'sr-page', FILES = 'sr-files';
const SCOPE = new URL(self.registration.scope);

const url = (path) => new URL(`${path}?v=${ASSETS[path]}`, SCOPE).href;

// What every visit fetches is kept at once (the worker is registered once the scene shows, so the browser's own cache
// still holds it); the rest (sounds, the walker, the Ultra tier's models) as the page asks for it.
self.addEventListener('install', (e) => e.waitUntil((async () => {
  const c = await caches.open(FILES);
  await Promise.all(Object.keys(ASSETS).filter((p) => /^(textures|basis)\//.test(p) || p === 'models/figures.glb').map(async (p) => {
    if (await c.match(url(p))) return;
    const res = await fetch(url(p));
    if (res.status === 200) await c.put(url(p), res);
  })).catch(() => {}); // (whatever failed is kept when the page next asks for it)
  await self.skipWaiting();
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== PAGE && k !== FILES) await caches.delete(k);
  const files = await caches.open(FILES);
  for (const req of await files.keys()) if (!current(new URL(req.url))) await files.delete(req);
  await self.clients.claim();
})()));

// the path of a versioned file of this build, or null
function current(u) {
  if (u.origin !== SCOPE.origin || !u.pathname.startsWith(SCOPE.pathname)) return null;
  const path = decodeURIComponent(u.pathname.slice(SCOPE.pathname.length));
  return ASSETS[path] && u.searchParams.get('v') === ASSETS[path] ? path : null;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') { e.respondWith(page(req, e)); return; }
  if (req.headers.has('range') || !current(new URL(req.url))) return;
  e.respondWith(file(req, e));
});

async function page(req, e) {
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok && new URL(req.url).pathname.startsWith(SCOPE.pathname)) {
      const copy = res.clone();
      e.waitUntil(caches.open(PAGE).then((c) => c.put(SCOPE.href, copy)));
    }
    return res;
  } catch (err) {
    const kept = await caches.match(SCOPE.href, { cacheName: PAGE });
    if (kept) return kept;
    throw err;
  }
}

async function file(req, e) {
  const c = await caches.open(FILES);
  const hit = await c.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200) e.waitUntil(c.put(req.url, res.clone()));
  return res;
}

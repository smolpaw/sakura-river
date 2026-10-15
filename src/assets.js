// The URL of a file the page fetches from public/ (textures/…, models/…, audio/…, basis/…), beside the page. In a
// `vite build` the build's plugin (vite.config.js) puts each file's content hash into __SR_ASSETS__, and the URL
// carries it (`?v=<hash>`): the service worker (src/sw.js) keeps such a file for good, and a deploy that changes the
// file changes its URL, so neither the worker nor the browser's cache can hand an old copy to a new page. Elsewhere
// (the dev server, the bench's builds) the URL is plain.
/* global __SR_ASSETS__ */
const HASHES = typeof __SR_ASSETS__ !== 'undefined' ? __SR_ASSETS__ : {};

export const assetUrl = (path) => {
  const u = new URL(path, document.baseURI);
  if (HASHES[path]) u.searchParams.set('v', HASHES[path]);
  return u.href;
};

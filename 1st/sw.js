/* PowerPrep service worker — offline support.
   Shell: network-first (so updates land immediately when online).
   Bank: cache-first (large, versioned by build). */
const VERSION = '35cf4734';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest'];
const SHELL_CACHE = 'pp-shell-' + VERSION;
const BANK_CACHE = 'pp-bank-' + VERSION;

self.addEventListener('install', e => {
  // pre-cache the bank too, so shell and bank flip versions atomically
  e.waitUntil(Promise.all([
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)),
    caches.open(BANK_CACHE).then(c => c.add('./bank.enc.json')),
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== BANK_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // sync POSTs etc. pass through
  if (url.pathname.endsWith('bank.enc.json')) {
    e.respondWith(
      caches.open(BANK_CACHE).then(c => c.match(e.request).then(hit => hit ||
        fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })))
    );
    return;
  }
  // network-first with a 4s timeout so a weak signal falls back to cache instead of stalling launch
  e.respondWith((async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(e.request, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) caches.open(SHELL_CACHE).then(c => c.put(e.request, r.clone()));
      return r;
    } catch (err) {
      clearTimeout(timer);
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

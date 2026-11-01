// Offline cache for the app shell (only active when served over http/https).
const CACHE = 'mdreader-v2';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/bib.js',
  './js/markdown.js',
  './js/editor.js',
  './js/welcome.js',
  './js/app.js',
  './icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Network first for the app itself (so updates arrive), cache first for CDN libraries.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isCdn = url.hostname === 'cdnjs.cloudflare.com';
  if (url.origin !== location.origin && !isCdn) return;
  if (isCdn) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          })
      )
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

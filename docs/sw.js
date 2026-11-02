// Keeps the app opening when the phone is offline. Network first, so an update to the app arrives
// the next time it opens online; the saved copy is only the fallback. Requests to the inbox
// (another origin) are never touched.

const CACHE = 'masroofi-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './worker.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/app.js',
  './js/actions.js',
  './js/export.js',
  './js/format.js',
  './js/guide.js',
  './js/ingest.js',
  './js/merchants.js',
  './js/merge.js',
  './js/model.js',
  './js/normalize.js',
  './js/parser.js',
  './js/periods.js',
  './js/store.js',
  './js/sync.js',
  './js/views.js',
  './js/wallet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});

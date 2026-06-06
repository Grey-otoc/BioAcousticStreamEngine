// BASE Viewer — service worker
// Caches the app shell so the PWA loads instantly from home screen and works offline.
// Does NOT handle MQTT streaming — that requires an active network connection.

const CACHE = 'base-viewer-v1';

const SHELL = [
  './',
  './viewer.js',
  './viewer.css',
  './mqtt.min.js',
  './manifest.json',
  './assets/base-logo.png',
  './assets/icons/icon-16.png',
  './assets/icons/icon-32.png',
  './assets/icons/icon-180.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/favicon.ico',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for shell assets; network-first for everything else.
// Cross-origin requests (MQTT broker, image CDNs) are never intercepted.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fromNetwork = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => cached);          // network failed — fall back to cache
      return cached || fromNetwork;
    })
  );
});

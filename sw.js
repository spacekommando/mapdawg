/**
 * sw.js — Service Worker for GeoPDF Navigator
 * Caches the app shell (HTML/CSS/JS) for offline use.
 * Map PDFs are NOT cached — they're loaded from device storage each time.
 */

const CACHE_NAME = 'geopdf-navigator-v1';
const CACHE_URLS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/pdf-parser.js',
  './js/gps.js',
  './js/gpx-export.js',
  './manifest.json',
];

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: serve from cache, fall back to network
self.addEventListener('fetch', event => {
  // Don't intercept CDN requests (pdf.js) — they have their own caching
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET requests for app files
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback
        return caches.match('./index.html');
      });
    })
  );
});

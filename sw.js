// Meeting Copilot Service Worker
const CACHE_NAME = 'meeting-copilot-v33';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700;900&display=swap'
];

// Install: cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for HTML/navigation, cache-first for static assets, native for API calls
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API and Local Server calls: DO NOT call event.respondWith, let the browser handle network natively!
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('google.com') || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return;
  }

  // HTML / page navigation: network-first so updates take effect immediately without stale cache
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets (icons, fonts, manifest): cache-first
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

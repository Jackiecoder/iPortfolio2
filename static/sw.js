// Service worker for Portfolio Tracker PWA.
// Goal: make the app installable + launchable offline, WITHOUT ever caching
// API responses (live prices / authenticated data must always hit the network).

const CACHE = 'portfolio-shell-v1';

// App shell: enough to render the page chrome offline. The page then fetches
// live data over the network (and shows its own loading/empty state offline).
const SHELL = [
  '/',
  '/static/css/style.css',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // CDN libs: let the browser handle
  if (url.pathname.startsWith('/api/')) return;          // never cache API/auth responses

  // Navigations (opening the app): network-first, fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets: cache-first, then populate cache on miss.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(req, copy));
      return res;
    }).catch(() => hit))
  );
});

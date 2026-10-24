// Service worker: makes the app shell available offline.
//
// Bump VERSION whenever a shell file changes, so devices drop the old cache.
// Cards and images are not cached here; they live in IndexedDB, and GitHub
// API calls always go to the network.

const VERSION = 'v3';
const CACHE = `studycards-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/app.js',
  'js/ui.js',
  'js/store.js',
  'js/sync.js',
  'js/github.js',
  'js/images.js',
  'js/render.js',
  'js/lib/util.js',
  'js/lib/srs.js',
  'js/lib/merge.js',
  'js/lib/session.js',
  'js/lib/bulk.js',
  'vendor/marked.esm.js',
  'vendor/purify.es.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('studycards-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Network first for the app's own files, falling back to the cache. When
// online you always get the latest deploy; when offline the app still opens.
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Data files in the repo are read through the GitHub API, never from Pages.
  if (url.pathname.includes('/data/')) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return caches.match('index.html');
      throw new Error('offline');
    }
  })());
});

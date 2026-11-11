const CACHE_NAME = 'thaisanpro-v6';
const ASSETS = [
  '/',
  '/index.html',
  '/huong-dan.html',
  '/chinh-sach-bao-mat.html',
  '/dieu-khoan.html',
  '/lien-he.html',
  '/favicon.svg',
  '/manifest.json',
  '/affiliate.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request)).then((res) => res || caches.match('/index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((res) => {
      return res || fetch(e.request).catch(() => caches.match('/index.html'));
    })
  );
});

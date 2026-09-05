/**
 * FREAKSHOW TOPUP - PWA HIGH-PERFORMANCE SERVICE WORKER
 * Version: 3.0.0
 */

const CACHE_NAME = 'freakshow-topup-v14.0';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/INDEX.HTML',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/assets/logo.jpg',
  '/assets/ff_diamond.jpg',
  '/assets/ff_membership_v2.jpg',
  '/assets/ff_membership.jpg',
  '/assets/ff_levelup.jpg',
  '/assets/less_is_more.png',
  '/assets/pubg_uc.jpg',
  '/assets/mlbb_diamond.jpg',
  '/assets/tiktok_coins.jpg',
  '/assets/youtube_premium.jpg',
  '/assets/garena_voucher.jpg',
  '/assets/hero_banner.jpg',
  '/assets/promo_banner.jpg',
  '/assets/bqr.png'
];

// Install Event - Resilient pre-caching
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await Promise.allSettled(
        STATIC_ASSETS.map(url =>
          fetch(url)
            .then(res => {
              if (res.ok) return cache.put(url, res);
            })
            .catch(() => {})
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up stale caches immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Smart Caching Strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Handle Public API Requests: Network-First (Never serve stale settings)
  if (url.pathname.startsWith('/api/settings/public')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (url.pathname === '/api/products') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Skip dynamic user/admin APIs from static cache
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Handle Scripts and HTML: Network-First to guarantee real-time updates
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('.js')) {
    event.respondWith(
      fetch(event.request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Handle Static Assets (Images, CSS, Fonts): Cache-First / SWR
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {});

      return cachedResponse || fetchPromise;
    })
  );
});

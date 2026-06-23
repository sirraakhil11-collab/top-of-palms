const CACHE = 'topp-v2';
const SHELL = ['/pos', '/reserve', '/manager/dashboard', '/login'];

self.addEventListener('install', e => {
  self.skipWaiting();
  // Don't pre-cache — just activate immediately
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Never cache API calls or POST requests
  if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/email/')) return;

  // Network-first for HTML pages (always fresh data)
  if (request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      fetch(request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for static assets (CSS/JS embedded in HTML, icons, fonts)
  e.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(resp => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(request, clone));
      }
      return resp;
    }))
  );
});

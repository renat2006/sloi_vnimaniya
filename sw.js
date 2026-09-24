const VERSION = 'sloi-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/stage.js',
  './js/paint.js',
  './js/geom.js',
  './js/session.js',
  './js/store.js',
  './js/archive.js',
  './js/audio.js',
  './js/net.js',
  './js/config.js',
  './js/native.js',
  './js/updates.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll().then((cls) =>
        cls.forEach((c) => c.postMessage({ type: 'updated' }))
      ))
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin &&
      (url.pathname.startsWith('/presence/') || url.pathname.startsWith('/push/') || url.pathname === '/cores')) {
    e.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ offline: true }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      ))
    );
    return;
  }

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true })
        .then((r) => r || new Response('Офлайн', { status: 503 })))
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    if (!/(^|\.)(googleapis|gstatic)\.com$/.test(url.hostname)) return;
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => hit || new Response('', { status: 504 })))
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || new Response('', { status: 504 })))
  );
});

/* ── push / notifications ────────────────────────────────── */
self.addEventListener('push', (e) => {
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
      const hasVisibleFocused = cls.some((c) => c.visibilityState === 'visible' && c.focused);
      if (hasVisibleFocused) return;

      let title = 'Слои внимания';
      let body = 'Сеанс завершён — можно извлечь керн';
      let url = './?go=stage';
      try {
        if (e.data) {
          const d = e.data.json();
          if (d) {
            if (d.title) title = d.title;
            if (d.body) body = d.body;
            if (d.url) url = d.url;
          }
        }
      } catch {}

      return self.registration.showNotification(title, {
        body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: 'sloi-session',
        renotify: false,
        data: { url }
      });
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const targetUrl = (e.notification && e.notification.data && e.notification.data.url) || './?go=stage';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
      for (const c of cls) {
        if (new URL(c.url).origin === self.location.origin) {
          return c.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'notify') {
    self.registration.showNotification(e.data.title || 'Слои внимания', {
      body: e.data.body || '',
      icon: './icons/icon-192.png',
      tag: 'sloi-session'
    });
  }
});

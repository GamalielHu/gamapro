/**
 * Service worker: la app funciona sin red (shell + librerías en caché).
 * - Archivos de la app: red primero (cada publicación se ve al instante),
 *   caché solo si no hay conexión.
 * - Librerías de CDN (URLs con versión fija): caché primero.
 * La API del panel, el proxy y los streams nunca pasan por aquí.
 */
const VERSION = 'gamapro-v4';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'src/styles.css', 'src/main.js',
  'src/services/xtream.js', 'src/services/cache.js', 'src/player/engine.js', 'src/player/wakelock.js', 'src/player/nosleep.mp4',
  'src/services/catalog-store.js', 'src/workers/catalog-core.js', 'src/workers/catalog-parser.worker.js',
  'src/ui/dom.js', 'src/ui/login.js', 'src/ui/catalog.js', 'src/ui/player-ui.js', 'src/ui/settings.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];
const CDN = [
  'https://cdn.tailwindcss.com/3.4.16',
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.mjs',
  'https://cdn.jsdelivr.net/npm/idb-keyval@6.2.1/+esm',
];
const CDN_HOSTS = new Set(['cdn.tailwindcss.com', 'cdn.jsdelivr.net']);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    await Promise.all(CDN.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && (url.pathname.includes('/proxy') || url.pathname.endsWith('.php'))) return;
  if (!sameOrigin && !CDN_HOSTS.has(url.hostname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (!sameOrigin) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req, sameOrigin ? { cache: 'no-cache' } : undefined);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

/**
 * Service worker: la app arranca al instante y sin red (shell + librerías en caché).
 * Estrategia stale-while-revalidate solo para la app y los CDN; la API del panel,
 * el proxy y los streams nunca pasan por aquí.
 */
const VERSION = 'gamapro-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'src/styles.css', 'src/main.js',
  'src/services/xtream.js', 'src/services/cache.js', 'src/player/engine.js',
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
    const hit = await cache.match(req, { ignoreSearch: sameOrigin });
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    if (hit) {
      event.waitUntil(network);
      return hit;
    }
    return network;
  })());
});

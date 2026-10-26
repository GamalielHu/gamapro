# GamaPro

Cliente web IPTV ultraligero para la API Xtream Codes. Sin build: HTML + Tailwind (CDN) + ESM nativo + `hls.js` + `idb-keyval`. `mpegts.js` se carga solo si hace falta reproducir `.ts`.

## Uso

```bash
npm start            # http://127.0.0.1:8787 (app + proxy CORS en /proxy?url=)
npm run start:lan    # igual, pero accesible desde celulares/tablets de la misma red (muestra la IP)
```

También funciona en cualquier hosting estático (GitHub Pages, Netlify). En ese caso, si el panel bloquea CORS o usa `http://` en una página `https://`, configura un proxy en **Ajustes** o define antes de cargar la app:

```html
<script>window.GAMAPRO_CONFIG = { corsProxy: 'https://mi-proxy/?url={url}', corsProxyMode: 'auto' };</script>
```

## Estructura

| Ruta | Rol |
|---|---|
| `index.html` | Shell tipo TV: sidebar, grid, reproductor fullscreen |
| `src/services/xtream.js` | Cliente API Xtream + URLs de streaming + proxy CORS (off/auto/always) |
| `src/services/cache.js` | IndexedDB (catálogos con TTL y copia de respaldo) y credenciales cifradas AES-GCM |
| `src/player/engine.js` | hls.js baja latencia, reconexión, watchdog, fallback m3u8 → ts → proxy, limpieza de memoria |
| `src/ui/login.js` | Acceso y "Probar conexión" |
| `src/ui/catalog.js` | Grid virtual (solo tarjetas visibles en el DOM), búsqueda en tiempo real, series |
| `src/ui/player-ui.js` | OSD: audio, subtítulos, zapping, teclado/mando/control TV |
| `src/ui/settings.js` | Ajustes |
| `server.mjs` | Servidor local opcional (estático + proxy CORS, sin dependencias) |

## Controles del reproductor

↑/↓ o CH+/CH− cambian de canal · dígitos saltan al número de canal · ←/→ ±10 s en VOD · Espacio pausa · A audio · S subtítulos · F pantalla completa · Esc/Atrás sale. Mandos compatibles con la Gamepad API.

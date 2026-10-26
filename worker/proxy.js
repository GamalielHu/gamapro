/**
 * Núcleo del proxy CORS, basado en fetch estándar: lo usan el Worker de
 * Cloudflare (worker/index.js) y el servidor local (server.mjs).
 *
 *   GET /proxy?url=<destino>            → reenvía con cabeceras CORS
 *   GET /proxy?url=<m3u8>&mode=proxy    → además reescribe el playlist para que
 *                                         cada segmento también pase por el proxy
 *                                         (reproductor nativo de Safari/iPad)
 *   GET /proxy/health                   → "gamapro-proxy"
 *   GET /proxy/debug?url=<destino>      → JSON con la cadena de redirecciones y la
 *                                         respuesta del panel vista desde el proxy
 */

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range, content-type',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges, content-type',
};

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control'];
const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

/** Convierte cada URI del playlist en absoluta y, opcionalmente, la envuelve. */
export function rewritePlaylist(text, base, wrap = (u) => u) {
  const abs = (u) => { try { return wrap(new URL(u, base).href); } catch { return u; } };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u)}"`);
    return abs(t);
  }).join('\n');
}

const text = (body, status = 200) => new Response(body, { status, headers: CORS });

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Cloudflare Workers no puede conectarse a IPs literales (error 1003). Muchos paneles
 *  redirigen el stream a http://IP/...; se usa un nombre DNS comodín que resuelve
 *  a esa misma IP (149.51.42.6 → 149.51.42.6.nip.io). */
export function aliasIpHost(url, enabled) {
  if (!enabled) return url;
  const u = new URL(url);
  if (!IPV4.test(u.hostname)) return url;
  u.hostname = `${u.hostname}.nip.io`;
  return u.href;
}

/** fetch siguiendo redirecciones a mano, para poder aplicar aliasIpHost en cada salto.
 *  Devuelve la respuesta final y su URL real (sin alias), base para reescribir playlists. */
async function fetchFollow(target, init, ipAlias, onHop) {
  let url = target;
  for (let i = 0; i < 8; i++) {
    const fetchUrl = aliasIpHost(url, ipAlias);
    const res = await fetch(fetchUrl, { ...init, redirect: 'manual' });
    const loc = res.headers.get('location');
    onHop?.(url, fetchUrl, res);
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      url = new URL(loc, url).href;
      continue;
    }
    return { res, url };
  }
  throw new Error('demasiadas redirecciones');
}

const mask = (url) => url.replace(/\/\/([^/]+)\/([^/]+)\/([^/]+)\//, '//$1/***/***/');

/** Diagnóstico: qué ve el proxy al pedir la URL (redirecciones, estado, tipo, primeros bytes). */
async function debug(target, userAgent, ipAlias) {
  const hops = [];
  try {
    const { res } = await fetchFollow(target, { headers: { 'user-agent': userAgent, accept: '*/*' } }, ipAlias, (url, fetchUrl, r) => {
      hops.push({ url: mask(url), ...(fetchUrl !== url ? { via: new URL(fetchUrl).host } : {}), status: r.status, type: r.headers.get('content-type') });
    });
    const reader = res.body?.getReader();
    const chunk = reader ? (await reader.read()).value : null;
    await reader?.cancel();
    hops[hops.length - 1].sample = chunk ? new TextDecoder().decode(chunk.slice(0, 160)).replace(/[^\x20-\x7e\n]/g, '.') : '';
  } catch (err) {
    hops.push({ error: err.message });
  }
  return new Response(JSON.stringify({ hops }, null, 2), { headers: { ...CORS, 'content-type': 'application/json' } });
}

/**
 * @param {Request} request
 * @param {{ allowHosts?: string[], userAgent?: string, ipAlias?: boolean }} [opts]
 * @returns {Promise<Response>}
 */
export async function handleProxy(request, { allowHosts = [], userAgent = DEFAULT_UA, ipAlias = false } = {}) {
  const self = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (self.pathname.endsWith('/health')) return text('gamapro-proxy');
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('método no permitido', 405);

  let target;
  try { target = new URL(self.searchParams.get('url') || ''); } catch { return text('url inválida', 400); }
  if (!/^https?:$/.test(target.protocol)) return text('protocolo no permitido', 400);
  if (allowHosts.length && !allowHosts.includes(target.hostname)) return text('host no permitido', 403);
  if (self.pathname.endsWith('/debug')) return debug(target.href, userAgent, ipAlias);

  const headers = { 'user-agent': userAgent, accept: '*/*' };
  const range = request.headers.get('range');
  if (range) headers.range = range;

  let upstream, finalUrl;
  try {
    ({ res: upstream, url: finalUrl } = await fetchFollow(target.href, { headers, signal: request.signal }, ipAlias));
  } catch (err) {
    return text(`upstream: ${err.message}`, 502);
  }

  const out = new Headers(CORS);
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }

  const type = upstream.headers.get('content-type') || '';
  const isPlaylist = /mpegurl/i.test(type) || /\.m3u8?$/i.test(new URL(finalUrl).pathname);
  if (isPlaylist && upstream.ok) {
    const wrap = self.searchParams.get('mode') === 'proxy'
      ? (u) => `${self.origin}${self.pathname}?url=${encodeURIComponent(u)}&mode=proxy`
      : undefined;
    const body = rewritePlaylist(await upstream.text(), finalUrl, wrap);
    out.delete('content-length');
    out.set('content-type', 'application/vnd.apple.mpegurl');
    out.set('cache-control', 'no-cache');
    return new Response(request.method === 'HEAD' ? null : body, { status: upstream.status, headers: out });
  }
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}

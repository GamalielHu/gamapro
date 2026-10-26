#!/usr/bin/env node
/**
 * Servidor local opcional de GamaPro (sin dependencias, Node 18+):
 *  - Sirve la app estática.
 *  - /proxy?url=<destino>  → proxy CORS para paneles que bloquean el navegador.
 *    Reenvía Range (seek en VOD), sigue redirecciones y reescribe playlists
 *    .m3u8 a URLs absolutas para que hls.js resuelva bien los segmentos.
 *
 * Variables: PORT (8787), HOST (127.0.0.1), ALLOW_HOSTS ("a.tv,b.tv"), PROXY_UA.
 * `--lan` escucha en 0.0.0.0 para abrir la app desde celulares/tablets de la misma red.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');
const ALLOW = (process.env.ALLOW_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const UA = process.env.PROXY_UA || 'VLC/3.0.20 LibVLC/3.0.20';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range, content-type',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges, content-type',
};
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control'];

function rewritePlaylist(text, base) {
  const abs = (u) => { try { return new URL(u, base).href; } catch { return u; } };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u)}"`);
    return abs(t);
  }).join('\n');
}

async function proxy(req, res, target) {
  let url;
  try { url = new URL(target); } catch { res.writeHead(400, CORS).end('url inválida'); return; }
  if (!/^https?:$/.test(url.protocol)) { res.writeHead(400, CORS).end('protocolo no permitido'); return; }
  if (ALLOW.length && !ALLOW.includes(url.hostname)) { res.writeHead(403, CORS).end('host no permitido'); return; }

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const headers = { 'user-agent': UA, accept: '*/*' };
  if (req.headers.range) headers.range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, CORS).end(`upstream: ${err.message}`);
    return;
  }

  const out = { ...CORS };
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  const type = upstream.headers.get('content-type') || '';
  const isPlaylist = /mpegurl/i.test(type) || /\.m3u8?$/i.test(new URL(upstream.url).pathname);
  if (isPlaylist && upstream.ok) {
    const body = rewritePlaylist(await upstream.text(), upstream.url);
    delete out['content-length'];
    res.writeHead(upstream.status, { ...out, 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache' });
    res.end(body);
    return;
  }
  res.writeHead(upstream.status, out);
  if (req.method === 'HEAD' || !upstream.body) { res.end(); return; }
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(ROOT, rel || 'index.html');
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404).end('no encontrado');
  }
}

createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://local');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }
  if (pathname === '/proxy/health') { res.writeHead(200, CORS).end('gamapro-proxy'); return; }
  if (pathname === '/proxy') { proxy(req, res, searchParams.get('url') || ''); return; }
  serveStatic(req, res, pathname);
}).listen(PORT, HOST, () => {
  console.log(`GamaPro → http://127.0.0.1:${PORT}  (proxy CORS en /proxy?url=)`);
  if (HOST === '0.0.0.0') {
    const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    for (const ip of ips) console.log(`  En la red local: http://${ip.address}:${PORT}`);
  }
});

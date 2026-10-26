#!/usr/bin/env node
/**
 * Servidor local opcional de GamaPro (sin dependencias, Node 18+):
 *  - Sirve la app estática.
 *  - /proxy?url=<destino>  → proxy CORS (misma lógica que el Worker, ver worker/proxy.js).
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
import { handleProxy } from './worker/proxy.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');
const ALLOW = (process.env.ALLOW_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const UA = process.env.PROXY_UA || undefined;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

async function proxy(req, res) {
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const request = new Request(`http://${req.headers.host || 'local'}${req.url}`, {
    method: req.method,
    headers: req.headers.range ? { range: req.headers.range } : {},
    signal: ctrl.signal,
  });
  const response = await handleProxy(request, { allowHosts: ALLOW, userAgent: UA });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { res.end(); return; }
  Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
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
  const { pathname } = new URL(req.url, 'http://local');
  if (pathname === '/proxy' || pathname.startsWith('/proxy/')) {
    proxy(req, res).catch(() => res.destroy());
    return;
  }
  serveStatic(req, res, pathname);
}).listen(PORT, HOST, () => {
  console.log(`GamaPro → http://127.0.0.1:${PORT}  (proxy CORS en /proxy?url=)`);
  if (HOST === '0.0.0.0') {
    const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    for (const ip of ips) console.log(`  En la red local: http://${ip.address}:${PORT}`);
  }
});

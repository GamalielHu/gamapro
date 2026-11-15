/**
 * Conversión al vuelo de .mkv/.avi a HLS para Safari (iPad/iPhone), que no abre
 * Matroska. Solo en el servidor Node (Render / npm start), no en Cloudflare.
 *
 *   GET /remux/health            → "gamapro-remux" si hay ffmpeg disponible
 *   GET /remux?url=<archivo>     → arranca ffmpeg y redirige a /remux/<id>/index.m3u8
 *   GET /remux/<id>/<archivo>    → playlist y segmentos generados
 *
 * El video se copia sin recodificar (casi sin CPU); el audio se pasa a AAC estéreo
 * porque AC3/DTS no siempre se oyen en el navegador. Las sesiones sin uso se borran.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(tmpdir(), 'gamapro-remux');
const IDLE_MS = 120_000;
const MAX_SESSIONS = 2;
const READY_TIMEOUT_MS = 70_000;
const UA = process.env.PROXY_UA || 'VLC/3.0.20 LibVLC/3.0.20';

/** Ruta de ffmpeg: FFMPEG_PATH, paquete ffmpeg-static o el del sistema. */
async function findFfmpeg() {
  const candidates = [process.env.FFMPEG_PATH];
  try { candidates.push((await import('ffmpeg-static')).default); } catch { /* no instalado */ }
  candidates.push('ffmpeg');
  for (const bin of candidates.filter(Boolean)) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }); return bin; } catch { /* siguiente */ }
  }
  return null;
}

const FFMPEG = await findFfmpeg();
if (FFMPEG) console.log(`  Conversión .mkv → HLS activa (${FFMPEG})`);

const sessions = new Map(); // id → { proc, dir, last, ready: Promise<void>, error }

const text = (res, status, body) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' }).end(body);

async function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.proc?.kill('SIGKILL'); } catch { /* ya terminó */ }
  await rm(s.dir, { recursive: true, force: true }).catch(() => {});
}

setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.last > IDLE_MS) killSession(id);
}, 30_000).unref();

/** Lee la cabecera del archivo para saber el códec de video (HEVC necesita la etiqueta hvc1 en Safari). */
function probeVideoCodec(url) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-probesize', '1M', '-analyzeduration', '2M', '-user_agent', UA, '-i', url], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 10_000);
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      clearTimeout(timer);
      resolve(/Video:\s*(hevc|h265)/i.test(err) ? 'hevc' : 'other');
    });
  });
}

async function waitForPlaylist(s) {
  const file = join(s.dir, 'index.m3u8');
  const t0 = Date.now();
  while (Date.now() - t0 < READY_TIMEOUT_MS) {
    if (s.error) throw new Error(s.error);
    try {
      if (/#EXTINF/.test(await readFile(file, 'utf8'))) return;
    } catch { /* aún no existe */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('la conversión tardó demasiado en empezar');
}

function startSession(id, url, codecHint) {
  for (const old of [...sessions.keys()].slice(0, Math.max(0, sessions.size - MAX_SESSIONS + 1))) killSession(old);
  return createSession(id, url, codecHint);
}

/** Al reproducir de verdad, cortar las demás conversiones: el panel suele permitir
 *  pocas conexiones a la vez por cuenta. */
function keepOnly(id) {
  for (const other of [...sessions.keys()]) if (other !== id) killSession(other);
}

function createSession(id, url, codecHint) {
  const dir = join(ROOT, id);
  const session = { dir, url, last: Date.now(), error: null, proc: null, ready: null, t: { start: Date.now() }, log: '' };
  sessions.set(id, session);
  session.ready = (async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    // El panel ya informa el códec de los episodios: así se evita una conexión extra de análisis.
    const codec = codecHint ? (/hevc|h265/i.test(codecHint) ? 'hevc' : 'other') : await probeVideoCodec(url);
    session.codec = codec;
    session.t.probed = Date.now();
    if (sessions.get(id) !== session) throw new Error('sesión cancelada');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-probesize', '2M', '-analyzeduration', '3M',
      '-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', url,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-c:v', 'copy', ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
      '-c:a', 'aac', '-ac', '2', '-b:a', '160k',
      '-f', 'hls', '-hls_init_time', '2', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
      // H.264 en segmentos .ts (lo más compatible); HEVC exige fMP4 en Safari.
      ...(codec === 'hevc'
        ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 's%05d.m4s')]
        : ['-hls_segment_filename', join(dir, 's%05d.ts')]),
      join(dir, 'index.m3u8'),
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    session.proc = proc;
    proc.stderr.on('data', (d) => { session.log = (session.log + d).slice(-2000); });
    proc.on('close', (code) => {
      session.t.ended = Date.now();
      if (code && !session.error) session.error = `ffmpeg terminó (${code}): ${session.log.trim().split('\n').pop() || ''}`;
    });
    await waitForPlaylist(session);
    session.t.ready = Date.now();
  })();
  session.ready.catch((err) => { session.error ||= err.message; });
  return session;
}

const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.ts': 'video/mp2t' };

/** @returns {Promise<boolean>} true si la petición era de /remux */
export async function handleRemux(req, res, pathname, search) {
  if (pathname !== '/remux' && !pathname.startsWith('/remux/')) return false;
  if (pathname === '/remux/health') { text(res, FFMPEG ? 200 : 404, FFMPEG ? 'gamapro-remux' : 'sin ffmpeg'); return true; }
  if (!FFMPEG) { text(res, 501, 'ffmpeg no disponible en el servidor'); return true; }
  if (pathname === '/remux/status') {
    // Diagnóstico: cuánto tarda cada paso de cada conversión activa.
    const out = [];
    for (const [id, x] of sessions) {
      const files = await readdir(x.dir).catch(() => []);
      let bytes = 0;
      for (const f of files) bytes += (await stat(join(x.dir, f)).catch(() => ({ size: 0 }))).size;
      const ms = (k) => (x.t[k] ? x.t[k] - x.t.start : null);
      out.push({
        id, file: x.url.replace(/\/\/([^/]+)\/(\w+\/)?([^/]+)\/([^/]+)\//, '//$1/$2***/***/'), codec: x.codec,
        edadSeg: Math.round((Date.now() - x.t.start) / 1000), analisisMs: ms('probed'), primerSegmentoMs: ms('ready'), terminoMs: ms('ended'),
        segmentos: files.filter((f) => /\.(ts|m4s)$/.test(f)).length, MB: +(bytes / 1048576).toFixed(1),
        error: x.error, log: x.log.slice(-300),
      });
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(out, null, 2));
    return true;
  }

  if (pathname === '/remux') {
    let url;
    try { url = new URL(search.get('url') || ''); } catch { text(res, 400, 'url inválida'); return true; }
    if (!/^https?:$/.test(url.protocol)) { text(res, 400, 'protocolo no permitido'); return true; }
    const id = createHash('sha1').update(url.href).digest('hex').slice(0, 16);
    let s = sessions.get(id);
    if (s?.error) { await killSession(id); s = null; }
    const warm = search.get('warm') === '1';
    if (!warm) keepOnly(id);
    s ||= startSession(id, url.href, search.get('v'));
    s.last = Date.now();
    if (warm) {
      // Solo preparar: responder ya, la conversión sigue en segundo plano.
      s.ready.catch(() => {});
      text(res, 202, 'preparando');
      return true;
    }
    try {
      await s.ready;
    } catch (err) {
      await killSession(id);
      text(res, 502, `conversión: ${err.message}`);
      return true;
    }
    res.writeHead(302, { location: `/remux/${id}/index.m3u8`, 'access-control-allow-origin': '*', 'cache-control': 'no-store' }).end();
    return true;
  }

  const [, , id, file] = pathname.split('/');
  const s = sessions.get(id);
  if (!s || !/^[\w.-]+$/.test(file || '')) { text(res, 404, 'sesión terminada'); return true; }
  s.last = Date.now();
  const path = join(s.dir, file);
  try {
    let body = await readFile(path);
    const ext = file.slice(file.lastIndexOf('.'));
    if (ext === '.m3u8' && s.proc?.exitCode === 0 && !body.includes('#EXT-X-ENDLIST')) body = Buffer.concat([body, Buffer.from('#EXT-X-ENDLIST\n')]);
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': ext === '.m3u8' ? 'no-cache' : 'max-age=3600',
      'access-control-allow-origin': '*',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    text(res, 404, 'no encontrado');
  }
  return true;
}

/**
 * Motor de reproducción: hls.js / MPEG-TS (mpegts.js bajo demanda) / <video> nativo.
 *
 * - Recibe una lista ordenada de fuentes y cae a la siguiente si una falla
 *   (.m3u8 → .ts directo → mismas fuentes vía proxy CORS).
 * - Reconexión agresiva: reintentos con backoff, recuperación de errores de
 *   media, watchdog anti-congelamiento y salto al borde en vivo.
 * - Cada cambio de fuente destruye la instancia anterior (hls.destroy(),
 *   unload de mpegts, src del <video> y blobs revocados) para no filtrar memoria.
 *
 * - TTFF: búfer inicial corto, calidad mínima al arrancar (sube a la máxima que
 *   permita el ancho de banda tras 2 s estables) y manifiestos precargados.
 *
 * Eventos (EventTarget): 'source', 'state', 'tracks', 'error', 'autoplay-muted'.
 */
import Hls, { LoadStats } from 'hls.js';
import { proxify, proxifyPlaylist, isProxied } from '../services/xtream.js';

const MPEGTS_URL = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/+esm';

/** Arranque agresivo (TTFF bajo): búfer inicial corto, prefetch del primer fragmento,
 *  demux progresivo y calidad baja al inicio; sube de calidad tras 2 s estables. */
export const HLS_CONFIG = Object.freeze({
  enableWorker: true,
  lowLatencyMode: true,
  startFragPrefetch: true,
  progressive: true,
  maxBufferLength: 15,
  maxMaxBufferLength: 30,
  maxBufferSize: 30 * 1000 * 1000,
  startLevel: 0,
  backBufferLength: 20,
  liveSyncDurationCount: 3,
  manifestLoadingMaxRetry: 5,
  levelLoadingMaxRetry: 5,
  fragLoadingMaxRetry: 6,
  manifestLoadingRetryDelay: 500,
  levelLoadingRetryDelay: 500,
  fragLoadingRetryDelay: 500,
  manifestLoadingTimeOut: 10000,
  levelLoadingTimeOut: 10000,
  fragLoadingTimeOut: 20000,
  maxBufferHole: 0.5,
  nudgeMaxRetry: 10,
  liveDurationInfinity: true,
  maxLiveSyncPlaybackRate: 1.5,
  capLevelToPlayerSize: true,
});

const QUALITY_UP_MS = 2000;

// ---------- precarga predictiva de manifiestos (zapping rápido) ----------
const PREFETCH_TTL_MS = 6000; // un playlist en vivo más viejo ya no sirve de arranque
const PREFETCH_MAX = 8;
const prefetched = new Map(); // url original → { text, url (final), t } | { pending }

/**
 * Descarga el manifiesto HLS en memoria sin reproducir. Si el usuario abre ese
 * canal en los próximos segundos, hls.js lo recibe al instante (0 ms de red).
 * @param {string} streamUrl  URL .m3u8 original
 * @param {{ proxy?: boolean }} [opts]
 */
export function prefetchNextStream(streamUrl, { proxy = false } = {}) {
  if (!streamUrl) return;
  const hit = prefetched.get(streamUrl);
  if (hit && (hit.pending || Date.now() - hit.t < PREFETCH_TTL_MS)) return;
  const entry = { pending: true };
  prefetched.set(streamUrl, entry);
  while (prefetched.size > PREFETCH_MAX) prefetched.delete(prefetched.keys().next().value);
  const url = proxy ? proxify(streamUrl) : streamUrl;
  fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
    .then(async (res) => {
      const text = res.ok ? await res.text() : '';
      if (!text.startsWith('#EXTM3U')) throw new Error('no es un playlist');
      // Vía proxy, el playlist ya viene con URLs absolutas: la base es la URL original.
      prefetched.set(streamUrl, { text, url: proxy ? streamUrl : res.url || streamUrl, t: Date.now() });
    })
    .catch(() => { if (prefetched.get(streamUrl) === entry) prefetched.delete(streamUrl); });
}

function takePrefetched(url) {
  const hit = prefetched.get(url);
  if (!hit || hit.pending) return null;
  prefetched.delete(url);
  return Date.now() - hit.t < PREFETCH_TTL_MS ? hit : null;
}

/**
 * Loader de hls.js por composición (no herencia) para envolver el loader que hls.js
 * elija en tiempo de ejecución (FetchLoader progresivo o XhrLoader):
 *  - prefetch: sirve el manifiesto precargado sin tocar la red.
 *  - proxy: pasa cada petición por el proxy y conserva la URL original como base,
 *    para que los segmentos relativos del playlist se resuelvan bien.
 */
function makeLoader({ proxy = false, prefetch = false, Base = null } = {}) {
  return class GamaLoader {
    constructor(config) {
      this.inner = new (Base || config.loader)(config);
      this.stats = this.inner.stats;
      this.context = null;
    }

    load(context, config, callbacks) {
      this.context = context;
      const original = context.url;
      const hit = prefetch && context.type === 'manifest' ? takePrefetched(original) : null;
      if (hit) {
        const now = performance.now();
        const stats = new LoadStats();
        stats.loading = { start: now, first: now, end: now };
        stats.loaded = stats.total = hit.text.length;
        this.stats = stats;
        setTimeout(() => callbacks.onSuccess({ url: hit.url, data: hit.text, code: 200 }, stats, context, null), 0);
        return;
      }
      if (proxy && !isProxied(original)) context.url = proxify(original);
      this.inner.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, net) => {
          if (proxy) {
            response.url = original;
            ctx.url = original;
          }
          callbacks.onSuccess(response, stats, ctx, net);
        },
      });
      this.stats = this.inner.stats;
    }

    abort() { this.inner.abort(); }
    destroy() { this.inner.destroy(); }
    getCacheAge() { return this.inner.getCacheAge?.() ?? null; }
    getResponseHeader(name) { return this.inner.getResponseHeader?.(name) ?? null; }
  };
}

/** iPad/iPhone/Safari: el HLS nativo gasta menos batería y permite AirPlay. */
const PREFER_NATIVE_HLS = typeof document !== 'undefined'
  && document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== ''
  && /Apple/.test(navigator.vendor || '');

function describeHlsError(data) {
  const code = data.response?.code;
  if (code === 0) return `${data.details} (bloqueado por CORS o sin conexión)`;
  return code ? `${data.details} (HTTP ${code})` : String(data.details || data.type);
}

const STALL_LIVE_MS = 8000;
const STALL_VOD_MS = 15000;
const MAX_NET_RETRIES = 4;

export class PlayerEngine extends EventTarget {
  #video;
  #hls = null;
  #mpegts = null;
  #nativeActive = false;
  #sources = [];
  #index = 0;
  #token = 0;
  #retries = 0;
  #stalls = 0;
  #retryTimer = 0;
  #watchdog = 0;
  #lastTime = -1;
  #stallSince = 0;
  #blobs = new Set();
  #attempts = [];
  #qualityTimer = 0;
  #qualityRaised = false;
  live = false;

  constructor(video) {
    super();
    this.#video = video;
    video.addEventListener('error', () => this.#onNativeError());
    video.addEventListener('playing', () => { this.#retries = 0; this.#emit('state', { state: 'playing' }); this.#scheduleQualityUp(); });
    video.addEventListener('waiting', () => { clearTimeout(this.#qualityTimer); this.#emit('state', { state: 'buffering' }); });
    video.addEventListener('pause', () => this.#emit('state', { state: 'paused' }));
    video.addEventListener('loadedmetadata', () => this.#emit('tracks'));
    video.audioTracks?.addEventListener?.('addtrack', () => this.#emit('tracks'));
    video.textTracks?.addEventListener?.('addtrack', () => this.#emit('tracks'));
    globalThis.addEventListener('online', () => this.#sources.length && this.#restart('red recuperada'));
  }

  get video() { return this.#video; }
  get current() { return this.#sources[this.#index] || null; }

  /**
   * @param {Array<{url:string, kind:'hls'|'mpegts'|'native', proxy?:boolean, label?:string}>} sources
   */
  load(sources, { live = false, startTime = 0 } = {}) {
    this.#token++;
    this.#teardown();
    this.#sources = sources.filter(Boolean);
    this.#index = 0;
    this.#stalls = 0;
    this.#attempts = [];
    this.live = live;
    this.startTime = startTime;
    this.#start();
  }

  /** Libera todo. Llamar al cerrar el reproductor. */
  destroy() {
    this.#token++;
    this.#teardown();
    this.#sources = [];
    this.#emit('state', { state: 'stopped' });
  }

  // ---------- pistas ----------
  getAudioTracks() {
    if (this.#hls?.audioTracks?.length) {
      return this.#hls.audioTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Pista ${i + 1}`, active: i === this.#hls.audioTrack }));
    }
    const list = this.#video.audioTracks;
    if (!list) return [];
    return Array.from(list, (t, i) => ({ id: i, label: t.label || t.language || `Pista ${i + 1}`, active: t.enabled }));
  }

  setAudioTrack(id) {
    if (this.#hls?.audioTracks?.length) { this.#hls.audioTrack = id; return; }
    const list = this.#video.audioTracks;
    if (list) Array.from(list).forEach((t, i) => { t.enabled = i === id; });
  }

  getSubtitleTracks() {
    const tracks = Array.from(this.#video.textTracks || []).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    return tracks.map((t, i) => ({ id: i, label: t.label || t.language || `Subtítulo ${i + 1}`, active: t.mode === 'showing' }));
  }

  setSubtitleTrack(id) {
    if (this.#hls?.subtitleTracks?.length) {
      this.#hls.subtitleTrack = id;
      this.#hls.subtitleDisplay = id >= 0;
    }
    const tracks = Array.from(this.#video.textTracks || []).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    tracks.forEach((t, i) => { t.mode = i === id ? 'showing' : 'disabled'; });
    this.#emit('tracks');
  }

  // ---------- internos ----------
  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  #start() {
    const token = this.#token;
    const src = this.current;
    if (!src) {
      this.#emit('error', { message: 'No se pudo reproducir este contenido con ninguna fuente disponible.', attempts: [...this.#attempts] });
      return;
    }
    this.#retries = 0;
    this.#emit('source', { source: src, index: this.#index, total: this.#sources.length });
    this.#emit('state', { state: 'loading' });
    if (src.kind === 'hls') this.#playHls(src, token);
    else if (src.kind === 'mpegts') this.#playMpegts(src, token);
    else this.#playNative(src);
    this.#armWatchdog(token);
  }

  #next(reason) {
    console.warn('[engine] fuente fallida:', this.current?.url, '→', reason);
    if (this.current) this.#attempts.push({ source: this.current, reason: String(reason) });
    this.#teardown();
    this.#index++;
    this.#start();
  }

  /** Tras 2 s de reproducción continua, saltar a la mayor calidad que soporte la red. */
  #scheduleQualityUp() {
    clearTimeout(this.#qualityTimer);
    const hls = this.#hls;
    if (!hls || this.#qualityRaised || hls.levels.length < 2) return;
    this.#qualityTimer = setTimeout(() => {
      if (this.#hls !== hls || this.#video.paused || !hls.autoLevelEnabled) return;
      const bw = hls.bandwidthEstimate;
      let target = hls.levels.length - 1;
      if (Number.isFinite(bw) && bw > 0) {
        while (target > 0 && hls.levels[target].bitrate > bw * 0.85) target--;
      }
      this.#qualityRaised = true;
      if (target > hls.currentLevel) hls.nextLevel = target;
    }, QUALITY_UP_MS);
  }

  #restart(reason) {
    console.warn('[engine] reiniciando fuente:', reason);
    const token = ++this.#token;
    this.#teardown();
    if (token === this.#token) this.#start();
  }

  #playHls(src, token) {
    if (PREFER_NATIVE_HLS || !Hls.isSupported()) {
      if (this.#video.canPlayType('application/vnd.apple.mpegurl')) return this.#playNative(src);
      return this.#next('HLS no soportado');
    }
    const config = { ...HLS_CONFIG };
    if (src.proxy) {
      // Todo (playlists, fragmentos, claves) por el proxy; el demux progresivo requiere
      // el loader nativo de hls.js, así que vía proxy se usa XHR.
      const Base = Hls.DefaultConfig.loader;
      config.loader = makeLoader({ proxy: true, Base });
      config.pLoader = makeLoader({ proxy: true, prefetch: true, Base });
    } else {
      config.pLoader = makeLoader({ prefetch: true });
    }
    if (!this.live && this.startTime) config.startPosition = this.startTime;
    const hls = new Hls(config);
    this.#hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, () => { if (token === this.#token) { this.#tryPlay(); this.#emit('tracks'); } });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => this.#emit('tracks'));
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.#emit('tracks'));
    hls.on(Hls.Events.FRAG_LOADED, () => { this.#retries = 0; });
    hls.on(Hls.Events.ERROR, (_, data) => {
      // Si la calidad alta se atasca, volver a ABR automático.
      if (!data.fatal && data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR && !hls.autoLevelEnabled) hls.nextLevel = -1;
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (token !== this.#token || this.#hls !== hls || !data.fatal) return;
      this.#onHlsFatal(hls, data, token);
    });

    hls.attachMedia(this.#video);
    hls.loadSource(src.url);
  }

  #onHlsFatal(hls, data, token) {
    this.#retries++;
    const D = Hls.ErrorDetails;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      // El manifiesto ya agotó sus reintentos internos: pasar a la siguiente fuente.
      if ([D.MANIFEST_LOAD_ERROR, D.MANIFEST_LOAD_TIMEOUT, D.MANIFEST_PARSING_ERROR].includes(data.details) && !hls.levels?.length) {
        return this.#next(describeHlsError(data));
      }
      if (this.#retries <= MAX_NET_RETRIES) {
        const delay = Math.min(500 * 2 ** (this.#retries - 1), 4000);
        clearTimeout(this.#retryTimer);
        this.#retryTimer = setTimeout(() => { if (token === this.#token) hls.startLoad(this.live ? -1 : undefined); }, delay);
        return;
      }
      return this.#next(describeHlsError(data));
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (this.#retries === 1) return hls.recoverMediaError();
      if (this.#retries === 2) { hls.swapAudioCodec(); return hls.recoverMediaError(); }
    }
    this.#next(describeHlsError(data));
  }

  async #playMpegts(src, token) {
    let mpegts;
    try {
      const mod = await import(MPEGTS_URL);
      mpegts = mod.default ?? mod;
    } catch {
      if (token === this.#token && this.current === src) this.#next('mpegts.js no disponible');
      return;
    }
    if (token !== this.#token || this.current !== src) return;
    if (!mpegts.isSupported?.()) return this.#next('MSE no soportado');

    const url = src.proxy ? proxify(src.url) : src.url;
    const player = mpegts.createPlayer(
      { type: 'mpegts', isLive: this.live, url },
      {
        enableWorker: true,
        lazyLoad: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 6,
        liveBufferLatencyMinRemain: 1.5,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 15,
      },
    );
    this.#mpegts = player;
    player.on(mpegts.Events.ERROR, (type, detail) => { if (token === this.#token && this.#mpegts === player) this.#next(`mpegts ${type} ${detail}`); });
    player.attachMediaElement(this.#video);
    player.load();
    this.#tryPlay();
  }

  #playNative(src) {
    const v = this.#video;
    this.#nativeActive = true;
    if (!src.proxy) v.src = src.url;
    else v.src = src.kind === 'hls' ? proxifyPlaylist(src.url) : proxify(src.url);
    if (src.url.startsWith('blob:')) this.#blobs.add(src.url);
    if (!this.live && this.startTime) v.addEventListener('loadedmetadata', () => { v.currentTime = this.startTime; }, { once: true });
    v.load();
    this.#tryPlay();
  }

  #onNativeError() {
    if (!this.#nativeActive || !this.#video.error) return;
    const e = this.#video.error;
    const why = { 1: 'abortado', 2: 'error de red', 3: 'no se pudo decodificar', 4: 'formato no soportado o URL inaccesible' }[e.code] || '';
    this.#next(`video error ${e.code} ${why}${e.message ? ` · ${e.message}` : ''}`);
  }

  #tryPlay() {
    const v = this.#video;
    v.play().catch((err) => {
      if (err?.name !== 'NotAllowedError') return;
      v.muted = true;
      v.play().then(() => this.#emit('autoplay-muted')).catch(() => {});
    });
  }

  /** Detecta congelamientos (tiempo que no avanza) y desfases del borde en vivo. */
  #armWatchdog(token) {
    clearInterval(this.#watchdog);
    this.#lastTime = -1;
    this.#stallSince = 0;
    this.#watchdog = setInterval(() => {
      if (token !== this.#token) return clearInterval(this.#watchdog);
      const v = this.#video;
      if (v.paused || v.ended) { this.#stallSince = 0; return; }
      if (v.currentTime !== this.#lastTime) {
        this.#lastTime = v.currentTime;
        this.#stallSince = 0;
        if (this.live && this.#hls?.liveSyncPosition && v.currentTime < this.#hls.liveSyncPosition - 20) {
          v.currentTime = this.#hls.liveSyncPosition; // muy atrasado: volver al borde
        }
        return;
      }
      this.#stallSince ||= Date.now();
      if (Date.now() - this.#stallSince < (this.live ? STALL_LIVE_MS : STALL_VOD_MS)) return;
      this.#stallSince = 0;
      this.#stalls++;
      if (this.#stalls === 1 && this.#hls) {
        this.#hls.stopLoad();
        this.#hls.startLoad(this.live ? -1 : v.currentTime);
      } else if (this.#stalls <= 3) {
        if (!this.live) this.startTime = v.currentTime;
        this.#restart('congelado');
      } else {
        this.#stalls = 0;
        this.#next('congelado repetidamente');
      }
    }, 2000);
  }

  #teardown() {
    clearInterval(this.#watchdog);
    clearTimeout(this.#qualityTimer);
    this.#qualityRaised = false;
    clearTimeout(this.#retryTimer);
    if (this.#hls) {
      this.#hls.destroy();
      this.#hls = null;
    }
    if (this.#mpegts) {
      const p = this.#mpegts;
      this.#mpegts = null;
      try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch { /* ya destruido */ }
    }
    this.#nativeActive = false;
    const v = this.#video;
    const old = v.getAttribute('src') || '';
    v.pause();
    v.removeAttribute('src');
    v.load(); // libera el decodificador y el MediaSource
    if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    for (const url of this.#blobs) URL.revokeObjectURL(url);
    this.#blobs.clear();
  }
}

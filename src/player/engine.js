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
 * Eventos (EventTarget): 'source', 'state', 'tracks', 'error', 'autoplay-muted'.
 */
import Hls from 'hls.js';
import { proxify, isProxied } from '../services/xtream.js';

const MPEGTS_URL = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/+esm';

export const HLS_CONFIG = Object.freeze({
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
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
  backBufferLength: 30,
  maxBufferSize: 60 * 1000 * 1000,
  maxBufferHole: 0.5,
  nudgeMaxRetry: 10,
  liveDurationInfinity: true,
  maxLiveSyncPlaybackRate: 1.5,
  lowLatencyMode: true,
  startFragPrefetch: true,
  capLevelToPlayerSize: true,
  enableWorker: true,
});

/** Loader de hls.js que pasa cada petición por el proxy pero conserva la URL original
 *  como base, para que los segmentos relativos del playlist se resuelvan bien. */
function makeProxyLoader() {
  const Base = Hls.DefaultConfig.loader;
  return class ProxyLoader extends Base {
    load(context, config, callbacks) {
      const original = context.url;
      if (!isProxied(original)) context.url = proxify(original);
      super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, net) => {
          response.url = original;
          ctx.url = original;
          callbacks.onSuccess(response, stats, ctx, net);
        },
      });
    }
  };
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
  live = false;

  constructor(video) {
    super();
    this.#video = video;
    video.addEventListener('error', () => this.#onNativeError());
    video.addEventListener('playing', () => { this.#retries = 0; this.#emit('state', { state: 'playing' }); });
    video.addEventListener('waiting', () => this.#emit('state', { state: 'buffering' }));
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
      this.#emit('error', { message: 'No se pudo reproducir este contenido con ninguna fuente disponible.' });
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
    this.#teardown();
    this.#index++;
    this.#start();
  }

  #restart(reason) {
    console.warn('[engine] reiniciando fuente:', reason);
    const token = ++this.#token;
    this.#teardown();
    if (token === this.#token) this.#start();
  }

  #playHls(src, token) {
    if (!Hls.isSupported()) {
      if (this.#video.canPlayType('application/vnd.apple.mpegurl')) return this.#playNative(src);
      return this.#next('HLS no soportado');
    }
    const config = { ...HLS_CONFIG };
    if (src.proxy) config.loader = makeProxyLoader();
    if (!this.live && this.startTime) config.startPosition = this.startTime;
    const hls = new Hls(config);
    this.#hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, () => { if (token === this.#token) { this.#tryPlay(); this.#emit('tracks'); } });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => this.#emit('tracks'));
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.#emit('tracks'));
    hls.on(Hls.Events.FRAG_LOADED, () => { this.#retries = 0; });
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
        return this.#next(data.details);
      }
      if (this.#retries <= MAX_NET_RETRIES) {
        const delay = Math.min(500 * 2 ** (this.#retries - 1), 4000);
        clearTimeout(this.#retryTimer);
        this.#retryTimer = setTimeout(() => { if (token === this.#token) hls.startLoad(this.live ? -1 : undefined); }, delay);
        return;
      }
      return this.#next(data.details);
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (this.#retries === 1) return hls.recoverMediaError();
      if (this.#retries === 2) { hls.swapAudioCodec(); return hls.recoverMediaError(); }
    }
    this.#next(data.details || data.type);
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
    v.src = src.proxy ? proxify(src.url) : src.url;
    if (src.url.startsWith('blob:')) this.#blobs.add(src.url);
    if (!this.live && this.startTime) v.addEventListener('loadedmetadata', () => { v.currentTime = this.startTime; }, { once: true });
    v.load();
    this.#tryPlay();
  }

  #onNativeError() {
    if (!this.#nativeActive || !this.#video.error) return;
    this.#next(`video error ${this.#video.error.code}`);
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

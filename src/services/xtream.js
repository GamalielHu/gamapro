/**
 * Cliente de la API Xtream Codes (player_api.php).
 *
 * CORS: muchos paneles no envían cabeceras CORS o se sirven por http.
 * El proxy se configura con configureProxy() (Ajustes) o con
 * window.GAMAPRO_CONFIG = { corsProxy: '...' } antes de cargar la app.
 *   - Plantilla con marcador: "https://mi-proxy.example/?url={url}"
 *   - Prefijo simple:          "/proxy?url="   (servidor incluido: server.mjs)
 * Modos: 'off' (nunca), 'auto' (solo si falla la llamada directa), 'always'.
 */

const TIMEOUT_MS = 20000;

const proxy = { url: '', mode: 'auto' };
/** Hosts donde la llamada directa ya falló: se van directo al proxy en esta sesión. */
const proxiedHosts = new Set();

export class XtreamError extends Error {
  constructor(message, code = 'unknown', status = 0) {
    super(message);
    this.name = 'XtreamError';
    this.code = code;
    this.status = status;
  }
}

export function configureProxy({ url = proxy.url, mode = proxy.mode } = {}) {
  proxy.url = (url || '').trim();
  proxy.mode = ['off', 'auto', 'always'].includes(mode) ? mode : 'auto';
  proxiedHosts.clear();
}

export const getProxy = () => ({ ...proxy });
export const proxyEnabled = () => Boolean(proxy.url) && proxy.mode !== 'off';

const envProxy = globalThis.GAMAPRO_CONFIG?.corsProxy;
if (envProxy) configureProxy({ url: envProxy, mode: globalThis.GAMAPRO_CONFIG?.corsProxyMode });

/** Envuelve una URL con el proxy configurado (siempre devuelve URL absoluta). */
export function proxify(target) {
  if (!proxy.url || isProxied(target)) return target;
  const enc = encodeURIComponent(target);
  const raw = proxy.url.includes('{url}') ? proxy.url.replace('{url}', enc) : proxy.url + enc;
  return new URL(raw, globalThis.location?.href).href;
}

export function isProxied(url) {
  if (!proxy.url) return false;
  const base = new URL(proxy.url.split('{url}')[0], globalThis.location?.href).href;
  return url.startsWith(base);
}

/** ¿La página es https y el destino http? El navegador lo bloquearía (mixed content). */
function isMixedContent(target) {
  return globalThis.location?.protocol === 'https:' && target.startsWith('http:');
}

async function request(url, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Tiempo de espera agotado', 'TimeoutError')), TIMEOUT_MS);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new XtreamError(`El panel respondió HTTP ${res.status}`, 'http', res.status);
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new XtreamError('Respuesta no válida del panel (no es JSON)', 'parse');
    }
  } catch (err) {
    if (err?.name === 'TimeoutError' || ctrl.signal.reason?.name === 'TimeoutError') {
      throw new XtreamError('El panel tardó demasiado en responder', 'timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** GET JSON con fallback automático al proxy CORS ante errores de red/CORS. */
export async function fetchJson(target, { signal } = {}) {
  const host = new URL(target).host;
  const useProxy = proxyEnabled() && (proxy.mode === 'always' || proxiedHosts.has(host) || isMixedContent(target));
  if (useProxy) return request(proxify(target), signal);

  try {
    return await request(target, signal);
  } catch (err) {
    // fetch lanza TypeError ante CORS, DNS, mixed content o conexión rechazada.
    if (!(err instanceof TypeError)) throw err;
    if (proxyEnabled()) {
      const data = await request(proxify(target), signal);
      proxiedHosts.add(host);
      return data;
    }
    throw new XtreamError('No se pudo conectar con el panel (posible bloqueo CORS). Configura un proxy CORS en Ajustes.', 'cors');
  }
}

/** Normaliza lo que escriba el usuario: "panel.tv:8080/", "http://x/player_api.php"… */
export function normalizeHost(input) {
  let host = String(input || '').trim();
  if (!host) throw new XtreamError('Falta la URL del servidor', 'input');
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`;
  const u = new URL(host);
  const path = u.pathname.replace(/\/(player_api|get|xmltv)\.php$/i, '').replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

const asArray = (data) => (Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data) : []);
const enc = encodeURIComponent;

export class XtreamClient {
  constructor({ host, username, password }) {
    this.host = normalizeHost(host);
    this.username = String(username || '').trim();
    this.password = String(password || '').trim();
    if (!this.username || !this.password) throw new XtreamError('Usuario y contraseña son obligatorios', 'input');
    this.info = null;
  }

  get credentials() {
    return { host: this.host, username: this.username, password: this.password };
  }

  apiUrl(action, params = {}) {
    let url = `${this.host}/player_api.php?username=${enc(this.username)}&password=${enc(this.password)}`;
    if (action) url += `&action=${action}`;
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url += `&${k}=${enc(v)}`;
    }
    return url;
  }

  call(action, params, opts) {
    return fetchJson(this.apiUrl(action, params), opts);
  }

  /** Auth: player_api.php?username={u}&password={p} */
  async auth(opts) {
    const data = await this.call('', {}, opts);
    const user = data?.user_info;
    if (!user || Number(user.auth) !== 1) throw new XtreamError('Usuario o contraseña incorrectos', 'auth');
    if (user.status && user.status !== 'Active') throw new XtreamError(`Cuenta ${user.status}`, 'auth');
    this.info = data;
    return data;
  }

  /** Formatos permitidos por la cuenta (m3u8, ts, rtmp). */
  get outputFormats() {
    const f = this.info?.user_info?.allowed_output_formats;
    return Array.isArray(f) && f.length ? f : ['m3u8', 'ts'];
  }

  // Live
  getLiveCategories(opts) { return this.call('get_live_categories', {}, opts).then(asArray); }
  getLiveStreams(categoryId, opts) { return this.call('get_live_streams', { category_id: categoryId }, opts).then(asArray); }

  // VOD
  getVodCategories(opts) { return this.call('get_vod_categories', {}, opts).then(asArray); }
  getVodStreams(categoryId, opts) { return this.call('get_vod_streams', { category_id: categoryId }, opts).then(asArray); }
  getVodInfo(vodId, opts) { return this.call('get_vod_info', { vod_id: vodId }, opts); }

  // Series
  getSeriesCategories(opts) { return this.call('get_series_categories', {}, opts).then(asArray); }
  getSeries(categoryId, opts) { return this.call('get_series', { category_id: categoryId }, opts).then(asArray); }
  /** Devuelve { info, seasons, episodes: { "1": [...], "2": [...] } } */
  async getSeriesInfo(seriesId, opts) {
    const data = (await this.call('get_series_info', { series_id: seriesId }, opts)) || {};
    const episodes = {};
    const raw = data.episodes;
    if (Array.isArray(raw)) {
      // Algunos paneles devuelven [[ep, ep], [ep]] en lugar de un objeto por temporada.
      raw.forEach((list, i) => { for (const ep of asArray(list)) (episodes[ep.season ?? i + 1] ||= []).push(ep); });
    } else {
      for (const [season, list] of Object.entries(raw || {})) episodes[season] = asArray(list);
    }
    return { info: data.info || {}, seasons: asArray(data.seasons), episodes };
  }

  // URLs de streaming
  #seg() { return `${enc(this.username)}/${enc(this.password)}`; }
  /** Live: {url}/{u}/{p}/{stream_id}.m3u8 (o .ts) */
  liveUrl(streamId, ext = 'm3u8') { return `${this.host}/${this.#seg()}/${streamId}.${ext}`; }
  /** Variante /live/ usada por la mayoría de paneles modernos. */
  liveUrlAlt(streamId, ext = 'm3u8') { return `${this.host}/live/${this.#seg()}/${streamId}.${ext}`; }
  /** VOD: {url}/movie/{u}/{p}/{stream_id}.{container_extension} */
  vodUrl(streamId, ext = 'mp4') { return `${this.host}/movie/${this.#seg()}/${streamId}.${ext || 'mp4'}`; }
  /** Episodio: {url}/series/{u}/{p}/{episode_id}.{container_extension} */
  episodeUrl(episodeId, ext = 'mp4') { return `${this.host}/series/${this.#seg()}/${episodeId}.${ext || 'mp4'}`; }
}

/** Arranque de GamaPro: sesión, navegación y conexión catálogo ↔ reproductor. */
import { XtreamClient, configureProxy, getProxy, proxyEnabled, needsProxy, downloadUrl } from './services/xtream.js';
import { loadCredentials, saveCredentials, clearCredentials, loadSettings, accountKey } from './services/cache.js';
import { PlayerEngine, prefetchNextStream } from './player/engine.js';
import { renderLogin } from './ui/login.js';
import { Catalog } from './ui/catalog.js';
import { PlayerUI } from './ui/player-ui.js';
import { renderSettings } from './ui/settings.js';
import { $, esc, toast, KEY, isTyping } from './ui/dom.js';

const els = {
  login: $('#login-view'),
  app: $('#app-view'),
  nav: $('#nav'),
  account: $('#account-box'),
  header: $('#catalog-header'),
  catalogRoot: $('#catalog-root'),
  settingsRoot: $('#settings-root'),
  player: $('#player'),
};

const state = { client: null, view: 'live', remux: false };

const settings = loadSettings();
configureProxy({ url: settings.proxyUrl || getProxy().url, mode: settings.proxyMode });

// ---------- fuentes de reproducción (orden = prioridad de fallback) ----------
function withProxyFallback(direct, { vod = false } = {}) {
  if (!proxyEnabled()) return direct;
  // Todas las fuentes, también las https: el panel puede redirigir a http://IP (bloqueado en página https).
  const proxied = direct.map((s) => ({ ...s, proxy: true }));
  // Si el panel ya necesitó el proxy (CORS, http en página https), no perder tiempo con intentos directos.
  const list = needsProxy(direct[0]?.url || '') ? proxied : [...direct, ...proxied];
  // VOD: probar primero el archivo (directo y vía proxy); HLS solo como último recurso.
  return vod ? [...list.filter((s) => s.kind === 'native'), ...list.filter((s) => s.kind !== 'native')] : list;
}

// Safari (iPad/iPhone/Mac) no abre .mkv/.avi: en esos casos probar antes la versión HLS.
const APPLE = /Apple/.test(navigator.vendor || '');
const SAFARI_UNSUPPORTED = new Set(['mkv', 'avi', 'wmv', 'flv']);

/** Recuerda qué posición de la lista de fuentes funcionó por sección, para probarla primero
 *  la próxima vez (p. ej. si siempre funciona "Directo · proxy", no esperar a las directas). */
const LAST_GOOD_KEY = 'gp.lastGoodSource';
const lastGood = (() => { try { return JSON.parse(localStorage.getItem(LAST_GOOD_KEY) || '{}'); } catch { return {}; } })();
let lastResolved = null;

/** Forma de la lista (tipos y proxy en orden): la posición recordada solo vale para la misma forma. */
const shapeOf = (list) => list.map((s) => `${s.kind}${s.proxy ? '+p' : ''}`).join(',');

function preferLastGood(section, list) {
  list.forEach((s, i) => { s.slot = i; });
  const good = lastGood[section];
  if (!good || good.shape !== shapeOf(list) || !list[good.slot] || good.slot === 0) return list;
  return [list[good.slot], ...list.filter((_, i) => i !== good.slot)];
}

function rememberGoodSource() {
  const src = engine.current;
  if (!lastResolved || !src || src.slot === undefined) return;
  lastGood[lastResolved.section] = { slot: src.slot, shape: lastResolved.shape };
  try { localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(lastGood)); } catch { /* modo privado */ }
}

function sourcesFor(client, section, item) {
  const list = buildSources(client, section, item);
  lastResolved = { section, shape: shapeOf(list) };
  const ordered = preferLastGood(section, list);
  return ordered;
}

function buildSources(client, section, item) {
  const fmts = client.outputFormats;
  if (section === 'live') {
    const hls = [
      { kind: 'hls', url: client.liveUrl(item.id, 'm3u8') },
      { kind: 'hls', url: client.liveUrlAlt(item.id, 'm3u8') },
    ];
    const ts = [
      { kind: 'mpegts', url: client.liveUrl(item.id, 'ts') },
      { kind: 'mpegts', url: client.liveUrlAlt(item.id, 'ts') },
      { kind: 'native', url: client.liveUrl(item.id, 'ts') },
    ];
    let list = loadSettings().liveFormat === 'ts' ? [...ts, ...hls] : [...hls, ...ts];
    const allowed = list.filter((s) => fmts.includes(s.kind === 'hls' ? 'm3u8' : 'ts'));
    if (allowed.length) list = allowed;
    // Fuentes vía proxy: solo las que pasan por fetch/XHR (hls, mpegts) o http en página https.
    return withProxyFallback(list);
  }
  const ext = (item.ext || 'mp4').toLowerCase();
  const main = section === 'movies' ? client.vodUrl(item.id, ext) : client.episodeUrl(item.id, ext);
  const alt = section === 'movies' ? client.episodeUrl(item.id, ext) : client.vodUrl(item.id, ext);
  const list = ext === 'm3u8'
    ? [{ kind: 'hls', url: main }, { kind: 'hls', url: alt }]
    : [
      { kind: 'native', url: main },
      { kind: 'native', url: alt },
      { kind: 'hls', url: main.replace(/\.[^./]+$/, '.m3u8') },
    ];
  const out = withProxyFallback(list, { vod: true });
  if (!SAFARI_UNSUPPORTED.has(ext)) return out;
  // .mkv/.avi: el servidor (Render / npm start) lo convierte a HLS al vuelo. En Safari va
  // primero (no abre Matroska); en el resto, después de intentar el archivo tal cual.
  const remux = state.remux ? [{ kind: 'hls', url: remuxUrl(main), label: 'Convertido', fromStart: true, hlsjs: true, slowStart: true }] : [];
  if (APPLE) return [...remux, ...out.filter((s) => s.kind === 'hls'), ...out.filter((s) => s.kind !== 'hls')];
  return [...out.filter((s) => s.kind === 'native'), ...remux, ...out.filter((s) => s.kind !== 'native')];
}

// ---------- precarga predictiva (zapping rápido) ----------
/** Precarga el manifiesto del canal que el usuario está mirando en la lista / el siguiente. */
const warmed = new Map(); // url de conversión → hora del último aviso

function prefetchFor({ section, item }) {
  if (!item || !state.client) return;
  if (section === 'movies' || section === 'episode') return warmRemux(section, item);
  if (section !== 'live') return;
  const src = buildSources(state.client, section, item).find((s) => s.kind === 'hls');
  if (src) prefetchNextStream(src.url, { proxy: Boolean(src.proxy) });
}

/** Empieza la conversión del .mkv en el servidor antes del clic: al reproducir ya está lista. */
function warmRemux(section, item) {
  const ext = (item.ext || 'mp4').toLowerCase();
  if (!state.remux || !APPLE || !SAFARI_UNSUPPORTED.has(ext)) return;
  const file = section === 'movies' ? state.client.vodUrl(item.id, ext) : state.client.episodeUrl(item.id, ext);
  const url = remuxUrl(file);
  if (Date.now() - (warmed.get(url) || 0) < 60_000) return;
  warmed.set(url, Date.now());
  fetch(`${url}&warm=1`, { cache: 'no-store' }).catch(() => {});
}

const remuxUrl = (file) => new URL(`remux?url=${encodeURIComponent(file)}`, location.href).href;

// ---------- descargas (películas y episodios) ----------
function startDownload({ section, item }) {
  if (section !== 'movies' && section !== 'episode') return;
  const ext = (item.ext || 'mp4').toLowerCase();
  const src = section === 'movies' ? state.client.vodUrl(item.id, ext) : state.client.episodeUrl(item.id, ext);
  const filename = `${item.name}.${ext}`.replace(/[\\/:*?"<>|]+/g, ' ');
  const a = document.createElement('a');
  a.href = downloadUrl(src, filename);
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  toast(`Descargando "${item.name}"… En iPad/iPhone queda en la app Archivos → Descargas.`, { ms: 5000 });
}

// ---------- reproductor ----------
const engine = new PlayerEngine($('#video'));
const playerUI = new PlayerUI({
  root: els.player,
  osd: $('#osd'),
  engine,
  resolve: ({ section, item }) => ({
    title: `${item.num ? `${item.num} · ` : ''}${item.name}`,
    sources: sourcesFor(state.client, section, item),
    live: section === 'live',
  }),
  onDownload: startDownload,
  onPrefetch: prefetchFor,
});

engine.addEventListener('state', (e) => { if (e.detail.state === 'playing') rememberGoodSource(); });

// ---------- catálogo ----------
const catalog = new Catalog({
  root: els.catalogRoot,
  search: $('#search-input'),
  category: $('#category-select'),
  countLabel: $('#count-label'),
  titleEl: $('#view-title'),
  onPlay: (ctx) => playerUI.open(ctx),
  onDownload: startDownload,
  onPrefetch: prefetchFor,
  onEdge: () => els.nav.querySelector('.active')?.focus(),
});

// ---------- navegación ----------
function setView(view) {
  state.view = view;
  els.nav.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const isSettings = view === 'settings';
  els.settingsRoot.classList.toggle('hidden', !isSettings);
  els.catalogRoot.classList.toggle('hidden', isSettings);
  els.header.classList.toggle('hidden', isSettings);
  if (isSettings) {
    renderSettings(els.settingsRoot, {
      client: state.client,
      onReload: () => { catalog.data.clear(); setView('live'); catalog.show('live', { force: true }); },
      onLogout: logout,
    });
  } else {
    catalog.show(view);
  }
}

els.nav.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (btn) setView(btn.dataset.view);
});
els.nav.addEventListener('keydown', (e) => {
  const btns = [...els.nav.querySelectorAll('[data-view]')];
  const i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (state.view === 'settings') els.settingsRoot.querySelector('input,select,button')?.focus();
    else catalog.focus();
  }
});

// Atajos globales fuera del reproductor.
document.addEventListener('keydown', (e) => {
  if (playerUI.isOpen || els.app.classList.contains('hidden')) return;
  if (e.key === '/' && !isTyping(document.activeElement)) { e.preventDefault(); $('#search-input').focus(); return; }
  if (KEY.back.has(e.key) && !isTyping(document.activeElement) && !catalog.isDetailOpen()) {
    e.preventDefault();
    els.nav.querySelector('.active')?.focus();
  }
});

// ---------- sesión ----------
function renderAccount(client) {
  const u = client.info?.user_info;
  const exp = Number(u?.exp_date) ? new Date(Number(u.exp_date) * 1000).toLocaleDateString() : null;
  els.account.innerHTML = `<div class="text-slate-300 truncate">${esc(client.username)}</div>${exp ? `<div>Vence: ${esc(exp)}</div>` : ''}`;
}

async function enterApp(client, { verify = false } = {}) {
  client.accountId = accountKey(client.credentials);
  state.client = client;
  catalog.setClient(client);
  els.login.classList.add('hidden');
  els.app.classList.remove('hidden');
  renderAccount(client);
  setView('live');

  if (verify) {
    // Verificación en segundo plano: el catálogo cacheado ya se muestra mientras tanto.
    try {
      await client.auth();
      renderAccount(client);
    } catch (err) {
      if (err.code === 'auth') {
        toast(err.message, { type: 'error' });
        logout();
      } else {
        toast(`Sin conexión con el panel: ${err.message}. Mostrando catálogo guardado.`, { ms: 5000 });
      }
    }
  }
}

function showLogin(initial = {}) {
  els.app.classList.add('hidden');
  els.login.classList.remove('hidden');
  renderLogin(els.login, {
    initial,
    onLogin: async (client) => {
      await saveCredentials(client.credentials);
      await enterApp(client);
    },
  });
}

function logout() {
  playerUI.close();
  const prev = state.client?.credentials;
  clearCredentials();
  state.client = null;
  showLogin(prev ? { host: prev.host, username: prev.username } : {});
}

/** Si la app la sirve server.mjs, usar su proxy local por defecto. */
async function detectLocalProxy() {
  if (getProxy().url || location.protocol === 'file:') return;
  try {
    const res = await fetch('proxy/health', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (res.ok && (await res.text()).trim() === 'gamapro-proxy') configureProxy({ url: 'proxy?url=', mode: settings.proxyMode });
  } catch { /* hosting estático sin proxy */ }
}

/** ¿El servidor puede convertir .mkv a HLS? (Render / npm start con ffmpeg). */
async function detectRemux() {
  if (location.protocol === 'file:') return;
  try {
    const res = await fetch('remux/health', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    state.remux = res.ok && (await res.text()).trim() === 'gamapro-remux';
  } catch { /* sin conversión (Cloudflare u hosting estático) */ }
}

async function boot() {
  await Promise.all([detectLocalProxy(), detectRemux()]);
  const creds = await loadCredentials();
  if (!creds) return showLogin();
  try {
    await enterApp(new XtreamClient(creds), { verify: true });
  } catch {
    showLogin(creds);
  }
}

boot();

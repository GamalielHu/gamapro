/**
 * Núcleo del procesamiento de catálogos. Corre dentro del Web Worker
 * (catalog-parser.worker.js) y, si el navegador no admite workers de módulo,
 * en el hilo principal con la misma API.
 *
 * - Descarga y parsea los JSON de Xtream (20.000+ ítems) fuera del hilo de la UI.
 * - Los guarda en IndexedDB en formato columnar comprimido (gzip con
 *   CompressionStream): mucho más chico y rápido de leer que un array de objetos.
 * - Mantiene en memoria un índice de búsqueda (nombre normalizado + categoría):
 *   cada filtro responde en pocos ms y devuelve solo índices (Int32Array).
 */
import { XtreamClient, configureProxy } from '../services/xtream.js';

const DB_NAME = 'gamapro-catalog';
const STORE = 'kv';
const FORMAT = 2;

/** Campos por sección (columnas) y cómo se leen de la respuesta de Xtream. */
const SPECS = {
  live: {
    cats: (c) => c.getLiveCategories(),
    items: (c) => c.getLiveStreams(),
    cols: {
      id: (s) => s.stream_id, name: (s) => s.name || '', icon: (s) => s.stream_icon || '',
      cat: (s) => String(s.category_id ?? ''), num: (s) => s.num ?? '', epg: (s) => s.epg_channel_id || '',
    },
    sortByNum: true,
  },
  movies: {
    cats: (c) => c.getVodCategories(),
    items: (c) => c.getVodStreams(),
    cols: {
      id: (s) => s.stream_id, name: (s) => s.name || '', icon: (s) => s.stream_icon || '',
      cat: (s) => String(s.category_id ?? ''), ext: (s) => s.container_extension || 'mp4', rating: (s) => s.rating ?? '',
    },
  },
  series: {
    cats: (c) => c.getSeriesCategories(),
    items: (c) => c.getSeries(),
    cols: {
      id: (s) => s.series_id, name: (s) => s.name || '', icon: (s) => s.cover || '',
      cat: (s) => String(s.category_id ?? ''), rating: (s) => s.rating ?? '',
    },
  },
};

export const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------- IndexedDB mínimo (sin dependencias: los workers no ven el importmap) ----------
let dbPromise = null;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const idbGet = (key) => idb('readonly', (s) => s.get(key)).catch(() => undefined);
const idbSet = (key, value) => idb('readwrite', (s) => s.put(value, key));

// ---------- compresión ----------
const canGzip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function pack(obj) {
  const json = JSON.stringify(obj);
  if (!canGzip) return { enc: 'json', data: json };
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return { enc: 'gzip', data: await new Response(stream).blob() };
}

async function unpack({ enc, data }) {
  if (enc === 'json') return JSON.parse(data);
  return new Response(data.stream().pipeThrough(new DecompressionStream('gzip'))).json();
}

// ---------- carga ----------
function toColumns(section, rows) {
  const spec = SPECS[section];
  const keys = Object.keys(spec.cols);
  const cols = Object.fromEntries(keys.map((k) => [k, new Array(rows.length)]));
  rows.forEach((row, i) => { for (const k of keys) cols[k][i] = spec.cols[k](row); });
  if (spec.sortByNum && rows.length) {
    const order = rows.map((_, i) => i);
    const n = cols.num.map((v) => (v === '' ? Infinity : Number(v)));
    order.sort((a, b) => (n[a] - n[b]) || (a - b));
    for (const k of keys) cols[k] = order.map((i) => cols[k][i]);
  }
  return cols;
}

const indexes = new Map(); // section → { q: string[], cat: string[], length }

function buildIndex(section, cols) {
  const q = cols.name.map(fold);
  indexes.set(section, { q, cat: cols.cat, length: q.length });
  const counts = {};
  for (const c of cols.cat) counts[c] = (counts[c] || 0) + 1;
  return counts;
}

/**
 * @param {{ section: string, key: string, creds: object, proxy: {url:string, mode:string},
 *           ttlMs: number, force?: boolean }} req
 * @returns {Promise<{ categories: object[], cols: object, counts: object, stale: boolean, from: string }>}
 */
export async function loadSection({ section, key, creds, proxy, ttlMs, force = false }) {
  const spec = SPECS[section];
  const record = await idbGet(key);
  const valid = record && record.v === FORMAT;
  if (valid && !force && Date.now() - record.t < ttlMs) {
    const { categories, cols } = await unpack(record.packed);
    return { categories, cols, counts: buildIndex(section, cols), stale: false, from: 'cache' };
  }
  try {
    configureProxy(proxy);
    const client = new XtreamClient(creds);
    const [categories, rows] = await Promise.all([spec.cats(client), spec.items(client)]);
    const cols = toColumns(section, rows);
    const counts = buildIndex(section, cols);
    pack({ categories, cols })
      .then((packed) => idbSet(key, { v: FORMAT, t: Date.now(), packed }))
      .catch((e) => console.warn('[catalog] no se pudo guardar', key, e));
    return { categories, cols, counts, stale: false, from: 'network' };
  } catch (err) {
    if (!valid) throw err;
    // Panel caído: servir la última copia guardada.
    const { categories, cols } = await unpack(record.packed);
    return { categories, cols, counts: buildIndex(section, cols), stale: true, from: 'cache' };
  }
}

/** Índices de los ítems que cumplen categoría + todas las palabras buscadas. */
export function filterSection({ section, cat = '', query = '' }) {
  const ix = indexes.get(section);
  if (!ix) return new Int32Array(0);
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const out = new Int32Array(ix.length);
  let n = 0;
  for (let i = 0; i < ix.length; i++) {
    if (cat && ix.cat[i] !== cat) continue;
    let ok = true;
    for (const t of terms) if (!ix.q[i].includes(t)) { ok = false; break; }
    if (ok) out[n++] = i;
  }
  return out.slice(0, n);
}

export async function clearAll(prefix = '') {
  indexes.clear();
  const keys = await idb('readonly', (s) => s.getAllKeys()).catch(() => []);
  await Promise.all((keys || []).filter((k) => String(k).startsWith(prefix)).map((k) => idb('readwrite', (s) => s.delete(k))));
}

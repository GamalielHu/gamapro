/**
 * Acceso al catálogo desde la UI. Delega en el Web Worker; si el navegador no
 * admite workers de módulo, usa el mismo núcleo en el hilo principal.
 */
import { getProxy } from './xtream.js';

let worker = null;
let workerFailed = false;
let core = null;
let seq = 0;
const pending = new Map();

function startWorker() {
  try {
    const w = new Worker(new URL('../workers/catalog-parser.worker.js', import.meta.url), { type: 'module', name: 'gamapro-catalog' });
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.ok) p.resolve(data.result);
      else p.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
    };
    w.onerror = (e) => {
      // El worker no pudo arrancar (p. ej. sin soporte de módulos): pasar al hilo principal.
      console.warn('[catalog] worker no disponible, usando hilo principal', e.message);
      e.preventDefault?.();
      worker = null;
      workerFailed = true;
      for (const [id, p] of pending) { pending.delete(id); p.retry(); }
    };
    return w;
  } catch {
    return null;
  }
}

async function localCall(type, payload) {
  core ||= await import('../workers/catalog-core.js');
  if (type === 'load') return core.loadSection(payload);
  if (type === 'filter') return core.filterSection(payload);
  return core.clearAll(payload?.prefix);
}

function call(type, payload) {
  if (!worker && !workerFailed) {
    worker = startWorker();
    workerFailed = !worker;
  }
  if (!worker) return localCall(type, payload);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, retry: () => localCall(type, payload).then(resolve, reject) });
    worker.postMessage({ id, type, payload });
  });
}

/** El worker vive en /src/workers/: el proxy relativo ("proxy?url=") se pasa absoluto. */
function proxyForWorker() {
  const { url, mode } = getProxy();
  if (!url || url.includes('{url}')) return { url, mode };
  return { url: new URL(url, location.href).href, mode };
}

export const catalogStore = {
  /** @returns {Promise<{ categories, cols, counts, stale, from }>} */
  load({ section, accountId, creds, ttlHours, force = false }) {
    return call('load', {
      section,
      key: `${accountId}:${section}`,
      creds,
      proxy: proxyForWorker(),
      ttlMs: ttlHours * 3600_000,
      force,
    });
  },
  /** @returns {Promise<Int32Array>} índices que cumplen el filtro */
  filter(section, cat, query) {
    return call('filter', { section, cat, query });
  },
  clear(prefix = '') {
    return call('clear', { prefix });
  },
};

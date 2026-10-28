/**
 * Web Worker de catálogos: descarga, parseo, ordenamiento, compresión en
 * IndexedDB y búsqueda, todo fuera del hilo de la UI (sin jank al hacer scroll).
 * Protocolo: { id, type: 'load' | 'filter' | 'clear', payload } → { id, ok, result | error }
 */
import { loadSection, filterSection, clearAll } from './catalog-core.js';

self.onmessage = async ({ data: { id, type, payload } }) => {
  try {
    if (type === 'load') {
      self.postMessage({ id, ok: true, result: await loadSection(payload) });
    } else if (type === 'filter') {
      const result = filterSection(payload);
      self.postMessage({ id, ok: true, result }, [result.buffer]);
    } else if (type === 'clear') {
      await clearAll(payload?.prefix);
      self.postMessage({ id, ok: true, result: null });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: { message: err?.message || String(err), code: err?.code } });
  }
};

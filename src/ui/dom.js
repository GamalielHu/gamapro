/** Utilidades DOM mínimas compartidas por la UI. */

export const $ = (sel, root = document) => root.querySelector(sel);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Crea un elemento a partir de HTML (un solo nodo raíz). */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Texto normalizado para búsqueda: minúsculas y sin acentos. */
export const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec % 60), m = Math.floor((sec / 60) % 60), hh = Math.floor(sec / 3600);
  const mm = hh ? String(m).padStart(2, '0') : m;
  return `${hh ? `${hh}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function toast(message, { type = 'info', ms = 3200 } = {}) {
  const box = $('#toast');
  if (!box) return;
  const color = type === 'error' ? 'bg-red-600/95' : type === 'ok' ? 'bg-emerald-600/95' : 'bg-ink-700/95';
  const node = h(`<div class="${color} px-4 py-2 rounded-lg text-sm shadow-lg border border-white/10 max-w-[90vw]">${esc(message)}</div>`);
  box.append(node);
  setTimeout(() => node.remove(), ms);
}

/** Atajos de teclas de mandos TV / navegadores de Smart TV. */
export const KEY = {
  back: new Set(['Escape', 'Backspace', 'BrowserBack', 'GoBack', 'XF86Back']),
  ok: new Set(['Enter', 'NumpadEnter', 'Select']),
  chUp: new Set(['ChannelUp', 'PageUp', 'MediaTrackNext']),
  chDown: new Set(['ChannelDown', 'PageDown', 'MediaTrackPrevious']),
};

export const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && el.type !== 'range';

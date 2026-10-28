/**
 * Catálogo con grid virtual: solo existen en el DOM las tarjetas visibles
 * (+ margen), así listas de 10.000+ canales no congelan la página.
 * - Datos: descarga, parseo, caché comprimida y búsqueda en un Web Worker
 *   (services/catalog-store.js): el hilo de la UI solo pinta.
 * - Carátulas: IntersectionObserver con 200 px de margen, placeholder SVG
 *   mientras cargan y fallback local inmediato si fallan (sin reintentos).
 * - Precarga predictiva: tras 800 ms sobre un canal se precarga su manifiesto.
 */
import { cached, loadSettings } from '../services/cache.js';
import { catalogStore } from '../services/catalog-store.js';
import { h, esc, debounce, KEY, toast } from './dom.js';

const OVERSCAN_ROWS = 3;
const DWELL_MS = 800;

const SECTIONS = {
  live: { title: 'Live TV', layout: { minWidth: 150, itemHeight: 140, art: 'logo' } },
  movies: { title: 'Películas', layout: { minWidth: 140, itemHeight: 250, art: 'poster' } },
  series: { title: 'Series', layout: { minWidth: 140, itemHeight: 250, art: 'poster' } },
};

const svg = (body) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`)}`;
/** Placeholder mientras descarga (≈200 bytes, sin red). */
const PLACEHOLDER = svg('<rect width="64" height="64" fill="#0d1320"/><rect x="22" y="26" width="20" height="12" rx="2" fill="none" stroke="#1e293b" stroke-width="2"/>');
/** Icono genérico cuando la carátula falla (404, CORS, etc.). */
const FALLBACK = {
  logo: svg('<rect width="64" height="64" fill="#0d1320"/><rect x="14" y="18" width="36" height="24" rx="4" fill="none" stroke="#334155" stroke-width="3"/><path d="M26 48h12" stroke="#334155" stroke-width="3" stroke-linecap="round"/>'),
  poster: svg('<rect width="64" height="64" fill="#0d1320"/><rect x="18" y="14" width="28" height="36" rx="3" fill="none" stroke="#334155" stroke-width="3"/><path d="M28 26l10 6-10 6z" fill="#334155"/>'),
};
/** URLs que ya fallaron en esta sesión: no se vuelven a pedir. */
const failedImages = new Set();

export class VirtualGrid {
  constructor(scroller, { renderItem, onActivate, onEdge, onDwell }) {
    this.scroller = scroller;
    this.renderItem = renderItem;
    this.onActivate = onActivate;
    this.onEdge = onEdge;
    this.onDwell = onDwell;
    this.dwellTimer = 0;
    this.items = [];
    this.nodes = new Map();
    this.cols = 1;
    this.itemW = 150;
    this.itemH = 140;
    this.minWidth = 150;
    this.focusIndex = 0;
    this.frame = 0;

    this.inner = h('<div class="relative w-full"></div>');
    scroller.append(this.inner);

    scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.resizeObs = new ResizeObserver(() => { this.measure(); this.schedule(true); });
    this.resizeObs.observe(scroller);

    this.inner.addEventListener('click', (e) => {
      const node = e.target.closest('[data-i]');
      if (node) this.activate(Number(node.dataset.i));
    });
    this.inner.addEventListener('focusin', (e) => {
      const node = e.target.closest('[data-i]');
      if (!node) return;
      this.focusIndex = Number(node.dataset.i);
      this.dwell(this.focusIndex);
    });
    this.inner.addEventListener('mouseover', (e) => {
      const node = e.target.closest('[data-i]');
      if (node && Number(node.dataset.i) !== this.dwellIndex) this.dwell(Number(node.dataset.i));
    });
    this.inner.addEventListener('mouseleave', () => { clearTimeout(this.dwellTimer); this.dwellIndex = -1; });

    // Carga perezosa de carátulas con margen preventivo.
    this.io = new IntersectionObserver((entries) => {
      for (const { isIntersecting, target } of entries) {
        if (!isIntersecting) continue;
        this.io.unobserve(target);
        const src = target.dataset.src;
        if (src && !failedImages.has(src)) target.src = src;
        else if (src) target.src = target.dataset.fallback;
      }
    }, { root: scroller, rootMargin: '200px 0px' });
    // Fallback inmediato: un solo intento por URL, sin reintentos de red.
    this.inner.addEventListener('error', (e) => {
      const img = e.target;
      if (img.tagName !== 'IMG' || !img.dataset.src || img.src === img.dataset.fallback) return;
      failedImages.add(img.dataset.src);
      img.src = img.dataset.fallback;
    }, true);
    scroller.addEventListener('keydown', (e) => this.onKey(e));
  }

  configure({ minWidth, itemHeight }) {
    this.minWidth = minWidth;
    this.itemH = itemHeight;
  }

  setItems(items) {
    this.items = items;
    this.focusIndex = 0;
    for (const node of this.nodes.values()) this.release(node);
    this.nodes.clear();
    this.scroller.scrollTop = 0;
    this.measure();
    this.draw(true);
  }

  measure() {
    const w = this.scroller.clientWidth - 16;
    this.cols = Math.max(1, Math.floor(w / this.minWidth));
    this.itemW = w / this.cols;
    const rows = Math.ceil(this.items.length / this.cols);
    this.inner.style.height = `${rows * this.itemH + 16}px`;
  }

  schedule(relayout = false) {
    this.relayout ||= relayout;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw(this.relayout);
      this.relayout = false;
    });
  }

  range() {
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 800;
    const firstRow = Math.max(0, Math.floor(top / this.itemH) - OVERSCAN_ROWS);
    const lastRow = Math.ceil((top + height) / this.itemH) + OVERSCAN_ROWS;
    return [firstRow * this.cols, Math.min(this.items.length, lastRow * this.cols)];
  }

  place(node, i) {
    const x = 8 + (i % this.cols) * this.itemW;
    const y = 8 + Math.floor(i / this.cols) * this.itemH;
    node.style.transform = `translate(${x}px, ${y}px)`;
    node.style.width = `${this.itemW}px`;
    node.style.height = `${this.itemH}px`;
  }

  /** Precarga predictiva: el ítem bajo el foco/puntero más de 800 ms. */
  dwell(i) {
    clearTimeout(this.dwellTimer);
    this.dwellIndex = i;
    if (!this.onDwell) return;
    this.dwellTimer = setTimeout(() => { if (this.items[i]) this.onDwell(this.items[i], i); }, DWELL_MS);
  }

  release(node) {
    const img = node.querySelector('img');
    if (img) {
      this.io.unobserve(img);
      if (img.src !== img.dataset.fallback) img.removeAttribute('src'); // cancela descargas pendientes
    }
    node.remove();
  }

  draw(relayout = false) {
    const [first, last] = this.range();
    for (const [i, node] of this.nodes) {
      if (i < first || i >= last) {
        if (node.contains(document.activeElement)) continue; // no perder el foco
        this.release(node);
        this.nodes.delete(i);
      } else if (relayout) {
        this.place(node, i);
      }
    }
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      if (this.nodes.has(i)) continue;
      const node = this.renderItem(this.items[i], i);
      node.dataset.i = i;
      node.tabIndex = -1;
      const img = node.querySelector('img[data-src]');
      if (img) this.io.observe(img);
      this.place(node, i);
      this.nodes.set(i, node);
      frag.append(node);
    }
    this.inner.append(frag);
  }

  focus(index = this.focusIndex) {
    if (!this.items.length) return false;
    index = Math.max(0, Math.min(this.items.length - 1, index));
    this.focusIndex = index;
    const row = Math.floor(index / this.cols);
    const top = row * this.itemH;
    const { scrollTop, clientHeight } = this.scroller;
    if (top < scrollTop) this.scroller.scrollTop = top;
    else if (top + this.itemH + 16 > scrollTop + clientHeight) this.scroller.scrollTop = top + this.itemH + 16 - clientHeight;
    this.draw();
    this.nodes.get(index)?.focus({ preventScroll: true });
    return true;
  }

  activate(i) {
    if (this.items[i]) this.onActivate(this.items[i], i);
  }

  onKey(e) {
    const i = this.focusIndex;
    let next = null;
    switch (e.key) {
      case 'ArrowRight': next = i + 1; break;
      case 'ArrowLeft':
        if (i % this.cols === 0) { this.onEdge?.('left'); e.preventDefault(); return; }
        next = i - 1; break;
      case 'ArrowDown': next = i + this.cols; break;
      case 'ArrowUp':
        if (i < this.cols) { this.onEdge?.('up'); e.preventDefault(); return; }
        next = i - this.cols; break;
      case 'PageDown': next = i + this.cols * 4; break;
      case 'PageUp': next = i - this.cols * 4; break;
      case 'Home': next = 0; break;
      case 'End': next = this.items.length - 1; break;
      default:
        if (KEY.ok.has(e.key) && document.activeElement?.dataset.i) { e.preventDefault(); this.activate(i); }
        return;
    }
    e.preventDefault();
    this.focus(next);
  }
}

function renderCard(item, art) {
  const initials = esc(item.name.replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 2).toUpperCase() || '?');
  const img = item.icon
    ? `<img src="${PLACEHOLDER}" data-src="${esc(item.icon)}" data-fallback="${FALLBACK[art]}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : '';
  const badge = item.num ? `<span class="card-badge">${esc(item.num)}</span>`
    : item.rating && Number(item.rating) > 0 ? `<span class="card-badge">★ ${esc(Number(item.rating).toFixed(1))}</span>` : '';
  return h(`
    <div class="card" role="button" aria-label="${esc(item.name)}">
      <div class="card-in">
        <div class="card-art ${art}"><span class="card-fallback absolute">${initials}</span>${img}${badge}</div>
        <div class="card-name" title="${esc(item.name)}">${esc(item.name)}</div>
      </div>
    </div>`);
}

/** Columnas del worker → objetos ligeros que usa el grid (una pasada, sin parseo). */
function fromColumns(cols) {
  const keys = Object.keys(cols);
  const n = cols.id?.length || 0;
  const items = new Array(n);
  for (let i = 0; i < n; i++) {
    const it = {};
    for (const k of keys) it[k] = cols[k][i];
    items[i] = it;
  }
  return items;
}

export class Catalog {
  /**
   * @param {{ root: HTMLElement, search: HTMLInputElement, category: HTMLSelectElement,
   *           countLabel: HTMLElement, titleEl: HTMLElement, onPlay: Function, onEdge?: Function }} opts
   */
  constructor({ root, search, category, countLabel, titleEl, onPlay, onEdge, onDownload, onPrefetch }) {
    Object.assign(this, { root, search, category, countLabel, titleEl, onPlay, onDownload, onPrefetch });
    this.filterToken = 0;
    this.client = null;
    this.section = null;
    this.data = new Map(); // section -> { categories, items }
    this.filtered = [];
    this.loadToken = 0;

    root.innerHTML = '';
    this.scroller = h('<div class="absolute inset-0 overflow-y-auto overscroll-contain outline-none" tabindex="-1"></div>');
    this.status = h('<div class="hidden absolute inset-0 flex items-center justify-center text-slate-400 text-sm p-6 text-center"></div>');
    this.detail = h('<div class="hidden absolute inset-0 overflow-y-auto bg-ink-900 z-10"></div>');
    root.append(this.scroller, this.status, this.detail);

    this.grid = new VirtualGrid(this.scroller, {
      renderItem: (item) => renderCard(item, SECTIONS[this.section].layout.art),
      onActivate: (item, index) => this.activate(item, index),
      onEdge: (dir) => (dir === 'up' ? this.search.focus() : onEdge?.(dir)),
      onDwell: (item) => { if (this.section === 'live') this.onPrefetch?.({ section: 'live', item }); },
    });

    this.search.addEventListener('input', debounce(() => this.applyFilter(), 120));
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || KEY.ok.has(e.key)) { e.preventDefault(); this.grid.focus(0); }
    });
    this.category.addEventListener('change', () => this.applyFilter());
  }

  setClient(client) {
    this.client = client;
    this.data.clear();
  }

  get prefix() {
    return `${this.client.accountId}:`;
  }

  async show(section, { force = false } = {}) {
    const conf = SECTIONS[section];
    this.section = section;
    this.closeDetail();
    this.titleEl.textContent = conf.title;
    this.grid.configure(conf.layout);
    this.search.value = '';
    const token = ++this.loadToken;

    if (!this.data.has(section) || force) {
      this.grid.setItems([]);
      this.setStatus('Cargando catálogo…');
      try {
        const res = await catalogStore.load({
          section,
          accountId: this.client.accountId,
          creds: this.client.credentials,
          ttlHours: loadSettings().cacheHours,
          force,
        });
        this.data.set(section, { categories: res.categories, counts: res.counts, items: fromColumns(res.cols) });
        if (res.stale) toast('Sin conexión con el panel: mostrando el catálogo guardado.');
      } catch (err) {
        if (token === this.loadToken) this.setStatus(`No se pudo cargar: ${err.message}`);
        return;
      }
    }
    if (token !== this.loadToken) return;
    this.fillCategories();
    this.applyFilter();
  }

  fillCategories() {
    const { categories, counts, items } = this.data.get(this.section);
    const opts = [`<option value="">Todas (${items.length})</option>`];
    for (const c of categories) {
      const n = counts[String(c.category_id)];
      if (n) opts.push(`<option value="${esc(c.category_id)}">${esc(c.category_name)} (${n})</option>`);
    }
    this.category.innerHTML = opts.join('');
  }

  /** El filtrado corre en el worker; respuestas viejas (tecleo rápido) se descartan. */
  async applyFilter() {
    const section = this.section;
    const entry = this.data.get(section);
    if (!entry) return;
    const token = ++this.filterToken;
    const cat = this.category.value;
    const query = this.search.value;
    let idx;
    try {
      idx = cat || query.trim() ? await catalogStore.filter(section, cat, query) : null;
    } catch {
      idx = null;
    }
    if (token !== this.filterToken || section !== this.section) return;
    this.filtered = idx ? Array.from(idx, (i) => entry.items[i]) : entry.items;
    this.countLabel.textContent = `${this.filtered.length.toLocaleString()} ítems`;
    this.setStatus(this.filtered.length ? '' : 'Sin resultados');
    this.grid.setItems(this.filtered);
  }

  setStatus(msg) {
    this.status.textContent = msg;
    this.status.classList.toggle('hidden', !msg);
  }

  focus() {
    if (!this.detail.classList.contains('hidden')) return this.detail.querySelector('button')?.focus();
    if (!this.grid.focus()) this.search.focus();
  }

  activate(item, index) {
    if (this.section === 'series') return this.openSeries(item);
    this.onPlay({ section: this.section, item, list: this.filtered, index });
  }

  // ---------- Detalle de serie ----------
  async openSeries(series) {
    const d = this.detail;
    d.classList.remove('hidden');
    d.innerHTML = '<div class="p-8 text-slate-400 text-sm">Cargando episodios…</div>';
    let data;
    try {
      data = await cached(`${this.prefix}series-info:${series.id}`, () => this.client.getSeriesInfo(series.id), { ttlHours: 6 });
    } catch (err) {
      d.innerHTML = '';
      toast(`No se pudo cargar la serie: ${err.message}`, { type: 'error' });
      this.closeDetail();
      return;
    }
    const seasons = Object.keys(data.episodes).sort((a, b) => Number(a) - Number(b));
    const info = data.info;
    d.innerHTML = '';
    const view = h(`
      <div class="p-4 sm:p-6 max-w-5xl">
        <div class="flex gap-5 mb-5">
          ${series.icon ? `<img src="${esc(series.icon)}" alt="" class="hidden sm:block w-32 rounded-lg object-cover" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
          <div class="min-w-0">
            <button data-back class="btn mb-3">← Volver</button>
            <h2 class="text-xl font-semibold">${esc(series.name)}</h2>
            <p class="text-xs text-slate-400 mt-1">${esc([info.releaseDate || info.release_date, info.genre].filter(Boolean).join(' · '))}</p>
            <p class="text-sm text-slate-300 mt-2 line-clamp-4">${esc(info.plot || '')}</p>
          </div>
        </div>
        <div data-seasons class="flex flex-wrap gap-2 mb-4"></div>
        <div data-episodes class="grid gap-2"></div>
      </div>`);
    d.append(view);
    const seasonBar = view.querySelector('[data-seasons]');
    const list = view.querySelector('[data-episodes]');

    const showSeason = (s) => {
      seasonBar.querySelectorAll('button').forEach((b) => b.classList.toggle('btn-primary', b.dataset.s === s));
      const eps = data.episodes[s] || [];
      list.innerHTML = '';
      eps.forEach((ep, idx) => {
        const row = h(`
          <div class="flex gap-2">
            <button data-play class="btn !justify-start text-left !font-normal flex-1 min-w-0">
              <span class="text-brand-400 tabular-nums w-10 shrink-0">E${esc(ep.episode_num ?? idx + 1)}</span>
              <span class="truncate">${esc(ep.title || `Episodio ${idx + 1}`)}</span>
            </button>
            ${this.onDownload ? '<button data-dl class="btn shrink-0" title="Descargar" aria-label="Descargar episodio">⬇</button>' : ''}
          </div>`);
        const items = () => eps.map((e, i) => ({
          id: e.id, name: `${series.name} · T${s}E${e.episode_num ?? i + 1}`, ext: e.container_extension || 'mp4', icon: e.info?.movie_image,
        }));
        row.querySelector('[data-play]').addEventListener('click', () => {
          const all = items();
          this.onPlay({ section: 'episode', item: all[idx], list: all, index: idx });
        });
        row.querySelector('[data-dl]')?.addEventListener('click', () => this.onDownload({ section: 'episode', item: items()[idx] }));
        list.append(row);
      });
    };

    for (const s of seasons) {
      const b = h(`<button class="btn" data-s="${esc(s)}">Temporada ${esc(s)}</button>`);
      b.addEventListener('click', () => showSeason(s));
      seasonBar.append(b);
    }
    view.querySelector('[data-back]').addEventListener('click', () => { this.closeDetail(); this.grid.focus(); });
    d.addEventListener('keydown', this.detailKeys ||= (e) => {
      if (KEY.back.has(e.key)) { e.preventDefault(); this.closeDetail(); this.grid.focus(); return; }
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const focusables = [...d.querySelectorAll('button')];
      const i = focusables.indexOf(document.activeElement);
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      focusables[Math.max(0, Math.min(focusables.length - 1, i + step))]?.focus();
      e.preventDefault();
    });
    if (seasons.length) showSeason(seasons[0]);
    else list.innerHTML = '<p class="text-sm text-slate-400">Esta serie no tiene episodios.</p>';
    view.querySelector('[data-back]').focus();
  }

  closeDetail() {
    this.detail.classList.add('hidden');
    this.detail.innerHTML = '';
  }

  isDetailOpen() {
    return !this.detail.classList.contains('hidden');
  }
}

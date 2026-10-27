/**
 * Catálogo con grid virtual: solo existen en el DOM las tarjetas visibles
 * (+ margen), así listas de 10.000+ canales no congelan la página.
 * Búsqueda en tiempo real, filtro por categoría y navegación con flechas.
 */
import { cached } from '../services/cache.js';
import { h, esc, fold, debounce, KEY, toast } from './dom.js';

const OVERSCAN_ROWS = 3;

const SECTIONS = {
  live: {
    title: 'Live TV',
    layout: { minWidth: 150, itemHeight: 140, art: 'logo' },
    categories: (c, o) => c.getLiveCategories(o),
    streams: (c, o) => c.getLiveStreams(undefined, o),
    norm: (s) => ({ id: s.stream_id, name: s.name || '', icon: s.stream_icon, cat: String(s.category_id ?? ''), num: s.num, epg: s.epg_channel_id }),
  },
  movies: {
    title: 'Películas',
    layout: { minWidth: 140, itemHeight: 250, art: 'poster' },
    categories: (c, o) => c.getVodCategories(o),
    streams: (c, o) => c.getVodStreams(undefined, o),
    norm: (s) => ({ id: s.stream_id, name: s.name || '', icon: s.stream_icon, cat: String(s.category_id ?? ''), ext: s.container_extension || 'mp4', rating: s.rating }),
  },
  series: {
    title: 'Series',
    layout: { minWidth: 140, itemHeight: 250, art: 'poster' },
    categories: (c, o) => c.getSeriesCategories(o),
    streams: (c, o) => c.getSeries(undefined, o),
    norm: (s) => ({ id: s.series_id, name: s.name || '', icon: s.cover, cat: String(s.category_id ?? ''), rating: s.rating }),
  },
};

export class VirtualGrid {
  constructor(scroller, { renderItem, onActivate, onEdge }) {
    this.scroller = scroller;
    this.renderItem = renderItem;
    this.onActivate = onActivate;
    this.onEdge = onEdge;
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
      if (node) this.focusIndex = Number(node.dataset.i);
    });
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

  release(node) {
    const img = node.querySelector('img');
    if (img) img.removeAttribute('src'); // cancela descargas pendientes
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
    ? `<img src="${esc(item.icon)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
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

export class Catalog {
  /**
   * @param {{ root: HTMLElement, search: HTMLInputElement, category: HTMLSelectElement,
   *           countLabel: HTMLElement, titleEl: HTMLElement, onPlay: Function, onEdge?: Function }} opts
   */
  constructor({ root, search, category, countLabel, titleEl, onPlay, onEdge, onDownload }) {
    Object.assign(this, { root, search, category, countLabel, titleEl, onPlay, onDownload });
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
        const opts = { force };
        const [categories, items] = await Promise.all([
          cached(`${this.prefix}${section}:cats`, () => conf.categories(this.client), opts),
          cached(`${this.prefix}${section}:items`, async () => (await conf.streams(this.client)).map(conf.norm), opts),
        ]);
        for (const it of items) it.q = fold(it.name);
        this.data.set(section, { categories, items });
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
    const { categories, items } = this.data.get(this.section);
    const counts = new Map();
    for (const it of items) counts.set(it.cat, (counts.get(it.cat) || 0) + 1);
    const opts = [`<option value="">Todas (${items.length})</option>`];
    for (const c of categories) {
      const n = counts.get(String(c.category_id));
      if (n) opts.push(`<option value="${esc(c.category_id)}">${esc(c.category_name)} (${n})</option>`);
    }
    this.category.innerHTML = opts.join('');
  }

  applyFilter() {
    const entry = this.data.get(this.section);
    if (!entry) return;
    const cat = this.category.value;
    const terms = fold(this.search.value).split(/\s+/).filter(Boolean);
    this.filtered = entry.items.filter((it) => (!cat || it.cat === cat) && terms.every((t) => it.q.includes(t)));
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

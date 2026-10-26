/**
 * OSD minimalista del reproductor: mouse, teclado (flechas tipo control TV),
 * mandos (Gamepad API) y teclas de Smart TV.
 *
 * Live:  ↑/↓, CH+/CH-, PgUp/PgDn → cambio de canal (zapping con debounce)
 *        dígitos → saltar al canal por número
 * VOD:   ←/→ → ±10 s
 * Todos: Enter/OK → mostrar OSD / activar botón · Espacio → pausa
 *        Esc/Back → cerrar menú o salir · A = audio · S = subtítulos · F = pantalla completa
 */
import { h, esc, fmtTime, KEY, toast } from './dom.js';

const HIDE_MS = 3500;
const ZAP_MS = 350;
const DIGITS_MS = 1500;

export class PlayerUI {
  /**
   * @param {{ root: HTMLElement, osd: HTMLElement, engine: import('../player/engine.js').PlayerEngine,
   *           resolve: (ctx:{section:string,item:object}) => {title:string, sources:Array, live:boolean},
   *           onClose?: Function }} opts
   */
  constructor({ root, osd, engine, resolve, onClose }) {
    Object.assign(this, { root, osd, engine, resolve, onClose });
    this.video = engine.video;
    this.ctx = null;
    this.hideTimer = 0;
    this.zapTimer = 0;
    this.digits = '';
    this.digitTimer = 0;
    this.padFrame = 0;
    this.padPrev = [];
    this.build();
    this.bind();
  }

  build() {
    this.osd.innerHTML = '';
    this.ui = h(`
      <div class="absolute inset-0 flex flex-col justify-between text-white">
        <div class="osd-layer bg-gradient-to-b from-black/80 to-transparent px-5 pt-4 pb-10 flex items-start gap-4">
          <div class="min-w-0 flex-1">
            <div data-title class="text-lg sm:text-xl font-semibold truncate"></div>
            <div data-sub class="text-xs text-slate-300 mt-0.5 truncate"></div>
          </div>
          <div data-clock class="text-sm tabular-nums text-slate-300"></div>
        </div>
        <div data-digits class="hidden absolute top-6 right-6 text-4xl font-bold tabular-nums bg-black/60 px-4 py-2 rounded-xl"></div>
        <div data-spinner class="hidden absolute inset-0 flex items-center justify-center pointer-events-none"><div class="spinner"></div></div>
        <div data-center class="absolute inset-0" aria-hidden="true"></div>
        <div class="osd-layer relative bg-gradient-to-t from-black/85 to-transparent px-5 pt-10 pb-5">
          <div data-seekrow class="flex items-center gap-3 mb-3 text-xs tabular-nums">
            <span data-cur>0:00</span>
            <input data-seek type="range" class="seek flex-1" min="0" max="1000" value="0" step="1" aria-label="Posición">
            <span data-dur>--:--</span>
          </div>
          <div class="flex items-center gap-2" data-controls>
            <button class="osd-btn" data-act="prev" title="Canal anterior">⏮</button>
            <button class="osd-btn" data-act="back10" title="-10 s">↺</button>
            <button class="osd-btn" data-act="toggle" title="Reproducir/Pausa">⏸</button>
            <button class="osd-btn" data-act="fwd10" title="+10 s">↻</button>
            <button class="osd-btn" data-act="next" title="Canal siguiente">⏭</button>
            <span class="flex-1"></span>
            <button class="osd-btn" data-act="mute" title="Silencio">🔊</button>
            <button class="osd-btn" data-act="audio" title="Audio (A)">🎧</button>
            <button class="osd-btn" data-act="subs" title="Subtítulos (S)">CC</button>
            <button class="osd-btn" data-act="fs" title="Pantalla completa (F)">⛶</button>
            <button class="osd-btn" data-act="close" title="Salir (Esc)">✕</button>
          </div>
          <div data-menu class="osd-menu hidden absolute right-5 bottom-20 min-w-[14rem] max-h-[50vh] overflow-y-auto bg-ink-800/95 border border-white/10 rounded-xl p-1.5 shadow-2xl" role="menu"></div>
        </div>
      </div>`);
    this.osd.append(this.ui);
    const q = (s) => this.ui.querySelector(s);
    this.el = {
      title: q('[data-title]'), sub: q('[data-sub]'), clock: q('[data-clock]'), digits: q('[data-digits]'),
      spinner: q('[data-spinner]'), center: q('[data-center]'), seekRow: q('[data-seekrow]'), seek: q('[data-seek]'),
      cur: q('[data-cur]'), dur: q('[data-dur]'), controls: q('[data-controls]'), menu: q('[data-menu]'),
      toggle: q('[data-act="toggle"]'), mute: q('[data-act="mute"]'),
    };
  }

  bind() {
    const { engine, video, el } = this;
    el.controls.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) this.action(act);
    });
    el.center.addEventListener('click', () => (this.osdVisible ? this.action('toggle') : this.showOsd()));
    el.center.addEventListener('dblclick', () => this.action('fs'));
    el.seek.addEventListener('input', () => {
      if (Number.isFinite(video.duration)) video.currentTime = (el.seek.value / 1000) * video.duration;
    });
    this.root.addEventListener('mousemove', () => this.showOsd());
    this.root.addEventListener('keydown', (e) => this.onKey(e));

    video.addEventListener('timeupdate', () => this.updateTime());
    video.addEventListener('durationchange', () => this.updateTime());
    video.addEventListener('volumechange', () => { el.mute.textContent = video.muted ? '🔇' : '🔊'; });
    video.addEventListener('play', () => { el.toggle.textContent = '⏸'; });
    video.addEventListener('pause', () => { el.toggle.textContent = '▶'; this.showOsd(true); });

    engine.addEventListener('state', (e) => {
      const s = e.detail.state;
      el.spinner.classList.toggle('hidden', !(s === 'loading' || s === 'buffering'));
    });
    engine.addEventListener('source', (e) => {
      const { source, index, total } = e.detail;
      const fmt = source.kind === 'hls' ? 'HLS' : source.kind === 'mpegts' ? 'MPEG-TS' : 'Directo';
      el.sub.textContent = `${fmt}${source.proxy ? ' · proxy' : ''}${index ? ` · fuente ${index + 1}/${total}` : ''}`;
    });
    engine.addEventListener('error', (e) => {
      el.spinner.classList.add('hidden');
      el.sub.textContent = e.detail.message;
      toast(e.detail.message, { type: 'error', ms: 5000 });
      this.showOsd(true);
    });
    engine.addEventListener('autoplay-muted', () => toast('Reproduciendo sin sonido: pulsa 🔊 para activarlo'));
    engine.addEventListener('tracks', () => { if (!el.menu.classList.contains('hidden')) this.openMenu(this.menuKind); });
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }
  get osdVisible() { return !this.root.classList.contains('osd-hidden'); }

  /** @param {{section:string, item:object, list:object[], index:number}} ctx */
  open(ctx) {
    this.ctx = { ...ctx };
    this.lastFocus = document.activeElement;
    this.root.classList.remove('hidden');
    this.root.focus();
    if (!document.fullscreenElement) this.root.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
    this.playCurrent();
    this.startClock();
    this.startGamepad();
    this.showOsd();
  }

  close() {
    if (!this.isOpen) return;
    clearTimeout(this.zapTimer);
    clearInterval(this.clockTimer);
    cancelAnimationFrame(this.padFrame);
    this.closeMenu();
    this.engine.destroy();
    this.root.classList.add('hidden');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.ctx = null;
    this.onClose?.();
    this.lastFocus?.focus?.();
  }

  playCurrent() {
    const { title, sources, live } = this.resolve(this.ctx);
    this.live = live;
    this.el.title.textContent = title;
    this.el.seekRow.classList.toggle('hidden', live);
    this.ui.querySelectorAll('[data-act="back10"],[data-act="fwd10"]').forEach((b) => b.classList.toggle('hidden', live));
    const multi = this.ctx.list?.length > 1;
    this.ui.querySelectorAll('[data-act="prev"],[data-act="next"]').forEach((b) => b.classList.toggle('hidden', !multi));
    this.engine.load(sources, { live });
  }

  /** Zapping: el título cambia al instante, la carga espera a que se deje de pulsar. */
  zap(delta) {
    const list = this.ctx?.list;
    if (!list || list.length < 2) return;
    this.ctx.index = (this.ctx.index + delta + list.length) % list.length;
    this.ctx.item = list[this.ctx.index];
    const it = this.ctx.item;
    this.el.title.textContent = `${it.num ? `${it.num} · ` : ''}${it.name}`;
    this.el.sub.textContent = 'Cambiando…';
    this.showOsd();
    clearTimeout(this.zapTimer);
    this.zapTimer = setTimeout(() => this.playCurrent(), ZAP_MS);
  }

  jumpToNumber(num) {
    const list = this.ctx?.list || [];
    const idx = list.findIndex((it) => String(it.num) === num);
    if (idx < 0) return toast(`Canal ${num} no está en esta lista`);
    this.zap(idx - this.ctx.index);
  }

  pushDigit(d) {
    this.digits = (this.digits + d).slice(-4);
    this.el.digits.textContent = this.digits;
    this.el.digits.classList.remove('hidden');
    clearTimeout(this.digitTimer);
    this.digitTimer = setTimeout(() => {
      this.el.digits.classList.add('hidden');
      const n = this.digits;
      this.digits = '';
      this.jumpToNumber(n);
    }, DIGITS_MS);
  }

  action(act) {
    const v = this.video;
    this.showOsd();
    switch (act) {
      case 'toggle': v.paused ? v.play().catch(() => {}) : v.pause(); break;
      case 'prev': this.zap(-1); break;
      case 'next': this.zap(1); break;
      case 'back10': this.seekBy(-10); break;
      case 'fwd10': this.seekBy(10); break;
      case 'mute': v.muted = !v.muted; break;
      case 'audio': this.toggleMenu('audio'); break;
      case 'subs': this.toggleMenu('subs'); break;
      case 'fs':
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else this.root.requestFullscreen?.().catch(() => {});
        break;
      case 'close': this.close(); break;
    }
  }

  seekBy(sec) {
    const v = this.video;
    if (this.live || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 1, v.currentTime + sec));
  }

  // ---------- menús de audio / subtítulos ----------
  toggleMenu(kind) {
    if (!this.el.menu.classList.contains('hidden') && this.menuKind === kind) return this.closeMenu();
    this.openMenu(kind);
  }

  openMenu(kind) {
    this.menuKind = kind;
    const menu = this.el.menu;
    const tracks = kind === 'audio' ? this.engine.getAudioTracks() : this.engine.getSubtitleTracks();
    const items = kind === 'subs' ? [{ id: -1, label: 'Desactivados', active: !tracks.some((t) => t.active) }, ...tracks] : tracks;
    const heading = kind === 'audio' ? 'Audio' : 'Subtítulos';
    menu.innerHTML = `<div class="px-3 py-1.5 text-xs uppercase tracking-wide text-slate-400">${heading}</div>${
      items.length ? items.map((t) => `<button role="menuitemradio" aria-checked="${t.active}" data-id="${t.id}">${esc(t.label)}</button>`).join('')
        : '<div class="px-3 py-2 text-sm text-slate-400">No hay pistas disponibles</div>'}`;
    menu.classList.remove('hidden');
    menu.onclick = (e) => {
      const b = e.target.closest('button[data-id]');
      if (!b) return;
      const id = Number(b.dataset.id);
      kind === 'audio' ? this.engine.setAudioTrack(id) : this.engine.setSubtitleTrack(id);
      this.closeMenu();
    };
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'))?.focus();
  }

  closeMenu() {
    this.el.menu.classList.add('hidden');
    if (this.el.menu.contains(document.activeElement)) this.ui.querySelector(`[data-act="${this.menuKind}"]`)?.focus();
  }

  // ---------- OSD ----------
  showOsd(sticky = false) {
    this.root.classList.remove('osd-hidden');
    clearTimeout(this.hideTimer);
    if (sticky) return;
    this.hideTimer = setTimeout(() => {
      if (this.video.paused || !this.el.menu.classList.contains('hidden')) return;
      this.root.classList.add('osd-hidden');
      if (this.el.controls.contains(document.activeElement)) this.root.focus();
    }, HIDE_MS);
  }

  updateTime() {
    const v = this.video;
    if (this.live) return;
    this.el.cur.textContent = fmtTime(v.currentTime);
    this.el.dur.textContent = fmtTime(v.duration);
    if (Number.isFinite(v.duration) && v.duration > 0 && document.activeElement !== this.el.seek) {
      this.el.seek.value = Math.round((v.currentTime / v.duration) * 1000);
    }
  }

  startClock() {
    const tick = () => { this.el.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    tick();
    clearInterval(this.clockTimer);
    this.clockTimer = setInterval(tick, 15000);
  }

  // ---------- teclado ----------
  onKey(e) {
    const k = e.key;
    const menuOpen = !this.el.menu.classList.contains('hidden');
    const inControls = this.el.controls.contains(document.activeElement);

    if (KEY.back.has(k)) {
      e.preventDefault();
      return menuOpen ? this.closeMenu() : this.close();
    }
    if (menuOpen && (k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      const btns = [...this.el.menu.querySelectorAll('button')];
      const i = btns.indexOf(document.activeElement);
      btns[(i + (k === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
      return;
    }
    if (inControls && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      e.preventDefault();
      const btns = [...this.el.controls.querySelectorAll('button:not(.hidden)')];
      const i = btns.indexOf(document.activeElement);
      btns[Math.max(0, Math.min(btns.length - 1, i + (k === 'ArrowRight' ? 1 : -1)))]?.focus();
      this.showOsd();
      return;
    }
    if (document.activeElement === this.el.seek && (k === 'ArrowLeft' || k === 'ArrowRight')) { this.showOsd(); return; }

    if (KEY.chUp.has(k)) { e.preventDefault(); return this.zap(1); }
    if (KEY.chDown.has(k)) { e.preventDefault(); return this.zap(-1); }

    switch (k) {
      case 'ArrowUp': e.preventDefault(); return this.live ? this.zap(-1) : this.showOsd();
      case 'ArrowDown': e.preventDefault(); return this.live ? this.zap(1) : this.showOsd();
      case 'ArrowLeft': e.preventDefault(); this.showOsd(); return this.seekBy(-10);
      case 'ArrowRight': e.preventDefault(); this.showOsd(); return this.seekBy(10);
      case ' ': case 'MediaPlayPause': case 'k': e.preventDefault(); return this.action('toggle');
      case 'a': case 'A': return this.action('audio');
      case 's': case 'S': return this.action('subs');
      case 'f': case 'F': return this.action('fs');
      case 'm': case 'M': return this.action('mute');
    }
    if (KEY.ok.has(k) && !inControls && !menuOpen) {
      e.preventDefault();
      this.showOsd();
      this.el.toggle.focus();
      return;
    }
    if (this.live && /^[0-9]$/.test(k)) this.pushDigit(k);
  }

  // ---------- mando (Gamepad API) ----------
  startGamepad() {
    if (!navigator.getGamepads) return;
    const MAP = { 0: 'Enter', 1: 'Escape', 2: 'a', 3: 's', 4: 'PageDown', 5: 'PageUp', 9: ' ', 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight' };
    const loop = () => {
      if (!this.isOpen) return;
      const pad = [...navigator.getGamepads()].find(Boolean);
      if (pad) {
        pad.buttons.forEach((b, i) => {
          const was = this.padPrev[i];
          if (b.pressed && !was && MAP[i]) {
            const target = document.activeElement && this.root.contains(document.activeElement) ? document.activeElement : this.root;
            target.dispatchEvent(new KeyboardEvent('keydown', { key: MAP[i], bubbles: true }));
            if (MAP[i] === 'Enter' && target.tagName === 'BUTTON') target.click();
          }
          this.padPrev[i] = b.pressed;
        });
      }
      this.padFrame = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.padFrame);
    this.padFrame = requestAnimationFrame(loop);
  }
}

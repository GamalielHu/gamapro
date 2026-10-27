/**
 * Mantiene la pantalla encendida mientras hay video (como YouTube).
 * - Screen Wake Lock API cuando existe (Chrome/Android, Safari 16.4+).
 * - Respaldo para iPad/iPhone antiguos o modo app sin Wake Lock: un video
 *   mínimo, silencioso y en bucle, que iOS trata como reproducción activa.
 * El bloqueo se pierde al cambiar de app; se vuelve a pedir al regresar.
 */
const FALLBACK_SRC = new URL('./nosleep.mp4', import.meta.url).href;

export class KeepAwake {
  #sentinel = null;
  #wanted = false;
  #fallback = null;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.#wanted) this.#acquire();
    });
  }

  enable() {
    this.#wanted = true;
    this.#acquire();
  }

  disable() {
    this.#wanted = false;
    this.#sentinel?.release().catch(() => {});
    this.#sentinel = null;
    this.#fallback?.pause();
  }

  async #acquire() {
    if ('wakeLock' in navigator) {
      try {
        if (!this.#sentinel || this.#sentinel.released) this.#sentinel = await navigator.wakeLock.request('screen');
        if (!this.#wanted) this.disable(); // se desactivó mientras se pedía
        return;
      } catch {
        // Denegado (p. ej. modo app en iOS antiguo): usar el respaldo.
      }
    }
    if (!this.#fallback) {
      const v = document.createElement('video');
      v.src = FALLBACK_SRC;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;bottom:0;right:0';
      document.body.append(v);
      this.#fallback = v;
    }
    this.#fallback.play().catch(() => {});
  }
}

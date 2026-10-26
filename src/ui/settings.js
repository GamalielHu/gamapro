/** Vista de Ajustes: proxy CORS, formato de Live, caché y sesión. */
import { configureProxy } from '../services/xtream.js';
import { loadSettings, saveSettings, clearCatalogCache } from '../services/cache.js';
import { h, esc, toast } from './dom.js';

export function renderSettings(root, { client, onReload, onLogout }) {
  const s = loadSettings();
  const u = client.info?.user_info || {};
  const exp = Number(u.exp_date) ? new Date(Number(u.exp_date) * 1000).toLocaleDateString() : '—';
  root.innerHTML = '';
  const view = h(`
    <form class="p-4 sm:p-6 max-w-2xl space-y-6">
      <section class="bg-ink-800 rounded-xl p-5 border border-white/5">
        <h2 class="font-semibold mb-3">Cuenta</h2>
        <dl class="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt class="text-slate-400">Servidor</dt><dd class="truncate">${esc(client.host)}</dd>
          <dt class="text-slate-400">Usuario</dt><dd>${esc(client.username)}</dd>
          <dt class="text-slate-400">Estado</dt><dd>${esc(u.status || '—')}</dd>
          <dt class="text-slate-400">Vence</dt><dd>${esc(exp)}</dd>
          <dt class="text-slate-400">Conexiones</dt><dd>${esc(u.active_cons ?? '—')} / ${esc(u.max_connections ?? '—')}</dd>
          <dt class="text-slate-400">Formatos</dt><dd>${esc(client.outputFormats.join(', '))}</dd>
        </dl>
      </section>

      <section class="bg-ink-800 rounded-xl p-5 border border-white/5 space-y-3">
        <h2 class="font-semibold">Proxy CORS</h2>
        <p class="text-xs text-slate-400">Se usa cuando el panel bloquea llamadas desde el navegador o se sirve por http en una página https.
          Con el servidor incluido (<code>npm start</code>) usa <code>/proxy?url=</code>. También acepta plantillas con <code>{url}</code>.</p>
        <input name="proxyUrl" class="field w-full" placeholder="/proxy?url=" value="${esc(s.proxyUrl)}">
        <select name="proxyMode" class="field w-full">
          <option value="auto">Automático (solo si falla la conexión directa)</option>
          <option value="always">Siempre</option>
          <option value="off">Desactivado</option>
        </select>
      </section>

      <section class="bg-ink-800 rounded-xl p-5 border border-white/5 space-y-3">
        <h2 class="font-semibold">Reproducción y caché</h2>
        <label class="block text-sm">Formato preferido de Live TV
          <select name="liveFormat" class="field w-full mt-1">
            <option value="m3u8">HLS (.m3u8) → si falla, MPEG-TS</option>
            <option value="ts">MPEG-TS (.ts) → si falla, HLS</option>
          </select>
        </label>
        <label class="block text-sm">Validez del catálogo en caché (horas)
          <input name="cacheHours" type="number" min="1" max="168" class="field w-full mt-1" value="${esc(s.cacheHours)}">
        </label>
      </section>

      <div class="flex flex-wrap gap-3">
        <button type="submit" class="btn btn-primary">Guardar</button>
        <button type="button" data-reload class="btn">Recargar catálogo</button>
        <button type="button" data-clear class="btn">Vaciar caché</button>
        <button type="button" data-logout class="btn !text-red-300">Cerrar sesión</button>
      </div>
    </form>`);
  view.proxyMode.value = s.proxyMode;
  view.liveFormat.value = s.liveFormat;
  root.append(view);

  view.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = saveSettings({
      proxyUrl: view.proxyUrl.value.trim(),
      proxyMode: view.proxyMode.value,
      liveFormat: view.liveFormat.value,
      cacheHours: Math.max(1, Math.min(168, Number(view.cacheHours.value) || 12)),
    });
    configureProxy({ url: next.proxyUrl, mode: next.proxyMode });
    toast('Ajustes guardados', { type: 'ok' });
  });
  view.querySelector('[data-reload]').addEventListener('click', () => onReload());
  view.querySelector('[data-clear]').addEventListener('click', async () => {
    await clearCatalogCache();
    toast('Caché vaciada', { type: 'ok' });
  });
  view.querySelector('[data-logout]').addEventListener('click', () => onLogout());
}

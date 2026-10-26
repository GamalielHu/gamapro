/** Formulario de acceso: Host/URL, Usuario, Contraseña, "Probar conexión" y proxy CORS. */
import { XtreamClient, configureProxy, getProxy } from '../services/xtream.js';
import { saveSettings, loadSettings } from '../services/cache.js';
import { h, esc } from './dom.js';

function describe(info) {
  const u = info.user_info || {};
  const exp = Number(u.exp_date) ? new Date(Number(u.exp_date) * 1000).toLocaleDateString() : 'sin fecha';
  return `Conexión OK · Estado: ${u.status || '—'} · Vence: ${exp} · Conexiones: ${u.active_cons ?? 0}/${u.max_connections ?? '∞'}`;
}

/**
 * @param {HTMLElement} root
 * @param {{ initial?: object, onLogin: (client: XtreamClient) => Promise<void>|void }} opts
 */
export function renderLogin(root, { initial = {}, onLogin }) {
  const settings = loadSettings();
  root.innerHTML = '';
  const form = h(`
    <form class="min-h-full flex items-center justify-center p-4" autocomplete="on" novalidate>
      <div class="w-full max-w-md bg-ink-800 border border-white/5 rounded-2xl p-6 sm:p-8 shadow-2xl">
        <div class="flex items-center gap-2 text-2xl font-bold mb-1">
          <span class="inline-block w-3 h-3 rounded-full bg-brand-500"></span>Gama<span class="text-brand-400 -ml-2">Pro</span>
        </div>
        <p class="text-sm text-slate-400 mb-6">Accede con tu cuenta Xtream Codes.</p>

        <label class="block text-xs text-slate-400 mb-1" for="lg-host">Host / URL</label>
        <input id="lg-host" name="host" class="field w-full mb-4" placeholder="http://servidor.tv:8080" inputmode="url" required value="${esc(initial.host)}">

        <label class="block text-xs text-slate-400 mb-1" for="lg-user">Usuario</label>
        <input id="lg-user" name="username" class="field w-full mb-4" autocomplete="username" required value="${esc(initial.username)}">

        <label class="block text-xs text-slate-400 mb-1" for="lg-pass">Contraseña</label>
        <input id="lg-pass" name="password" type="password" class="field w-full mb-4" autocomplete="current-password" required value="${esc(initial.password)}">

        <details class="mb-5 text-sm">
          <summary class="cursor-pointer text-slate-400 select-none">Proxy CORS (opcional)</summary>
          <div class="mt-3 space-y-2">
            <input name="proxyUrl" class="field w-full" placeholder="/proxy?url=  o  https://proxy/?url={url}" value="${esc(settings.proxyUrl)}">
            <select name="proxyMode" class="field w-full">
              <option value="auto">Automático (solo si falla la conexión directa)</option>
              <option value="always">Siempre</option>
              <option value="off">Desactivado</option>
            </select>
          </div>
        </details>

        <p data-status class="min-h-[1.25rem] text-sm mb-4" role="status" aria-live="polite"></p>

        <div class="flex gap-3">
          <button type="button" data-test class="btn flex-1">Probar conexión</button>
          <button type="submit" class="btn btn-primary flex-1">Entrar</button>
        </div>
      </div>
    </form>`);
  form.proxyMode.value = settings.proxyMode;
  root.append(form);

  const status = form.querySelector('[data-status]');
  const buttons = form.querySelectorAll('button');
  const setStatus = (msg, kind = 'info') => {
    status.textContent = msg;
    status.className = `min-h-[1.25rem] text-sm mb-4 ${kind === 'error' ? 'text-red-400' : kind === 'ok' ? 'text-emerald-400' : 'text-slate-400'}`;
  };

  async function attempt() {
    const proxyUrl = form.proxyUrl.value.trim();
    const proxyMode = form.proxyMode.value;
    configureProxy({ url: proxyUrl || getProxy().url, mode: proxyMode });
    saveSettings({ proxyUrl, proxyMode });
    const client = new XtreamClient({ host: form.host.value, username: form.username.value, password: form.password.value });
    const info = await client.auth();
    return { client, info };
  }

  async function run(action) {
    buttons.forEach((b) => { b.disabled = true; });
    setStatus('Conectando…');
    try {
      const { client, info } = await attempt();
      setStatus(describe(info), 'ok');
      if (action === 'login') await onLogin(client);
    } catch (err) {
      setStatus(err.message || 'Error de conexión', 'error');
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  form.querySelector('[data-test]').addEventListener('click', () => run('test'));
  form.addEventListener('submit', (e) => { e.preventDefault(); run('login'); });
  (initial.host ? form.password : form.host).focus();
}

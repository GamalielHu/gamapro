/**
 * Cloudflare Worker: sirve la app (assets estáticos) y el proxy CORS en /proxy.
 * Variables opcionales: ALLOW_HOSTS ("panel1.tv,panel2.tv"), PROXY_UA.
 */
import { handleProxy } from './proxy.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/proxy' || pathname.startsWith('/proxy/')) {
      return handleProxy(request, {
        allowHosts: (env.ALLOW_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
        userAgent: env.PROXY_UA || undefined,
      });
    }
    return env.ASSETS.fetch(request);
  },
};

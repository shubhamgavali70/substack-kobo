import { type Context, Hono } from 'hono';
import type { AppBindings } from '../app';
import { authenticate, requirePageAuth } from '../auth/middleware';

/**
 * Static UI served from Workers static assets. The Worker runs first for every
 * request so that private pages are gated by the session; public assets are
 * limited to the login page, stylesheet, scripts and PWA manifest.
 */
export const pageRoutes = new Hono<AppBindings>();

const PUBLIC_ASSETS = new Set([
  '/login',
  '/login.html',
  '/app.css',
  '/app.js',
  '/manifest.webmanifest',
  '/sw.js',
  '/icon.svg',
  '/favicon.ico',
]);

pageRoutes.get('/login', async (c) => {
  const auth = await authenticate(c);
  if (auth) return c.redirect('/', 302);
  return serveAsset(c, '/login.html');
});

pageRoutes.get('/', requirePageAuth, (c) => serveAsset(c, '/index.html'));
pageRoutes.get('/library', requirePageAuth, (c) => serveAsset(c, '/library.html'));

pageRoutes.get('/*', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (!PUBLIC_ASSETS.has(path)) {
    const auth = await authenticate(c);
    if (!auth) return c.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
  }
  return serveAsset(c, path);
});

async function serveAsset(c: Context<AppBindings>, path: string): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = path;
  const response = await c.env.ASSETS.fetch(
    new Request(url.toString(), { method: 'GET', headers: c.req.raw.headers }),
  );
  if (response.status === 404) return c.text('Not found', 404);
  const headers = new Headers(response.headers);
  if (path.endsWith('.html') || path === '/login') headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

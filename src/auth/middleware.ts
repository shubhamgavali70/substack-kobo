import type { Context, MiddlewareHandler } from 'hono';
import type { AppBindings } from '../app';
import { AppError } from '../types';
import { secretsEqual } from './crypto';
import { parseCookies, sessionCookieName, verifySessionCookie } from './session';

export type AuthMethod = 'session' | 'token';

export interface AuthInfo {
  method: AuthMethod;
  sessionId: string | null;
}

export function isSecureRequest(c: Context<AppBindings>): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

/**
 * Resolves the caller's identity from either the session cookie or a bearer
 * API token. Returns null when unauthenticated.
 */
export async function authenticate(c: Context<AppBindings>): Promise<AuthInfo | null> {
  const env = c.env;
  const authHeader = c.req.header('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (
      env.API_TOKEN &&
      env.API_TOKEN.length >= 16 &&
      token.length > 0 &&
      (await secretsEqual(token, env.API_TOKEN))
    ) {
      return { method: 'token', sessionId: null };
    }
    return null;
  }
  const cookies = parseCookies(c.req.header('cookie'));
  const cookieValue = cookies[sessionCookieName(isSecureRequest(c))];
  if (!cookieValue || !env.SESSION_SECRET) return null;
  const sessionId = await verifySessionCookie(env.DB, env.SESSION_SECRET, cookieValue);
  return sessionId ? { method: 'session', sessionId } : null;
}

/** Rejects cross-site state-changing requests that ride on the session cookie. */
export function assertSameOrigin(c: Context<AppBindings>): void {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const fetchSite = c.req.header('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new AppError('FORBIDDEN', 'Cross-site requests are not allowed.');
  }
  const origin = c.req.header('origin');
  if (origin) {
    const expected = new URL(c.req.url).origin;
    if (origin !== expected)
      throw new AppError('FORBIDDEN', 'Cross-site requests are not allowed.');
  }
}

/** API middleware: 401 JSON when unauthenticated. */
export const requireApiAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = await authenticate(c);
  if (!auth) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required.');
  }
  if (auth.method === 'session') assertSameOrigin(c);
  c.set('auth', auth);
  await next();
};

/** Page middleware: redirect to the login page when unauthenticated. */
export const requirePageAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = await authenticate(c);
  if (!auth) {
    const url = new URL(c.req.url);
    const next = encodeURIComponent(url.pathname + url.search);
    return c.redirect(`/login?next=${next}`, 302);
  }
  c.set('auth', auth);
  await next();
};

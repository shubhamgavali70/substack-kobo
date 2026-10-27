import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../app';
import { secretsEqual } from '../auth/crypto';
import { authenticate, isSecureRequest } from '../auth/middleware';
import { enforceRateLimit } from '../auth/rateLimit';
import {
  buildSessionCookie,
  clearSessionCookie,
  createSession,
  destroySession,
  sessionCookieName,
} from '../auth/session';
import { AppError } from '../types';

const loginSchema = z.object({ password: z.string().min(1).max(1024) });

export const authRoutes = new Hono<AppBindings>();

authRoutes.post('/login', async (c) => {
  await enforceRateLimit(c, 'login', 8, 15 * 60);
  const body = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError('VALIDATION_ERROR', 'Password is required.');
  const env = c.env;
  if (!env.AUTH_PASSWORD || !env.SESSION_SECRET) {
    throw new AppError('INTERNAL_ERROR', 'Authentication is not configured on the server.');
  }
  if (!(await secretsEqual(body.data.password, env.AUTH_PASSWORD))) {
    c.get('logger').warn('auth.login_failed');
    throw new AppError('UNAUTHENTICATED', 'Incorrect password.');
  }
  const secure = isSecureRequest(c);
  const ttl = c.get('config').sessionTtlSeconds;
  const session = await createSession(
    env.DB,
    env.SESSION_SECRET,
    ttl,
    c.req.header('user-agent') ?? null,
  );
  c.header(
    'Set-Cookie',
    buildSessionCookie(sessionCookieName(secure), session.cookieValue, ttl, secure),
  );
  c.get('logger').info('auth.login_succeeded');
  return c.json({ ok: true });
});

authRoutes.post('/logout', async (c) => {
  const auth = await authenticate(c);
  const secure = isSecureRequest(c);
  if (auth?.sessionId) await destroySession(c.env.DB, auth.sessionId);
  c.header('Set-Cookie', clearSessionCookie(sessionCookieName(secure), secure));
  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  const auth = await authenticate(c);
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Not signed in.');
  return c.json({ authenticated: true, method: auth.method });
});

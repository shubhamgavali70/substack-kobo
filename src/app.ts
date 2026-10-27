import { Hono } from 'hono';
import type { AuthInfo } from './auth/middleware';
import type { AppConfig, Env } from './env';
import { loadConfig } from './env';
import { createLogger, type Logger, newRequestId } from './observability/logger';
import { articleRoutes } from './routes/articles';
import { authRoutes } from './routes/auth';
import { pageRoutes } from './routes/pages';
import { AppError, isAppError } from './types';

export type AppBindings = {
  Bindings: Env;
  Variables: {
    logger: Logger;
    config: AppConfig;
    requestId: string;
    auth: AuthInfo;
  };
};

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('cf-ray') ?? newRequestId();
    const started = Date.now();
    const logger = createLogger({
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    });
    c.set('requestId', requestId);
    c.set('logger', logger);
    c.set('config', loadConfig(c.env));
    await next();
    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (new URL(c.req.url).protocol === 'https:') {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (!c.res.headers.get('content-type')?.includes('application/epub+zip')) {
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
    if (c.req.path.startsWith('/api/')) {
      logger.info('http.request', { status: c.res.status, durationMs: Date.now() - started });
    }
  });

  app.get('/api/health', (c) => c.json({ ok: true, requestId: c.get('requestId') }));
  app.route('/api/auth', authRoutes);
  app.route('/api/articles', articleRoutes);
  app.all('/api/*', () => {
    throw new AppError('NOT_FOUND', 'Unknown API route.');
  });
  app.route('/', pageRoutes);

  app.onError((error, c) => {
    const logger = c.get('logger') ?? createLogger();
    if (isAppError(error)) {
      if (error.httpStatus >= 500)
        logger.error('http.error', {
          code: error.code,
          message: error.message,
          cause: error.cause,
        });
      else logger.warn('http.client_error', { code: error.code, message: error.message });
      return c.json(
        { error: error.toJSON(), requestId: c.get('requestId') },
        error.httpStatus as 400,
      );
    }
    logger.error('http.unhandled_error', { error });
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong. Check the logs with the request id.',
        },
        requestId: c.get('requestId'),
      },
      500,
    );
  });

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404));

  return app;
}

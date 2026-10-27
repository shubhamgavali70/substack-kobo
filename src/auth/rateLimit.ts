import type { Context } from 'hono';
import type { AppBindings } from '../app';
import { RateLimitRepository } from '../db/rateLimits';
import { AppError } from '../types';

export function clientKey(c: Context<AppBindings>): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export async function enforceRateLimit(
  c: Context<AppBindings>,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const repo = new RateLimitRepository(c.env.DB);
  const { allowed } = await repo.hit(`${bucket}:${clientKey(c)}`, limit, windowSeconds);
  if (!allowed) {
    c.get('logger').warn('rate_limit.exceeded', { bucket });
    throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a moment and try again.', {
      details: { retryAfterSeconds: windowSeconds },
    });
  }
}

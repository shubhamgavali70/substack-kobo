import { isoAfterSeconds, nowIso } from './time';

/**
 * Fixed-window counters stored in D1. Adequate for a single-user system where
 * the goal is to slow brute force attempts and runaway automations, not to
 * absorb large-scale abuse (Cloudflare WAF / Access can be layered on top).
 */
export class RateLimitRepository {
  constructor(private readonly db: D1Database) {}

  /** Increments the counter and returns whether the request is allowed. */
  async hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const now = nowIso();
    const windowEnd = isoAfterSeconds(windowSeconds);
    await this.db
      .prepare(
        `INSERT INTO rate_limits (key, count, window_ends_at) VALUES (?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_ends_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
           window_ends_at = CASE WHEN rate_limits.window_ends_at <= ?3 THEN ?2 ELSE rate_limits.window_ends_at END`,
      )
      .bind(key, windowEnd, now)
      .run();
    const row = await this.db
      .prepare('SELECT count FROM rate_limits WHERE key = ?1')
      .bind(key)
      .first<{ count: number }>();
    const count = row?.count ?? 1;
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  }

  async pruneExpired(): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM rate_limits WHERE window_ends_at <= ?1')
      .bind(nowIso())
      .run();
    return result.meta.changes ?? 0;
  }
}

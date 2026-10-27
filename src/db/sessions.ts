import { isoAfterSeconds, nowIso } from './time';

export interface SessionRow {
  id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
}

export class SessionRepository {
  constructor(private readonly db: D1Database) {}

  async create(id: string, ttlSeconds: number, userAgent: string | null): Promise<void> {
    const now = nowIso();
    await this.db
      .prepare(
        'INSERT INTO sessions (id, created_at, expires_at, last_seen_at, user_agent) VALUES (?1, ?2, ?3, ?2, ?4)',
      )
      .bind(id, now, isoAfterSeconds(ttlSeconds), userAgent?.slice(0, 300) ?? null)
      .run();
  }

  async findValid(id: string): Promise<SessionRow | null> {
    const row = await this.db
      .prepare('SELECT * FROM sessions WHERE id = ?1 AND expires_at > ?2')
      .bind(id, nowIso())
      .first<SessionRow>();
    return row ?? null;
  }

  async touch(id: string): Promise<void> {
    await this.db
      .prepare('UPDATE sessions SET last_seen_at = ?2 WHERE id = ?1')
      .bind(id, nowIso())
      .run();
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE id = ?1').bind(id).run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM sessions').run();
  }

  async pruneExpired(): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM sessions WHERE expires_at <= ?1')
      .bind(nowIso())
      .run();
    return result.meta.changes ?? 0;
  }
}

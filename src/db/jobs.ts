import type { ErrorCode, JobRecord, JobStatus } from '../types';
import { isoAfterSeconds, nowIso } from './time';

interface JobRow {
  id: string;
  article_id: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  last_error_code: ErrorCode | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: JobRow): JobRecord {
  return {
    id: row.id,
    articleId: row.article_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * D1-backed job store. Claiming is an atomic conditional UPDATE, which makes
 * processing idempotent under duplicate queue deliveries and concurrent
 * workers: only one claimant sees `changes === 1`.
 */
export class JobRepository {
  constructor(private readonly db: D1Database) {}

  async create(id: string, articleId: string, maxAttempts: number): Promise<JobRecord> {
    const now = nowIso();
    await this.db
      .prepare(
        `INSERT INTO processing_jobs (id, article_id, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
         VALUES (?1, ?2, 'QUEUED', 0, ?3, ?4, ?4, ?4)`,
      )
      .bind(id, articleId, maxAttempts, now)
      .run();
    const job = await this.findById(id);
    if (!job) throw new Error('Job insert did not persist');
    return job;
  }

  async findById(id: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM processing_jobs WHERE id = ?1')
      .bind(id)
      .first<JobRow>();
    return row ? mapRow(row) : null;
  }

  async findActiveByArticle(articleId: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM processing_jobs WHERE article_id = ?1 AND status IN ('QUEUED','PROCESSING','WAITING_RETRY')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(articleId)
      .first<JobRow>();
    return row ? mapRow(row) : null;
  }

  async findLatestByArticle(articleId: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM processing_jobs WHERE article_id = ?1 ORDER BY created_at DESC LIMIT 1',
      )
      .bind(articleId)
      .first<JobRow>();
    return row ? mapRow(row) : null;
  }

  /**
   * Attempts to claim a job for processing. Returns the claimed job, or null
   * when the job is not claimable (already processing, completed, not yet due).
   */
  async claim(id: string, leaseSeconds: number): Promise<JobRecord | null> {
    const now = new Date();
    const result = await this.db
      .prepare(
        `UPDATE processing_jobs
         SET status = 'PROCESSING', attempts = attempts + 1, lease_expires_at = ?2, updated_at = ?3
         WHERE id = ?1
           AND status IN ('QUEUED','WAITING_RETRY')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)
           AND attempts < max_attempts`,
      )
      .bind(id, isoAfterSeconds(leaseSeconds, now), now.toISOString())
      .run();
    if ((result.meta.changes ?? 0) !== 1) return null;
    return this.findById(id);
  }

  async markCompleted(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE processing_jobs SET status = 'COMPLETED', lease_expires_at = NULL, next_attempt_at = NULL,
           last_error = NULL, last_error_code = NULL, updated_at = ?2 WHERE id = ?1`,
      )
      .bind(id, nowIso())
      .run();
  }

  async scheduleRetry(
    id: string,
    nextAttemptAt: string,
    error: { code: ErrorCode; message: string },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE processing_jobs SET status = 'WAITING_RETRY', lease_expires_at = NULL, next_attempt_at = ?2,
           last_error = ?3, last_error_code = ?4, updated_at = ?5 WHERE id = ?1`,
      )
      .bind(id, nextAttemptAt, error.message.slice(0, 1000), error.code, nowIso())
      .run();
  }

  async markFailed(id: string, error: { code: ErrorCode; message: string }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE processing_jobs SET status = 'FAILED', lease_expires_at = NULL, next_attempt_at = NULL,
           last_error = ?2, last_error_code = ?3, updated_at = ?4 WHERE id = ?1`,
      )
      .bind(id, error.message.slice(0, 1000), error.code, nowIso())
      .run();
  }

  /** Jobs whose retry time has arrived (or that were never dispatched). */
  async findDue(limit: number, now: Date = new Date()): Promise<JobRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM processing_jobs
         WHERE status IN ('QUEUED','WAITING_RETRY') AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
         ORDER BY next_attempt_at ASC, created_at ASC LIMIT ?2`,
      )
      .bind(now.toISOString(), limit)
      .all<JobRow>();
    return rows.results.map(mapRow);
  }

  /** Jobs stuck in PROCESSING past their lease (worker crashed or exceeded limits). */
  async findStale(now: Date = new Date(), limit = 50): Promise<JobRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM processing_jobs WHERE status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?1
         ORDER BY lease_expires_at ASC LIMIT ?2`,
      )
      .bind(now.toISOString(), limit)
      .all<JobRow>();
    return rows.results.map(mapRow);
  }

  /** Re-queues a job for a manual retry, resetting the attempt budget. */
  async requeue(id: string, maxAttempts: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE processing_jobs SET status = 'QUEUED', attempts = 0, max_attempts = ?2, next_attempt_at = ?3,
           lease_expires_at = NULL, last_error = NULL, last_error_code = NULL, updated_at = ?3 WHERE id = ?1`,
      )
      .bind(id, maxAttempts, nowIso())
      .run();
  }

  async deleteByArticle(articleId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM processing_jobs WHERE article_id = ?1')
      .bind(articleId)
      .run();
  }
}

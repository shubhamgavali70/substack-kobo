import { ArticleRepository } from '../db/articles';
import { JobRepository } from '../db/jobs';
import { RateLimitRepository } from '../db/rateLimits';
import { SessionRepository } from '../db/sessions';
import { isoAfterSeconds } from '../db/time';
import { type Env, loadConfig } from '../env';
import type { Logger } from '../observability/logger';
import { computeBackoffSeconds } from './backoff';
import { dispatchJob } from './dispatcher';

const MAX_DUE_JOBS_PER_RUN = 10;
/** Without Queues each job runs inside the cron invocation; keep it bounded. */
const MAX_INLINE_JOBS_PER_RUN = 3;

export interface MaintenanceSummary {
  recovered: number;
  dispatched: number;
  prunedSessions: number;
  prunedRateLimits: number;
}

/**
 * Cron entry point: recovers jobs whose lease expired mid-processing,
 * dispatches due retries, and prunes expired sessions and counters. Every
 * step is bounded so the run stays well within Workers execution limits.
 */
export async function runScheduledMaintenance(
  env: Env,
  logger: Logger,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<MaintenanceSummary> {
  const config = loadConfig(env);
  const jobs = new JobRepository(env.DB);
  const articles = new ArticleRepository(env.DB);
  const summary: MaintenanceSummary = {
    recovered: 0,
    dispatched: 0,
    prunedSessions: 0,
    prunedRateLimits: 0,
  };

  // 1. Recover stale leases.
  const stale = await jobs.findStale();
  for (const job of stale) {
    const message = 'Processing was interrupted (worker timeout or crash).';
    if (job.attempts < job.maxAttempts) {
      const delay = computeBackoffSeconds(job.attempts);
      await jobs.scheduleRetry(job.id, isoAfterSeconds(delay), { code: 'TIMEOUT', message });
      await articles.setStatus(job.articleId, 'RETRYABLE_ERROR', { code: 'TIMEOUT', message });
    } else {
      await jobs.markFailed(job.id, { code: 'MAX_ATTEMPTS_EXCEEDED', message });
      await articles.setStatus(job.articleId, 'FAILED', { code: 'MAX_ATTEMPTS_EXCEEDED', message });
    }
    summary.recovered += 1;
    logger.warn('job.lease_recovered', {
      jobId: job.id,
      articleId: job.articleId,
      attempts: job.attempts,
    });
  }

  // 2. Dispatch due jobs.
  const due = await jobs.findDue(MAX_DUE_JOBS_PER_RUN);
  const limit = env.ARTICLE_QUEUE ? due.length : Math.min(due.length, MAX_INLINE_JOBS_PER_RUN);
  for (const job of due.slice(0, limit)) {
    await dispatchJob({ env, logger, waitUntil }, job);
    summary.dispatched += 1;
  }

  // 3. Housekeeping.
  summary.prunedSessions = await new SessionRepository(env.DB).pruneExpired();
  summary.prunedRateLimits = await new RateLimitRepository(env.DB).pruneExpired();

  logger.info('maintenance.complete', { ...summary, maxAttempts: config.maxJobAttempts });
  return summary;
}

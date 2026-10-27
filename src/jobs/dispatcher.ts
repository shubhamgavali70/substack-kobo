import type { Env } from '../env';
import type { Logger } from '../observability/logger';
import type { JobRecord } from '../types';
import { processJob } from './processor';

export interface DispatchDeps {
  env: Env;
  logger: Logger;
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Hands a job to the background. With a Queue binding the message is sent to
 * Cloudflare Queues; without one, processing starts immediately after the
 * current response via waitUntil. Either way D1 remains the source of truth,
 * and the cron sweep picks up anything that slips through.
 */
export async function dispatchJob(deps: DispatchDeps, job: JobRecord): Promise<'queue' | 'inline'> {
  const { env, logger } = deps;
  if (env.ARTICLE_QUEUE) {
    try {
      await env.ARTICLE_QUEUE.send({ jobId: job.id, articleId: job.articleId });
      logger.info('job.dispatched', { jobId: job.id, articleId: job.articleId, via: 'queue' });
      return 'queue';
    } catch (error) {
      logger.error('job.dispatch_failed', { jobId: job.id, error, fallback: 'inline' });
    }
  }
  deps.waitUntil(
    processJob(env, job.id, logger.child({ jobId: job.id, articleId: job.articleId })).catch(
      (error) => {
        logger.error('job.inline_failed', { jobId: job.id, error });
      },
    ),
  );
  logger.info('job.dispatched', { jobId: job.id, articleId: job.articleId, via: 'inline' });
  return 'inline';
}

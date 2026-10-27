import type { Env } from '../env';
import type { Logger } from '../observability/logger';
import type { JobMessage } from '../types';
import { processJob } from './processor';

/**
 * Queue consumer. Each message is processed independently and acknowledged
 * whether or not the job succeeded: retry scheduling is handled by D1 state
 * and the cron sweep, which keeps the two retry mechanisms from compounding.
 * Only an unexpected infrastructure failure (for example D1 unavailable) is
 * retried at the queue level, bounded by the consumer's max_retries.
 */
export async function handleQueueBatch(
  batch: MessageBatch<JobMessage>,
  env: Env,
  logger: Logger,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    if (!body || typeof body.jobId !== 'string') {
      logger.warn('queue.malformed_message', { messageId: message.id });
      message.ack();
      continue;
    }
    const jobLogger = logger.child({
      jobId: body.jobId,
      articleId: body.articleId,
      messageId: message.id,
      attempt: message.attempts,
    });
    try {
      const outcome = await processJob(env, body.jobId, jobLogger);
      jobLogger.info('queue.message_processed', { outcome });
      message.ack();
    } catch (error) {
      jobLogger.error('queue.message_failed', { error });
      if (message.attempts >= 3) message.ack();
      else message.retry({ delaySeconds: 60 * message.attempts });
    }
  }
}

import { createApp } from './app';
import type { Env } from './env';
import { handleQueueBatch } from './jobs/queueConsumer';
import { runScheduledMaintenance } from './jobs/scheduler';
import { createLogger, newRequestId } from './observability/logger';
import type { JobMessage } from './types';

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const logger = createLogger({ trigger: 'queue', batchId: newRequestId(), queue: batch.queue });
    logger.info('queue.batch_received', { size: batch.messages.length });
    await handleQueueBatch(batch, env, logger);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const logger = createLogger({ trigger: 'cron', cron: controller.cron, runId: newRequestId() });
    await runScheduledMaintenance(env, logger, (p) => ctx.waitUntil(p));
  },
} satisfies ExportedHandler<Env, JobMessage>;

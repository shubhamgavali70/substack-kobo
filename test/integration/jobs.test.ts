import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobRepository } from '../../src/db/jobs';
import worker from '../../src/index';
import { processJob } from '../../src/jobs/processor';
import { runScheduledMaintenance } from '../../src/jobs/scheduler';
import { createLogger } from '../../src/observability/logger';
import type { JobMessage } from '../../src/types';
import { fixtures } from '../fixtures';
import {
  FREE_URL,
  getArticle,
  html,
  inlineEnv,
  installDefaultRoutes,
  outboundCalls,
  readArticleRow,
  readJobRow,
  routes,
  stubOutboundFetch,
  submit,
} from './helpers';

const quiet = createLogger({}, () => undefined);

describe('background processing', () => {
  const testEnv = inlineEnv();

  beforeEach(async () => {
    stubOutboundFetch();
    installDefaultRoutes();
    await env.DB.prepare('DELETE FROM processing_jobs').run();
    await env.DB.prepare('DELETE FROM articles').run();
  });
  afterAll(() => vi.unstubAllGlobals());

  async function queuedArticle(url = FREE_URL): Promise<{ articleId: string; jobId: string }> {
    // Insert without dispatching so the test controls when processing happens.
    const articleId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO articles (id, canonical_url, original_url, status, content_source, captured_at, created_at, updated_at)
       VALUES (?1, ?2, ?2, 'QUEUED', 'public', ?3, ?3, ?3)`,
    )
      .bind(articleId, url, now)
      .run();
    await new JobRepository(env.DB).create(jobId, articleId, 5);
    return { articleId, jobId };
  }

  it('processes a job exactly once when the same job is delivered twice concurrently', async () => {
    const { articleId, jobId } = await queuedArticle();
    const outcomes = await Promise.all([
      processJob(testEnv, jobId, quiet),
      processJob(testEnv, jobId, quiet),
    ]);
    expect(outcomes.sort()).toEqual(['completed', 'skipped']);
    expect(outboundCalls.filter((u) => u === FREE_URL)).toHaveLength(1);
    expect((await readArticleRow(articleId))?.status).toBe('READY');
    expect((await readJobRow(articleId))?.attempts).toBe(1);
  });

  it('skips completed jobs on redelivery and never reprocesses', async () => {
    const { jobId } = await queuedArticle();
    expect(await processJob(testEnv, jobId, quiet)).toBe('completed');
    expect(await processJob(testEnv, jobId, quiet)).toBe('skipped');
    expect(await processJob(testEnv, 'does-not-exist', quiet)).toBe('skipped');
    expect(outboundCalls.filter((u) => u === FREE_URL)).toHaveLength(1);
  });

  it('does not run a retry before its scheduled time', async () => {
    routes.set(FREE_URL, () => html('down', 503));
    const { articleId, jobId } = await queuedArticle();
    expect(await processJob(testEnv, jobId, quiet)).toBe('retry_scheduled');
    expect(await processJob(testEnv, jobId, quiet)).toBe('skipped'); // not due yet
    expect((await readArticleRow(articleId))?.status).toBe('RETRYABLE_ERROR');
  });

  it('acknowledges queue messages, including duplicates, and lets D1 state drive retries', async () => {
    const { articleId, jobId } = await queuedArticle();
    const message: JobMessage = { jobId, articleId };
    const batch = createMessageBatch<JobMessage>('substack-kobo-jobs', [
      { id: 'm1', timestamp: new Date(), body: message, attempts: 1 },
      { id: 'm2', timestamp: new Date(), body: message, attempts: 1 },
      {
        id: 'm3',
        timestamp: new Date(),
        body: { jobId: 'missing', articleId: 'missing' },
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, testEnv, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(['m1', 'm2', 'm3']);
    expect(result.retryMessages).toEqual([]);
    expect((await readArticleRow(articleId))?.status).toBe('READY');
    expect(outboundCalls.filter((u) => u === FREE_URL)).toHaveLength(1);
  });

  it('cron: dispatches due retries and completes them', async () => {
    routes.set(FREE_URL, () => html('down', 503));
    const { articleId, jobId } = await queuedArticle();
    expect(await processJob(testEnv, jobId, quiet)).toBe('retry_scheduled');

    // Time travel: make the retry due, and let the publication recover.
    await env.DB.prepare(
      "UPDATE processing_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
    )
      .bind(jobId)
      .run();
    installDefaultRoutes();

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '* * * * *' }), testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect((await readArticleRow(articleId))?.status).toBe('READY');
    const job = await readJobRow(articleId);
    expect(job?.status).toBe('COMPLETED');
    expect(job?.attempts).toBe(2);
  });

  it('cron: recovers jobs whose lease expired while PROCESSING', async () => {
    const { articleId, jobId } = await queuedArticle();
    // Simulate a worker that claimed the job and died.
    await env.DB.prepare(
      "UPDATE processing_jobs SET status = 'PROCESSING', attempts = 1, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
    )
      .bind(jobId)
      .run();
    await env.DB.prepare("UPDATE articles SET status = 'PROCESSING' WHERE id = ?1")
      .bind(articleId)
      .run();

    const summary = await runScheduledMaintenance(testEnv, quiet, () => undefined);
    expect(summary.recovered).toBe(1);
    const job = await readJobRow(articleId);
    expect(job?.status).toBe('WAITING_RETRY');
    expect(job?.last_error_code).toBe('TIMEOUT');
    expect((await readArticleRow(articleId))?.status).toBe('RETRYABLE_ERROR');
  });

  it('cron: fails stale jobs that have exhausted their attempts', async () => {
    const { articleId, jobId } = await queuedArticle();
    await env.DB.prepare(
      "UPDATE processing_jobs SET status = 'PROCESSING', attempts = 5, max_attempts = 5, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
    )
      .bind(jobId)
      .run();
    await runScheduledMaintenance(testEnv, quiet, () => undefined);
    expect((await readJobRow(articleId))?.status).toBe('FAILED');
    expect((await readArticleRow(articleId))?.status).toBe('FAILED');
    expect((await readArticleRow(articleId))?.error_code).toBe('MAX_ATTEMPTS_EXCEEDED');
  });

  it('cron: processes at most a bounded number of inline jobs per run', async () => {
    for (let i = 0; i < 5; i++) {
      routes.set(`https://quietdesk.substack.com/p/bulk-${i}`, () =>
        html(fixturesFree(`https://quietdesk.substack.com/p/bulk-${i}`)),
      );
      await queuedArticle(`https://quietdesk.substack.com/p/bulk-${i}`);
    }
    const promises: Promise<unknown>[] = [];
    const summary = await runScheduledMaintenance(testEnv, quiet, (p) => void promises.push(p));
    expect(summary.dispatched).toBe(3);
    await Promise.all(promises);
    const ready = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM articles WHERE status = 'READY'",
    ).first<{ n: number }>();
    expect(ready?.n).toBe(3);
  });

  it('enqueue via the API sends to the queue when the binding exists', async () => {
    const sent: JobMessage[] = [];
    const queueEnv = inlineEnv({
      ARTICLE_QUEUE: {
        send: async (body: JobMessage) => void sent.push(body),
      } as unknown as Queue<JobMessage>,
    });
    const { status, body } = await submit(queueEnv, FREE_URL);
    expect(status).toBe(202);
    expect(sent).toEqual([{ jobId: body.jobId, articleId: body.article.id }]);
    // Nothing processed inline: the article is still queued and no outbound fetch happened.
    expect((await getArticle(queueEnv, body.article.id)).body.article.status).toBe('QUEUED');
    expect(outboundCalls).toHaveLength(0);
  });
});

function fixturesFree(url: string): string {
  return fixtures.freePost.replace(FREE_URL, url);
}

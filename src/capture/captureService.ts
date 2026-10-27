import { importObjectKey, type ManualImportPayload } from '../acquisition';
import { ArticleRepository } from '../db/articles';
import { JobRepository } from '../db/jobs';
import type { AppConfig, Env } from '../env';
import { dispatchJob } from '../jobs/dispatcher';
import type { Logger } from '../observability/logger';
import { newId } from '../observability/logger';
import { EpubStorage } from '../storage/r2';
import type { ArticleRecord, JobRecord } from '../types';
import { canonicalizeArticleUrl } from './urlPolicy';

export interface CaptureDeps {
  env: Env;
  config: AppConfig;
  logger: Logger;
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface CaptureInput {
  url: string;
  /** Optional user-supplied content for articles that cannot be fetched publicly. */
  content?: ManualImportPayload | undefined;
}

export interface CaptureResult {
  article: ArticleRecord;
  job: JobRecord | null;
  /** True when the URL was already in the library and no new work was queued. */
  duplicate: boolean;
}

/**
 * Validates, deduplicates and queues an explicitly submitted article. The HTTP
 * handler returns as soon as the job row exists; processing happens in the
 * background (Queues when available, otherwise after the response).
 */
export async function enqueueArticle(
  deps: CaptureDeps,
  input: CaptureInput,
): Promise<CaptureResult> {
  const { env, config, logger } = deps;
  const { canonicalUrl, originalUrl, host } = canonicalizeArticleUrl(
    input.url,
    config.allowedHosts,
  );
  const articles = new ArticleRepository(env.DB);
  const jobs = new JobRepository(env.DB);

  const existing = await articles.findByCanonicalUrl(canonicalUrl);
  if (existing) {
    logger.info('capture.duplicate', { articleId: existing.id, host, status: existing.status });
    const job = await jobs.findLatestByArticle(existing.id);
    return { article: existing, job, duplicate: true };
  }

  const articleId = newId();
  const contentSource = input.content ? 'manual' : 'public';
  let article: ArticleRecord;
  try {
    article = await articles.insert({ id: articleId, canonicalUrl, originalUrl, contentSource });
  } catch (error) {
    // Lost a race with a concurrent submission of the same URL.
    if (isUniqueViolation(error)) {
      const winner = await articles.findByCanonicalUrl(canonicalUrl);
      if (winner) {
        const job = await jobs.findLatestByArticle(winner.id);
        return { article: winner, job, duplicate: true };
      }
    }
    throw error;
  }

  if (input.content) {
    await new EpubStorage(env.EPUBS, logger).putJson(importObjectKey(articleId), input.content);
  }

  const job = await jobs.create(newId(), articleId, config.maxJobAttempts);
  logger.info('capture.accepted', { articleId, jobId: job.id, host, contentSource });
  await dispatchJob({ env, logger, waitUntil: deps.waitUntil }, job);
  return { article, job, duplicate: false };
}

export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

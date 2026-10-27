import { downloadImages, getContentSource } from '../acquisition';
import { sha256Hex } from '../auth/crypto';
import { assertSafeDestination } from '../capture/urlPolicy';
import { ArticleRepository } from '../db/articles';
import { JobRepository } from '../db/jobs';
import { isoAfterSeconds } from '../db/time';
import { type Env, loadConfig } from '../env';
import { generateEpub } from '../epub';
import type { Logger } from '../observability/logger';
import { EpubStorage } from '../storage/r2';
import { AppError, type ArticleStatus, type ErrorCode, toAppError } from '../types';
import { computeBackoffSeconds } from './backoff';

export type ProcessOutcome = 'completed' | 'retry_scheduled' | 'failed' | 'skipped';

/**
 * Processes one job end to end: claim → acquire content → images → EPUB →
 * R2 → D1. Safe to call multiple times for the same job (duplicate queue
 * deliveries, cron + queue overlap): only one claim succeeds.
 */
export async function processJob(env: Env, jobId: string, logger: Logger): Promise<ProcessOutcome> {
  const config = loadConfig(env);
  const jobs = new JobRepository(env.DB);
  const articles = new ArticleRepository(env.DB);
  const storage = new EpubStorage(env.EPUBS, logger);
  const startedAt = Date.now();

  const job = await jobs.claim(jobId, config.jobLeaseSeconds);
  if (!job) {
    logger.info('job.skipped', { reason: 'not claimable (already processing, done, or not due)' });
    return 'skipped';
  }
  const article = await articles.findById(job.articleId);
  if (!article) {
    logger.warn('job.orphaned', { reason: 'article deleted' });
    await jobs.markFailed(job.id, { code: 'NOT_FOUND', message: 'Article no longer exists' });
    return 'failed';
  }
  await articles.setStatus(article.id, 'PROCESSING');
  logger.info('job.started', {
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    source: article.contentSource,
  });

  try {
    const source = getContentSource(article.contentSource);
    const acquired = await source.fetchArticle(
      { articleId: article.id, url: article.canonicalUrl, mode: article.contentSource },
      { config, logger, bucket: env.EPUBS },
    );
    const normalized = acquired.article;
    logger.info('acquisition.complete', {
      source: source.kind,
      wordCount: normalized.wordCount,
      imageRefs: normalized.images.length,
    });

    // Adopt the page's canonical URL when it is allowed and not already taken.
    if (acquired.canonicalHint && acquired.canonicalHint !== article.canonicalUrl) {
      await adoptCanonical(
        articles,
        article.id,
        acquired.canonicalHint,
        config.allowedHosts,
        logger,
      );
    }

    await articles.updateMetadata(article.id, {
      title: normalized.title,
      author: normalized.author,
      publicationName: normalized.publicationName,
      publishedAt: normalized.publishedAt,
      wordCount: normalized.wordCount,
    });

    const images = config.includeImages
      ? await downloadImages(normalized.images, config, logger)
      : [];
    const epubStart = Date.now();
    const epub = generateEpub(normalized, images, {
      identifier: article.id,
      generatorName: config.appName,
    });
    logger.info('epub.generated', {
      bytes: epub.size,
      images: epub.imageCount,
      durationMs: Date.now() - epubStart,
    });

    const contentHash = await sha256Hex(normalized.contentXhtml);
    const key = EpubStorage.epubKey(article.id, epub.filename);
    await storage.putEpub(key, epub.bytes, {
      articleId: article.id,
      contentHash,
      source: normalized.source,
    });

    // Remove a previous EPUB with a different key (title changed on retry).
    if (article.epubObjectKey && article.epubObjectKey !== key) {
      await storage.deleteMany([article.epubObjectKey]).catch(() => undefined);
    }

    await articles.markReady(article.id, {
      epubObjectKey: key,
      epubSize: epub.size,
      epubFilename: epub.filename,
      contentHash,
    });
    await jobs.markCompleted(job.id);
    logger.info('job.completed', { durationMs: Date.now() - startedAt, epubBytes: epub.size });
    return 'completed';
  } catch (rawError) {
    const error = toAppError(rawError, 'INTERNAL_ERROR');
    const durationMs = Date.now() - startedAt;
    const terminalStatus = terminalStatusFor(error.code);

    if (terminalStatus) {
      await articles.setStatus(article.id, terminalStatus, {
        code: error.code,
        message: error.message,
      });
      await jobs.markFailed(job.id, { code: error.code, message: error.message });
      logger.warn('job.terminal', { code: error.code, status: terminalStatus, durationMs });
      return 'failed';
    }

    const retryable =
      error.retryable || error.code === 'INTERNAL_ERROR' || error.code === 'STORAGE_FAILED';
    if (retryable && job.attempts < job.maxAttempts) {
      const delay = computeBackoffSeconds(job.attempts);
      const nextAttemptAt = isoAfterSeconds(delay);
      await jobs.scheduleRetry(job.id, nextAttemptAt, { code: error.code, message: error.message });
      await articles.setStatus(article.id, 'RETRYABLE_ERROR', {
        code: error.code,
        message: `${error.message} Next retry in about ${Math.round(delay / 60)} min.`,
      });
      logger.warn('job.retry_scheduled', {
        code: error.code,
        attempt: job.attempts,
        delaySeconds: delay,
        durationMs,
        error,
      });
      return 'retry_scheduled';
    }

    const code: ErrorCode = retryable ? 'MAX_ATTEMPTS_EXCEEDED' : error.code;
    const message = retryable
      ? `Gave up after ${job.attempts} attempts. Last error: ${error.message}`
      : error.message;
    await jobs.markFailed(job.id, { code, message });
    await articles.setStatus(article.id, 'FAILED', { code, message });
    logger.error('job.failed', { code, attempt: job.attempts, durationMs, error });
    return 'failed';
  }
}

/** Errors that should never be retried automatically map to a final article status. */
function terminalStatusFor(code: ErrorCode): ArticleStatus | null {
  switch (code) {
    case 'AUTHORIZATION_REQUIRED':
      return 'AUTHORIZATION_REQUIRED';
    case 'CONTENT_UNAVAILABLE':
    case 'HOST_NOT_ALLOWED':
    case 'INVALID_URL':
    case 'TOO_LARGE':
    case 'EXTRACTION_FAILED':
      return 'CONTENT_UNAVAILABLE';
    case 'DUPLICATE_ARTICLE':
      return 'FAILED';
    default:
      return null;
  }
}

async function adoptCanonical(
  articles: ArticleRepository,
  articleId: string,
  hint: string,
  allowedHosts: readonly string[],
  logger: Logger,
): Promise<void> {
  let candidate: URL;
  try {
    candidate = assertSafeDestination(hint, { allowedHosts, purpose: 'canonical' });
  } catch {
    return; // Ignore canonical hints that point outside the allowlist.
  }
  candidate.search = '';
  candidate.hash = '';
  const normalized = candidate.toString().replace(/\/$/, '');
  const updated = await articles.updateCanonicalUrl(articleId, normalized);
  if (!updated) {
    const existing = await articles.findByCanonicalUrl(normalized);
    throw new AppError(
      'DUPLICATE_ARTICLE',
      `This article is already in your library${existing?.title ? ` as "${existing.title}"` : ''}.`,
      existing ? { details: { existingArticleId: existing.id } } : {},
    );
  }
  logger.info('article.canonical_adopted', { canonicalUrl: normalized });
}

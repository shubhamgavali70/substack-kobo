import { importObjectKey } from '../acquisition';
import { ArticleRepository } from '../db/articles';
import { JobRepository } from '../db/jobs';
import { GoogleDriveClient } from '../delivery';
import type { AppConfig, Env } from '../env';
import { dispatchJob } from '../jobs/dispatcher';
import type { Logger } from '../observability/logger';
import { newId } from '../observability/logger';
import { EpubStorage } from '../storage/r2';
import {
  AppError,
  type ArticleRecord,
  type ArticleView,
  type LibraryFilters,
  type Paginated,
  RETRYABLE_ARTICLE_STATUSES,
} from '../types';

export interface LibraryDeps {
  env: Env;
  config: AppConfig;
  logger: Logger;
  waitUntil: (promise: Promise<unknown>) => void;
}

export function toArticleView(article: ArticleRecord): ArticleView {
  const ready = article.status === 'READY' && !!article.epubObjectKey;
  return {
    id: article.id,
    url: article.originalUrl,
    canonicalUrl: article.canonicalUrl,
    title: article.title,
    author: article.author,
    publicationName: article.publicationName,
    publishedAt: article.publishedAt,
    capturedAt: article.capturedAt,
    status: article.status,
    errorCode: article.errorCode,
    errorMessage: article.errorMessage,
    contentSource: article.contentSource,
    epubSize: article.epubSize,
    epubFilename: article.epubFilename,
    wordCount: article.wordCount,
    downloadUrl: ready ? `/api/articles/${article.id}/download` : null,
    canRetry: RETRYABLE_ARTICLE_STATUSES.includes(article.status),
    canImport: article.status !== 'PROCESSING' && article.status !== 'QUEUED',
    driveStatus: article.driveStatus,
    driveError: article.driveError,
    driveUploadedAt: article.driveUploadedAt,
    updatedAt: article.updatedAt,
  };
}

export async function getLibrary(
  deps: LibraryDeps,
  filters: LibraryFilters,
): Promise<Paginated<ArticleView>> {
  const page = await new ArticleRepository(deps.env.DB).list(filters);
  return { ...page, items: page.items.map(toArticleView) };
}

export async function getArticle(deps: LibraryDeps, id: string): Promise<ArticleRecord> {
  const article = await new ArticleRepository(deps.env.DB).findById(id);
  if (!article) throw new AppError('NOT_FOUND', 'Article not found.');
  return article;
}

/** Re-queues processing for an article in a retryable state. */
export async function retryArticle(deps: LibraryDeps, id: string): Promise<ArticleRecord> {
  const articles = new ArticleRepository(deps.env.DB);
  const jobs = new JobRepository(deps.env.DB);
  const article = await getArticle(deps, id);
  if (!RETRYABLE_ARTICLE_STATUSES.includes(article.status)) {
    throw new AppError('CONFLICT', `Articles in status ${article.status} cannot be retried.`);
  }
  const existing = await jobs.findLatestByArticle(id);
  let job = existing;
  if (job && (job.status === 'QUEUED' || job.status === 'PROCESSING')) {
    throw new AppError('CONFLICT', 'A processing job is already active for this article.');
  }
  if (job) {
    await jobs.requeue(job.id, deps.config.maxJobAttempts);
    job = await jobs.findById(job.id);
  } else {
    job = await jobs.create(newId(), id, deps.config.maxJobAttempts);
  }
  if (!job) throw new AppError('INTERNAL_ERROR', 'Could not create the retry job.');
  await articles.setStatus(id, 'QUEUED');
  deps.logger.info('article.retry_requested', { articleId: id, jobId: job.id });
  await dispatchJob({ env: deps.env, logger: deps.logger, waitUntil: deps.waitUntil }, job);
  const updated = await articles.findById(id);
  return updated ?? article;
}

/**
 * Attaches user-supplied content and queues (re)processing from the manual
 * source. Used for subscriber-only posts the user is entitled to read.
 */
export async function importArticleContent(
  deps: LibraryDeps,
  id: string,
  payload: unknown,
): Promise<ArticleRecord> {
  const { manualImportSchema } = await import('../acquisition');
  const parsed = manualImportSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid import payload.',
    );
  }
  const articles = new ArticleRepository(deps.env.DB);
  const jobs = new JobRepository(deps.env.DB);
  const article = await getArticle(deps, id);
  if (article.status === 'PROCESSING' || article.status === 'QUEUED') {
    throw new AppError(
      'CONFLICT',
      'Wait for the current processing job to finish before importing content.',
    );
  }
  await new EpubStorage(deps.env.EPUBS, deps.logger).putJson(importObjectKey(id), parsed.data);
  await articles.setContentSource(id, 'manual');
  const existing = await jobs.findLatestByArticle(id);
  let job = existing;
  if (job) {
    await jobs.requeue(job.id, deps.config.maxJobAttempts);
    job = await jobs.findById(job.id);
  } else {
    job = await jobs.create(newId(), id, deps.config.maxJobAttempts);
  }
  if (!job) throw new AppError('INTERNAL_ERROR', 'Could not create the import job.');
  await articles.setStatus(id, 'QUEUED');
  deps.logger.info('article.import_requested', { articleId: id, jobId: job.id });
  await dispatchJob({ env: deps.env, logger: deps.logger, waitUntil: deps.waitUntil }, job);
  const updated = await articles.findById(id);
  return updated ?? article;
}

/** Uploads (or re-uploads) a READY article's EPUB to Google Drive. */
export async function sendArticleToDrive(deps: LibraryDeps, id: string): Promise<ArticleRecord> {
  const articles = new ArticleRepository(deps.env.DB);
  const article = await getArticle(deps, id);
  if (article.status !== 'READY' || !article.epubObjectKey) {
    throw new AppError('CONFLICT', 'The EPUB must be ready before it can be sent to Google Drive.');
  }
  const client = new GoogleDriveClient(deps.env, deps.logger);
  client.assertConfigured();
  const status = await client.status();
  if (!status.connected) {
    throw new AppError(
      'INTEGRATION_NOT_CONNECTED',
      'Google Drive is not connected. Connect it from the library page.',
    );
  }
  const object = await new EpubStorage(deps.env.EPUBS, deps.logger).getEpub(article.epubObjectKey);
  if (!object)
    throw new AppError(
      'NOT_FOUND',
      'The EPUB file is missing from storage. Retry processing first.',
    );
  const bytes = new Uint8Array(await object.arrayBuffer());
  try {
    const result = await client.uploadEpub(
      bytes,
      article.epubFilename ?? `article-${id.slice(0, 8)}.epub`,
      article.driveFileId,
    );
    await articles.setDriveResult(id, { fileId: result.fileId });
  } catch (error) {
    const appError =
      error instanceof AppError ? error : new AppError('DELIVERY_FAILED', String(error));
    await articles.setDriveResult(id, { error: appError.message });
    throw appError;
  }
  const updated = await articles.findById(id);
  return updated ?? article;
}

/** Deletes stored files first, then the database row (jobs cascade). */
export async function deleteArticle(deps: LibraryDeps, id: string): Promise<void> {
  const articles = new ArticleRepository(deps.env.DB);
  const article = await getArticle(deps, id);
  const storage = new EpubStorage(deps.env.EPUBS, deps.logger);
  const keys = [importObjectKey(id)];
  if (article.epubObjectKey) keys.push(article.epubObjectKey);
  await storage.deleteMany(keys);
  if (article.driveFileId) {
    // Best effort: the copy in Drive is the user's; failing to remove it must not block deletion.
    await new GoogleDriveClient(deps.env, deps.logger)
      .deleteFile(article.driveFileId)
      .catch((error) => deps.logger.warn('drive.delete_failed', { articleId: id, error }));
  }
  await new JobRepository(deps.env.DB).deleteByArticle(id);
  await articles.delete(id);
  deps.logger.info('article.deleted', { articleId: id, hadEpub: !!article.epubObjectKey });
}

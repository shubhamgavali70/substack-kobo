import { ArticleRepository } from '../db/articles';
import type { Env } from '../env';
import type { Logger } from '../observability/logger';
import { type ArticleRecord, toAppError } from '../types';
import { GoogleDriveClient } from './googleDrive';

/**
 * Pushes a finished EPUB to Google Drive when the integration is connected.
 * Failures are recorded on the article (drive_status = FAILED) and never
 * affect the READY state: the EPUB is still downloadable directly.
 */
export async function deliverToDriveIfConnected(
  env: Env,
  article: ArticleRecord,
  bytes: Uint8Array,
  filename: string,
  logger: Logger,
): Promise<'uploaded' | 'skipped' | 'failed'> {
  const client = new GoogleDriveClient(env, logger);
  if (!client.configured) return 'skipped';
  const status = await client.status();
  if (!status.connected) return 'skipped';
  const articles = new ArticleRepository(env.DB);
  try {
    const result = await client.uploadEpub(bytes, filename, article.driveFileId);
    await articles.setDriveResult(article.id, { fileId: result.fileId });
    return 'uploaded';
  } catch (error) {
    const appError = toAppError(error, 'DELIVERY_FAILED');
    logger.warn('drive.upload_failed', {
      articleId: article.id,
      code: appError.code,
      error: appError,
    });
    await articles.setDriveResult(article.id, { error: appError.message });
    return 'failed';
  }
}

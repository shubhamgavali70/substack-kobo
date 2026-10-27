import type { Logger } from '../observability/logger';
import { AppError } from '../types';

/**
 * R2 wrapper for EPUB files and manual-import payloads. Object keys are
 * internal: they are never returned by the API; downloads go through the
 * authenticated endpoint which looks keys up in D1.
 */
export class EpubStorage {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly logger: Logger,
  ) {}

  static epubKey(articleId: string, filename: string): string {
    // Keys stay ASCII-safe regardless of the title; the pretty filename is in D1.
    const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    return `epubs/${articleId}/${safe || 'article.epub'}`;
  }

  async putEpub(key: string, bytes: Uint8Array, metadata: Record<string, string>): Promise<void> {
    try {
      await this.bucket.put(key, bytes, {
        httpMetadata: { contentType: 'application/epub+zip' },
        customMetadata: metadata,
      });
    } catch (error) {
      this.logger.error('r2.put_failed', { key, error });
      throw new AppError('STORAGE_FAILED', 'Storing the EPUB failed. The job will be retried.', {
        retryable: true,
        cause: error,
      });
    }
  }

  async getEpub(key: string): Promise<R2ObjectBody | null> {
    try {
      return await this.bucket.get(key);
    } catch (error) {
      this.logger.error('r2.get_failed', { key, error });
      throw new AppError('STORAGE_FAILED', 'Reading the EPUB from storage failed.', {
        cause: error,
      });
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    try {
      await this.bucket.put(key, JSON.stringify(value), {
        httpMetadata: { contentType: 'application/json' },
      });
    } catch (error) {
      this.logger.error('r2.put_failed', { key, error });
      throw new AppError('STORAGE_FAILED', 'Storing the imported content failed.', {
        cause: error,
      });
    }
  }

  /** Deletes objects; missing objects are not an error. */
  async deleteMany(keys: string[]): Promise<void> {
    const unique = keys.filter((k, i) => k && keys.indexOf(k) === i);
    if (unique.length === 0) return;
    try {
      await this.bucket.delete(unique);
    } catch (error) {
      this.logger.error('r2.delete_failed', { keys: unique, error });
      throw new AppError('STORAGE_FAILED', 'Deleting stored files failed. Please try again.', {
        cause: error,
      });
    }
  }
}

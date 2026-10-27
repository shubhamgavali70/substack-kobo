import type { AppConfig } from '../env';
import type { Logger } from '../observability/logger';
import type { ArticleImageRef, DownloadedImage } from '../types';
import { safeFetch } from './safeFetch';

/**
 * Downloads article images under the image-host allowlist and size budget.
 * Failures are non-fatal: an image that cannot be fetched is simply omitted
 * from the EPUB (the generator removes the dangling <img>).
 */

const MEDIA_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export async function downloadImages(
  images: ArticleImageRef[],
  config: AppConfig,
  logger: Logger,
): Promise<DownloadedImage[]> {
  const results: DownloadedImage[] = [];
  let totalBytes = 0;
  const candidates = images.slice(0, config.maxImages);
  if (images.length > config.maxImages) {
    logger.warn('images.truncated', { requested: images.length, kept: config.maxImages });
  }

  for (const image of candidates) {
    if (totalBytes >= config.maxTotalImageBytes) {
      logger.warn('images.budget_exhausted', { imageId: image.id });
      break;
    }
    try {
      const response = await safeFetch(image.sourceUrl, {
        allowedHosts: config.allowedImageHosts,
        maxBytes: Math.min(config.maxImageBytes, config.maxTotalImageBytes - totalBytes),
        timeoutMs: config.fetchTimeoutMs,
        // Ask the CDN for formats every e-reader understands; WebP is EPUB 3.3
        // core media but Kobo support is uneven, so it is deprioritized.
        accept: 'image/jpeg,image/png,image/gif;q=0.9,image/webp;q=0.5',
        purpose: 'image',
        logger,
      });
      if (response.status !== 200) {
        logger.warn('images.skipped', { imageId: image.id, reason: `status ${response.status}` });
        continue;
      }
      const mediaType = response.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
      const ext = MEDIA_TYPES[mediaType] ?? sniffImage(response.body);
      if (!ext) {
        logger.warn('images.skipped', {
          imageId: image.id,
          reason: `unsupported media type ${mediaType || 'unknown'}`,
        });
        continue;
      }
      const resolvedType = MEDIA_TYPES[mediaType] ? mediaType : extToMediaType(ext);
      totalBytes += response.body.byteLength;
      results.push({
        id: image.id,
        data: response.body,
        mediaType: resolvedType,
        filename: `${image.id}.${ext}`,
      });
    } catch (error) {
      logger.warn('images.skipped', {
        imageId: image.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info('images.downloaded', { count: results.length, totalBytes });
  return results;
}

function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return 'webp';
  return null;
}

function extToMediaType(ext: string): string {
  for (const [type, e] of Object.entries(MEDIA_TYPES)) if (e === ext) return type;
  return 'application/octet-stream';
}

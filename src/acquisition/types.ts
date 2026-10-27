import type { AppConfig } from '../env';
import type { Logger } from '../observability/logger';
import type { ContentSourceKind, NormalizedArticle } from '../types';

/**
 * Content acquisition boundary.
 *
 * A ContentSource turns an acquisition request into a NormalizedArticle or
 * throws an AppError with one of the typed codes (AUTHORIZATION_REQUIRED,
 * CONTENT_UNAVAILABLE, FETCH_FAILED, TIMEOUT, TOO_LARGE, EXTRACTION_FAILED).
 * Queue processing and EPUB generation depend only on this interface, so a
 * future officially supported Substack integration can be added as another
 * implementation without touching the rest of the pipeline.
 */
export interface AcquisitionRequest {
  articleId: string;
  /** Canonical, policy-validated article URL. */
  url: string;
  mode: ContentSourceKind;
}

export interface AcquisitionResult {
  article: NormalizedArticle;
  /** Canonical URL hinted by the source, if different from the request URL. */
  canonicalHint: string | null;
}

export interface ContentSource {
  readonly kind: ContentSourceKind;
  fetchArticle(request: AcquisitionRequest, deps: AcquisitionDeps): Promise<AcquisitionResult>;
}

export interface AcquisitionDeps {
  config: AppConfig;
  logger: Logger;
  bucket: R2Bucket;
}

import { AppError } from '../types';
import { extractSubstackArticle } from './extract';
import { safeFetch } from './safeFetch';
import type {
  AcquisitionDeps,
  AcquisitionRequest,
  AcquisitionResult,
  ContentSource,
} from './types';

/**
 * Fetches the publicly rendered page of a Substack post, exactly as an
 * anonymous browser would (no cookies, no credentials), and extracts the
 * article. Paywalled or login-protected content is reported, not bypassed.
 */
export class SubstackPublicHtmlSource implements ContentSource {
  readonly kind = 'public' as const;

  async fetchArticle(
    request: AcquisitionRequest,
    deps: AcquisitionDeps,
  ): Promise<AcquisitionResult> {
    const { config, logger } = deps;
    const response = await safeFetch(request.url, {
      allowedHosts: config.allowedHosts,
      maxBytes: config.maxArticleBytes,
      timeoutMs: config.fetchTimeoutMs,
      accept: 'text/html,application/xhtml+xml;q=0.9',
      purpose: 'article',
      logger,
    });

    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        'AUTHORIZATION_REQUIRED',
        'The publication requires a login to view this post. Use manual import for content you are entitled to read.',
      );
    }
    if (response.status === 404 || response.status === 410) {
      throw new AppError(
        'CONTENT_UNAVAILABLE',
        'The article was not found (it may have been removed or the link is wrong).',
      );
    }
    if (response.status === 429) {
      throw new AppError(
        'FETCH_FAILED',
        'The publication is rate limiting requests. The job will be retried later.',
        {
          retryable: true,
        },
      );
    }
    if (response.status >= 500) {
      throw new AppError(
        'FETCH_FAILED',
        `The publication server returned an error (${response.status}).`,
        {
          retryable: true,
        },
      );
    }
    if (response.status !== 200) {
      throw new AppError(
        'CONTENT_UNAVAILABLE',
        `Unexpected response (${response.status}) when fetching the article.`,
      );
    }
    if (!/text\/html|application\/xhtml\+xml/i.test(response.contentType)) {
      throw new AppError('CONTENT_UNAVAILABLE', 'The URL did not return an HTML page.');
    }

    const html = new TextDecoder('utf-8').decode(response.body);
    const extracted = extractSubstackArticle(html, response.finalUrl);
    return extracted;
  }
}

import { assertSafeDestination } from '../capture/urlPolicy';
import type { Logger } from '../observability/logger';
import { AppError } from '../types';

/**
 * A fetch wrapper that enforces the URL policy on every hop, bounds response
 * size and duration, and never sends cookies or credentials.
 */

export interface SafeFetchOptions {
  allowedHosts: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  accept?: string;
  purpose?: string;
  logger?: Logger;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Uint8Array;
  redirects: number;
}

const USER_AGENT =
  'SubstackToKobo/0.1 (+personal reading tool; respects robots and access controls)';

export async function safeFetch(
  input: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const purpose = options.purpose ?? 'article';
  let current = assertSafeDestination(input, { allowedHosts: options.allowedHosts, purpose });
  // Never fetch over plain http even if submitted that way.
  current.protocol = 'https:';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = Date.now();

  try {
    for (let hop = 0; ; hop++) {
      let response: Response;
      try {
        response = await fetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'Accept-Language': 'en;q=0.9,*;q=0.5',
            'User-Agent': USER_AGENT,
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AppError(
            'TIMEOUT',
            `Fetching the ${purpose} took longer than ${options.timeoutMs / 1000}s.`,
            {
              retryable: true,
              cause: error,
            },
          );
        }
        throw new AppError('FETCH_FAILED', `Could not reach the ${purpose} server.`, {
          retryable: true,
          cause: error,
        });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) {
          throw new AppError('FETCH_FAILED', 'The server redirected without a destination.', {
            retryable: false,
          });
        }
        if (hop >= maxRedirects) {
          throw new AppError('FETCH_FAILED', 'Too many redirects while fetching the article.', {
            retryable: false,
          });
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new AppError('FETCH_FAILED', 'The server redirected to an invalid URL.', {
            retryable: false,
          });
        }
        // Every redirect destination is revalidated against the same policy.
        current = assertSafeDestination(next, {
          allowedHosts: options.allowedHosts,
          purpose: 'redirect',
        });
        if (current.protocol !== 'https:') {
          throw new AppError(
            'HOST_NOT_ALLOWED',
            'Redirects to non-https destinations are not followed.',
          );
        }
        options.logger?.debug('fetch.redirect', { hop: hop + 1, to: current.hostname });
        continue;
      }

      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > options.maxBytes) {
        await response.body?.cancel();
        throw new AppError(
          'TOO_LARGE',
          `The ${purpose} is larger than the ${formatBytes(options.maxBytes)} limit.`,
        );
      }

      const body = await readBounded(response, options.maxBytes, purpose);
      options.logger?.debug('fetch.complete', {
        status: response.status,
        bytes: body.byteLength,
        durationMs: Date.now() - startedAt,
        redirects: hop,
      });
      return {
        finalUrl: current.toString(),
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body,
        redirects: hop,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(
  response: Response,
  maxBytes: number,
  purpose: string,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError(
        'TOO_LARGE',
        `The ${purpose} is larger than the ${formatBytes(maxBytes)} limit.`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

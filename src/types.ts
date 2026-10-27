/**
 * Shared domain types. Kept dependency-free so every module (routes, jobs,
 * EPUB generation, tests) can import them without pulling in runtime code.
 */

export const ARTICLE_STATUSES = [
  'QUEUED',
  'PROCESSING',
  'READY',
  'RETRYABLE_ERROR',
  'CONTENT_UNAVAILABLE',
  'AUTHORIZATION_REQUIRED',
  'FAILED',
] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const JOB_STATUSES = [
  'QUEUED',
  'PROCESSING',
  'WAITING_RETRY',
  'COMPLETED',
  'FAILED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses from which a user may request a retry. */
export const RETRYABLE_ARTICLE_STATUSES: readonly ArticleStatus[] = [
  'RETRYABLE_ERROR',
  'FAILED',
  'CONTENT_UNAVAILABLE',
  'AUTHORIZATION_REQUIRED',
];

export const ERROR_CODES = [
  'INVALID_URL',
  'HOST_NOT_ALLOWED',
  'VALIDATION_ERROR',
  'AUTHORIZATION_REQUIRED',
  'CONTENT_UNAVAILABLE',
  'FETCH_FAILED',
  'TIMEOUT',
  'TOO_LARGE',
  'EXTRACTION_FAILED',
  'EPUB_GENERATION_FAILED',
  'STORAGE_FAILED',
  'MAX_ATTEMPTS_EXCEEDED',
  'DUPLICATE_ARTICLE',
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'CONFLICT',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorOptions {
  /** Whether a background job should retry after this error. */
  retryable?: boolean;
  /** HTTP status to use when surfacing this error from an API route. */
  httpStatus?: number;
  /** Safe-to-expose structured details (never secrets or article content). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * The single error type used across the application. Messages are written to
 * be shown to the user; internal diagnostics belong in `cause`/logs.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(code);
    this.details = options.details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

function defaultHttpStatus(code: ErrorCode): number {
  switch (code) {
    case 'INVALID_URL':
    case 'HOST_NOT_ALLOWED':
    case 'VALIDATION_ERROR':
      return 400;
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'DUPLICATE_ARTICLE':
      return 409;
    case 'TOO_LARGE':
      return 413;
    case 'RATE_LIMITED':
      return 429;
    case 'FETCH_FAILED':
    case 'TIMEOUT':
    case 'CONTENT_UNAVAILABLE':
    case 'AUTHORIZATION_REQUIRED':
      return 502;
    default:
      return 500;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown, fallbackCode: ErrorCode = 'INTERNAL_ERROR'): AppError {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(fallbackCode, message, { cause: error });
}

export type ContentSourceKind = 'public' | 'manual';

export interface ArticleRecord {
  id: string;
  canonicalUrl: string;
  originalUrl: string;
  title: string | null;
  author: string | null;
  publicationName: string | null;
  publishedAt: string | null;
  capturedAt: string;
  status: ArticleStatus;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  contentHash: string | null;
  contentSource: ContentSourceKind;
  epubObjectKey: string | null;
  epubSize: number | null;
  epubFilename: string | null;
  wordCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  articleId: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  lastErrorCode: ErrorCode | null;
  createdAt: string;
  updatedAt: string;
}

/** Message body sent through Cloudflare Queues. Everything else lives in D1. */
export interface JobMessage {
  jobId: string;
  articleId: string;
}

/** An image referenced by the article body, before download. */
export interface ArticleImageRef {
  /** Stable id used in the rewritten `src` (e.g. "img001"). */
  id: string;
  sourceUrl: string;
  alt: string;
}

/** An image that was downloaded and is ready to be packaged. */
export interface DownloadedImage {
  id: string;
  data: Uint8Array;
  mediaType: string;
  /** File name inside the EPUB, e.g. "img001.jpg". */
  filename: string;
}

/**
 * Normalized article content: the contract between content acquisition and
 * EPUB generation. `contentXhtml` is sanitized, well-formed XHTML with image
 * `src` attributes rewritten to `images/<imageId>`.
 */
export interface NormalizedArticle {
  title: string;
  author: string | null;
  publicationName: string | null;
  /** ISO 8601 timestamp if known. */
  publishedAt: string | null;
  canonicalUrl: string;
  sourceUrl: string;
  language: string;
  description: string | null;
  contentXhtml: string;
  images: ArticleImageRef[];
  wordCount: number;
  source: ContentSourceKind;
}

/** Public API representation of an article (never exposes R2 object keys). */
export interface ArticleView {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string | null;
  author: string | null;
  publicationName: string | null;
  publishedAt: string | null;
  capturedAt: string;
  status: ArticleStatus;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  contentSource: ContentSourceKind;
  epubSize: number | null;
  epubFilename: string | null;
  wordCount: number | null;
  downloadUrl: string | null;
  canRetry: boolean;
  canImport: boolean;
  updatedAt: string;
}

export interface LibraryFilters {
  query?: string | undefined;
  status?: ArticleStatus | undefined;
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

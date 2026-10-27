import type { JobMessage } from './types';

/** Bindings and variables available to the Worker. */
export interface Env {
  DB: D1Database;
  EPUBS: R2Bucket;
  ASSETS: Fetcher;
  /** Optional: absent when the account/plan has no Queues configured. */
  ARTICLE_QUEUE?: Queue<JobMessage>;

  // Secrets (wrangler secret put ...)
  AUTH_PASSWORD?: string;
  SESSION_SECRET?: string;
  API_TOKEN?: string;

  // Plain vars (wrangler.jsonc "vars")
  ALLOWED_HOSTS?: string;
  ALLOWED_IMAGE_HOSTS?: string;
  APP_NAME?: string;
  INCLUDE_IMAGES?: string;
  MAX_JOB_ATTEMPTS?: string;

  // Test-only: migrations applied by the Vitest setup file.
  TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
}

export interface AppConfig {
  appName: string;
  allowedHosts: string[];
  allowedImageHosts: string[];
  includeImages: boolean;
  maxJobAttempts: number;
  /** Max bytes of article HTML we are willing to read. */
  maxArticleBytes: number;
  /** Max bytes per image and total for all images in one article. */
  maxImageBytes: number;
  maxTotalImageBytes: number;
  maxImages: number;
  fetchTimeoutMs: number;
  /** How long a job claim is held before it is considered stale. */
  jobLeaseSeconds: number;
  sessionTtlSeconds: number;
}

const DEFAULT_ALLOWED_HOSTS = ['substack.com', '*.substack.com'];
const DEFAULT_ALLOWED_IMAGE_HOSTS = [
  'substackcdn.com',
  '*.substackcdn.com',
  'substack-post-media.s3.amazonaws.com',
  'bucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaws.com',
];

export function parseHostList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

export function loadConfig(env: Env): AppConfig {
  const maxAttempts = Number.parseInt(env.MAX_JOB_ATTEMPTS ?? '5', 10);
  return {
    appName: env.APP_NAME ?? 'Substack to Kobo',
    allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...parseHostList(env.ALLOWED_HOSTS)],
    allowedImageHosts: [...DEFAULT_ALLOWED_IMAGE_HOSTS, ...parseHostList(env.ALLOWED_IMAGE_HOSTS)],
    includeImages: (env.INCLUDE_IMAGES ?? 'true').toLowerCase() !== 'false',
    maxJobAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.min(maxAttempts, 20) : 5,
    maxArticleBytes: 5 * 1024 * 1024,
    maxImageBytes: 5 * 1024 * 1024,
    maxTotalImageBytes: 25 * 1024 * 1024,
    maxImages: 40,
    fetchTimeoutMs: 20_000,
    jobLeaseSeconds: 180,
    sessionTtlSeconds: 30 * 24 * 60 * 60,
  };
}

/** Throws early with a clear message when required secrets are missing. */
export function assertSecretsConfigured(env: Env): void {
  const missing: string[] = [];
  if (!env.AUTH_PASSWORD) missing.push('AUTH_PASSWORD');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    missing.push('SESSION_SECRET (>= 32 chars)');
  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${missing.join(', ')}. Set them with "wrangler secret put <NAME>" or in .dev.vars for local development.`,
    );
  }
}

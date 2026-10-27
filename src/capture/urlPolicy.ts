import { AppError } from '../types';

/**
 * URL validation, SSRF protection and canonicalization.
 *
 * Every URL that the system will fetch passes through `assertSafeDestination`,
 * both when submitted and again for every redirect hop. Hostnames must be on
 * the configured allowlist; IP literals, local names and metadata endpoints
 * are rejected outright.
 */

const MAX_URL_LENGTH = 2048;

const FORBIDDEN_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

const FORBIDDEN_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.arpa',
  '.home',
  '.lan',
  '.corp',
];

export function isIpLiteral(hostname: string): boolean {
  // URL parsing brackets IPv6 literals: "[::1]".
  if (hostname.startsWith('[') || hostname.includes(':')) return true;
  // Dotted quad or any all-numeric form (decimal/hex/octal ambiguity means we
  // reject anything that is purely digits, dots and hex prefixes).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(hostname)) return true;
  return false;
}

export function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return true;
  if (FORBIDDEN_HOSTS.has(host)) return true;
  if (isIpLiteral(host)) return true;
  if (!host.includes('.')) return true; // single-label hostnames are internal names
  return FORBIDDEN_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Allowlist matching. Patterns are exact hostnames or `*.example.com` which
 * matches any subdomain (but not the apex).
 */
export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const pattern of allowedHosts) {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (host === p) {
      return true;
    }
  }
  return false;
}

export interface SafeDestinationOptions {
  allowedHosts: readonly string[];
  /** Human-readable purpose used in error messages ("article", "image", "redirect"). */
  purpose?: string;
}

/**
 * Validates that a URL is an acceptable fetch destination. Returns the parsed
 * URL or throws an AppError with a user-facing message.
 */
export function assertSafeDestination(input: string | URL, options: SafeDestinationOptions): URL {
  const purpose = options.purpose ?? 'article';
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    throw new AppError('INVALID_URL', `The ${purpose} URL is not a valid absolute URL.`);
  }
  if (typeof input === 'string' && input.length > MAX_URL_LENGTH) {
    throw new AppError('INVALID_URL', `The ${purpose} URL is too long.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('INVALID_URL', `Only http(s) URLs are accepted for the ${purpose}.`);
  }
  if (url.username || url.password) {
    throw new AppError('INVALID_URL', 'URLs with embedded credentials are not accepted.');
  }
  if (url.port && url.port !== '443' && url.port !== '80') {
    throw new AppError('INVALID_URL', 'URLs with non-standard ports are not accepted.');
  }
  if (isForbiddenHost(url.hostname)) {
    throw new AppError('HOST_NOT_ALLOWED', 'IP addresses and internal hostnames are not accepted.');
  }
  if (!isHostAllowed(url.hostname, options.allowedHosts)) {
    throw new AppError(
      'HOST_NOT_ALLOWED',
      `The host "${url.hostname}" is not on the allowlist. Add it to ALLOWED_HOSTS if this is a Substack publication on a custom domain.`,
      { details: { host: url.hostname } },
    );
  }
  return url;
}

export interface CanonicalizedUrl {
  /** Normalized URL used for deduplication and fetching. */
  canonicalUrl: string;
  /** The URL exactly as submitted (trimmed). */
  originalUrl: string;
  host: string;
}

const TRACKING_PATH_SUFFIXES = ['/comments', '/comment'];

/**
 * Validates and canonicalizes a submitted article URL.
 *
 * - Forces https, lowercases the host, strips query/fragment (Substack share
 *   links carry `?r=` and `utm_*` parameters), trims trailing slashes.
 * - Rewrites `open.substack.com/pub/<pub>/p/<slug>` share links, which the
 *   Substack mobile app produces, to `https://<pub>.substack.com/p/<slug>`.
 */
export function canonicalizeArticleUrl(
  rawInput: string,
  allowedHosts: readonly string[],
): CanonicalizedUrl {
  const originalUrl = rawInput.trim();
  if (originalUrl.length === 0) {
    throw new AppError('INVALID_URL', 'Please provide an article URL.');
  }
  let url = assertSafeDestination(originalUrl, { allowedHosts, purpose: 'article' });

  // Rewrite app share links to the publication's own address.
  if (url.hostname.toLowerCase() === 'open.substack.com') {
    const match = /^\/pub\/([a-z0-9-]+)\/p\/([^/?#]+)/i.exec(url.pathname);
    if (match?.[1] && match[2]) {
      url = new URL(`https://${match[1].toLowerCase()}.substack.com/p/${match[2]}`);
    }
  }

  const canonical = new URL(url.toString());
  canonical.protocol = 'https:';
  canonical.hostname = canonical.hostname.toLowerCase();
  canonical.port = '';
  canonical.search = '';
  canonical.hash = '';
  canonical.username = '';
  canonical.password = '';

  let path = canonical.pathname.replace(/\/{2,}/g, '/');
  for (const suffix of TRACKING_PATH_SUFFIXES) {
    if (path.endsWith(suffix) && /\/p\//.test(path)) {
      path = path.slice(0, -suffix.length);
    }
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  canonical.pathname = path;

  if (canonical.pathname === '/' || canonical.pathname === '') {
    throw new AppError(
      'INVALID_URL',
      'That looks like a publication home page, not an article. Please share the link of a specific post.',
    );
  }

  // Re-validate after rewriting (the rewritten host must still be allowed).
  assertSafeDestination(canonical, { allowedHosts, purpose: 'article' });

  return { canonicalUrl: canonical.toString(), originalUrl, host: canonical.hostname };
}

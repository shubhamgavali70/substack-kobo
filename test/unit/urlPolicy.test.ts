import { describe, expect, it } from 'vitest';
import {
  assertSafeDestination,
  canonicalizeArticleUrl,
  isForbiddenHost,
  isHostAllowed,
  isIpLiteral,
} from '../../src/capture/urlPolicy';
import { AppError } from '../../src/types';

const allowed = ['substack.com', '*.substack.com', 'custom.example.org'];

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('isHostAllowed', () => {
  it('matches exact hosts and wildcard subdomains', () => {
    expect(isHostAllowed('quietdesk.substack.com', allowed)).toBe(true);
    expect(isHostAllowed('open.substack.com', allowed)).toBe(true);
    expect(isHostAllowed('substack.com', allowed)).toBe(true);
    expect(isHostAllowed('custom.example.org', allowed)).toBe(true);
    expect(isHostAllowed('CUSTOM.EXAMPLE.ORG', allowed)).toBe(true);
  });
  it('rejects look-alike and unrelated hosts', () => {
    expect(isHostAllowed('notsubstack.com', allowed)).toBe(false);
    expect(isHostAllowed('substack.com.evil.net', allowed)).toBe(false);
    expect(isHostAllowed('evil.custom.example.org', allowed)).toBe(false);
    expect(isHostAllowed('example.org', allowed)).toBe(false);
  });
});

describe('SSRF protections', () => {
  it('detects IP literals in all common forms', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('2130706433')).toBe(true);
    expect(isIpLiteral('0x7f.0.0.1')).toBe(true);
    expect(isIpLiteral('quietdesk.substack.com')).toBe(false);
  });
  it('rejects private, local and metadata hostnames', () => {
    for (const host of [
      'localhost',
      'metadata.google.internal',
      'something.local',
      'intranet',
      'db.internal',
      '169.254.169.254',
      '10.0.0.1',
      '[fd00::1]',
    ]) {
      expect(isForbiddenHost(host)).toBe(true);
    }
  });
  it('rejects non-http schemes, credentials and odd ports', () => {
    expect(
      codeOf(() =>
        assertSafeDestination('ftp://quietdesk.substack.com/p/x', { allowedHosts: allowed }),
      ),
    ).toBe('INVALID_URL');
    expect(
      codeOf(() =>
        assertSafeDestination('https://user:pw@quietdesk.substack.com/p/x', {
          allowedHosts: allowed,
        }),
      ),
    ).toBe('INVALID_URL');
    expect(
      codeOf(() =>
        assertSafeDestination('https://quietdesk.substack.com:8443/p/x', { allowedHosts: allowed }),
      ),
    ).toBe('INVALID_URL');
    expect(
      codeOf(() =>
        assertSafeDestination('https://169.254.169.254/latest/meta-data', {
          allowedHosts: allowed,
        }),
      ),
    ).toBe('HOST_NOT_ALLOWED');
    expect(
      codeOf(() =>
        assertSafeDestination('https://evil.example.net/p/x', { allowedHosts: allowed }),
      ),
    ).toBe('HOST_NOT_ALLOWED');
  });
});

describe('canonicalizeArticleUrl', () => {
  it('strips tracking parameters, fragments and trailing slashes', () => {
    const result = canonicalizeArticleUrl(
      '  https://QuietDesk.substack.com/p/why-slow-reading-wins/?utm_source=share&r=abc#comments ',
      allowed,
    );
    expect(result.canonicalUrl).toBe('https://quietdesk.substack.com/p/why-slow-reading-wins');
    expect(result.originalUrl).toBe(
      'https://QuietDesk.substack.com/p/why-slow-reading-wins/?utm_source=share&r=abc#comments',
    );
    expect(result.host).toBe('quietdesk.substack.com');
  });
  it('rewrites mobile-app share links from open.substack.com', () => {
    const result = canonicalizeArticleUrl(
      'https://open.substack.com/pub/quietdesk/p/why-slow-reading-wins?r=1abc&utm_medium=ios',
      allowed,
    );
    expect(result.canonicalUrl).toBe('https://quietdesk.substack.com/p/why-slow-reading-wins');
  });
  it('upgrades http to https and drops the /comments suffix', () => {
    const result = canonicalizeArticleUrl('http://quietdesk.substack.com/p/slug/comments', allowed);
    expect(result.canonicalUrl).toBe('https://quietdesk.substack.com/p/slug');
  });
  it('produces identical canonical URLs for equivalent inputs (deduplication key)', () => {
    const a = canonicalizeArticleUrl(
      'https://quietdesk.substack.com/p/slug?utm_campaign=post',
      allowed,
    ).canonicalUrl;
    const b = canonicalizeArticleUrl(
      'https://open.substack.com/pub/quietdesk/p/slug',
      allowed,
    ).canonicalUrl;
    const c = canonicalizeArticleUrl(
      'HTTPS://QUIETDESK.SUBSTACK.COM/p/slug/',
      allowed,
    ).canonicalUrl;
    expect(new Set([a, b, c]).size).toBe(1);
  });
  it('rejects publication home pages, empty input and junk', () => {
    expect(codeOf(() => canonicalizeArticleUrl('https://quietdesk.substack.com/', allowed))).toBe(
      'INVALID_URL',
    );
    expect(codeOf(() => canonicalizeArticleUrl('', allowed))).toBe('INVALID_URL');
    expect(codeOf(() => canonicalizeArticleUrl('not a url', allowed))).toBe('INVALID_URL');
    expect(codeOf(() => canonicalizeArticleUrl('javascript:alert(1)', allowed))).toBe(
      'INVALID_URL',
    );
  });
  it('rejects hosts outside the allowlist with an actionable message', () => {
    try {
      canonicalizeArticleUrl('https://www.platformer.news/p/some-post', allowed);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('HOST_NOT_ALLOWED');
      expect((error as AppError).message).toContain('ALLOWED_HOSTS');
    }
  });
});

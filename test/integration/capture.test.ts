import { env } from 'cloudflare:test';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEpubStructure } from '../../src/epub';
import { fixtures } from '../fixtures';
import {
  bearer,
  call,
  callJson,
  FREE_URL,
  getArticle,
  html,
  IMAGE_URL,
  inlineEnv,
  installDefaultRoutes,
  outboundCalls,
  PAID_URL,
  readArticleRow,
  readJobRow,
  routes,
  stubOutboundFetch,
  submit,
} from './helpers';

describe('capture → process → download', () => {
  const testEnv = inlineEnv();

  beforeEach(async () => {
    stubOutboundFetch();
    installDefaultRoutes();
    await env.DB.prepare('DELETE FROM processing_jobs').run();
    await env.DB.prepare('DELETE FROM articles').run();
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });
  afterAll(() => vi.unstubAllGlobals());

  it('rejects invalid URLs and hosts outside the allowlist with clear errors', async () => {
    const invalid = await submit(testEnv, 'not-a-url');
    expect(invalid.status).toBe(400);
    expect((invalid.body as unknown as { error: { code: string } }).error.code).toBe('INVALID_URL');

    const forbidden = await submit(testEnv, 'https://evil.example.net/p/post');
    expect(forbidden.status).toBe(400);
    expect((forbidden.body as unknown as { error: { code: string } }).error.code).toBe(
      'HOST_NOT_ALLOWED',
    );

    const internal = await submit(testEnv, 'http://169.254.169.254/latest/meta-data/');
    expect(internal.status).toBe(400);

    const malformed = await call(testEnv, '/api/articles', {
      method: 'POST',
      headers: bearer(),
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    expect(outboundCalls).toHaveLength(0);
  });

  it('accepts a URL, returns a job id immediately and produces a READY article with a valid EPUB', async () => {
    const { status, body } = await submit(testEnv, `${FREE_URL}?utm_source=share&r=abc`);
    expect(status).toBe(202);
    expect(body.jobId).toBeTruthy();
    expect(body.duplicate).toBe(false);
    const id = body.article.id;

    // Inline processing ran during waitUntil; the article is now READY.
    const { body: after } = await getArticle(testEnv, id);
    expect(after.article.status).toBe('READY');
    expect(after.article.title).toBe('Why Slow Reading Wins');
    expect(after.article.author).toBe('Ada Okafor');
    expect(after.article.publicationName).toBe('The Quiet Desk');
    expect(after.article.downloadUrl).toBe(`/api/articles/${id}/download`);
    expect(after.article.epubFilename).toBe('The Quiet Desk - Why Slow Reading Wins.epub');
    expect(after.article.canonicalUrl).toBe(FREE_URL);
    expect(after.article).not.toHaveProperty('epubObjectKey');

    // Only the article page and its allowed image were fetched.
    expect(outboundCalls).toEqual([FREE_URL, IMAGE_URL]);

    const row = await readArticleRow(id);
    expect(row?.epub_object_key).toMatch(/^epubs\//);
    expect(row?.content_hash).toHaveLength(64);
    const job = await readJobRow(id);
    expect(job?.status).toBe('COMPLETED');
    expect(job?.attempts).toBe(1);

    const stored = await env.EPUBS.get(String(row?.epub_object_key));
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe('application/epub+zip');
  });

  it('serves the EPUB download with correct headers to authenticated callers only', async () => {
    const { body } = await submit(testEnv, FREE_URL);
    const id = body.article.id;

    const unauthenticated = await call(testEnv, `/api/articles/${id}/download`);
    expect(unauthenticated.status).toBe(401);

    const response = await call(testEnv, `/api/articles/${id}/download`, { headers: bearer() });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/epub+zip');
    expect(response.headers.get('content-disposition')).toContain(
      'attachment; filename="The Quiet Desk - Why Slow Reading Wins.epub"',
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const validation = validateEpubStructure(bytes);
    expect(validation.errors).toEqual([]);
    expect(validation.files).toContain('OEBPS/images/img001.jpg');
  });

  it('deduplicates equivalent URLs and returns the existing article', async () => {
    const first = await submit(testEnv, FREE_URL);
    const second = await submit(
      testEnv,
      'https://open.substack.com/pub/quietdesk/p/why-slow-reading-wins?r=zz&utm_medium=ios',
    );
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.article.id).toBe(first.body.article.id);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM articles').first<{ n: number }>();
    expect(count?.n).toBe(1);
    // The page was fetched only once.
    expect(outboundCalls.filter((u) => u === FREE_URL)).toHaveLength(1);
  });

  it('marks paywalled posts AUTHORIZATION_REQUIRED without retrying, then accepts manual import', async () => {
    const { body } = await submit(testEnv, PAID_URL);
    const id = body.article.id;
    const { body: after } = await getArticle(testEnv, id);
    expect(after.article.status).toBe('AUTHORIZATION_REQUIRED');
    expect(after.article.errorCode).toBe('AUTHORIZATION_REQUIRED');
    expect(String(after.article.errorMessage)).toMatch(/manual import/i);
    expect(after.article.canRetry).toBe(true);
    expect(after.article.canImport).toBe(true);
    expect(after.article.downloadUrl).toBeNull();
    const job = await readJobRow(id);
    expect(job?.status).toBe('FAILED');
    expect(job?.attempts).toBe(1);

    const imported = await callJson<{ article: { status: string } }>(
      testEnv,
      `/api/articles/${id}/import`,
      {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify({
          text: 'The full essay.\n\nIt has several paragraphs — pasted from the subscriber email — and some Unicode: ñ, ß, 中文.\n\nThe end.',
          title: 'The Paid Essay',
          author: 'Ada Okafor',
          publicationName: 'The Quiet Desk',
        }),
      },
    );
    expect(imported.status).toBe(202);

    const { body: done } = await getArticle(testEnv, id);
    expect(done.article.status).toBe('READY');
    expect(done.article.contentSource).toBe('manual');
    expect(done.article.title).toBe('The Paid Essay');
    const download = await call(testEnv, `/api/articles/${id}/download`, { headers: bearer() });
    expect(download.status).toBe(200);
    expect(validateEpubStructure(new Uint8Array(await download.arrayBuffer())).ok).toBe(true);
  });

  it('accepts manual content together with the URL on first submission', async () => {
    const { status, body } = await submit(
      testEnv,
      'https://quietdesk.substack.com/p/direct-import',
      {
        html: '<h1>Direct import</h1><p>Paragraph one with enough words to count as content.</p><p>Paragraph two.</p>',
        author: 'Someone',
      },
    );
    expect(status).toBe(202);
    const { body: after } = await getArticle(testEnv, body.article.id);
    expect(after.article.status).toBe('READY');
    expect(after.article.title).toBe('Direct import');
    expect(outboundCalls).toHaveLength(0);
  });

  it('rejects empty manual imports', async () => {
    const { body } = await submit(testEnv, PAID_URL);
    const bad = await call(testEnv, `/api/articles/${body.article.id}/import`, {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ text: '   ' }),
    });
    expect(bad.status).toBe(400);
  });

  it('marks missing pages CONTENT_UNAVAILABLE and non-HTML responses too', async () => {
    routes.set('https://quietdesk.substack.com/p/gone', () =>
      html('<html><body>Not found</body></html>', 404),
    );
    const gone = await submit(testEnv, 'https://quietdesk.substack.com/p/gone');
    expect((await getArticle(testEnv, gone.body.article.id)).body.article.status).toBe(
      'CONTENT_UNAVAILABLE',
    );

    routes.set(
      'https://quietdesk.substack.com/p/pdf',
      () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
    );
    const pdf = await submit(testEnv, 'https://quietdesk.substack.com/p/pdf');
    expect((await getArticle(testEnv, pdf.body.article.id)).body.article.status).toBe(
      'CONTENT_UNAVAILABLE',
    );
  });

  it('follows redirects only to allowed hosts and revalidates every hop', async () => {
    routes.set(
      'https://quietdesk.substack.com/p/moved',
      () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://quietdesk.substack.com/p/why-slow-reading-wins' },
        }),
    );
    const moved = await submit(testEnv, 'https://quietdesk.substack.com/p/moved');
    const after = await getArticle(testEnv, moved.body.article.id);
    expect(after.body.article.status).toBe('READY');
    // The canonical URL from the final page was adopted.
    expect(after.body.article.canonicalUrl).toBe(FREE_URL);

    routes.set(
      'https://quietdesk.substack.com/p/evil-redirect',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    );
    const evil = await submit(testEnv, 'https://quietdesk.substack.com/p/evil-redirect');
    const evilAfter = await getArticle(testEnv, evil.body.article.id);
    expect(evilAfter.body.article.status).toBe('CONTENT_UNAVAILABLE');
    expect(evilAfter.body.article.errorCode).toBe('HOST_NOT_ALLOWED');
    expect(outboundCalls).not.toContain('http://169.254.169.254/latest/meta-data/');

    routes.set(
      'https://quietdesk.substack.com/p/offsite',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://www.platformer.news/p/post' },
        }),
    );
    const offsite = await submit(testEnv, 'https://quietdesk.substack.com/p/offsite');
    const offsiteAfter = await getArticle(testEnv, offsite.body.article.id);
    expect(offsiteAfter.body.article.errorCode).toBe('HOST_NOT_ALLOWED');
    expect(outboundCalls.some((u) => u.includes('platformer.news'))).toBe(false);
  });

  it('refuses to adopt a canonical URL that collides with another article', async () => {
    await submit(testEnv, FREE_URL);
    routes.set('https://quietdesk.substack.com/p/alias', () => html(fixtures.freePost));
    const alias = await submit(testEnv, 'https://quietdesk.substack.com/p/alias');
    const after = await getArticle(testEnv, alias.body.article.id);
    expect(after.body.article.status).toBe('FAILED');
    expect(after.body.article.errorCode).toBe('DUPLICATE_ARTICLE');
  });

  it('schedules a retry with backoff on server errors, and fails after max attempts', async () => {
    routes.set('https://quietdesk.substack.com/p/flaky', () => html('oops', 503));
    const { body } = await submit(testEnv, 'https://quietdesk.substack.com/p/flaky');
    const id = body.article.id;
    const { body: after } = await getArticle(testEnv, id);
    expect(after.article.status).toBe('RETRYABLE_ERROR');
    expect(after.article.errorCode).toBe('FETCH_FAILED');
    expect(String(after.article.errorMessage)).toMatch(/retry/i);
    const job = await readJobRow(id);
    expect(job?.status).toBe('WAITING_RETRY');
    expect(job?.attempts).toBe(1);
    expect(Date.parse(String(job?.next_attempt_at))).toBeGreaterThan(Date.now() + 50_000);

    // Exhaust the attempt budget: pretend the previous attempts already happened.
    await env.DB.prepare(
      "UPDATE processing_jobs SET attempts = max_attempts - 1, next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
    )
      .bind(job?.id)
      .run();
    const { processJob } = await import('../../src/jobs/processor');
    const { createLogger } = await import('../../src/observability/logger');
    const outcome = await processJob(
      testEnv,
      String(job?.id),
      createLogger({}, () => undefined),
    );
    expect(outcome).toBe('failed');
    const { body: final } = await getArticle(testEnv, id);
    expect(final.article.status).toBe('FAILED');
    expect(final.article.errorCode).toBe('MAX_ATTEMPTS_EXCEEDED');
    expect(final.article.canRetry).toBe(true);
  });

  it('lets the user retry a failed article, which resets the attempt budget', async () => {
    routes.set('https://quietdesk.substack.com/p/later', () => html('oops', 500));
    const { body } = await submit(testEnv, 'https://quietdesk.substack.com/p/later');
    const id = body.article.id;
    expect((await getArticle(testEnv, id)).body.article.status).toBe('RETRYABLE_ERROR');

    routes.set('https://quietdesk.substack.com/p/later', () =>
      html(fixtures.freePost.replace(FREE_URL, 'https://quietdesk.substack.com/p/later')),
    );
    const retry = await callJson<{ article: { status: string } }>(
      testEnv,
      `/api/articles/${id}/retry`,
      {
        method: 'POST',
        headers: bearer(),
      },
    );
    expect(retry.status).toBe(202);
    const { body: after } = await getArticle(testEnv, id);
    expect(after.article.status).toBe('READY');
    const job = await readJobRow(id);
    expect(job?.attempts).toBe(1);
  });

  it('refuses to retry an article that is READY or already processing', async () => {
    const { body } = await submit(testEnv, FREE_URL);
    const response = await call(testEnv, `/api/articles/${body.article.id}/retry`, {
      method: 'POST',
      headers: bearer(),
    });
    expect(response.status).toBe(409);
  });

  it('schedules a retry when R2 storage fails, without losing the article', async () => {
    const failingBucket = {
      put: async () => {
        throw new Error('simulated R2 outage');
      },
      get: (key: string) => env.EPUBS.get(key),
      delete: (keys: string | string[]) => env.EPUBS.delete(keys),
    } as unknown as R2Bucket;
    const brokenEnv = inlineEnv({ EPUBS: failingBucket });
    const { body } = await submit(brokenEnv, FREE_URL);
    const { body: after } = await getArticle(brokenEnv, body.article.id);
    expect(after.article.status).toBe('RETRYABLE_ERROR');
    expect(after.article.errorCode).toBe('STORAGE_FAILED');
    expect(after.article.title).toBe('Why Slow Reading Wins'); // metadata saved before the failure
    expect((await readJobRow(body.article.id))?.status).toBe('WAITING_RETRY');
  });

  it('deletes the article together with its EPUB and import payload', async () => {
    const { body } = await submit(testEnv, FREE_URL);
    const id = body.article.id;
    const row = await readArticleRow(id);
    const key = String(row?.epub_object_key);
    expect(await env.EPUBS.get(key)).not.toBeNull();

    const unauthenticated = await call(testEnv, `/api/articles/${id}`, { method: 'DELETE' });
    expect(unauthenticated.status).toBe(401);

    const response = await call(testEnv, `/api/articles/${id}`, {
      method: 'DELETE',
      headers: bearer(),
    });
    expect(response.status).toBe(200);
    expect(await env.EPUBS.get(key)).toBeNull();
    expect(await readArticleRow(id)).toBeNull();
    expect(await readJobRow(id)).toBeNull();

    const again = await call(testEnv, `/api/articles/${id}`, {
      method: 'DELETE',
      headers: bearer(),
    });
    expect(again.status).toBe(404);
    const bogus = await call(testEnv, '/api/articles/not-a-uuid', {
      method: 'DELETE',
      headers: bearer(),
    });
    expect(bogus.status).toBe(404);
  });

  it('returns 409 for downloads of articles that are not ready', async () => {
    const { body } = await submit(testEnv, PAID_URL);
    const response = await call(testEnv, `/api/articles/${body.article.id}/download`, {
      headers: bearer(),
    });
    expect(response.status).toBe(409);
  });

  it('lists, searches, filters and paginates the library', async () => {
    await submit(testEnv, FREE_URL);
    await submit(testEnv, PAID_URL);
    for (let i = 0; i < 3; i++) {
      await submit(testEnv, `https://quietdesk.substack.com/p/direct-${i}`, {
        text: `Direct article number ${i} with a handful of words so it counts as readable content for the test.`,
        title: `Direct ${i}`,
        author: i % 2 === 0 ? 'Even Author' : 'Odd Author',
      });
    }
    const all = await callJson<{
      items: Array<{ title: string }>;
      total: number;
      totalPages: number;
    }>(testEnv, '/api/articles?pageSize=2', {
      headers: bearer(),
    });
    expect(all.body.total).toBe(5);
    expect(all.body.totalPages).toBe(3);
    expect(all.body.items).toHaveLength(2);

    const page3 = await callJson<{ items: unknown[]; page: number }>(
      testEnv,
      '/api/articles?pageSize=2&page=3',
      { headers: bearer() },
    );
    expect(page3.body.items).toHaveLength(1);

    const search = await callJson<{ items: Array<{ title: string }> }>(
      testEnv,
      '/api/articles?q=even',
      { headers: bearer() },
    );
    expect(search.body.items.map((a) => a.title).sort()).toEqual(['Direct 0', 'Direct 2']);

    const needsImport = await callJson<{ items: Array<{ status: string }> }>(
      testEnv,
      '/api/articles?status=AUTHORIZATION_REQUIRED',
      {
        headers: bearer(),
      },
    );
    expect(needsImport.body.items).toHaveLength(1);
    expect(needsImport.body.items[0]?.status).toBe('AUTHORIZATION_REQUIRED');

    const wildcard = await callJson<{ items: unknown[] }>(testEnv, '/api/articles?q=%25', {
      headers: bearer(),
    });
    expect(wildcard.body.items).toHaveLength(0); // LIKE wildcards are escaped

    const bad = await call(testEnv, '/api/articles?status=NOPE', { headers: bearer() });
    expect(bad.status).toBe(400);
  });
});

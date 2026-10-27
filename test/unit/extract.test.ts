import { parseDocument } from 'htmlparser2';
import { describe, expect, it } from 'vitest';
import { extractSubstackArticle } from '../../src/acquisition/extract';
import { sanitizeFragment } from '../../src/acquisition/sanitize';
import { AppError } from '../../src/types';
import { fixtures } from '../fixtures';

const PAGE = 'https://quietdesk.substack.com/p/why-slow-reading-wins';

describe('extractSubstackArticle', () => {
  it('extracts metadata and a clean body from a free post', () => {
    const { article, canonicalHint } = extractSubstackArticle(fixtures.freePost, PAGE);
    expect(article.title).toBe('Why Slow Reading Wins');
    expect(article.author).toBe('Ada Okafor');
    expect(article.publicationName).toBe('The Quiet Desk');
    expect(article.publishedAt).toBe('2026-09-14T13:05:00.000Z');
    expect(article.language).toBe('en');
    expect(article.description).toContain('日本語');
    expect(canonicalHint).toBe(PAGE);
    expect(article.wordCount).toBeGreaterThan(80);
  });

  it('removes scripts, styles, forms, widgets and iframes', () => {
    const { article } = extractSubstackArticle(fixtures.freePost, PAGE);
    const body = article.contentXhtml;
    expect(body).not.toMatch(/<script|<style|<iframe|<form|<input|<button/);
    expect(body).not.toContain('Subscribe now');
    expect(body).not.toContain('Expand');
    expect(body).not.toContain('class="button');
  });

  it('keeps semantic structure, links and unicode text', () => {
    const { article } = extractSubstackArticle(fixtures.freePost, PAGE);
    const body = article.contentXhtml;
    expect(body).toContain('<h2 id="sec-1">'.slice(0, 3)); // headings survive (ids assigned later)
    expect(body).toMatch(/<h2>Friction is a feature<\/h2>/);
    expect(body).toContain('<blockquote>');
    expect(body).toContain('<ol start="3">');
    expect(body).toContain('<code>code spans</code>');
    expect(body).toContain('<s>strikethrough</s>');
    expect(body).toContain(
      '<pre><code>const pages = read(slowly);\nif (pages &gt; 10) rest();</code></pre>',
    );
    expect(body).toContain('日本語の読者、Ελληνικοί αναγνώστες');
    expect(body).toContain('📚');
    expect(body).toContain('“curly quotes”');
    // Relative links are resolved against the page URL.
    expect(body).toContain(
      '<a href="https://quietdesk.substack.com/p/another-post?utm_source=post">moment to rest</a>',
    );
    expect(body).toContain('<a href="https://example.org/reading?ref=substack">reference</a>');
    // Footnote anchors keep their ids and fragment links.
    expect(body).toContain('<a href="#footnote-1" id="footnote-anchor-1">1</a>');
    expect(body).toContain('<div id="footnote-1" class="footnote">');
    expect(body).toContain('<table>');
    expect(body).toContain('<th>Device</th>');
  });

  it('rewrites images to placeholders and reports them, unwrapping image links', () => {
    const { article } = extractSubstackArticle(fixtures.freePost, PAGE);
    expect(article.images).toHaveLength(2);
    expect(article.images[0]?.id).toBe('img001');
    expect(article.images[0]?.sourceUrl).toContain('substackcdn.com/image/fetch/w_1456');
    expect(article.images[0]?.alt).toBe('A wooden desk with an e-reader');
    expect(article.contentXhtml).toContain(
      '<img src="images/img001" alt="A wooden desk with an e-reader"/>',
    );
    expect(article.contentXhtml).toContain('<figcaption>The desk in question, 2026.</figcaption>');
    // The <a class="image-link"> wrapper is gone.
    expect(article.contentXhtml).not.toContain('image-link');
    expect(article.contentXhtml).not.toContain('<source');
  });

  it('produces well-formed XML (void elements self-closed, entities escaped)', () => {
    const { article } = extractSubstackArticle(fixtures.freePost, PAGE);
    const doc = parseDocument(`<root>${article.contentXhtml}</root>`, { xmlMode: true });
    expect(doc.children.length).toBe(1);
    expect(article.contentXhtml).not.toMatch(/<br>|<hr>|<img [^>]*[^/]>/);
    expect(article.contentXhtml).toContain('afternoon &amp; a device');
  });

  it('fails with AUTHORIZATION_REQUIRED on paywalled previews instead of truncating', () => {
    try {
      extractSubstackArticle(
        fixtures.paywalledPost,
        'https://quietdesk.substack.com/p/the-paid-essay',
      );
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('AUTHORIZATION_REQUIRED');
      expect((error as AppError).message).toMatch(/paid subscribers/i);
      expect((error as AppError).message).toMatch(/manual import/i);
    }
  });

  it('fails with CONTENT_UNAVAILABLE when the page is not a post', () => {
    try {
      extractSubstackArticle(fixtures.notAPost, 'https://quietdesk.substack.com/about');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as AppError).code).toBe('CONTENT_UNAVAILABLE');
    }
  });

  it('handles missing metadata gracefully', () => {
    const html = `<html><body><div class="body markup">${'<p>Plain words that go on for a while to pass the minimum length check of the extractor module.</p>'.repeat(3)}</div></body></html>`;
    const { article } = extractSubstackArticle(html, 'https://x.substack.com/p/bare');
    expect(article.title).toBe('Untitled article');
    expect(article.author).toBeNull();
    expect(article.publishedAt).toBeNull();
    expect(article.language).toBe('en');
  });
});

describe('sanitizeFragment', () => {
  it('drops javascript: links and data: images, demotes h1 to h2', () => {
    const doc = parseDocument(
      '<h1>Top</h1><p><a href="javascript:alert(1)">bad</a> <a href="mailto:a@b.co">mail</a></p><img src="data:image/png;base64,AAAA" alt="x"><p hidden>secret</p><p style="display:none">hidden</p>',
    );
    const out = sanitizeFragment(doc, 'https://x.substack.com/p/y');
    expect(out.xhtml).toContain('<h2>Top</h2>');
    expect(out.xhtml).toContain('bad');
    expect(out.xhtml).not.toContain('javascript:');
    expect(out.xhtml).toContain('<a href="mailto:a@b.co">mail</a>');
    expect(out.images).toHaveLength(0);
    expect(out.xhtml).not.toContain('secret');
    expect(out.xhtml).not.toContain('hidden');
  });

  it('strips control characters that are invalid in XML', () => {
    const doc = parseDocument('<p>bad\u0000char\u0007here</p>');
    const out = sanitizeFragment(doc, 'https://x.substack.com/p/y');
    expect(out.xhtml).toBe('<p>badcharhere</p>');
  });

  it('counts words across scripts', () => {
    const doc = parseDocument('<p>one two three</p><p>四 五</p>');
    expect(sanitizeFragment(doc, 'https://x.substack.com/p/y').wordCount).toBe(5);
  });
});

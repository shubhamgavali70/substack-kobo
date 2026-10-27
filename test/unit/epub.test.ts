import { unzipSync } from 'fflate';
import { parseDocument } from 'htmlparser2';
import { describe, expect, it } from 'vitest';
import { extractSubstackArticle } from '../../src/acquisition/extract';
import { generateEpub, validateEpubStructure } from '../../src/epub';
import { wrap } from '../../src/epub/cover';
import {
  asciiFilename,
  buildEpubFilename,
  contentDisposition,
  sanitizeFilenamePart,
} from '../../src/epub/filename';
import type { NormalizedArticle } from '../../src/types';
import { fixtures, TINY_PNG } from '../fixtures';

const decoder = new TextDecoder();
const PAGE = 'https://quietdesk.substack.com/p/why-slow-reading-wins';
const NOW = new Date('2026-10-27T10:00:00.000Z');

function sample(): NormalizedArticle {
  return extractSubstackArticle(fixtures.freePost, PAGE).article;
}

function assertWellFormedXml(text: string): void {
  const doc = parseDocument(text, { xmlMode: true });
  const elements = doc.children.filter((n) => n.type === 'tag');
  expect(elements.length).toBe(1);
}

describe('generateEpub', () => {
  it('produces a structurally valid EPUB 3 package', () => {
    const article = sample();
    const epub = generateEpub(
      article,
      [{ id: 'img001', data: TINY_PNG, mediaType: 'image/png', filename: 'img001.png' }],
      {
        identifier: '11111111-2222-4333-8444-555555555555',
        now: NOW,
      },
    );
    expect(epub.mediaType).toBe('application/epub+zip');
    expect(epub.size).toBe(epub.bytes.byteLength);
    expect(epub.filename).toBe('The Quiet Desk - Why Slow Reading Wins.epub');

    const validation = validateEpubStructure(epub.bytes);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.files).toEqual(
      expect.arrayContaining([
        'mimetype',
        'META-INF/container.xml',
        'OEBPS/content.opf',
        'OEBPS/nav.xhtml',
        'OEBPS/cover.xhtml',
        'OEBPS/cover.svg',
        'OEBPS/article.xhtml',
        'OEBPS/styles.css',
        'OEBPS/images/img001.png',
      ]),
    );
  });

  it('writes correct metadata into the OPF', () => {
    const article = sample();
    const epub = generateEpub(article, [], { identifier: 'abc-123', now: NOW });
    const files = unzipSync(epub.bytes);
    const opf = decoder.decode(files['OEBPS/content.opf']);
    assertWellFormedXml(opf);
    expect(opf).toContain('<dc:identifier id="pub-id">urn:uuid:abc-123</dc:identifier>');
    expect(opf).toContain('<dc:title id="title">Why Slow Reading Wins</dc:title>');
    expect(opf).toContain('<dc:creator id="creator">Ada Okafor</dc:creator>');
    expect(opf).toContain('<dc:publisher>The Quiet Desk</dc:publisher>');
    expect(opf).toContain('<dc:date>2026-09-14T13:05:00Z</dc:date>');
    expect(opf).toContain(`<dc:source>${PAGE}</dc:source>`);
    expect(opf).toContain('<dc:language>en</dc:language>');
    expect(opf).toContain('<meta property="dcterms:modified">2026-10-27T10:00:00Z</meta>');
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('properties="nav"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
  });

  it('renders the article document with header, body, footer and a TOC of headings', () => {
    const article = sample();
    const epub = generateEpub(article, [], { identifier: 'abc-123', now: NOW });
    const files = unzipSync(epub.bytes);
    const xhtml = decoder.decode(files['OEBPS/article.xhtml']);
    const nav = decoder.decode(files['OEBPS/nav.xhtml']);
    assertWellFormedXml(xhtml);
    assertWellFormedXml(nav);
    expect(xhtml).toContain('<h1>Why Slow Reading Wins</h1>');
    expect(xhtml).toContain('<p class="byline">Ada Okafor · The Quiet Desk</p>');
    expect(xhtml).toContain('Published September 14, 2026');
    expect(xhtml).toContain(`<a href="${PAGE}">Read on the web</a>`);
    expect(xhtml).toContain('日本語の読者');
    expect(xhtml).toContain('<h2 id="sec-1">Friction is a feature</h2>');
    expect(nav).toContain('<a href="article.xhtml#sec-1">Friction is a feature</a>');
    expect(nav).toContain('<a href="article.xhtml#sec-2">Multilingual margins</a>');
    expect(nav).toContain('epub:type="landmarks"');
    // No scripts or remote resources in the package.
    expect(xhtml).not.toMatch(/<script|https?:\/\/[^"]*\.(js|css)/);
  });

  it('drops images that could not be downloaded but keeps a note', () => {
    const article = sample();
    const epub = generateEpub(article, [], { identifier: 'abc-123', now: NOW });
    const files = unzipSync(epub.bytes);
    const xhtml = decoder.decode(files['OEBPS/article.xhtml']);
    expect(xhtml).not.toContain('images/img001');
    expect(xhtml).toContain('[Image unavailable: A wooden desk with an e-reader]');
    expect(Object.keys(files).some((f) => f.startsWith('OEBPS/images/'))).toBe(false);
  });

  it('stores the mimetype entry first and uncompressed', () => {
    const epub = generateEpub(sample(), [], { identifier: 'abc-123', now: NOW });
    const view = new DataView(epub.bytes.buffer, epub.bytes.byteOffset);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // stored
    const nameLength = view.getUint16(26, true);
    expect(decoder.decode(epub.bytes.subarray(30, 30 + nameLength))).toBe('mimetype');
    expect(decoder.decode(epub.bytes.subarray(30 + nameLength, 30 + nameLength + 20))).toBe(
      'application/epub+zip',
    );
  });

  it('handles missing metadata and escapes special characters in titles', () => {
    const article: NormalizedArticle = {
      title: 'Tom & Jerry <3 "quotes"',
      author: null,
      publicationName: null,
      publishedAt: null,
      canonicalUrl: 'https://x.substack.com/p/y',
      sourceUrl: 'https://x.substack.com/p/y',
      language: 'de',
      description: null,
      contentXhtml: '<p>Hallo Welt</p>',
      images: [],
      wordCount: 2,
      source: 'manual',
    };
    const epub = generateEpub(article, [], { identifier: 'zz', now: NOW });
    const files = unzipSync(epub.bytes);
    const opf = decoder.decode(files['OEBPS/content.opf']);
    assertWellFormedXml(opf);
    expect(opf).toContain('<dc:title id="title">Tom &amp; Jerry &lt;3 "quotes"</dc:title>');
    expect(opf).not.toContain('<dc:creator');
    expect(opf).not.toContain('<dc:date>');
    expect(opf).toContain('xml:lang="de"');
    expect(epub.filename).toBe('Tom Jerry 3 quotes.epub');
    const xhtml = decoder.decode(files['OEBPS/article.xhtml']);
    expect(xhtml).toContain('Content supplied by manual import.');
    expect(validateEpubStructure(epub.bytes).ok).toBe(true);
  });

  it('rejects a tampered package in the validator', () => {
    const epub = generateEpub(sample(), [], { identifier: 'abc', now: NOW });
    const broken = epub.bytes.slice();
    broken.set(new TextEncoder().encode('MIMETYPE'), 30);
    const result = validateEpubStructure(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('mimetype');
  });
});

describe('filenames', () => {
  it('sanitizes reserved characters but keeps unicode', () => {
    expect(sanitizeFilenamePart('Why/Slow: Reading? "Wins" | 日本語')).toBe(
      'Why Slow Reading Wins 日本語',
    );
    expect(sanitizeFilenamePart('..hidden..')).toBe('hidden');
  });
  it('builds stable names with a fallback', () => {
    expect(buildEpubFilename('Title', 'Pub', 'abcdef12-3456')).toBe('Pub - Title.epub');
    expect(buildEpubFilename(null, null, 'abcdef12-3456')).toBe('article-abcdef12.epub');
    expect(buildEpubFilename('x'.repeat(300), null, 'id').length).toBeLessThanOrEqual(130);
  });
  it('produces an RFC 6266 content disposition with ASCII fallback', () => {
    const header = contentDisposition('Désk – 日本語.epub');
    expect(header).toMatch(/^attachment; filename="[\x20-\x7E]+"; filename\*=UTF-8''/);
    expect(header).toContain("filename*=UTF-8''D%C3%A9sk");
    expect(asciiFilename('日本語.epub')).toBe('article.epub');
  });
});

describe('cover text wrapping', () => {
  it('wraps long titles and truncates with an ellipsis', () => {
    const lines = wrap('A very long title that keeps going and going and going without end', 20, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith('…')).toBe(true);
    expect(wrap('Short', 20, 3)).toEqual(['Short']);
  });
});

import type { Document, Element } from 'domhandler';
import { DomUtils, parseDocument } from 'htmlparser2';
import { AppError, type NormalizedArticle } from '../types';
import { sanitizeFragment } from './sanitize';

/**
 * Extracts a normalized article from the HTML of a Substack post page.
 *
 * Only standard, publicly rendered markup and metadata are used: Open Graph /
 * meta tags, JSON-LD (schema.org NewsArticle) and the post body element. If
 * the page is a paywalled preview, extraction stops with
 * AUTHORIZATION_REQUIRED instead of producing a truncated EPUB.
 */

const { findOne, findAll, textContent, getAttributeValue } = DomUtils;

export interface ExtractionResult {
  article: NormalizedArticle;
  /** Canonical URL declared by the page, if any (validated by the caller). */
  canonicalHint: string | null;
}

interface JsonLdArticle {
  headline?: unknown;
  author?: unknown;
  datePublished?: unknown;
  publisher?: unknown;
  isAccessibleForFree?: unknown;
  description?: unknown;
  inLanguage?: unknown;
}

const PAYWALL_TEXT =
  /this post is for (paid|paying) subscribers|upgrade to paid to read|become a paid subscriber to read/i;
const MIN_BODY_WORDS = 20;

export function extractSubstackArticle(html: string, pageUrl: string): ExtractionResult {
  const doc = parseDocument(html, { decodeEntities: true });
  const ld = readJsonLd(doc);
  const meta = (key: string) => readMeta(doc, key);

  const paywalled = detectPaywall(doc, ld);
  const body = findBody(doc);

  if (!body) {
    if (paywalled) throw paywallError();
    if (looksLikeLoginPage(doc)) {
      throw new AppError(
        'AUTHORIZATION_REQUIRED',
        'The page asked for a login. Use manual import for content you are entitled to read.',
      );
    }
    throw new AppError(
      'CONTENT_UNAVAILABLE',
      'Could not find the article body on this page. It may not be a Substack post, or the page layout changed.',
    );
  }

  const sanitized = sanitizeFragment(body, pageUrl);

  if (paywalled) throw paywallError();
  if (sanitized.wordCount < MIN_BODY_WORDS && sanitized.images.length === 0) {
    throw new AppError(
      'CONTENT_UNAVAILABLE',
      'The article body appears to be empty or truncated. If it is subscriber-only, use manual import.',
    );
  }

  const title =
    clean(meta('og:title')) ??
    clean(asString(ld?.headline)) ??
    clean(
      textOf(findOne((el) => /^h1$/i.test(el.name) && hasClass(el, 'post-title'), doc.children)),
    ) ??
    clean(stripTitleSuffix(textOf(findOne((el) => el.name === 'title', doc.children)))) ??
    'Untitled article';

  const author =
    clean(readAuthor(ld)) ?? clean(meta('author')) ?? clean(meta('article:author')) ?? null;
  const publicationName =
    clean(meta('og:site_name')) ??
    clean(readPublisher(ld)) ??
    clean(meta('application-name')) ??
    null;
  const publishedAt =
    toIso(meta('article:published_time')) ??
    toIso(asString(ld?.datePublished)) ??
    toIso(readTimeElement(doc)) ??
    null;
  const description =
    clean(meta('og:description')) ??
    clean(meta('description')) ??
    clean(asString(ld?.description)) ??
    null;
  const language = readLanguage(doc, ld);
  const canonicalHint = readCanonical(doc) ?? clean(meta('og:url')) ?? null;

  return {
    canonicalHint,
    article: {
      title,
      author,
      publicationName,
      publishedAt,
      canonicalUrl: pageUrl,
      sourceUrl: pageUrl,
      language,
      description,
      contentXhtml: sanitized.xhtml,
      images: sanitized.images,
      wordCount: sanitized.wordCount,
      source: 'public',
    },
  };
}

function paywallError(): AppError {
  return new AppError(
    'AUTHORIZATION_REQUIRED',
    'This post is for paid subscribers and only a preview is public. The system does not bypass paywalls. If you are a subscriber, use manual import with the full text from your subscriber email or the Substack reader.',
  );
}

function hasClass(el: Element, name: string): boolean {
  return (el.attribs.class ?? '').split(/\s+/).includes(name);
}

function findBody(doc: Document): Element | null {
  const selectors: Array<(el: Element) => boolean> = [
    (el) => el.name === 'div' && hasClass(el, 'body') && hasClass(el, 'markup'),
    (el) => el.name === 'div' && hasClass(el, 'available-content'),
    (el) => el.name === 'article',
    (el) => el.name === 'div' && hasClass(el, 'post-content'),
    (el) => el.name === 'main',
  ];
  for (const selector of selectors) {
    const found = findOne((el) => selector(el), doc.children);
    if (found) return found;
  }
  return null;
}

function detectPaywall(doc: Document, ld: JsonLdArticle | null): boolean {
  if (
    ld?.isAccessibleForFree === false ||
    ld?.isAccessibleForFree === 'False' ||
    ld?.isAccessibleForFree === 'false'
  ) {
    return true;
  }
  const marker = findOne(
    (el) => hasClass(el, 'paywall') || hasClass(el, 'paywall-title') || hasClass(el, 'paywall-cta'),
    doc.children,
  );
  if (marker && PAYWALL_TEXT.test(textContent(marker))) return true;
  if (marker) return true;
  return false;
}

function looksLikeLoginPage(doc: Document): boolean {
  const title = textOf(findOne((el) => el.name === 'title', doc.children)) ?? '';
  return /sign in|log in|login/i.test(title);
}

function readMeta(doc: Document, key: string): string | undefined {
  const el = findOne(
    (node) =>
      node.name === 'meta' &&
      (node.attribs.property === key || node.attribs.name === key) &&
      typeof node.attribs.content === 'string',
    doc.children,
  );
  return el ? getAttributeValue(el, 'content') : undefined;
}

function readCanonical(doc: Document): string | undefined {
  const el = findOne(
    (node) => node.name === 'link' && (node.attribs.rel ?? '').toLowerCase() === 'canonical',
    doc.children,
  );
  return el ? getAttributeValue(el, 'href') : undefined;
}

function readTimeElement(doc: Document): string | undefined {
  const el = findOne((node) => node.name === 'time' && !!node.attribs.datetime, doc.children);
  return el ? getAttributeValue(el, 'datetime') : undefined;
}

function readLanguage(doc: Document, ld: JsonLdArticle | null): string {
  const htmlEl = findOne((node) => node.name === 'html', doc.children);
  const lang = (htmlEl ? getAttributeValue(htmlEl, 'lang') : undefined) ?? asString(ld?.inLanguage);
  if (lang && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) return lang;
  return 'en';
}

function readJsonLd(doc: Document): JsonLdArticle | null {
  const scripts = findAll(
    (node) =>
      node.name === 'script' && (node.attribs.type ?? '').toLowerCase() === 'application/ld+json',
    doc.children,
  );
  for (const script of scripts) {
    try {
      const parsed: unknown = JSON.parse(textContent(script));
      const found = findArticleNode(parsed);
      if (found) return found;
    } catch {
      // Ignore malformed JSON-LD; it is optional metadata.
    }
  }
  return null;
}

function findArticleNode(value: unknown): JsonLdArticle | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArticleNode(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const type = obj['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === 'string' && /Article|BlogPosting|NewsArticle/.test(t))) {
      return obj as JsonLdArticle;
    }
    if (Array.isArray(obj['@graph'])) return findArticleNode(obj['@graph']);
  }
  return null;
}

function readAuthor(ld: JsonLdArticle | null): string | undefined {
  const author = ld?.author;
  if (!author) return undefined;
  const list = Array.isArray(author) ? author : [author];
  const names = list
    .map((a) => (typeof a === 'string' ? a : asString((a as Record<string, unknown> | null)?.name)))
    .filter((n): n is string => !!n);
  return names.length > 0 ? names.join(', ') : undefined;
}

function readPublisher(ld: JsonLdArticle | null): string | undefined {
  const publisher = ld?.publisher;
  if (!publisher) return undefined;
  if (typeof publisher === 'string') return publisher;
  return asString((publisher as Record<string, unknown>).name);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function textOf(el: Element | null): string | undefined {
  return el ? textContent(el) : undefined;
}

function stripTitleSuffix(title: string | undefined): string | undefined {
  if (!title) return undefined;
  return title.replace(/\s+-\s+by\s+.+$/i, '').trim();
}

function clean(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

export function toIso(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

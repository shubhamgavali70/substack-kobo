import { type ChildNode, type Document, type Element, isTag, isText } from 'domhandler';
import type { ArticleImageRef } from '../types';

/**
 * Converts a parsed HTML fragment into clean, well-formed XHTML suitable for
 * EPUB 3 content documents.
 *
 * - Only a conservative allowlist of elements/attributes survives.
 * - Scripts, styles, iframes, forms and Substack UI widgets are removed.
 * - Image `src` values are rewritten to `images/<id>` and reported so the
 *   processor can download them under its own policy.
 * - Links are resolved to absolute http(s)/mailto URLs or dropped.
 */

const KEEP: ReadonlySet<string> = new Set([
  'p',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'b',
  'i',
  'u',
  's',
  'del',
  'ins',
  'a',
  'img',
  'figure',
  'figcaption',
  'br',
  'hr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'sup',
  'sub',
  'span',
  'small',
  'mark',
  'cite',
  'q',
  'abbr',
  'kbd',
  'dl',
  'dt',
  'dd',
]);

/** Elements removed together with all their content. */
const DROP: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'source',
  'track',
  'button',
  'form',
  'input',
  'select',
  'option',
  'textarea',
  'label',
  'svg',
  'canvas',
  'noscript',
  'template',
  'nav',
  'link',
  'meta',
  'head',
  'title',
  'map',
  'area',
]);

/** Substack UI widgets that appear inside the article body markup. */
const DROP_CLASSES = [
  'subscription-widget-wrap',
  'subscription-widget',
  'subscribe-widget',
  'button-wrapper',
  'captioned-button-wrap',
  'image-link-expand',
  'digest-post-embed',
  'poll-embed',
  'community-chat-embed',
  'paywall',
  'paywall-title',
  'paywall-cta',
  'share-dialog',
  'post-footer',
  'like-button-container',
  'comments-section',
];

const VOID: ReadonlySet<string> = new Set(['br', 'hr', 'img']);
const HEADING_MAP: Record<string, string> = { h1: 'h2' };

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export interface SanitizeResult {
  xhtml: string;
  images: ArticleImageRef[];
  wordCount: number;
}

interface Context {
  baseUrl: URL;
  images: ArticleImageRef[];
  imageSrcToId: Map<string, string>;
  textParts: string[];
  ids: Set<string>;
}

export function sanitizeFragment(
  root: Element | Document | ChildNode[],
  baseUrl: string,
): SanitizeResult {
  const ctx: Context = {
    baseUrl: new URL(baseUrl),
    images: [],
    imageSrcToId: new Map(),
    textParts: [],
    ids: new Set(),
  };
  const children = Array.isArray(root) ? root : root.children;
  const out: string[] = [];
  for (const child of children) renderNode(child, ctx, out, false);
  const xhtml = collapseBlankLines(out.join(''));
  const text = ctx.textParts.join(' ');
  const wordCount = text.split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w)).length;
  return { xhtml, images: ctx.images, wordCount };
}

function hasClass(el: Element, name: string): boolean {
  const cls = el.attribs.class;
  if (!cls) return false;
  return cls.split(/\s+/).includes(name);
}

function hasAnyClass(el: Element, names: readonly string[]): boolean {
  return names.some((n) => hasClass(el, n));
}

function renderNode(node: ChildNode, ctx: Context, out: string[], preformatted: boolean): void {
  if (isText(node)) {
    const data = node.data;
    if (!preformatted && data.trim().length === 0) {
      // Collapse insignificant whitespace between blocks to a single space.
      if (data.length > 0) out.push(' ');
      return;
    }
    ctx.textParts.push(data);
    out.push(escapeText(preformatted ? data : data.replace(/\s+/g, ' ')));
    return;
  }
  if (!isTag(node)) return; // comments, directives, CDATA

  const name = node.name.toLowerCase();
  if (DROP.has(name) || hasAnyClass(node, DROP_CLASSES)) return;
  if (node.attribs.hidden !== undefined || /display\s*:\s*none/i.test(node.attribs.style ?? ''))
    return;

  if (name === 'img') {
    renderImage(node, ctx, out);
    return;
  }

  const mapped = HEADING_MAP[name] ?? name;
  if (!KEEP.has(mapped)) {
    // Unknown wrappers (div, section, picture, font, ...) are unwrapped. A div
    // with an id is kept so footnote links keep working.
    if (name === 'div' && validId(node.attribs.id, ctx)) {
      renderElement('div', node, ctx, out, preformatted);
      return;
    }
    for (const child of node.children) renderNode(child, ctx, out, preformatted);
    return;
  }

  if (mapped === 'a') {
    renderAnchor(node, ctx, out, preformatted);
    return;
  }

  renderElement(mapped, node, ctx, out, preformatted);
}

function renderElement(
  tag: string,
  el: Element,
  ctx: Context,
  out: string[],
  preformatted: boolean,
): void {
  const attrs: Record<string, string> = {};
  const id = validId(el.attribs.id, ctx);
  if (id) {
    attrs.id = id;
    ctx.ids.add(id);
  }
  if ((tag === 'td' || tag === 'th') && el.attribs.colspan && /^\d+$/.test(el.attribs.colspan)) {
    attrs.colspan = el.attribs.colspan;
  }
  if ((tag === 'td' || tag === 'th') && el.attribs.rowspan && /^\d+$/.test(el.attribs.rowspan)) {
    attrs.rowspan = el.attribs.rowspan;
  }
  if (tag === 'ol' && el.attribs.start && /^\d+$/.test(el.attribs.start))
    attrs.start = el.attribs.start;
  if (tag === 'abbr' && el.attribs.title) attrs.title = el.attribs.title.slice(0, 200);
  if (tag === 'figure' && hasClass(el, 'pullquote')) attrs.class = 'pullquote';
  if (tag === 'div' && hasClass(el, 'footnote')) attrs.class = 'footnote';

  const inner: string[] = [];
  const pre = preformatted || tag === 'pre';
  for (const child of el.children) renderNode(child, ctx, inner, pre);
  const body = inner.join('');

  if (VOID.has(tag)) {
    out.push(`<${tag}${serializeAttrs(attrs)}/>`);
    return;
  }
  // Drop empty paragraphs/spans/headings that would only add blank space.
  if (
    body.trim().length === 0 &&
    !attrs.id &&
    (tag === 'p' ||
      tag === 'span' ||
      tag === 'div' ||
      /^h[2-6]$/.test(tag) ||
      tag === 'figure' ||
      tag === 'li')
  ) {
    return;
  }
  if (tag === 'span' && Object.keys(attrs).length === 0) {
    out.push(body); // spans without attributes carry no meaning in the EPUB
    return;
  }
  out.push(`<${tag}${serializeAttrs(attrs)}>${body}</${tag}>`);
  if (isBlock(tag)) out.push('\n');
}

function renderAnchor(el: Element, ctx: Context, out: string[], preformatted: boolean): void {
  const href = resolveHref(el.attribs.href, ctx.baseUrl);
  const inner: string[] = [];
  for (const child of el.children) renderNode(child, ctx, inner, preformatted);
  const body = inner.join('');
  // Substack wraps images in links to themselves; keep only the image.
  const onlyImage = /^\s*<img [^>]*\/>\s*$/.test(body);
  if (!href || onlyImage) {
    out.push(body);
    return;
  }
  if (body.trim().length === 0) return;
  const attrs: Record<string, string> = { href };
  const id = validId(el.attribs.id, ctx);
  if (id) attrs.id = id;
  out.push(`<a${serializeAttrs(attrs)}>${body}</a>`);
}

function renderImage(el: Element, ctx: Context, out: string[]): void {
  const src = pickImageSource(el, ctx.baseUrl);
  if (!src) return;
  let id = ctx.imageSrcToId.get(src);
  if (!id) {
    id = `img${String(ctx.images.length + 1).padStart(3, '0')}`;
    ctx.imageSrcToId.set(src, id);
    ctx.images.push({ id, sourceUrl: src, alt: (el.attribs.alt ?? '').trim().slice(0, 500) });
  }
  const attrs: Record<string, string> = {
    src: `images/${id}`,
    alt: (el.attribs.alt ?? '').trim().slice(0, 500),
  };
  out.push(`<img${serializeAttrs(attrs)}/>`);
}

function pickImageSource(el: Element, base: URL): string | null {
  const candidates = [el.attribs.src, el.attribs['data-src'], firstSrcset(el.attribs.srcset)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate.trim(), base);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        url.protocol = 'https:';
        return url.toString();
      }
    } catch {
      // ignore malformed candidate
    }
  }
  return null;
}

function firstSrcset(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first || undefined;
}

function resolveHref(href: string | undefined, base: URL): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith('#')) {
    return XML_NAME.test(trimmed.slice(1)) ? trimmed : null;
  }
  try {
    const url = new URL(trimmed, base);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') {
      return url.toString();
    }
  } catch {
    // fallthrough
  }
  return null;
}

function validId(id: string | undefined, _ctx: Context): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  return XML_NAME.test(trimmed) && trimmed.length <= 100 ? trimmed : null;
}

const BLOCK_TAGS = new Set([
  'p',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'hr',
  'table',
  'tr',
  'div',
  'dl',
  'dt',
  'dd',
]);

function isBlock(tag: string): boolean {
  return BLOCK_TAGS.has(tag);
}

function serializeAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
}

// Characters that are not allowed in XML 1.0 documents.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional XML control-char filter
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeText(text: string): string {
  return text
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

function collapseBlankLines(xhtml: string): string {
  return xhtml.replace(/\n{2,}/g, '\n').trim();
}

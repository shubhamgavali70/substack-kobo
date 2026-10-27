import { type Element, isTag } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { z } from 'zod';
import { AppError, type NormalizedArticle } from '../types';
import { toIso } from './extract';
import { sanitizeFragment } from './sanitize';
import type {
  AcquisitionDeps,
  AcquisitionRequest,
  AcquisitionResult,
  ContentSource,
} from './types';

/**
 * Manual import: the user supplies content they are entitled to use (for
 * example the full text of a subscriber email or a copy from the Substack
 * reader). The payload is stored in R2 under `imports/<articleId>.json` by the
 * API and consumed here during processing, so the rest of the pipeline is
 * identical to the public path.
 */

export const MAX_IMPORT_CHARS = 2_000_000;

export const manualImportSchema = z
  .object({
    html: z.string().max(MAX_IMPORT_CHARS).optional(),
    text: z.string().max(MAX_IMPORT_CHARS).optional(),
    title: z.string().trim().max(500).optional(),
    author: z.string().trim().max(300).optional(),
    publicationName: z.string().trim().max(300).optional(),
    publishedAt: z.string().trim().max(100).optional(),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
      .optional(),
  })
  .refine((v) => (v.html && v.html.trim().length > 0) || (v.text && v.text.trim().length > 0), {
    message: 'Provide the article content as "html" or "text".',
  });

export type ManualImportPayload = z.infer<typeof manualImportSchema>;

export function importObjectKey(articleId: string): string {
  return `imports/${articleId}.json`;
}

export class ManualImportSource implements ContentSource {
  readonly kind = 'manual' as const;

  async fetchArticle(
    request: AcquisitionRequest,
    deps: AcquisitionDeps,
  ): Promise<AcquisitionResult> {
    const object = await deps.bucket.get(importObjectKey(request.articleId));
    if (!object) {
      throw new AppError(
        'CONTENT_UNAVAILABLE',
        'No imported content was found for this article. Use manual import to provide the content again.',
      );
    }
    let payload: ManualImportPayload;
    try {
      payload = manualImportSchema.parse(await object.json());
    } catch (error) {
      throw new AppError(
        'CONTENT_UNAVAILABLE',
        'The imported content is malformed. Please import it again.',
        {
          cause: error,
        },
      );
    }
    return { article: buildArticleFromImport(payload, request.url), canonicalHint: null };
  }
}

export function buildArticleFromImport(
  payload: ManualImportPayload,
  url: string,
): NormalizedArticle {
  const html =
    payload.html && payload.html.trim().length > 0 ? payload.html : textToHtml(payload.text ?? '');
  const doc = parseDocument(html, { decodeEntities: true });
  // If a full document was pasted, use its body; otherwise treat as fragment.
  const bodyEl = findElement(doc.children, 'body');
  const sanitized = sanitizeFragment(bodyEl && isTag(bodyEl) ? (bodyEl as Element) : doc, url);
  if (sanitized.wordCount === 0 && sanitized.images.length === 0) {
    throw new AppError(
      'CONTENT_UNAVAILABLE',
      'The imported content did not contain any readable text.',
    );
  }
  let host = 'unknown publication';
  try {
    host = new URL(url).hostname;
  } catch {
    // url validated upstream
  }
  return {
    title: payload.title?.trim() || titleFromHtml(doc.children) || 'Untitled article',
    author: payload.author?.trim() || null,
    publicationName: payload.publicationName?.trim() || host,
    publishedAt: toIso(payload.publishedAt) ?? null,
    canonicalUrl: url,
    sourceUrl: url,
    language: payload.language ?? 'en',
    description: null,
    contentXhtml: sanitized.xhtml,
    images: sanitized.images,
    wordCount: sanitized.wordCount,
    source: 'manual',
  };
}

function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paragraphs
    .map(
      (p) =>
        `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</p>`,
    )
    .join('\n');
}

type Node = ReturnType<typeof parseDocument>['children'][number];

function findElement(nodes: Node[], name: string): Node | null {
  for (const node of nodes) {
    if (node.type === 'tag' && node.name === name) return node;
    if ('children' in node && Array.isArray(node.children)) {
      const found = findElement(node.children as Node[], name);
      if (found) return found;
    }
  }
  return null;
}

function titleFromHtml(nodes: Node[]): string | null {
  const h1 = findElement(nodes, 'h1') ?? findElement(nodes, 'title');
  if (!h1 || !('children' in h1)) return null;
  const text = (h1.children as Node[])
    .map((c) => (c.type === 'text' ? c.data : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text.slice(0, 500) : null;
}

import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { manualImportSchema } from '../acquisition';
import type { AppBindings } from '../app';
import { requireApiAuth } from '../auth/middleware';
import { enforceRateLimit } from '../auth/rateLimit';
import { enqueueArticle } from '../capture/captureService';
import { DirectDownloadDelivery } from '../delivery';
import {
  deleteArticle,
  getArticle,
  getLibrary,
  importArticleContent,
  retryArticle,
  toArticleView,
} from '../library/service';
import { EpubStorage } from '../storage/r2';
import { AppError, ARTICLE_STATUSES } from '../types';

const captureSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  content: manualImportSchema.optional(),
});

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(ARTICLE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const idSchema = z.string().uuid();

export const articleRoutes = new Hono<AppBindings>();

articleRoutes.use('*', requireApiAuth);

function deps(c: Context<AppBindings>) {
  return {
    env: c.env,
    config: c.get('config'),
    logger: c.get('logger'),
    waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p),
  };
}

function parseId(raw: string): string {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Article not found.');
  return parsed.data;
}

articleRoutes.post('/', async (c) => {
  await enforceRateLimit(c, 'capture', 60, 60 * 60);
  const body = captureSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    const issue = body.error.issues[0];
    throw new AppError(
      'VALIDATION_ERROR',
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request body.',
    );
  }
  const result = await enqueueArticle(deps(c), { url: body.data.url, content: body.data.content });
  const view = toArticleView(result.article);
  return c.json(
    {
      article: view,
      jobId: result.job?.id ?? null,
      duplicate: result.duplicate,
      message: result.duplicate
        ? 'This article is already in your library.'
        : 'Article queued for processing.',
    },
    result.duplicate ? 200 : 202,
  );
});

articleRoutes.get('/', async (c) => {
  const query = listSchema.safeParse(c.req.query());
  if (!query.success) throw new AppError('VALIDATION_ERROR', 'Invalid list parameters.');
  const { q, status, page, pageSize } = query.data;
  const result = await getLibrary(deps(c), { query: q || undefined, status, page, pageSize });
  return c.json(result);
});

articleRoutes.get('/:id', async (c) => {
  const article = await getArticle(deps(c), parseId(c.req.param('id')));
  return c.json({ article: toArticleView(article) });
});

articleRoutes.post('/:id/retry', async (c) => {
  const article = await retryArticle(deps(c), parseId(c.req.param('id')));
  return c.json({ article: toArticleView(article) }, 202);
});

articleRoutes.post('/:id/import', async (c) => {
  const payload = await c.req.json().catch(() => null);
  const article = await importArticleContent(deps(c), parseId(c.req.param('id')), payload);
  return c.json({ article: toArticleView(article) }, 202);
});

articleRoutes.delete('/:id', async (c) => {
  await deleteArticle(deps(c), parseId(c.req.param('id')));
  return c.json({ ok: true });
});

articleRoutes.get('/:id/download', async (c) => {
  const id = parseId(c.req.param('id'));
  const article = await getArticle(deps(c), id);
  if (article.status !== 'READY' || !article.epubObjectKey) {
    throw new AppError('CONFLICT', 'The EPUB for this article is not ready yet.');
  }
  const storage = new EpubStorage(c.env.EPUBS, c.get('logger'));
  const object = await storage.getEpub(article.epubObjectKey);
  if (!object) {
    c.get('logger').error('download.missing_object', { articleId: id });
    throw new AppError(
      'NOT_FOUND',
      'The EPUB file is missing from storage. Retry processing to regenerate it.',
    );
  }
  c.get('logger').info('download.served', { articleId: id, bytes: object.size });
  return new DirectDownloadDelivery().deliver(article, object);
});

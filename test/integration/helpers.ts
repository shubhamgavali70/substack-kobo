import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { fixtures, TINY_JPEG } from '../fixtures';

export const FREE_URL = 'https://quietdesk.substack.com/p/why-slow-reading-wins';
export const PAID_URL = 'https://quietdesk.substack.com/p/the-paid-essay';
export const IMAGE_URL =
  'https://substackcdn.com/image/fetch/w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fexample.com%2Fdesk.jpg';

export type RouteHandler = (request: Request) => Response | Promise<Response>;

/** Routes for the stubbed outbound fetch, keyed by exact URL. */
export const routes = new Map<string, RouteHandler>();
export const outboundCalls: string[] = [];

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function installDefaultRoutes(): void {
  routes.clear();
  outboundCalls.length = 0;
  routes.set(FREE_URL, () => html(fixtures.freePost));
  routes.set(PAID_URL, () => html(fixtures.paywalledPost));
  routes.set(
    IMAGE_URL,
    () => new Response(TINY_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
  );
}

export function stubOutboundFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      outboundCalls.push(request.url);
      const handler = routes.get(request.url);
      if (!handler)
        return new Response('not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        });
      return handler(request);
    }),
  );
}

/** Test env without the queue binding so jobs run inline (deterministically). */
export function inlineEnv(overrides: Partial<Env> = {}): Env {
  const base = { ...(env as unknown as Env) };
  delete base.ARTICLE_QUEUE;
  return { ...base, ...overrides };
}

export interface CallResult {
  response: Response;
  json: () => Promise<Record<string, unknown>>;
}

/** Calls the Worker directly and waits for background work (waitUntil). */
export async function call(
  testEnv: Env,
  path: string,
  init: RequestInit = {},
  origin = 'https://reader.example',
): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(`${origin}${path}`, init);
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function callJson<T = Record<string, unknown>>(
  testEnv: Env,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T; response: Response }> {
  const response = await call(testEnv, path, init);
  const body = (await response.json()) as T;
  return { status: response.status, body, response };
}

export function bearer(extra: Record<string, string> = {}): HeadersInit {
  return { Authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json', ...extra };
}

export async function login(testEnv: Env, password = env.AUTH_PASSWORD): Promise<string> {
  const response = await call(testEnv, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://reader.example' },
    body: JSON.stringify({ password }),
  });
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

export async function submit(testEnv: Env, url: string, content?: unknown) {
  return callJson<{
    article: { id: string; status: string };
    jobId: string | null;
    duplicate: boolean;
  }>(testEnv, '/api/articles', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify(content ? { url, content } : { url }),
  });
}

export async function getArticle(testEnv: Env, id: string) {
  return callJson<{ article: Record<string, unknown> & { status: string } }>(
    testEnv,
    `/api/articles/${id}`,
    {
      headers: bearer(),
    },
  );
}

export async function readArticleRow(id: string) {
  return env.DB.prepare('SELECT * FROM articles WHERE id = ?1')
    .bind(id)
    .first<Record<string, unknown>>();
}

export async function readJobRow(articleId: string) {
  return env.DB.prepare(
    'SELECT * FROM processing_jobs WHERE article_id = ?1 ORDER BY created_at DESC LIMIT 1',
  )
    .bind(articleId)
    .first<Record<string, unknown>>();
}

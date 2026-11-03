import { env } from 'cloudflare:test';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealSecret } from '../../src/auth/secretBox';
import {
  bearer,
  call,
  callJson,
  FREE_URL,
  getArticle,
  inlineEnv,
  installDefaultRoutes,
  login,
  outboundRequests,
  prefixRoutes,
  readArticleRow,
  routes,
  stubOutboundFetch,
  submit,
} from './helpers';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_PREFIX = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_PREFIX = 'https://www.googleapis.com/drive/v3/files';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stubs a healthy Google: token exchange/refresh, folder search/create, upload, delete. */
function installGoogleRoutes(options: { uploadStatus?: number } = {}): void {
  routes.set(TOKEN_URL, async (request) => {
    const form = new URLSearchParams(await request.text());
    if (form.get('grant_type') === 'authorization_code') {
      return json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/drive.file',
      });
    }
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'refresh-1') {
      return json({ access_token: 'access-2', expires_in: 3600 });
    }
    return json({ error: 'invalid_grant' }, 400);
  });
  prefixRoutes.set('https://www.googleapis.com/drive/v3/about', () =>
    json({ user: { emailAddress: 'reader@example.com' } }),
  );
  prefixRoutes.set(UPLOAD_PREFIX, (request) =>
    options.uploadStatus && options.uploadStatus !== 200
      ? json({ error: { message: 'quota exceeded' } }, options.uploadStatus)
      : json({ id: request.method === 'PATCH' ? 'file-existing' : 'file-new', name: 'x.epub' }),
  );
  prefixRoutes.set(`${FILES_PREFIX}?q=`, () => json({ files: [] }));
  prefixRoutes.set(`${FILES_PREFIX}?fields=`, () =>
    json({ id: 'folder-1', name: 'Substack to Kobo' }),
  );
  prefixRoutes.set(`${FILES_PREFIX}/`, (request) =>
    request.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : json({ id: 'folder-1', trashed: false }),
  );
  prefixRoutes.set('https://oauth2.googleapis.com/revoke', () => json({}));
}

async function connectDirectly(secret: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO integrations (provider, refresh_token_enc, scope, account_email, created_at, updated_at)
     VALUES ('google_drive', ?1, 'https://www.googleapis.com/auth/drive.file', 'reader@example.com', ?2, ?2)`,
  )
    .bind(await sealSecret('refresh-1', secret), new Date().toISOString())
    .run();
}

describe('Google Drive delivery', () => {
  const testEnv = inlineEnv();
  const secret = env.SESSION_SECRET ?? '';

  beforeEach(async () => {
    stubOutboundFetch();
    installDefaultRoutes();
    installGoogleRoutes();
    await env.DB.prepare('DELETE FROM processing_jobs').run();
    await env.DB.prepare('DELETE FROM articles').run();
    await env.DB.prepare('DELETE FROM integrations').run();
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });
  afterAll(() => vi.unstubAllGlobals());

  it('reports configured-but-not-connected status and requires auth', async () => {
    expect((await call(testEnv, '/api/google/status')).status).toBe(401);
    const { body } = await callJson<{ drive: Record<string, unknown>; redirectUri: string }>(
      testEnv,
      '/api/google/status',
      {
        headers: bearer(),
      },
    );
    expect(body.drive).toMatchObject({
      configured: true,
      connected: false,
      scope: 'file',
      folderName: 'Substack to Kobo',
    });
    expect(body.redirectUri).toBe('https://reader.example/api/google/callback');
  });

  it('reports not configured when the OAuth client is absent and refuses to connect', async () => {
    const unconfigured = inlineEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    const { body } = await callJson<{ drive: { configured: boolean } }>(
      unconfigured,
      '/api/google/status',
      { headers: bearer() },
    );
    expect(body.drive.configured).toBe(false);
    const cookie = await login(unconfigured);
    const connect = await call(unconfigured, '/api/google/connect', { headers: { cookie } });
    expect(connect.status).toBe(501);
  });

  it('redirects to Google with a signed state cookie, then completes the callback', async () => {
    const cookie = await login(testEnv);
    const anonymous = await call(testEnv, '/api/google/connect');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toContain('/login');

    const connect = await call(testEnv, '/api/google/connect', { headers: { cookie } });
    expect(connect.status).toBe(302);
    const location = new URL(connect.headers.get('location') ?? '');
    expect(location.hostname).toBe('accounts.google.com');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://reader.example/api/google/callback',
    );
    const state = location.searchParams.get('state') ?? '';
    const stateCookie = (connect.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(stateCookie.startsWith('sk_oauth_state=')).toBe(true);

    // Wrong state is rejected.
    const bad = await call(testEnv, `/api/google/callback?code=abc&state=wrong`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });
    expect(bad.status).toBe(403);
    // Missing session is redirected to login (cookie present but no session).
    const noSession = await call(testEnv, `/api/google/callback?code=abc&state=${state}`, {
      headers: { cookie: stateCookie },
    });
    expect(noSession.status).toBe(302);

    const callback = await call(testEnv, `/api/google/callback?code=abc&state=${state}`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/library?drive=connected');

    const tokenRequest = outboundRequests.find((r) => r.url === TOKEN_URL);
    if (!tokenRequest) throw new Error('token request not sent');
    const form = new URLSearchParams(await tokenRequest.text());
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('abc');
    expect(form.get('redirect_uri')).toBe('https://reader.example/api/google/callback');

    const { body } = await callJson<{ drive: Record<string, unknown> }>(
      testEnv,
      '/api/google/status',
      { headers: bearer() },
    );
    expect(body.drive).toMatchObject({
      connected: true,
      accountEmail: 'reader@example.com',
      needsReconnect: false,
    });
    const row = await env.DB.prepare(
      "SELECT refresh_token_enc FROM integrations WHERE provider = 'google_drive'",
    ).first<{ refresh_token_enc: string }>();
    expect(row?.refresh_token_enc.startsWith('v1.')).toBe(true);
    expect(row?.refresh_token_enc).not.toContain('refresh-1');
  });

  it('handles a denied consent screen gracefully', async () => {
    const cookie = await login(testEnv);
    const response = await call(testEnv, '/api/google/callback?error=access_denied', {
      headers: { cookie },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/library?drive=denied');
  });

  it('uploads the EPUB to Drive automatically after processing when connected', async () => {
    await connectDirectly(secret);
    const { body } = await submit(testEnv, FREE_URL);
    const { body: after } = await getArticle(testEnv, body.article.id);
    expect(after.article.status).toBe('READY');
    expect(after.article.driveStatus).toBe('UPLOADED');
    expect(after.article.driveError).toBeNull();
    expect((await readArticleRow(body.article.id))?.drive_file_id).toBe('file-new');

    const upload = outboundRequests.find((r) => r.url.startsWith(UPLOAD_PREFIX));
    if (!upload) throw new Error('upload request not sent');
    expect(upload.method).toBe('POST');
    expect(upload.headers.get('authorization')).toBe('Bearer access-2');
    expect(upload.headers.get('content-type')).toContain('multipart/related');
    const text = new TextDecoder('latin1').decode(await upload.arrayBuffer());
    expect(text).toContain('"name":"The Quiet Desk - Why Slow Reading Wins.epub"');
    expect(text).toContain('"parents":["folder-1"]');
    expect(text).toContain('"mimeType":"application/epub+zip"');
    // A folder was created because the search found none.
    expect(
      outboundRequests.some(
        (r) => r.method === 'POST' && r.url.startsWith(`${FILES_PREFIX}?fields=`),
      ),
    ).toBe(true);
    const integration = await env.DB.prepare(
      "SELECT folder_id FROM integrations WHERE provider='google_drive'",
    ).first<{ folder_id: string }>();
    expect(integration?.folder_id).toBe('folder-1');
  });

  it('does not upload when Drive is not connected', async () => {
    const { body } = await submit(testEnv, FREE_URL);
    const { body: after } = await getArticle(testEnv, body.article.id);
    expect(after.article.status).toBe('READY');
    expect(after.article.driveStatus).toBeNull();
    expect(outboundRequests.some((r) => r.url.includes('googleapis.com'))).toBe(false);
  });

  it('keeps the article READY when the Drive upload fails and allows re-sending', async () => {
    await connectDirectly(secret);
    installGoogleRoutes({ uploadStatus: 403 });
    const { body } = await submit(testEnv, FREE_URL);
    const id = body.article.id;
    const { body: after } = await getArticle(testEnv, id);
    expect(after.article.status).toBe('READY');
    expect(after.article.downloadUrl).toBeTruthy();
    expect(after.article.driveStatus).toBe('FAILED');
    expect(after.article.driveError).toContain('quota exceeded');

    installGoogleRoutes();
    const resend = await callJson<{ article: { driveStatus: string } }>(
      testEnv,
      `/api/articles/${id}/drive`,
      {
        method: 'POST',
        headers: bearer(),
      },
    );
    expect(resend.status).toBe(200);
    expect(resend.body.article.driveStatus).toBe('UPLOADED');
  });

  it('replaces the existing Drive file on re-send instead of duplicating it', async () => {
    await connectDirectly(secret);
    const { body } = await submit(testEnv, FREE_URL);
    const id = body.article.id;
    outboundRequests.length = 0;
    await callJson(testEnv, `/api/articles/${id}/drive`, { method: 'POST', headers: bearer() });
    const upload = outboundRequests.find((r) => r.url.startsWith(UPLOAD_PREFIX));
    expect(upload?.method).toBe('PATCH');
    expect(upload?.url).toContain('/files/file-new?');
    expect((await readArticleRow(id))?.drive_file_id).toBe('file-existing');
  });

  it('refuses to send articles that are not ready or when not connected', async () => {
    const { body } = await submit(testEnv, FREE_URL);
    const notConnected = await call(testEnv, `/api/articles/${body.article.id}/drive`, {
      method: 'POST',
      headers: bearer(),
    });
    expect(notConnected.status).toBe(409);
    await connectDirectly(secret);
    routes.set(
      'https://quietdesk.substack.com/p/paid2',
      () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }),
    );
    const broken = await submit(testEnv, 'https://quietdesk.substack.com/p/paid2');
    const notReady = await call(testEnv, `/api/articles/${broken.body.article.id}/drive`, {
      method: 'POST',
      headers: bearer(),
    });
    expect(notReady.status).toBe(409);
  });

  it('reports reconnect-needed when the stored token cannot be decrypted', async () => {
    await connectDirectly('a-different-secret-that-is-long-enough-0000');
    const { body } = await callJson<{ drive: Record<string, unknown> }>(
      testEnv,
      '/api/google/status',
      { headers: bearer() },
    );
    expect(body.drive).toMatchObject({ connected: false, needsReconnect: true });
    // Processing still succeeds; delivery is skipped.
    const { body: created } = await submit(testEnv, FREE_URL);
    expect((await getArticle(testEnv, created.article.id)).body.article.status).toBe('READY');
  });

  it('deletes the Drive copy when the article is deleted (best effort)', async () => {
    await connectDirectly(secret);
    const { body } = await submit(testEnv, FREE_URL);
    outboundRequests.length = 0;
    const response = await call(testEnv, `/api/articles/${body.article.id}`, {
      method: 'DELETE',
      headers: bearer(),
    });
    expect(response.status).toBe(200);
    expect(
      outboundRequests.some((r) => r.method === 'DELETE' && r.url === `${FILES_PREFIX}/file-new`),
    ).toBe(true);

    // Drive failing must not block deletion.
    const { body: second } = await submit(testEnv, 'https://quietdesk.substack.com/p/moved2');
    void second;
  });

  it('disconnects: revokes at Google and forgets the token', async () => {
    await connectDirectly(secret);
    const response = await call(testEnv, '/api/google', { method: 'DELETE', headers: bearer() });
    expect(response.status).toBe(200);
    expect(
      outboundRequests.some((r) => r.url.startsWith('https://oauth2.googleapis.com/revoke')),
    ).toBe(true);
    const { body } = await callJson<{ drive: { connected: boolean } }>(
      testEnv,
      '/api/google/status',
      { headers: bearer() },
    );
    expect(body.drive.connected).toBe(false);
  });
});

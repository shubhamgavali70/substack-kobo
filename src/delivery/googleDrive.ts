import { randomToken } from '../auth/crypto';
import { openSecret, sealSecret } from '../auth/secretBox';
import { type IntegrationRecord, IntegrationRepository } from '../db/integrations';
import type { Env, GoogleDriveConfig } from '../env';
import { loadConfig } from '../env';
import type { Logger } from '../observability/logger';
import { AppError } from '../types';

/**
 * Google Drive delivery adapter.
 *
 * Uses the documented Google OAuth 2.0 and Drive v3 REST APIs only. By default
 * it requests the `drive.file` scope, which limits the app to files it created
 * itself; EPUBs are uploaded into a folder the app creates. With
 * GOOGLE_DRIVE_SCOPE=full and GOOGLE_DRIVE_FOLDER_ID, uploads go into an
 * existing folder instead (for example the folder a Kobo eReader syncs from).
 *
 * The refresh token is stored encrypted in D1 (see auth/secretBox.ts).
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PROVIDER = 'google_drive' as const;
const REQUEST_TIMEOUT_MS = 30_000;

export const SCOPES: Record<GoogleDriveConfig['scope'], string> = {
  file: 'https://www.googleapis.com/auth/drive.file',
  full: 'https://www.googleapis.com/auth/drive',
};

export interface DriveStatus {
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  folderName: string | null;
  folderId: string | null;
  scope: GoogleDriveConfig['scope'];
  /** True when the stored token can no longer be decrypted (SESSION_SECRET rotated). */
  needsReconnect: boolean;
}

export interface DriveUploadResult {
  fileId: string;
  name: string;
}

export function redirectUri(origin: string): string {
  return `${origin}/api/google/callback`;
}

export function buildAuthorizationUrl(
  config: GoogleDriveConfig,
  origin: string,
  state: string,
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri(origin));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES[config.scope]);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

export function newOauthState(): string {
  return randomToken(24);
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function googleFetch(input: string, init: RequestInit, purpose: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    throw new AppError('DELIVERY_FAILED', `Google ${purpose} request failed (network error).`, {
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string } | string;
      error_description?: string;
    };
    if (typeof parsed.error === 'string') return parsed.error_description ?? parsed.error;
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 300) || `HTTP ${response.status}`;
}

export class GoogleDriveClient {
  private readonly repo: IntegrationRepository;
  private readonly config: GoogleDriveConfig;
  private readonly secret: string;

  constructor(
    env: Env,
    private readonly logger: Logger,
  ) {
    this.repo = new IntegrationRepository(env.DB);
    this.config = loadConfig(env).googleDrive;
    this.secret = env.SESSION_SECRET ?? '';
  }

  get configured(): boolean {
    return this.config.enabled;
  }

  assertConfigured(): void {
    if (!this.config.enabled) {
      throw new AppError(
        'INTEGRATION_NOT_CONFIGURED',
        'Google Drive is not configured. Set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets (see docs/GOOGLE_DRIVE.md).',
      );
    }
  }

  async status(): Promise<DriveStatus> {
    const record = await this.repo.get(PROVIDER);
    const base = {
      configured: this.config.enabled,
      scope: this.config.scope,
      folderName: this.config.folderId ? null : this.config.folderName,
      folderId: this.config.folderId,
    };
    if (!record) return { ...base, connected: false, accountEmail: null, needsReconnect: false };
    const refresh = await openSecret(record.refreshTokenEnc, this.secret);
    return {
      ...base,
      connected: refresh !== null,
      needsReconnect: refresh === null,
      accountEmail: record.accountEmail,
      folderName: record.folderName ?? base.folderName,
      folderId: record.folderId ?? base.folderId,
    };
  }

  /** Exchanges the authorization code and stores the refresh token. */
  async completeConnection(code: string, origin: string): Promise<DriveStatus> {
    this.assertConfigured();
    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: redirectUri(origin),
      grant_type: 'authorization_code',
    });
    const response = await googleFetch(
      TOKEN_ENDPOINT,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      'token',
    );
    const token = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok || !token.access_token) {
      throw new AppError(
        'DELIVERY_FAILED',
        `Google did not accept the authorization: ${token.error_description ?? token.error ?? response.status}`,
      );
    }
    if (!token.refresh_token) {
      throw new AppError(
        'DELIVERY_FAILED',
        'Google did not return a refresh token. Remove the app from your Google account permissions and connect again.',
      );
    }
    const accountEmail = await this.fetchAccountEmail(token.access_token);
    await this.repo.upsert({
      provider: PROVIDER,
      refreshTokenEnc: await sealSecret(token.refresh_token, this.secret),
      scope: token.scope ?? SCOPES[this.config.scope],
      accountEmail,
    });
    await this.repo.setAccessToken(
      PROVIDER,
      await sealSecret(token.access_token, this.secret),
      new Date(Date.now() + Math.max(60, (token.expires_in ?? 3600) - 60) * 1000).toISOString(),
    );
    this.logger.info('drive.connected', { scope: token.scope });
    return this.status();
  }

  async disconnect(): Promise<void> {
    const record = await this.repo.get(PROVIDER);
    if (!record) return;
    const refresh = await openSecret(record.refreshTokenEnc, this.secret);
    if (refresh) {
      await googleFetch(
        `${REVOKE_ENDPOINT}?token=${encodeURIComponent(refresh)}`,
        { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
        'revoke',
      ).catch(() => undefined);
    }
    await this.repo.delete(PROVIDER);
    this.logger.info('drive.disconnected');
  }

  /** Uploads (or replaces) an EPUB and returns the Drive file id. */
  async uploadEpub(
    bytes: Uint8Array,
    filename: string,
    existingFileId: string | null,
  ): Promise<DriveUploadResult> {
    this.assertConfigured();
    const accessToken = await this.getAccessToken();
    const folderId = await this.ensureFolder(accessToken);

    const metadata: Record<string, unknown> = { name: filename, mimeType: 'application/epub+zip' };
    if (!existingFileId) metadata.parents = [folderId];
    const { body, contentType } = buildMultipartBody(metadata, bytes, 'application/epub+zip');

    const attempt = async (method: 'POST' | 'PATCH', url: string) =>
      googleFetch(
        url,
        {
          method,
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': contentType },
          body,
        },
        'upload',
      );

    let response: Response;
    if (existingFileId) {
      response = await attempt(
        'PATCH',
        `${DRIVE_UPLOAD_API}/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=id,name`,
      );
      if (response.status === 404) {
        // The user deleted the file in Drive; create a fresh one.
        metadata.parents = [folderId];
        const fresh = buildMultipartBody(metadata, bytes, 'application/epub+zip');
        response = await googleFetch(
          `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': fresh.contentType },
            body: fresh.body,
          },
          'upload',
        );
      }
    } else {
      response = await attempt('POST', `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name`);
    }
    if (!response.ok) {
      const message = await readError(response);
      throw new AppError('DELIVERY_FAILED', `Google Drive upload failed: ${message}`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    const result = (await response.json()) as { id: string; name: string };
    this.logger.info('drive.uploaded', {
      fileId: result.id,
      bytes: bytes.byteLength,
      replaced: !!existingFileId,
    });
    return { fileId: result.id, name: result.name };
  }

  /** Best-effort deletion of a file the app created. */
  async deleteFile(fileId: string): Promise<void> {
    if (!this.config.enabled) return;
    const accessToken = await this.getAccessToken();
    const response = await googleFetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` } },
      'delete',
    );
    if (!response.ok && response.status !== 404) {
      throw new AppError(
        'DELIVERY_FAILED',
        `Google Drive delete failed: ${await readError(response)}`,
      );
    }
    this.logger.info('drive.deleted', { fileId });
  }

  private async getAccessToken(): Promise<string> {
    const record = await this.repo.get(PROVIDER);
    if (!record) {
      throw new AppError(
        'INTEGRATION_NOT_CONNECTED',
        'Google Drive is not connected. Connect it from the library page.',
      );
    }
    if (
      record.accessTokenEnc &&
      record.accessTokenExpiresAt &&
      Date.parse(record.accessTokenExpiresAt) > Date.now()
    ) {
      const cached = await openSecret(record.accessTokenEnc, this.secret);
      if (cached) return cached;
    }
    const refresh = await openSecret(record.refreshTokenEnc, this.secret);
    if (!refresh) {
      throw new AppError(
        'INTEGRATION_NOT_CONNECTED',
        'The stored Google Drive credentials cannot be read (SESSION_SECRET changed). Reconnect Google Drive.',
      );
    }
    const body = new URLSearchParams({
      refresh_token: refresh,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
    });
    const response = await googleFetch(
      TOKEN_ENDPOINT,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      'token refresh',
    );
    const token = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok || !token.access_token) {
      if (token.error === 'invalid_grant') {
        throw new AppError(
          'INTEGRATION_NOT_CONNECTED',
          'Google revoked or expired the Drive authorization. Reconnect Google Drive from the library page.',
        );
      }
      throw new AppError(
        'DELIVERY_FAILED',
        `Could not refresh the Google access token: ${token.error_description ?? token.error ?? response.status}`,
        {
          retryable: response.status >= 500,
        },
      );
    }
    await this.repo.setAccessToken(
      PROVIDER,
      await sealSecret(token.access_token, this.secret),
      new Date(Date.now() + Math.max(60, (token.expires_in ?? 3600) - 60) * 1000).toISOString(),
    );
    return token.access_token;
  }

  private async ensureFolder(accessToken: string): Promise<string> {
    if (this.config.folderId) return this.config.folderId;
    const record = await this.repo.get(PROVIDER);
    if (record?.folderId) {
      // Verify it still exists (the user may have deleted it).
      const check = await googleFetch(
        `${DRIVE_API}/files/${encodeURIComponent(record.folderId)}?fields=id,trashed`,
        { headers: { authorization: `Bearer ${accessToken}` } },
        'folder lookup',
      );
      if (check.ok) {
        const info = (await check.json()) as { id: string; trashed?: boolean };
        if (!info.trashed) return info.id;
      }
    }
    const name = this.config.folderName;
    const q = `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const search = await googleFetch(
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive&pageSize=5`,
      { headers: { authorization: `Bearer ${accessToken}` } },
      'folder search',
    );
    if (search.ok) {
      const found = (await search.json()) as { files?: Array<{ id: string; name: string }> };
      const existing = found.files?.[0];
      if (existing) {
        await this.repo.setFolder(PROVIDER, existing.id, existing.name);
        return existing.id;
      }
    }
    const create = await googleFetch(
      `${DRIVE_API}/files?fields=id,name`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
      },
      'folder create',
    );
    if (!create.ok) {
      throw new AppError(
        'DELIVERY_FAILED',
        `Could not create the Drive folder: ${await readError(create)}`,
      );
    }
    const folder = (await create.json()) as { id: string; name: string };
    await this.repo.setFolder(PROVIDER, folder.id, folder.name);
    this.logger.info('drive.folder_created', { folderId: folder.id });
    return folder.id;
  }

  private async fetchAccountEmail(accessToken: string): Promise<string | null> {
    try {
      const response = await googleFetch(
        `${DRIVE_API}/about?fields=user(emailAddress)`,
        { headers: { authorization: `Bearer ${accessToken}` } },
        'about',
      );
      if (!response.ok) return null;
      const about = (await response.json()) as { user?: { emailAddress?: string } };
      return about.user?.emailAddress ?? null;
    } catch {
      return null;
    }
  }
}

/** Builds a multipart/related body for the Drive upload endpoint. */
export function buildMultipartBody(
  metadata: Record<string, unknown>,
  data: Uint8Array,
  mediaType: string,
): { body: Uint8Array; contentType: string } {
  const boundary = `sk_${randomToken(12)}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${mediaType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(data, head.byteLength);
  body.set(tail, head.byteLength + data.byteLength);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export type { IntegrationRecord };
export { PROVIDER as GOOGLE_DRIVE_PROVIDER };

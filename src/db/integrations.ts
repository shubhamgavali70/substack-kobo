import { nowIso } from './time';

export type IntegrationProvider = 'google_drive';

export interface IntegrationRow {
  provider: IntegrationProvider;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_token_expires_at: string | null;
  scope: string | null;
  account_email: string | null;
  folder_id: string | null;
  folder_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationRecord {
  provider: IntegrationProvider;
  refreshTokenEnc: string;
  accessTokenEnc: string | null;
  accessTokenExpiresAt: string | null;
  scope: string | null;
  accountEmail: string | null;
  folderId: string | null;
  folderName: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: IntegrationRow): IntegrationRecord {
  return {
    provider: row.provider,
    refreshTokenEnc: row.refresh_token_enc,
    accessTokenEnc: row.access_token_enc,
    accessTokenExpiresAt: row.access_token_expires_at,
    scope: row.scope,
    accountEmail: row.account_email,
    folderId: row.folder_id,
    folderName: row.folder_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class IntegrationRepository {
  constructor(private readonly db: D1Database) {}

  async get(provider: IntegrationProvider): Promise<IntegrationRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM integrations WHERE provider = ?1')
      .bind(provider)
      .first<IntegrationRow>();
    return row ? mapRow(row) : null;
  }

  async upsert(input: {
    provider: IntegrationProvider;
    refreshTokenEnc: string;
    scope: string | null;
    accountEmail: string | null;
  }): Promise<void> {
    const now = nowIso();
    await this.db
      .prepare(
        `INSERT INTO integrations (provider, refresh_token_enc, scope, account_email, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(provider) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc,
           access_token_enc = NULL, access_token_expires_at = NULL, scope = excluded.scope,
           account_email = excluded.account_email, folder_id = NULL, updated_at = excluded.updated_at`,
      )
      .bind(input.provider, input.refreshTokenEnc, input.scope, input.accountEmail, now)
      .run();
  }

  async setAccessToken(
    provider: IntegrationProvider,
    accessTokenEnc: string,
    expiresAt: string,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE integrations SET access_token_enc = ?2, access_token_expires_at = ?3, updated_at = ?4 WHERE provider = ?1',
      )
      .bind(provider, accessTokenEnc, expiresAt, nowIso())
      .run();
  }

  async setFolder(
    provider: IntegrationProvider,
    folderId: string,
    folderName: string,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE integrations SET folder_id = ?2, folder_name = ?3, updated_at = ?4 WHERE provider = ?1',
      )
      .bind(provider, folderId, folderName, nowIso())
      .run();
  }

  async delete(provider: IntegrationProvider): Promise<void> {
    await this.db.prepare('DELETE FROM integrations WHERE provider = ?1').bind(provider).run();
  }
}

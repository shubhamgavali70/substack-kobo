-- Third-party integrations (one row per provider; single-user system).
CREATE TABLE IF NOT EXISTS integrations (
  provider TEXT PRIMARY KEY,
  -- AES-GCM encrypted refresh token (key derived from SESSION_SECRET).
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  access_token_expires_at TEXT,
  scope TEXT,
  account_email TEXT,
  folder_id TEXT,
  folder_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Delivery state of each article's EPUB in Google Drive.
ALTER TABLE articles ADD COLUMN drive_file_id TEXT;
ALTER TABLE articles ADD COLUMN drive_status TEXT CHECK (drive_status IN ('UPLOADED','FAILED'));
ALTER TABLE articles ADD COLUMN drive_error TEXT;
ALTER TABLE articles ADD COLUMN drive_uploaded_at TEXT;

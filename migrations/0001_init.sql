-- Articles: one row per explicitly submitted article (deduplicated by canonical_url).
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL,
  original_url TEXT NOT NULL,
  title TEXT,
  author TEXT,
  publication_name TEXT,
  published_at TEXT,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED','PROCESSING','READY','RETRYABLE_ERROR','CONTENT_UNAVAILABLE','AUTHORIZATION_REQUIRED','FAILED'
  )),
  error_code TEXT,
  error_message TEXT,
  content_hash TEXT,
  content_source TEXT NOT NULL DEFAULT 'public',
  epub_object_key TEXT,
  epub_size INTEGER,
  epub_filename TEXT,
  word_count INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_canonical_url ON articles (canonical_url);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles (status);
CREATE INDEX IF NOT EXISTS idx_articles_captured_at ON articles (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_search ON articles (title, author, publication_name);

-- Processing jobs: the D1-backed work queue. A job may be dispatched via
-- Cloudflare Queues or processed inline, but D1 is the source of truth for
-- claiming, retries and recovery.
CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','PROCESSING','WAITING_RETRY','COMPLETED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_article_id ON processing_jobs (article_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status_next ON processing_jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON processing_jobs (status, lease_expires_at);

-- Only one active (non-terminal) job per article at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_per_article
  ON processing_jobs (article_id) WHERE status IN ('QUEUED','PROCESSING','WAITING_RETRY');

-- Login sessions (opaque id stored; cookie carries id + HMAC signature).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Fixed-window rate limiting counters (login attempts, capture requests).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_ends_at TEXT NOT NULL
);

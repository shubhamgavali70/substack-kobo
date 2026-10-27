import type {
  ArticleRecord,
  ArticleStatus,
  ContentSourceKind,
  ErrorCode,
  LibraryFilters,
  Paginated,
} from '../types';
import { nowIso } from './time';

interface ArticleRow {
  id: string;
  canonical_url: string;
  original_url: string;
  title: string | null;
  author: string | null;
  publication_name: string | null;
  published_at: string | null;
  captured_at: string;
  status: ArticleStatus;
  error_code: ErrorCode | null;
  error_message: string | null;
  content_hash: string | null;
  content_source: ContentSourceKind;
  epub_object_key: string | null;
  epub_size: number | null;
  epub_filename: string | null;
  word_count: number | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ArticleRow): ArticleRecord {
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    originalUrl: row.original_url,
    title: row.title,
    author: row.author,
    publicationName: row.publication_name,
    publishedAt: row.published_at,
    capturedAt: row.captured_at,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    contentHash: row.content_hash,
    contentSource: row.content_source,
    epubObjectKey: row.epub_object_key,
    epubSize: row.epub_size,
    epubFilename: row.epub_filename,
    wordCount: row.word_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewArticle {
  id: string;
  canonicalUrl: string;
  originalUrl: string;
  contentSource: ContentSourceKind;
}

export interface ArticleMetadataUpdate {
  title: string;
  author: string | null;
  publicationName: string | null;
  publishedAt: string | null;
  wordCount: number;
}

export interface ArticleReadyUpdate {
  epubObjectKey: string;
  epubSize: number;
  epubFilename: string;
  contentHash: string;
}

export class ArticleRepository {
  constructor(private readonly db: D1Database) {}

  async insert(article: NewArticle): Promise<ArticleRecord> {
    const now = nowIso();
    await this.db
      .prepare(
        `INSERT INTO articles (id, canonical_url, original_url, status, content_source, captured_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'QUEUED', ?4, ?5, ?5, ?5)`,
      )
      .bind(article.id, article.canonicalUrl, article.originalUrl, article.contentSource, now)
      .run();
    const created = await this.findById(article.id);
    if (!created) throw new Error('Article insert did not persist');
    return created;
  }

  async findById(id: string): Promise<ArticleRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM articles WHERE id = ?1')
      .bind(id)
      .first<ArticleRow>();
    return row ? mapRow(row) : null;
  }

  async findByCanonicalUrl(canonicalUrl: string): Promise<ArticleRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM articles WHERE canonical_url = ?1')
      .bind(canonicalUrl)
      .first<ArticleRow>();
    return row ? mapRow(row) : null;
  }

  async setStatus(
    id: string,
    status: ArticleStatus,
    error: { code: ErrorCode; message: string } | null = null,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE articles SET status = ?2, error_code = ?3, error_message = ?4, updated_at = ?5 WHERE id = ?1',
      )
      .bind(id, status, error?.code ?? null, error?.message ?? null, nowIso())
      .run();
  }

  async setContentSource(id: string, source: ContentSourceKind): Promise<void> {
    await this.db
      .prepare('UPDATE articles SET content_source = ?2, updated_at = ?3 WHERE id = ?1')
      .bind(id, source, nowIso())
      .run();
  }

  async updateMetadata(id: string, meta: ArticleMetadataUpdate): Promise<void> {
    await this.db
      .prepare(
        `UPDATE articles SET title = ?2, author = ?3, publication_name = ?4, published_at = ?5, word_count = ?6, updated_at = ?7
         WHERE id = ?1`,
      )
      .bind(
        id,
        meta.title,
        meta.author,
        meta.publicationName,
        meta.publishedAt,
        meta.wordCount,
        nowIso(),
      )
      .run();
  }

  /** Updates the canonical URL; returns false if another article already owns it. */
  async updateCanonicalUrl(id: string, canonicalUrl: string): Promise<boolean> {
    const existing = await this.findByCanonicalUrl(canonicalUrl);
    if (existing && existing.id !== id) return false;
    await this.db
      .prepare('UPDATE articles SET canonical_url = ?2, updated_at = ?3 WHERE id = ?1')
      .bind(id, canonicalUrl, nowIso())
      .run();
    return true;
  }

  async markReady(id: string, update: ArticleReadyUpdate): Promise<void> {
    await this.db
      .prepare(
        `UPDATE articles SET status = 'READY', error_code = NULL, error_message = NULL,
           epub_object_key = ?2, epub_size = ?3, epub_filename = ?4, content_hash = ?5, updated_at = ?6
         WHERE id = ?1`,
      )
      .bind(
        id,
        update.epubObjectKey,
        update.epubSize,
        update.epubFilename,
        update.contentHash,
        nowIso(),
      )
      .run();
  }

  async clearEpub(id: string): Promise<void> {
    await this.db
      .prepare(
        'UPDATE articles SET epub_object_key = NULL, epub_size = NULL, epub_filename = NULL, updated_at = ?2 WHERE id = ?1',
      )
      .bind(id, nowIso())
      .run();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM articles WHERE id = ?1').bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async list(filters: LibraryFilters): Promise<Paginated<ArticleRecord>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.status) {
      params.push(filters.status);
      where.push(`status = ?${params.length}`);
    }
    if (filters.query) {
      const like = `%${escapeLike(filters.query)}%`;
      params.push(like);
      const idx = params.length;
      where.push(
        `(title LIKE ?${idx} ESCAPE '\\' OR author LIKE ?${idx} ESCAPE '\\' OR publication_name LIKE ?${idx} ESCAPE '\\' OR canonical_url LIKE ?${idx} ESCAPE '\\')`,
      );
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM articles ${whereSql}`)
      .bind(...params)
      .first<{ total: number }>();
    const total = countRow?.total ?? 0;
    const offset = (filters.page - 1) * filters.pageSize;
    const rows = await this.db
      .prepare(
        `SELECT * FROM articles ${whereSql} ORDER BY captured_at DESC, id DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
      )
      .bind(...params, filters.pageSize, offset)
      .all<ArticleRow>();
    return {
      items: rows.results.map(mapRow),
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    };
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.db
      .prepare('SELECT status, COUNT(*) AS count FROM articles GROUP BY status')
      .all<{ status: string; count: number }>();
    const out: Record<string, number> = {};
    for (const row of rows.results) out[row.status] = row.count;
    return out;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

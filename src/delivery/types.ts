import type { ArticleRecord } from '../types';

/**
 * Delivery adapters move a finished EPUB to the reader. Only direct download is
 * implemented; cloud-folder delivery (Google Drive / Dropbox, which Kobo can
 * sync from) and any future wireless sync are separate adapters that would
 * plug in here without touching capture or processing.
 */
export interface DeliveryAdapter {
  readonly id: 'direct-download' | 'google-drive' | 'dropbox';
  readonly label: string;
  /** Produces the HTTP response (or performs the upload) for a READY article. */
  deliver(article: ArticleRecord, epub: R2ObjectBody): Promise<Response>;
}

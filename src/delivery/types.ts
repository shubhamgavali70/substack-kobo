import type { ArticleRecord } from '../types';

/**
 * Delivery adapters move a finished EPUB to the reader. Direct download is the
 * baseline; Google Drive upload (see googleDrive.ts / driveDelivery.ts) is an
 * optional push adapter the Kobo can sync from. Dropbox or any future wireless
 * sync would plug in the same way without touching capture or processing.
 */
export interface DeliveryAdapter {
  readonly id: 'direct-download' | 'google-drive' | 'dropbox';
  readonly label: string;
  /** Produces the HTTP response (or performs the upload) for a READY article. */
  deliver(article: ArticleRecord, epub: R2ObjectBody): Promise<Response>;
}

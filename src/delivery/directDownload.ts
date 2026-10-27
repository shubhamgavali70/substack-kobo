import { contentDisposition } from '../epub/filename';
import type { ArticleRecord } from '../types';
import type { DeliveryAdapter } from './types';

export class DirectDownloadDelivery implements DeliveryAdapter {
  readonly id = 'direct-download' as const;
  readonly label = 'Direct download';

  async deliver(article: ArticleRecord, epub: R2ObjectBody): Promise<Response> {
    const filename = article.epubFilename ?? `article-${article.id.slice(0, 8)}.epub`;
    const headers = new Headers({
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(epub.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (epub.httpEtag) headers.set('ETag', epub.httpEtag);
    return new Response(epub.body, { status: 200, headers });
  }
}

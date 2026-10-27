/**
 * Builds stable, filesystem-safe EPUB filenames from article metadata.
 * Unicode letters are preserved (Kobo handles UTF-8 names); characters that
 * are reserved on common filesystems or dangerous in headers are removed.
 */

const MAX_LENGTH = 120;

export function sanitizeFilenamePart(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control chars from filenames
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[\\/:*?"<>|#%&{}$!'@+`=;,]/g, ' ')
      .replace(/\.{2,}/g, '.')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
  );
}

export function buildEpubFilename(
  title: string | null,
  publication: string | null,
  fallbackId: string,
): string {
  const parts = [publication, title]
    .map((p) => (p ? sanitizeFilenamePart(p) : ''))
    .filter((p) => p.length > 0);
  let base = parts.join(' - ');
  if (base.length === 0) base = `article-${fallbackId.slice(0, 8)}`;
  if (base.length > MAX_LENGTH) base = `${base.slice(0, MAX_LENGTH).trimEnd()}`;
  return `${base}.epub`;
}

/** ASCII-only fallback for the plain `filename=` parameter of Content-Disposition. */
export function asciiFilename(filename: string): string {
  const ascii = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\]/g, '')
    .trim();
  return ascii.length > 5 ? ascii : 'article.epub';
}

export function contentDisposition(filename: string): string {
  const ascii = asciiFilename(filename);
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

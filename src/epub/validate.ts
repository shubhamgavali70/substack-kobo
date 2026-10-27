import { unzipSync } from 'fflate';

/**
 * Lightweight structural validation of an EPUB container. This is not a
 * replacement for EPUBCheck (run `pnpm run epub:check` for that); it catches
 * the packaging mistakes that break e-readers: wrong mimetype entry, missing
 * container.xml/OPF, manifest entries pointing to missing files.
 */
export interface EpubValidationResult {
  ok: boolean;
  errors: string[];
  files: string[];
  opfPath: string | null;
}

export function validateEpubStructure(bytes: Uint8Array): EpubValidationResult {
  const errors: string[] = [];
  const decoder = new TextDecoder();

  // First local file header must be the stored "mimetype" entry.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 30 || view.getUint32(0, true) !== 0x04034b50) {
    errors.push('Not a ZIP archive');
    return { ok: false, errors, files: [], opfPath: null };
  }
  const method = view.getUint16(8, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const firstName = decoder.decode(bytes.subarray(30, 30 + nameLength));
  if (firstName !== 'mimetype') errors.push(`First entry must be "mimetype", found "${firstName}"`);
  if (method !== 0) errors.push('mimetype entry must be stored (uncompressed)');
  if (extraLength !== 0) errors.push('mimetype entry must not have an extra field');
  const mimetypeContent = decoder.decode(
    bytes.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + 20),
  );
  if (mimetypeContent !== 'application/epub+zip')
    errors.push(`mimetype content is "${mimetypeContent}"`);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    errors.push(`ZIP could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, errors, files: [], opfPath: null };
  }
  const files = Object.keys(entries);

  const container = entries['META-INF/container.xml'];
  let opfPath: string | null = null;
  if (!container) {
    errors.push('META-INF/container.xml is missing');
  } else {
    const match = /full-path="([^"]+)"/.exec(decoder.decode(container));
    opfPath = match?.[1] ?? null;
    if (!opfPath) errors.push('container.xml does not declare a rootfile');
  }

  if (opfPath) {
    const opf = entries[opfPath];
    if (!opf) {
      errors.push(`OPF ${opfPath} is missing`);
    } else {
      const opfText = decoder.decode(opf);
      const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
      for (const match of opfText.matchAll(/<item\s[^>]*href="([^"]+)"/g)) {
        const href = decodeURIComponent(match[1] ?? '');
        if (!entries[dir + href]) errors.push(`Manifest item "${href}" is not in the archive`);
      }
      if (!/<dc:identifier/.test(opfText)) errors.push('OPF lacks dc:identifier');
      if (!/<dc:title/.test(opfText)) errors.push('OPF lacks dc:title');
      if (!/<dc:language/.test(opfText)) errors.push('OPF lacks dc:language');
      if (!/dcterms:modified/.test(opfText)) errors.push('OPF lacks dcterms:modified');
      if (!/properties="nav"/.test(opfText)) errors.push('OPF lacks a nav document');
    }
  }

  return { ok: errors.length === 0, errors, files, opfPath };
}

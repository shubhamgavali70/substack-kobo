import { zipSync } from 'fflate';
import { AppError, type DownloadedImage, type NormalizedArticle } from '../types';
import { generateCoverSvg } from './cover';
import { buildEpubFilename } from './filename';
import { EPUB_STYLESHEET } from './styles';
import { formatHumanDate, w3cdtf, xmlAttr, xmlText } from './xml';

/**
 * EPUB 3.3 packaging implemented directly on top of fflate (verified to run
 * in the Workers runtime). No library with filesystem assumptions is used.
 *
 * Package layout:
 *   mimetype                     (first entry, stored/uncompressed)
 *   META-INF/container.xml
 *   OEBPS/content.opf
 *   OEBPS/nav.xhtml
 *   OEBPS/cover.xhtml, cover.svg
 *   OEBPS/article.xhtml
 *   OEBPS/styles.css
 *   OEBPS/images/<id>.<ext>
 */

export interface EpubOptions {
  /** Stable identifier for dc:identifier (the article id). */
  identifier: string;
  /** Injected clock for deterministic tests. */
  now?: Date;
  generatorName?: string;
}

export interface GeneratedEpub {
  bytes: Uint8Array;
  filename: string;
  mediaType: 'application/epub+zip';
  size: number;
  imageCount: number;
}

interface TocEntry {
  id: string;
  title: string;
  level: 2 | 3;
}

export function generateEpub(
  article: NormalizedArticle,
  images: DownloadedImage[],
  options: EpubOptions,
): GeneratedEpub {
  try {
    const now = options.now ?? new Date();
    const encoder = new TextEncoder();
    const title = article.title.trim() || 'Untitled article';
    const language = article.language || 'en';

    const { xhtml: bodyXhtml, toc } = prepareBody(article.contentXhtml, images);
    const coverSvg = generateCoverSvg(title, article.publicationName, article.author);

    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 | 6 }]> = {};
    files.mimetype = [encoder.encode('application/epub+zip'), { level: 0 }];
    files['META-INF/container.xml'] = encoder.encode(containerXml());
    files['OEBPS/content.opf'] = encoder.encode(
      packageOpf(article, title, language, images, options.identifier, now, toc),
    );
    files['OEBPS/nav.xhtml'] = encoder.encode(navXhtml(title, language, toc));
    files['OEBPS/cover.xhtml'] = encoder.encode(coverXhtml(title, language));
    files['OEBPS/cover.svg'] = encoder.encode(coverSvg);
    files['OEBPS/article.xhtml'] = encoder.encode(
      articleXhtml(article, title, language, bodyXhtml, now, options.generatorName),
    );
    files['OEBPS/styles.css'] = encoder.encode(EPUB_STYLESHEET);
    for (const image of images) {
      // Images are already compressed; store them to save CPU time.
      files[`OEBPS/images/${image.filename}`] = [image.data, { level: 0 }];
    }

    const bytes = zipSync(files, { level: 6, mtime: now });
    return {
      bytes,
      filename: buildEpubFilename(title, article.publicationName, options.identifier),
      mediaType: 'application/epub+zip',
      size: bytes.byteLength,
      imageCount: images.length,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('EPUB_GENERATION_FAILED', 'Failed to build the EPUB package.', {
      cause: error,
    });
  }
}

/**
 * Finalizes the sanitized body: maps image placeholders to real files, drops
 * images that could not be downloaded and assigns ids to headings for the TOC.
 */
function prepareBody(xhtml: string, images: DownloadedImage[]): { xhtml: string; toc: TocEntry[] } {
  const byId = new Map(images.map((img) => [img.id, img]));
  let out = xhtml.replace(
    /<img src="images\/(img\d+)" alt="([^"]*)"\/>/g,
    (_match, id: string, alt: string) => {
      const image = byId.get(id);
      // Inline so it is valid wherever the <img> was (inside <p>, <figure>, ...).
      if (!image)
        return alt ? `<span class="missing-image"><em>[Image unavailable: ${alt}]</em></span>` : '';
      return `<img src="images/${image.filename}" alt="${alt}"/>`;
    },
  );

  const toc: TocEntry[] = [];
  let counter = 0;
  out = out.replace(
    /<(h[23])( id="([^"]*)")?>([\s\S]*?)<\/\1>/g,
    (_m, tag: string, _idAttr, existingId: string | undefined, inner: string) => {
      counter += 1;
      const id = existingId ?? `sec-${counter}`;
      const text = inner
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 0)
        toc.push({
          id,
          title: decodeBasicEntities(text).slice(0, 200),
          level: tag === 'h2' ? 2 : 3,
        });
      return `<${tag} id="${id}">${inner}</${tag}>`;
    },
  );
  return { xhtml: out, toc };
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function packageOpf(
  article: NormalizedArticle,
  title: string,
  language: string,
  images: DownloadedImage[],
  identifier: string,
  now: Date,
  toc: TocEntry[],
): string {
  const meta: string[] = [
    `<dc:identifier id="pub-id">urn:uuid:${xmlText(identifier)}</dc:identifier>`,
    `<dc:title id="title">${xmlText(title)}</dc:title>`,
    `<dc:language>${xmlText(language)}</dc:language>`,
    `<meta property="dcterms:modified">${w3cdtf(now)}</meta>`,
  ];
  if (article.author) {
    meta.push(`<dc:creator id="creator">${xmlText(article.author)}</dc:creator>`);
    meta.push(`<meta refines="#creator" property="role" scheme="marc:relators">aut</meta>`);
  }
  if (article.publicationName)
    meta.push(`<dc:publisher>${xmlText(article.publicationName)}</dc:publisher>`);
  if (article.publishedAt) meta.push(`<dc:date>${w3cdtf(new Date(article.publishedAt))}</dc:date>`);
  meta.push(`<dc:source>${xmlText(article.sourceUrl)}</dc:source>`);
  if (article.description)
    meta.push(`<dc:description>${xmlText(article.description)}</dc:description>`);
  // EPUB 2 style cover hint, still read by Kobo and many other readers.
  meta.push(`<meta name="cover" content="cover-image"/>`);

  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>`,
    `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="css" href="styles.css" media-type="text/css"/>`,
  ];
  for (const image of images) {
    manifest.push(
      `<item id="${xmlAttr(image.id)}" href="images/${xmlAttr(image.filename)}" media-type="${xmlAttr(image.mediaType)}"/>`,
    );
  }
  void toc;

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${xmlAttr(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${meta.join('\n    ')}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine>
    <itemref idref="cover" linear="yes"/>
    <itemref idref="article"/>
  </spine>
</package>
`;
}

function navXhtml(title: string, language: string, toc: TocEntry[]): string {
  const headingEntries = toc.filter((entry) => entry.level === 2);
  let tocList: string;
  if (headingEntries.length >= 2) {
    tocList = `<ol>
      <li><a href="article.xhtml">${xmlText(title)}</a>
        <ol>
          ${headingEntries.map((e) => `<li><a href="article.xhtml#${xmlAttr(e.id)}">${xmlText(e.title)}</a></li>`).join('\n          ')}
        </ol>
      </li>
    </ol>`;
  } else {
    tocList = `<ol>
      <li><a href="article.xhtml">${xmlText(title)}</a></li>
    </ol>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xmlAttr(language)}" lang="${xmlAttr(language)}">
<head>
  <meta charset="utf-8"/>
  <title>Contents</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    ${tocList}
  </nav>
  <nav epub:type="landmarks" hidden="hidden">
    <ol>
      <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>
      <li><a epub:type="bodymatter" href="article.xhtml">Start of article</a></li>
    </ol>
  </nav>
</body>
</html>
`;
}

function coverXhtml(title: string, language: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xmlAttr(language)}" lang="${xmlAttr(language)}">
<head>
  <meta charset="utf-8"/>
  <title>Cover</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body epub:type="cover">
  <div class="cover">
    <img src="cover.svg" alt="${xmlAttr(title)}"/>
  </div>
</body>
</html>
`;
}

function articleXhtml(
  article: NormalizedArticle,
  title: string,
  language: string,
  bodyXhtml: string,
  now: Date,
  generatorName = 'Substack to Kobo',
): string {
  const byline = [article.author, article.publicationName]
    .filter((v): v is string => !!v)
    .join(' · ');
  const published = formatHumanDate(article.publishedAt, language);
  const header: string[] = [`<h1>${xmlText(title)}</h1>`];
  if (article.description) header.push(`<p class="subtitle">${xmlText(article.description)}</p>`);
  if (byline) header.push(`<p class="byline">${xmlText(byline)}</p>`);
  if (published) header.push(`<p class="dateline">Published ${xmlText(published)}</p>`);
  header.push(`<p class="source"><a href="${xmlAttr(article.sourceUrl)}">Read on the web</a></p>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xmlAttr(language)}" lang="${xmlAttr(language)}">
<head>
  <meta charset="utf-8"/>
  <title>${xmlText(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body epub:type="bodymatter">
  <section class="article-header">
    ${header.join('\n    ')}
  </section>
  <section class="article-body">
${bodyXhtml}
  </section>
  <section class="article-footer">
    <hr/>
    <p>Source: <a href="${xmlAttr(article.sourceUrl)}">${xmlText(article.sourceUrl)}</a></p>
    <p>Captured ${xmlText(formatHumanDate(now.toISOString(), language) ?? '')} with ${xmlText(generatorName)}. ${
      article.source === 'manual' ? 'Content supplied by manual import.' : ''
    }</p>
  </section>
</body>
</html>
`;
}

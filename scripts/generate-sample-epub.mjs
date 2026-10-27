#!/usr/bin/env node
// Builds a sample EPUB from the test fixture using the real extractor and
// generator (bundled for Node with esbuild), so it can be inspected or passed
// to EPUBCheck. Output: tmp/sample.epub
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'tmp');
await mkdir(outDir, { recursive: true });

const entry = `
  export { extractSubstackArticle } from '${resolve(root, 'src/acquisition/extract.ts')}';
  export { generateEpub } from '${resolve(root, 'src/epub/generate.ts')}';
`;
const bundlePath = resolve(outDir, 'epub-bundle.mjs');
await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  outfile: bundlePath,
  logLevel: 'error',
});

const { extractSubstackArticle, generateEpub } = await import(bundlePath);
const html = await readFile(resolve(root, 'test/fixtures/free-post.html'), 'utf8');
const { article } = extractSubstackArticle(
  html,
  'https://quietdesk.substack.com/p/why-slow-reading-wins',
);

// 1x1 PNG stands in for the article image.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const epub = generateEpub(
  article,
  [{ id: 'img001', data: new Uint8Array(png), mediaType: 'image/png', filename: 'img001.png' }],
  {
    identifier: '11111111-2222-4333-8444-555555555555',
  },
);
const target = resolve(outDir, 'sample.epub');
await writeFile(target, epub.bytes);
console.log(`Wrote ${target} (${epub.size} bytes, filename "${epub.filename}")`);

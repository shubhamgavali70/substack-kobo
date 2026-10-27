#!/usr/bin/env node
// Validates an EPUB with the official W3C EPUBCheck (requires Java 11+).
// Usage: node scripts/epubcheck.mjs [path/to/file.epub]
// Without an argument it generates tmp/sample.epub first.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const jar = resolve(
  dirname(require.resolve('epubcheck-static/package.json')),
  'vendor/epubcheck.jar',
);

let target = process.argv[2];
if (!target) {
  const gen = spawnSync(process.execPath, [resolve(root, 'scripts/generate-sample-epub.mjs')], {
    stdio: 'inherit',
  });
  if (gen.status !== 0) process.exit(gen.status ?? 1);
  target = resolve(root, 'tmp/sample.epub');
}
if (!existsSync(target)) {
  console.error(`File not found: ${target}`);
  process.exit(1);
}
const java = spawnSync('java', ['-jar', jar, target], {
  stdio: 'inherit',
  env: { ...process.env, JAVA_TOOL_OPTIONS: '' },
});
if (java.error) {
  console.error('Java is required to run EPUBCheck: install a JRE (11+) and retry.');
  process.exit(1);
}
process.exit(java.status ?? 1);

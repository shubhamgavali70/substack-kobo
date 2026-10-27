#!/usr/bin/env node
// Prints strong random values for AUTH_PASSWORD, SESSION_SECRET and API_TOKEN.
import { randomBytes } from 'node:crypto';

const b64url = (bytes) =>
  bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log(
  '# Paste into .dev.vars for local development, or set with `wrangler secret put <NAME>`:',
);
console.log(`AUTH_PASSWORD=${b64url(randomBytes(24))}`);
console.log(`SESSION_SECRET=${b64url(randomBytes(48))}`);
console.log(`API_TOKEN=${b64url(randomBytes(32))}`);

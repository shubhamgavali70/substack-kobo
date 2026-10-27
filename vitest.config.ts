import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Test-only values. Production values come from Cloudflare secrets.
          bindings: {
            TEST_MIGRATIONS: migrations,
            AUTH_PASSWORD: 'test-password-please-change',
            SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
            API_TOKEN: 'test-api-token-0123456789',
            ALLOWED_HOSTS: 'custom.example.org',
            ALLOWED_IMAGE_HOSTS: 'images.example.org',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      silent: 'passed-only' as const,
    },
  };
});

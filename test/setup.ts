import { applyD1Migrations, env } from 'cloudflare:test';

// Each test file gets isolated storage; apply the real migrations so tests
// exercise the same schema that ships to production.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);

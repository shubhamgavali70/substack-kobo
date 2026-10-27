# Operations: secrets, backups, migration, troubleshooting

## Secrets and rotation

| Secret | Purpose | Rotation effect |
|--------|---------|-----------------|
| `AUTH_PASSWORD` | Login password | New logins need the new password; existing sessions stay valid until they expire or `SESSION_SECRET` rotates |
| `SESSION_SECRET` | HMAC key for session cookies (≥ 32 chars) | All sessions are invalidated immediately |
| `API_TOKEN` | Optional bearer token for Shortcuts/automations | Old token stops working immediately; update the Shortcut |

Rotate with:

```bash
pnpm run secret:generate            # prints fresh values
wrangler secret put SESSION_SECRET  # paste the value when prompted
wrangler secret put AUTH_PASSWORD
wrangler secret put API_TOKEN       # or: wrangler secret delete API_TOKEN to disable token auth
```

To force-logout every browser without rotating the key, run `wrangler d1 execute substack-kobo-db --remote --command "DELETE FROM sessions"`.

Optionally put Cloudflare Access (Zero Trust) in front of the Worker hostname for a second factor; the application's own login still applies.

## Backups

Metadata (D1):

```bash
wrangler d1 export substack-kobo-db --remote --output backup/substack-kobo-$(date +%F).sql
```

Files (R2): use `rclone` with the Cloudflare R2 S3-compatible endpoint, or Wrangler for small libraries:

```bash
wrangler r2 object get substack-kobo-epubs/<key> --file out.epub   # single object
# or with rclone configured for R2:
rclone sync r2:substack-kobo-epubs backup/epubs
```

The `articles` table records `epub_object_key` for every READY article, so a D1 export plus an R2 copy is a complete backup.

## Recovery

1. Recreate the resources (see README: D1 database, R2 bucket, queue) and update `wrangler.jsonc` with the new D1 id.
2. Restore metadata: `wrangler d1 execute substack-kobo-db --remote --file backup/substack-kobo-<date>.sql`.
3. Restore files: `rclone sync backup/epubs r2:substack-kobo-epubs`.
4. Set secrets and deploy.

Any article whose EPUB is missing from R2 can be regenerated from the library with **Retry** (public posts) or **Manual import** (subscriber-only posts).

## Exporting or migrating the library

* **EPUBs**: sync the R2 bucket to local disk with rclone (above). File names inside the bucket are ASCII-safe; the human-readable name is in `articles.epub_filename`.
* **Catalogue**: `wrangler d1 export … --output library.sql`, or a CSV via `wrangler d1 execute substack-kobo-db --remote --json --command "SELECT title, author, publication_name, published_at, captured_at, canonical_url, epub_filename FROM articles WHERE status='READY'"`.
* **Moving to another Cloudflare account**: export D1 and R2 as above, create resources in the new account, import, set secrets, deploy. Session rows can be dropped.

## Scheduled maintenance

The cron trigger (`* * * * *`) runs `runScheduledMaintenance`: recovers stale leases (jobs stuck in PROCESSING past 3 minutes), dispatches due retries (≤ 10 per run via Queues, ≤ 3 inline), prunes expired sessions and rate-limit counters. If minute-level crons are not desirable, change the schedule in `wrangler.jsonc`; retries will simply wait longer.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| Login returns 500 "Authentication is not configured" | Secrets missing | `wrangler secret put AUTH_PASSWORD` / `SESSION_SECRET`; locally, create `.dev.vars` |
| 400 `HOST_NOT_ALLOWED` on submit | Publication uses a custom domain | Add the host to `ALLOWED_HOSTS` in `wrangler.jsonc` (comma-separated) and redeploy |
| Article ends in `CONTENT_UNAVAILABLE` with `HOST_NOT_ALLOWED` | The post redirected to a custom domain | Same as above |
| `AUTHORIZATION_REQUIRED` | Paywalled or login-protected post | Use manual import with content you are entitled to |
| `RETRYABLE_ERROR` that never resolves | Publication returns 5xx/429 or R2 failing | Check `wrangler tail` for `job.retry_scheduled` events; retries stop after 5 attempts |
| Articles stay `QUEUED` | Queue consumer not deployed / cron not firing | `wrangler deploy` again; check **Workers › Triggers**; without Queues, inline processing needs the request to finish normally |
| `wrangler deploy` complains about Queues | Queues not enabled, or daily free-tier operations exhausted | Enable Queues in the dashboard, or remove the `queues` block from `wrangler.jsonc`; the app falls back to inline + cron |
| Processing exceeds CPU limits | Free plan CPU budget is very small | Use Workers Paid (30 s default); raise with `limits.cpu_ms` in `wrangler.jsonc` if needed |
| Images missing in EPUB | Host not in `ALLOWED_IMAGE_HOSTS`, too large, or unsupported type | Extend the allowlist or set `INCLUDE_IMAGES=false` for text-only EPUBs |
| EPUB rejected by a reader | Validate with `pnpm run epub:check path/to/file.epub` | Open an issue with the EPUBCheck output |

Logs: `wrangler tail --format pretty` streams structured JSON events. Every API response has an `X-Request-Id` header that matches the `requestId` field in logs.

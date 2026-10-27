# Saving articles from your phone

Only links you explicitly submit are processed. Bookmarking inside the Substack app does not notify this system; you still need to share the link.

## Android

**Recommended: install the capture page as an app (Share Target).**

1. Open `https://<your-worker>/` in Chrome and sign in.
2. Chrome menu › **Add to Home screen** (or **Install app**).
3. In the Substack app, open a post › Share › choose **To Kobo**. The capture page opens with the link pre-filled and submits it automatically. Progress is shown live and the download button appears when the EPUB is ready.

If the app does not appear in the share sheet, open it once from the home screen first; Android registers share targets after the first launch.

**Alternative:** Share › **Copy link**, open the capture page, paste, submit.

## iOS / iPadOS

iOS does not support web share targets, so use one of these:

**Option A: copy and paste.** Share › **Copy Link** in the Substack app, open the capture page (add it to the Home Screen from Safari's share sheet for one-tap access), paste, submit.

**Option B: a Shortcut using the API token (one tap from the share sheet).**

1. Create an API token: `pnpm run secret:generate` and set it with `wrangler secret put API_TOKEN`.
2. In Shortcuts, create a new shortcut, enable **Show in Share Sheet**, and set accepted types to **URLs** and **Text**.
3. Add actions:
   * **Get URLs from Input** (Shortcut Input)
   * **Get Contents of URL**: `https://<your-worker>/api/articles`, Method **POST**, Headers `Authorization: Bearer <token>`, Request Body **JSON** with field `url` = the URL from the previous step.
   * **Get Dictionary Value** `message` from Contents of URL, then **Show Notification**.
4. Share a post from Substack › tap the shortcut.

The response returns `202` with `jobId` when queued, or `200` with `duplicate: true` when the link was already saved. Open the library later to download.

## API summary

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/login` | `{ "password": "…" }` → session cookie |
| POST | `/api/auth/logout` | Invalidate session |
| GET | `/api/auth/me` | Check authentication |
| POST | `/api/articles` | `{ "url": "…", "content"?: {…} }` → 202 queued / 200 duplicate |
| GET | `/api/articles?q=&status=&page=&pageSize=` | Paginated library |
| GET | `/api/articles/:id` | Article status and metadata |
| POST | `/api/articles/:id/retry` | Re-queue a failed article |
| POST | `/api/articles/:id/import` | Supply content manually (`html` or `text`, optional `title`, `author`, `publicationName`, `publishedAt`, `language`) |
| DELETE | `/api/articles/:id` | Delete article and EPUB |
| GET | `/api/articles/:id/download` | EPUB file (`application/epub+zip`) |
| GET | `/api/health` | Liveness |

Authentication is either the session cookie (browser) or `Authorization: Bearer <API_TOKEN>` (automations). Cookie-authenticated state-changing requests must come from the same origin.

## Manual import for subscriber-only posts

When a post is paywalled, the article ends in **Needs import** (`AUTHORIZATION_REQUIRED`). The system never bypasses paywalls. If you are a paying subscriber you receive the full post by email and can read it in the app; paste that text or HTML into the **Manual import** panel on the capture page (or send it to `/api/articles/:id/import`). The EPUB is then built from the content you provided, with the original URL kept as the source.

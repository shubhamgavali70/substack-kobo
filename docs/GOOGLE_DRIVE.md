# Google Drive delivery

With Google Drive connected, every EPUB that finishes processing is uploaded to your Drive automatically, and your Kobo pulls it from there over Wi-Fi. No manual download is needed.

```
Substack post → Worker builds EPUB → R2 (library copy) → Google Drive folder → Kobo (More › Google Drive / Sync)
```

The integration uses Google's documented OAuth 2.0 and Drive v3 REST APIs. Tokens are stored encrypted in D1 (AES-GCM, key derived from `SESSION_SECRET`).

## 1. Create a Google OAuth client (one-time, about 5 minutes)

1. Open https://console.cloud.google.com/ and create a project (any name, e.g. "Substack to Kobo").
2. **APIs & Services › Library**: search for **Google Drive API** and enable it.
3. **APIs & Services › OAuth consent screen** (Google Auth Platform): choose **External**, fill in the app name and your email, and add your own Google account under **Test users**.
   * Scopes: none need to be added manually; the app requests `drive.file` at connect time.
   * Publishing status: while the app is in **Testing**, Google expires refresh tokens after 7 days, which means reconnecting weekly. To avoid that, click **Publish app**. For the `drive.file` scope no verification is required; you will see an "unverified app" warning once during connection, which is expected for a personal app.
4. **APIs & Services › Credentials › Create credentials › OAuth client ID**:
   * Application type: **Web application**
   * Authorized redirect URI: `https://<your-worker-host>/api/google/callback`
     (for local development also add `http://localhost:8787/api/google/callback`)
5. Copy the **Client ID** and **Client secret**.

## 2. Give the Worker the credentials

GitHub Actions deploy: add repository secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; the workflow uploads them on the next run.

Manual: `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put GOOGLE_CLIENT_SECRET`.

Local development: put them in `.dev.vars`.

## 3. Connect

Open the library page. The **Google Drive delivery** card shows *Not connected*; press **Connect Google Drive**, sign in with the Google account your Kobo uses, and approve. You are returned to the library with the card showing *Connected as you@gmail.com*.

From then on:

* Every article that reaches READY is uploaded to the folder **Substack to Kobo** in your Drive (created on first upload).
* Articles converted before you connected can be pushed with **Send to Drive** on their library card.
* Retrying an article replaces the existing Drive file instead of creating a duplicate.
* Deleting an article also deletes its Drive file (best effort). Books already downloaded to the Kobo stay on the device.
* Upload failures never block the EPUB: the article stays READY with a "Drive upload failed" note and a **Re-send to Drive** button.

## 4. On the Kobo

1. Firmware 4.37 or newer (More › Settings › Device information; update via Sync).
2. More › **Google Drive**, follow the sign-in / code flow using the same Google account.
3. Tap **Sync** on the home screen. Drive books appear under **My Books**; open the ⋮ menu to **Download all**, or tap a book to download it.

Kobo's help centre describes Drive books appearing in My Books after a sync. If your firmware only picks up a specific folder (some guides mention an auto-created "Rakuten Kobo" folder), switch the integration to target that folder:

1. In Drive, open the folder and copy the id from the URL (`https://drive.google.com/drive/folders/<id>`).
2. In `wrangler.jsonc` set `"GOOGLE_DRIVE_FOLDER_ID": "<id>"` and `"GOOGLE_DRIVE_SCOPE": "full"`, deploy, then **Disconnect** and **Connect** again so Google grants the broader scope. The `full` scope is a restricted Google scope: for your own personal OAuth client the unverified-app warning still lets you proceed, but prefer the default `file` scope whenever your Kobo shows the app folder.

## Configuration reference

| Setting | Where | Default | Meaning |
|---------|-------|---------|---------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | secrets | unset (integration disabled) | OAuth client credentials |
| `GOOGLE_DRIVE_FOLDER_NAME` | var | `Substack to Kobo` | Folder the app creates in your Drive root (`file` scope) |
| `GOOGLE_DRIVE_FOLDER_ID` | var | empty | Upload into this existing folder instead (needs `full` scope) |
| `GOOGLE_DRIVE_SCOPE` | var | `file` | `file` = only files the app created; `full` = whole Drive |

## Security notes

* Scope is `drive.file` by default: the app can see and change only files it created.
* The refresh token is encrypted at rest; rotating `SESSION_SECRET` makes it unreadable and the card shows *Reconnect needed*.
* **Disconnect** revokes the token at Google and deletes it from D1.
* The OAuth callback requires your normal login session plus a signed, 10-minute state cookie, so a third party cannot bind their Google account to your library.
* Google API hosts are fixed constants in the code; user-supplied URLs never reach them.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Card says *Not configured* | Secrets missing; add them and redeploy |
| Google shows `redirect_uri_mismatch` | The redirect URI in the OAuth client must be exactly `https://<host>/api/google/callback` |
| `Google did not return a refresh token` | Remove the app at https://myaccount.google.com/permissions and connect again |
| Uploads work for a week, then fail with *Reconnect needed* / `invalid_grant` | The OAuth app is in Testing mode; publish it (step 1.3) and reconnect |
| Books do not show on the Kobo | Make sure the Kobo is linked to the same Google account and tap Sync; otherwise use the folder-id mode above |

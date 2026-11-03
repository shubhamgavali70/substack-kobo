import { type Context, Hono } from 'hono';
import type { AppBindings } from '../app';
import { base64UrlEncode, hmacSha256, timingSafeEqualBytes } from '../auth/crypto';
import { authenticate, isSecureRequest, requireApiAuth } from '../auth/middleware';
import { parseCookies } from '../auth/session';
import { buildAuthorizationUrl, GoogleDriveClient, newOauthState } from '../delivery';
import { AppError } from '../types';

/**
 * Google Drive connection management.
 *
 *   GET  /api/google/status     connection state for the UI
 *   GET  /api/google/connect    redirects to Google's consent screen
 *   GET  /api/google/callback   OAuth redirect target (must match the client config)
 *   DELETE /api/google          revoke and forget the connection
 *
 * The OAuth state is a random nonce kept in a short-lived signed cookie; the
 * callback also requires the normal login session, so only the signed-in user
 * can bind a Google account.
 */
export const googleRoutes = new Hono<AppBindings>();

const STATE_COOKIE = 'sk_oauth_state';
const STATE_TTL_SECONDS = 10 * 60;

async function signState(secret: string, state: string, expires: number): Promise<string> {
  const sig = base64UrlEncode(await hmacSha256(secret, `${state}.${expires}`));
  return `${state}.${expires}.${sig}`;
}

async function verifyStateCookie(
  secret: string,
  cookie: string | undefined,
  state: string,
): Promise<boolean> {
  if (!cookie) return false;
  const [nonce, expires, sig] = cookie.split('.');
  if (!nonce || !expires || !sig || nonce !== state) return false;
  if (Number(expires) < Date.now()) return false;
  const expected = await hmacSha256(secret, `${nonce}.${expires}`);
  const provided = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  return timingSafeEqualBytes(expected, provided);
}

function origin(c: Context<AppBindings>): string {
  return new URL(c.req.url).origin;
}

googleRoutes.get('/status', requireApiAuth, async (c) => {
  const client = new GoogleDriveClient(c.env, c.get('logger'));
  return c.json({ drive: await client.status(), redirectUri: `${origin(c)}/api/google/callback` });
});

googleRoutes.get('/connect', async (c) => {
  const auth = await authenticate(c);
  if (!auth) return c.redirect(`/login?next=${encodeURIComponent('/library')}`, 302);
  const client = new GoogleDriveClient(c.env, c.get('logger'));
  client.assertConfigured();
  const secret = c.env.SESSION_SECRET ?? '';
  const state = newOauthState();
  const expires = Date.now() + STATE_TTL_SECONDS * 1000;
  const secure = isSecureRequest(c);
  c.header(
    'Set-Cookie',
    `${STATE_COOKIE}=${await signState(secret, state, expires)}; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}${secure ? '; Secure' : ''}`,
  );
  c.get('logger').info('drive.connect_started');
  return c.redirect(buildAuthorizationUrl(c.get('config').googleDrive, origin(c), state), 302);
});

googleRoutes.get('/callback', async (c) => {
  const auth = await authenticate(c);
  if (!auth) return c.redirect(`/login?next=${encodeURIComponent('/library')}`, 302);
  const query = c.req.query();
  const clearState = `${STATE_COOKIE}=; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=0`;
  c.header('Set-Cookie', clearState);
  if (query.error) {
    c.get('logger').warn('drive.connect_denied', { reason: query.error });
    return c.redirect(`/library?drive=denied`, 302);
  }
  const code = query.code;
  const state = query.state;
  if (!code || !state) throw new AppError('VALIDATION_ERROR', 'Missing OAuth parameters.');
  const cookies = parseCookies(c.req.header('cookie'));
  if (!(await verifyStateCookie(c.env.SESSION_SECRET ?? '', cookies[STATE_COOKIE], state))) {
    throw new AppError(
      'FORBIDDEN',
      'The OAuth state did not match. Start the connection again from the library page.',
    );
  }
  const client = new GoogleDriveClient(c.env, c.get('logger'));
  await client.completeConnection(code, origin(c));
  return c.redirect('/library?drive=connected', 302);
});

googleRoutes.delete('/', requireApiAuth, async (c) => {
  const client = new GoogleDriveClient(c.env, c.get('logger'));
  await client.disconnect();
  return c.json({ ok: true });
});

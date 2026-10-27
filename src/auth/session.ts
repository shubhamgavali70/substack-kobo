import { SessionRepository } from '../db/sessions';
import {
  base64UrlDecode,
  base64UrlEncode,
  hmacSha256,
  randomToken,
  timingSafeEqualBytes,
} from './crypto';

/**
 * Session cookies carry `<sessionId>.<hmac>`. The HMAC (keyed with
 * SESSION_SECRET) is verified before any database lookup, so forged cookies
 * never touch D1. Rotating SESSION_SECRET invalidates every session at once.
 */

export const SESSION_COOKIE = '__Host-sk_session';
export const SESSION_COOKIE_DEV = 'sk_session';

export interface SessionTokens {
  cookieValue: string;
  sessionId: string;
}

export async function createSession(
  db: D1Database,
  secret: string,
  ttlSeconds: number,
  userAgent: string | null,
): Promise<SessionTokens> {
  const sessionId = randomToken(24);
  await new SessionRepository(db).create(sessionId, ttlSeconds, userAgent);
  const signature = base64UrlEncode(await hmacSha256(secret, sessionId));
  return { cookieValue: `${sessionId}.${signature}`, sessionId };
}

export async function verifySessionCookie(
  db: D1Database,
  secret: string,
  cookieValue: string | undefined,
): Promise<string | null> {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return null;
  const sessionId = cookieValue.slice(0, dot);
  const providedSig = base64UrlDecode(cookieValue.slice(dot + 1));
  if (!providedSig || !/^[A-Za-z0-9_-]{16,64}$/.test(sessionId)) return null;
  const expectedSig = await hmacSha256(secret, sessionId);
  if (!timingSafeEqualBytes(providedSig, expectedSig)) return null;
  const repo = new SessionRepository(db);
  const session = await repo.findValid(sessionId);
  if (!session) return null;
  return sessionId;
}

export async function destroySession(db: D1Database, sessionId: string): Promise<void> {
  await new SessionRepository(db).delete(sessionId);
}

export function sessionCookieName(secure: boolean): string {
  // The __Host- prefix requires Secure, which local http dev servers lack.
  return secure ? SESSION_COOKIE : SESSION_COOKIE_DEV;
}

export function buildSessionCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(name: string, secure: boolean): string {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

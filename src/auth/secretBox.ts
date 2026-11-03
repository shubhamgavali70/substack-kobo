import { base64UrlDecode, base64UrlEncode } from './crypto';

/**
 * AES-256-GCM encryption for third-party tokens stored in D1. The key is
 * derived from SESSION_SECRET, so rotating that secret invalidates stored
 * tokens (the integration then needs to be reconnected).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveKey(secret: string, purpose: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${purpose}\u0000${secret}`),
  );
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function sealSecret(
  plaintext: string,
  secret: string,
  purpose = 'integration-token',
): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.byteLength);
  return `v1.${base64UrlEncode(out)}`;
}

/** Returns null when the value cannot be decrypted (wrong key or corrupt data). */
export async function openSecret(
  sealed: string,
  secret: string,
  purpose = 'integration-token',
): Promise<string | null> {
  if (!sealed.startsWith('v1.')) return null;
  const bytes = base64UrlDecode(sealed.slice(3));
  if (!bytes || bytes.byteLength < 13) return null;
  try {
    const key = await deriveKey(secret, purpose);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
      key,
      bytes.subarray(12),
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

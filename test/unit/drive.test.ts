import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from '../../src/auth/secretBox';
import { buildAuthorizationUrl, buildMultipartBody } from '../../src/delivery/googleDrive';
import type { GoogleDriveConfig } from '../../src/env';

const config: GoogleDriveConfig = {
  enabled: true,
  clientId: 'client-id',
  clientSecret: 'secret',
  folderName: 'Substack to Kobo',
  folderId: null,
  scope: 'file',
};

describe('secretBox', () => {
  it('round-trips and rejects the wrong key or tampered data', async () => {
    const sealed = await sealSecret('1//refresh-token', 'k'.repeat(40));
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('refresh-token');
    expect(await openSecret(sealed, 'k'.repeat(40))).toBe('1//refresh-token');
    expect(await openSecret(sealed, 'x'.repeat(40))).toBeNull();
    expect(await openSecret(`${sealed.slice(0, -3)}abc`, 'k'.repeat(40))).toBeNull();
    expect(await openSecret('garbage', 'k'.repeat(40))).toBeNull();
  });
  it('uses a fresh IV for every call', async () => {
    const a = await sealSecret('same', 'k'.repeat(40));
    const b = await sealSecret('same', 'k'.repeat(40));
    expect(a).not.toBe(b);
  });
});

describe('Google Drive helpers', () => {
  it('builds an offline-access authorization URL with the least-privilege scope', () => {
    const url = new URL(buildAuthorizationUrl(config, 'https://reader.example', 'state123'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://reader.example/api/google/callback');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state123');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
  it('requests the full scope only when configured', () => {
    const url = new URL(
      buildAuthorizationUrl({ ...config, scope: 'full' }, 'https://reader.example', 's'),
    );
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive');
  });
  it('builds a well-formed multipart/related upload body', () => {
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const { body, contentType } = buildMultipartBody(
      { name: 'a.epub', parents: ['f1'] },
      data,
      'application/epub+zip',
    );
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
    expect(boundary).toBeTruthy();
    const text = new TextDecoder('latin1').decode(body);
    expect(
      text.startsWith(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n{"name":"a.epub","parents":["f1"]}\r\n--${boundary}\r\ncontent-type: application/epub+zip\r\n\r\n`,
      ),
    ).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(body.indexOf(0x50)).toBeGreaterThan(0);
  });
});

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { bearer, call, callJson, inlineEnv, login } from './helpers';

describe('authentication and authorization', () => {
  const testEnv = inlineEnv();

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM rate_limits').run();
    await env.DB.prepare('DELETE FROM sessions').run();
  });

  it('rejects unauthenticated API calls with 401 JSON', async () => {
    const { status, body } = await callJson(testEnv, '/api/articles');
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    const post = await call(testEnv, '/api/articles', { method: 'POST', body: '{}' });
    expect(post.status).toBe(401);
    const download = await call(
      testEnv,
      '/api/articles/11111111-2222-4333-8444-555555555555/download',
    );
    expect(download.status).toBe(401);
  });

  it('redirects unauthenticated page requests to the login page', async () => {
    const home = await call(testEnv, '/');
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/login?next=%2F');
    const library = await call(testEnv, '/library');
    expect(library.headers.get('location')).toContain('/login');
  });

  it('serves public assets without authentication but gates everything else', async () => {
    const login = await call(testEnv, '/login');
    expect(login.status).toBe(200);
    expect(login.headers.get('content-type')).toContain('text/html');
    const css = await call(testEnv, '/app.css');
    expect(css.status).toBe(200);
    const unknown = await call(testEnv, '/secret.txt');
    expect(unknown.status).toBe(302);
  });

  it('rejects a wrong password and does not set a cookie', async () => {
    const response = await call(testEnv, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('issues a secure HttpOnly session cookie on login and accepts it afterwards', async () => {
    const response = await call(testEnv, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: env.AUTH_PASSWORD }),
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-sk_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');

    const cookie = setCookie.split(';')[0] ?? '';
    const me = await callJson(testEnv, '/api/auth/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ authenticated: true, method: 'session' });
    const home = await call(testEnv, '/', { headers: { cookie } });
    expect(home.status).toBe(200);
  });

  it('rejects forged and tampered session cookies', async () => {
    const cookie = await login(testEnv);
    const [name, value] = cookie.split('=') as [string, string];
    const tampered = `${name}=${value.slice(0, -2)}xx`;
    expect((await call(testEnv, '/api/auth/me', { headers: { cookie: tampered } })).status).toBe(
      401,
    );
    const forged = `${name}=someid.c2lnbmF0dXJl`;
    expect((await call(testEnv, '/api/auth/me', { headers: { cookie: forged } })).status).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const cookie = await login(testEnv);
    const logout = await call(testEnv, '/api/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://reader.example' },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await call(testEnv, '/api/auth/me', { headers: { cookie } })).status).toBe(401);
  });

  it('accepts the API bearer token and rejects wrong tokens', async () => {
    const ok = await call(testEnv, '/api/auth/me', { headers: bearer() });
    expect(ok.status).toBe(200);
    const bad = await call(testEnv, '/api/auth/me', {
      headers: { Authorization: 'Bearer wrong-token-value' },
    });
    expect(bad.status).toBe(401);
    const list = await call(testEnv, '/api/articles', { headers: bearer() });
    expect(list.status).toBe(200);
  });

  it('refuses token auth when no API token is configured', async () => {
    const noToken = inlineEnv({ API_TOKEN: '' });
    const response = await call(noToken, '/api/auth/me', { headers: { Authorization: 'Bearer ' } });
    expect(response.status).toBe(401);
  });

  it('blocks cross-site state-changing requests that rely on the cookie', async () => {
    const cookie = await login(testEnv);
    const crossSite = await call(testEnv, '/api/articles', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ url: 'https://quietdesk.substack.com/p/x' }),
    });
    expect(crossSite.status).toBe(403);
    const fetchSite = await call(testEnv, '/api/articles', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ url: 'https://quietdesk.substack.com/p/x' }),
    });
    expect(fetchSite.status).toBe(403);
  });

  it('rate limits repeated failed logins', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 9; i++) {
      const response = await call(testEnv, '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('adds security headers to responses', async () => {
    const response = await call(testEnv, '/api/health');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('strict-transport-security')).toContain('max-age');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

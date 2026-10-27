# Security notes

This is a single-user, private system. The controls below are what the code enforces; Cloudflare Access or WAF rules can be layered on top without changes.

## Authentication

* Login compares the submitted password against the `AUTH_PASSWORD` secret in constant time (HMAC of both sides, byte-wise comparison).
* A successful login creates a `sessions` row and sets `__Host-sk_session=<id>.<hmac>` (HttpOnly, Secure, SameSite=Lax, 30 days). The HMAC is verified before the database is consulted, so forged cookies cost nothing.
* Automations use `Authorization: Bearer <API_TOKEN>`; the token is compared in constant time and must be at least 16 characters to be accepted at all.
* Login attempts are rate-limited per IP (8 per 15 minutes); captures are limited to 60 per hour per IP.
* Logout deletes the session row; rotating `SESSION_SECRET` invalidates every session.

## CSRF

State-changing requests authenticated by cookie must present a same-origin `Origin` / `Sec-Fetch-Site`. The frontend sends JSON with `fetch`, so form-based cross-site posts are rejected. Bearer-token requests are not subject to CSRF.

## SSRF and outbound fetch policy

`assertSafeDestination` runs for the submitted URL, for every redirect hop and for every image URL:

* https only (http input is upgraded; redirects to http are refused), no credentials in the URL, no non-standard ports;
* hostname must be on the allowlist (`substack.com`, `*.substack.com` plus `ALLOWED_HOSTS`; image hosts use `ALLOWED_IMAGE_HOSTS`);
* IP literals in any notation, single-label names, `.local`/`.internal`/`.localhost` and known metadata hostnames are refused;
* redirects are followed manually (`redirect: 'manual'`), at most 5 hops, with re-validation;
* responses are capped at 5 MB (article) / 5 MB per image / 25 MB total, with a 20 s timeout;
* requests carry no cookies or credentials.

Workers `fetch` already cannot reach a user's private network, and allowlisted public hostnames further limit the attack surface.

## Content safety

The sanitizer whitelists a small set of HTML elements and attributes, drops scripts, styles, iframes, forms, event handlers and Substack UI widgets, and only emits `http(s)`, `mailto` and fragment links. The generated EPUB contains no JavaScript or remote resources. Filenames are sanitized for filesystem-reserved characters and the `Content-Disposition` header uses an ASCII fallback plus RFC 5987 encoding.

## Access controls, DRM and terms

* Paywalled or login-protected posts are reported (`AUTHORIZATION_REQUIRED`) and never fetched with credentials or otherwise bypassed.
* No undocumented Substack APIs are used; the public page and its standard metadata are parsed as a browser would see them.
* Manual import is for content the user is entitled to use (for example their own subscriber emails).

## Data exposure

* R2 is private; downloads go through the authenticated endpoint. Object keys are internal and never returned by the API.
* Logs redact keys matching token/cookie/password/secret/authorization and truncate long strings; article bodies are never logged.
* Error responses expose a code and a user-facing message, never stack traces. Each carries a request id for log correlation.
* Security headers: CSP (`default-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS on https.

## Input validation

All API bodies and query parameters are validated with zod (lengths, enums, UUID ids). D1 queries use bound parameters; search terms escape `LIKE` wildcards.

## Reporting

If you find a problem, rotate secrets first (see docs/OPERATIONS.md), then fix the code and redeploy.

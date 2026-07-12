# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| 0.1.x   | :x: |

## Reporting a Vulnerability

If you discover a security vulnerability in hiai-docs, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **hiai@webs.cool**

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 5 business days
- **Fix or mitigation**: within 30 days for critical/high severity

### Scope

In-scope vulnerabilities include:

- Authentication/authorization bypass
- SQL injection or data leakage between users
- Cross-site scripting (XSS) in rendered content
- Remote code execution
- Path traversal or file upload abuse
- Rate limiting bypass on public endpoints
- Exposure of secrets or credentials

### Out of scope

- Social engineering attacks
- Denial of service (DoS)
- Issues in third-party dependencies (report upstream)
- Issues requiring physical access to the server

## Security Architecture

- **Data isolation**: All queries filter by `owner_id` — no cross-user data access
- **Auth**: Better Auth sessions, owner-wide global Bearer keys, category-bound Bearer keys, and a separate static operator credential
- **CSRF**: HMAC-signed double-submit cookie pattern on all unsafe methods
- **Rate limiting**: Redis-based sliding window rate limiters on all public endpoints (search, documents, sharing, health)
- **Sharing**: Token-based links with optional password + expiration
- **Validation**: Zod schemas on all API inputs
- **Secrets**: All configuration via environment variables, zero hardcoded secrets
- **Encryption**: Passwords hashed with Bun.password (bcrypt)
- **CSP**: Content Security Policy headers on all pages
- **API-key isolation**: category scopes are strict, explicit `read` / `edit` / `write` grants; key lifecycle operations require a browser session
- **Admin fail-closed**: `/api/admin/*` accepts the configured operator key through `x-api-key` or Bearer auth and rejects all credentials when the key is unset
- **Storage webhook**: the signed inbound compatibility route is deprecated and intentionally performs no synchronization; there are no outbound lifecycle webhooks

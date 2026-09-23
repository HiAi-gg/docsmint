# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.8.x   | :white_check_mark: |
| < 0.8   | :x:                |

Security fixes land on the current minor line. Upgrade to 0.8.x for supported
self-hosted deployments.

## Reporting a Vulnerability

This policy covers vulnerabilities in the DocsMint OSS source, distribution, and
self-hosted deployments. The DocsMint Cloud hosted service at `docsmint.com`,
including its hosted MCP authorization service, is maintained separately and is
not part of the OSS self-hosted distribution. Report Cloud vulnerabilities under
the [DocsMint Cloud security policy](https://docsmint.com/security).

For OSS or self-hosted vulnerabilities, please report responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **docs@webs.cool**

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
- OAuth or other authorization-protocol flaws in an affected DocsMint component,
  including redirect or client binding, PKCE validation, consent bypass,
  scope or workspace escalation, and token confusion

### Out of scope

- Standalone social engineering or credential harvesting that does not rely on a
  technical product flaw
- Denial of service (DoS)
- Issues in third-party dependencies (report upstream)
- Issues requiring physical access to the server

A phishing step does not make a technical authorization flaw out of scope. Report
protocol weaknesses through the policy for the affected product; Cloud MCP
authorization-service findings belong to the linked Cloud policy.

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

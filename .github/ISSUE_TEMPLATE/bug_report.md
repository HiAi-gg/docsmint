---
name: Bug Report
about: Report a bug in hiai-docs to help us improve
title: "[BUG] "
labels: ["bug", "needs-triage"]
assignees: []
---

## Bug Description

<!-- A clear, concise description of what the bug is. -->

## Steps to Reproduce

1. Go to '...'
2. Click on '...'
3. Run command '...'
4. See error

## Expected Behavior

<!-- What you expected to happen. -->

## Actual Behavior

<!-- What actually happened. Include screenshots, error messages, or stack traces if applicable. -->

## Environment

| Field | Value |
|-------|-------|
| hiai-docs version | <!-- e.g. v0.1.0, commit SHA, or `main` --> |
| Deployment | <!-- Docker / local dev / other --> |
| Backend (Elysia) | <!-- version or commit --> |
| Frontend (SvelteKit) | <!-- version or commit --> |
| Database | <!-- PostgreSQL 18 + pgvector --> |
| OS | <!-- e.g. Ubuntu 22.04, macOS 14 --> |
| Browser | <!-- e.g. Chrome 120, Firefox 121 --> |
| Bun version | <!-- `bun --version` output --> |

## Configuration

<!-- Relevant environment variables from `.env` (redact secrets). -->

```bash
EMBEDDING_BASE_URL=
EMBEDDING_MODEL=
EMBEDDING_API_KEY=
DATABASE_URL=postgresql://***:***@***:**/hiai_docs
```

## Logs

<!-- Paste relevant logs from `api`, `web`, or `docker compose logs`. Wrap in ```blocks```. Use [pastebin](https://pastebin.com) or similar for very long logs. -->

```text
[Paste logs here]
```

## Severity

<!-- How badly does this affect you? -->

- [ ] Critical — data loss, security issue, or complete outage
- [ ] High — major feature broken
- [ ] Medium — feature degraded but workaround exists
- [ ] Low — minor cosmetic or edge case

## Possible Cause

<!-- Optional: your hypothesis on what might be causing the bug. -->

## Additional Context

<!-- Any other context, related issues, or PRs. -->

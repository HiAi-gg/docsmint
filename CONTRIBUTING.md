# Contributing to hiai-docs

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a feature branch: `git checkout -b feature/my-change`
4. Make your changes
5. Run checks: `bun run lint && bun run typecheck`
6. Commit with a clear message
7. Push and open a Pull Request

## Branch Naming

- `feature/description` — new features
- `fix/description` — bug fixes
- `refactor/description` — code refactoring
- `docs/description` — documentation changes

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add document version diff view
fix: resolve search pagination off-by-one
refactor: extract folder tree into separate component
docs: update API reference for share endpoints
```

## Code Style

- **Runtime**: Bun only (no npm/yarn)
- **Modules**: ESM only (`import`/`export`, no `require`)
- **TypeScript**: strict mode, no `any` types
- **Language**: English only — code, comments, docs, commit messages
- **Validation**: Zod for all API inputs
- **No Playwright**: use agent-browser for E2E tests

## Project Structure

```
hiai-docs/
├── backend/          # Elysia API (Bun)
├── frontend/         # SvelteKit (Svelte 5 + Tailwind v4)
├── packages/db/      # Drizzle ORM schema + migrations
├── docker-compose.yml
└── .env.example
```

## Testing

```bash
# Backend unit tests
cd backend && bun test

# Frontend tests
cd frontend && bun run test

# Type check everything
bun run typecheck
```

## Pull Request Checklist

- [ ] Code compiles without errors (`bun run typecheck`)
- [ ] Linting passes (`bun run lint`)
- [ ] Tests pass (`bun test`)
- [ ] No hardcoded secrets or paths
- [ ] Commit messages follow Conventional Commits
- [ ] Changes are focused — one feature/fix per PR

## Questions?

Open an issue or start a discussion on GitHub.

FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/
COPY packages/db/package.json ./packages/db/
COPY packages/cli/package.json ./packages/cli/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY packages/sdk/package.json ./packages/sdk/
ENV BUN_INSTALL_CONCURRENCY=1
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --no-verify

# Production-only dependencies for the runtime image. Installs just
# `dependencies` (no devDependencies) so the runtime image excludes the
# build toolchain (vite, svelte, @sveltejs/kit, svelte-check, …).
FROM base AS prod-deps
COPY package.json ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/
COPY packages/db/package.json ./packages/db/
COPY packages/cli/package.json ./packages/cli/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY packages/sdk/package.json ./packages/sdk/
ENV BUN_INSTALL_CONCURRENCY=1
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production

# Build
FROM base AS build
COPY package.json tsconfig.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY frontend/ ./frontend/
COPY packages/db/ ./packages/db/

RUN cd frontend && bun run build

# Run
FROM base AS runtime
# Runtime deps only (no devDependencies) → smaller image, smaller attack surface.
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/frontend/node_modules /app/frontend/node_modules
COPY --from=build /app/frontend/build /app/frontend/build
COPY frontend/package.json /app/frontend/

ENV NODE_ENV=production
# adapter-node reads PORT at runtime; keep the standalone image aligned with
# the compose mapping and its healthcheck instead of falling back to 3000.
ENV PORT=50701
ENV WEB_PORT=50701
# SvelteKit adapter-node defaults to a 512 KiB request-body limit. The API
# accepts up to 10 MiB per imported file (and up to 100 MiB per request for
# multi-file imports), so the same-origin API proxy must allow the backend's
# global 100 MiB envelope instead of rejecting valid uploads first.
ENV BODY_SIZE_LIMIT=104857600
WORKDIR /app/frontend

RUN addgroup -S app && adduser -S app -G app \
    && chown -R -h app:app /app/frontend /app/node_modules

USER app

HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:50701/ || exit 1

EXPOSE 50701

CMD ["bun", "run", "build/index.js"]

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
COPY --from=build /app/frontend/build ./frontend/build
COPY frontend/package.json ./frontend/

ENV NODE_ENV=production
ENV WEB_PORT=50701
WORKDIR /app/frontend

RUN addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app/frontend  # COPY files are root-owned by default; chown is required for non-root USER

USER app

HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:50701/ || exit 1

EXPOSE 50701

CMD ["bun", "run", "build/index.js"]

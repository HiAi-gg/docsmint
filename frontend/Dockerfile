FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock* ./
COPY frontend/package.json ./frontend/
RUN bun install --production

# Build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
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

EXPOSE 50701

CMD ["bun", "run", "build/index.js"]

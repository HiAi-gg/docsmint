FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock* ./
COPY backend/package.json ./backend/
COPY packages/db/package.json ./packages/db/
RUN bun install --production

# Build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY backend/ ./backend/
COPY packages/db/ ./packages/db/
RUN cd backend && bun build src/index.ts --outdir dist --target bun

# Run
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY backend/package.json ./backend/

ENV NODE_ENV=production
ENV API_PORT=50700
WORKDIR /app/backend

EXPOSE 50700

CMD ["bun", "run", "dist/index.js"]

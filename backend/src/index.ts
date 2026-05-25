import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { config } from "./lib/config";
import { logger } from "./lib/logger";
import { authRoutes } from "./api/routes/auth";
import { tagRoutes } from "./api/routes/tags";
import { shareRoutes } from "./api/routes/share";
import { searchRoutes } from "./api/routes/search";
import { documentRoutes } from "./api/routes/documents";
import { folderRoutes } from "./api/routes/folders";
import { versionRoutes } from "./api/routes/versions";
import { authMiddleware } from "./api/middleware/auth";
import { startEmbeddingWorker } from "./lib/embedding-queue";

// Start background embedding worker
startEmbeddingWorker();

const swaggerConfig = {
  path: "/api/docs",
  documentation: {
    info: {
      title: "hiai-docs API",
      version: "0.1.0",
      description:
        "Self-hosted AI-first documentation platform. Full-text + semantic search, version history, sharing, and folder organization.",
      contact: { name: "hiai-gg", url: "https://github.com/hiai-gg/hiai-docs" },
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
    },
    tags: [
      { name: "Auth", description: "Authentication endpoints" },
      { name: "Documents", description: "Document CRUD and search" },
      { name: "Folders", description: "Folder management" },
      { name: "Tags", description: "Tag management" },
      { name: "Versions", description: "Document version history" },
      { name: "Share", description: "Sharing and guest access" },
      { name: "Search", description: "Hybrid full-text + semantic search" },
    ],
  },
};

const app = new Elysia()
  .use(cors({
    origin: config.CORS_ORIGINS?.split(",") ?? [config.BETTER_AUTH_URL],
    credentials: true,
    maxAge: 86400, // 24h preflight cache
  }))
  .use(config.NODE_ENV !== "production" ? swagger(swaggerConfig) : (e: Elysia) => e)
  .use(authMiddleware)
  .use(authRoutes)
  .use(tagRoutes)
  .use(shareRoutes)
  .use(searchRoutes)
  .use(documentRoutes)
  .use(folderRoutes)
  .use(versionRoutes)
  .get("/api/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))
  .listen(config.API_PORT);

logger.info({ port: config.API_PORT }, "hiai-docs API started");

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down...");
  app.stop();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export type App = typeof app;

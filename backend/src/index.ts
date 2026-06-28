import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { authMiddleware } from "./api/middleware/auth";
import { csrfMiddleware } from "./api/middleware/csrf";
import {
	healthRateLimiter,
	rateLimitHeaders,
} from "./api/middleware/rate-limit";
import { attachmentRoutes } from "./api/routes/attachments";
import { authRoutes } from "./api/routes/auth";
import { categoryRoutes } from "./api/routes/categories";
import { collaborationRoutes } from "./api/routes/collaboration";
import { documentRoutes } from "./api/routes/documents";
import { folderRoutes } from "./api/routes/folders";
import { searchRoutes } from "./api/routes/search";
import { shareRoutes } from "./api/routes/share";
import { tagRoutes } from "./api/routes/tags";
import { versionRoutes } from "./api/routes/versions";
import { webhookRoutes } from "./api/routes/webhooks";
import { config } from "./lib/config";
import { startEmbeddingWorker } from "./lib/embedding-queue";
import { logger } from "./lib/logger";
import { BUCKET, ensureBucket, minio } from "./lib/minio";

// Start background embedding worker
startEmbeddingWorker();

ensureBucket(minio, BUCKET).catch((err) => {
	logger.error({ err }, "Failed to ensure MinIO bucket");
});

const MAX_BODY_SIZE_BYTES = 10 * 1024 * 1024;

const CSP_POLICY = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: http://localhost:9020 http://localhost:9000 http://minio:9000",
	"connect-src 'self' http://localhost:50700 ws://localhost:50700",
	"font-src 'self' data:",
	"frame-ancestors 'none'",
	"form-action 'self'",
].join("; ");

const HSTS_POLICY = "max-age=31536000; includeSubDomains";

const bodySizeLimit = new Elysia().onBeforeHandle(({ request, set }) => {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const length = Number(contentLength);
		if (Number.isFinite(length) && length > MAX_BODY_SIZE_BYTES) {
			set.status = 413;
			set.headers["X-Content-Type-Options"] = "nosniff";
			set.headers["X-Frame-Options"] = "DENY";
			return { error: "Request body too large (max 10MB)" };
		}
	}
});

const securityHeaders = new Elysia().onAfterHandle(({ set }) => {
	set.headers["Content-Security-Policy"] = CSP_POLICY;
	set.headers["Strict-Transport-Security"] = HSTS_POLICY;
	set.headers["X-Content-Type-Options"] = "nosniff";
	set.headers["X-Frame-Options"] = "DENY";
});

const swaggerConfig = {
	path: "/api/docs",
	documentation: {
		info: {
			title: "hiai-docs API",
			version: "0.0.9",
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
			{
				name: "Categories",
				description: "Category management for folders and documents",
			},
			{ name: "Versions", description: "Document version history" },
			{ name: "Share", description: "Sharing and guest access" },
			{ name: "Search", description: "Hybrid full-text + semantic search" },
		],
	},
};

const app = new Elysia()
	.use(bodySizeLimit)
	.use(securityHeaders)
	.use(
		cors({
			origin: config.CORS_ORIGINS?.split(",") ?? [config.BETTER_AUTH_URL],
			credentials: true,
			maxAge: 86400,
		}),
	)
	.use(
		config.NODE_ENV !== "production"
			? swagger(swaggerConfig)
			: (e: Elysia) => e,
	)
	.get("/api/health", async ({ request }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";
		const rl = await healthRateLimiter(ip);
		const headers = rateLimitHeaders(rl.remaining, rl.retryAfter);
		return Object.assign(
			{
				status: "ok",
				service: "hiai-docs",
				timestamp: new Date().toISOString(),
			},
			headers,
		);
	})
	.use(csrfMiddleware)
	.use(authMiddleware)
	.use(authRoutes)
	.use(tagRoutes)
	.use(categoryRoutes)
	.use(attachmentRoutes)
	.use(shareRoutes)
	.use(searchRoutes)
	.use(documentRoutes)
	.use(folderRoutes)
	.use(versionRoutes)
	.use(webhookRoutes)
	.use(collaborationRoutes)
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

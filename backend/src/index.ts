import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { authMiddleware } from "./api/middleware/auth";
import { csrfMiddleware } from "./api/middleware/csrf";
import {
	healthRateLimiter,
	rateLimitHeaders,
} from "./api/middleware/rate-limit";
import { adminRoutes } from "./api/routes/admin";
import { attachmentRoutes } from "./api/routes/attachments";
import { authRoutes } from "./api/routes/auth";
import { categoryRoutes } from "./api/routes/categories";
import { collaborationRoutes } from "./api/routes/collaboration";
import { documentRoutes } from "./api/routes/documents";
import { folderRoutes } from "./api/routes/folders";
import { graphRoutes } from "./api/routes/graph";
import { keysRoutes } from "./api/routes/keys";
import { metricsRoutes } from "./api/routes/metrics";
import { pluginsRoutes } from "./api/routes/plugins";
import { searchRoutes } from "./api/routes/search";
import { shareRoutes } from "./api/routes/share";
import { tagRoutes } from "./api/routes/tags";
import { versionRoutes } from "./api/routes/versions";
import { visibilityRoutes } from "./api/routes/visibility";
import { webhookRoutes } from "./api/routes/webhooks";
import { ensureApiKeyOwner } from "./lib/api-key-owner";
import { config } from "./lib/config";
import { drainLegacyEmbeddingQueue } from "./lib/embedding-queue";
import { logger } from "./lib/logger";
import { BUCKET, ensureBucket, storage } from "./lib/storage";
import { createPipelineStageDependencies } from "./queue/adapters";
import { configureOwnerStageLimits } from "./queue/fair-scheduler";
import { configureDefaultJobOptions } from "./queue/names";
import {
	createBullMqRecoveryWriter,
	postgresRecoveryStore,
	recoverStalledPipeline,
} from "./queue/recovery";
import { startRegisteredPipelineWorkers } from "./queue/start";

// The API-key principal owns records created by agentic/CLI clients. Provision
// it before accepting writes so a clean quickstart cannot fail owner FKs.
await ensureApiKeyOwner();

configureDefaultJobOptions({
	attempts: config.QUEUE_JOB_ATTEMPTS,
	retryBaseDelayMs: config.QUEUE_RETRY_BASE_DELAY_MS,
	completedRetentionCount: config.QUEUE_COMPLETED_RETENTION_COUNT,
	failedRetentionCount: config.QUEUE_FAILED_RETENTION_COUNT,
});
configureOwnerStageLimits({
	prepare: config.QUEUE_MAX_ACTIVE_PREPARE_PER_OWNER,
	embed: config.QUEUE_MAX_ACTIVE_EMBED_PER_OWNER,
	graph: config.QUEUE_MAX_ACTIVE_GRAPH_PER_OWNER,
});

const pipelineRuntime = await startRegisteredPipelineWorkers({
	redisUrl: config.REDIS_URL,
	dependencies: createPipelineStageDependencies(config.REDIS_URL),
	settings: {
		prepareConcurrency: config.QUEUE_PREPARE_CONCURRENCY,
		embedConcurrency: config.QUEUE_EMBED_CONCURRENCY,
		graphConcurrency: config.QUEUE_GRAPH_CONCURRENCY,
		summarizeConcurrency: config.QUEUE_SUMMARY_CONCURRENCY,
		finalizeConcurrency: config.QUEUE_FINALIZE_CONCURRENCY,
		embedBatchSize: config.QUEUE_EMBED_BATCH_SIZE,
		maxActiveBatchesPerDocument: config.QUEUE_MAX_ACTIVE_BATCHES_PER_DOCUMENT,
	},
	shutdownGraceMs: config.QUEUE_SHUTDOWN_GRACE_MS,
	recover: async () => {
		const legacy = await drainLegacyEmbeddingQueue();
		const recovery = await recoverStalledPipeline(
			postgresRecoveryStore,
			createBullMqRecoveryWriter(config.REDIS_URL),
			{
				staleAfterMs: config.QUEUE_RECOVERY_STALE_AFTER_MS,
				maxAttempts: config.QUEUE_JOB_ATTEMPTS,
			},
		);
		logger.info({ legacy, recovery }, "Pipeline recovery completed");
	},
});

ensureBucket(storage, BUCKET).catch((err) => {
	logger.error({ err }, "Failed to ensure storage bucket");
});

// Global body-size cap. Large attachment uploads NO LONGER pass through
// this process — they go to SeaweedFS directly via presigned URLs (see
// /api/documents/:id/attachments/presign) — so this only needs to be big
// enough for the remaining endpoints (markdown imports, document
// updates, etc.) while still blocking obviously malicious payloads.
const MAX_BODY_SIZE_BYTES = 100 * 1024 * 1024;

const CSP_POLICY = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: http://localhost:50702 http://seaweedfs:8333",
	"connect-src 'self' http://localhost:50700 ws://localhost:50700 http://localhost:50702",
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
			return { error: "Request body too large (max 100MB)" };
		}
	}
});

// Security-headers hook is chained directly on the parent app instance.
// In Elysia 1.4.x, `.onAfterHandle()` registered on a plugin (`new
// Elysia({...}).onAfterHandle(...)`) is local to the plugin's own routes
// and does NOT propagate to the parent's existing or future routes — only
// handler-local `set.headers` (e.g. csrf-token in csrf.ts) reaches the
// wire. Chaining directly on the parent before route registration makes
// the hook part of the parent's event array so all subsequent routes
// inherit it.

const swaggerConfig = {
	path: "/api/docs",
	documentation: {
		info: {
			title: "hiai-docs API",
			version: "0.2.8",
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
			{
				name: "Graph",
				description: "GraphRAG entity and relationship queries (AGE)",
			},
			{
				name: "Admin",
				description:
					"Operator maintenance endpoints (reindex, embedding stats, provider health) — API key protected",
			},
		],
	},
};

const app = new Elysia()
	.use(bodySizeLimit)
	.onAfterHandle(({ set }) => {
		set.headers["Content-Security-Policy"] = CSP_POLICY;
		set.headers["Strict-Transport-Security"] = HSTS_POLICY;
		set.headers["X-Content-Type-Options"] = "nosniff";
		set.headers["X-Frame-Options"] = "DENY";
	})
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

		let storageStatus = "unknown";
		try {
			await storage.send(new ListBucketsCommand({}));
			storageStatus = "ok";
		} catch {
			storageStatus = "error";
		}

		return Object.assign(
			{
				status: "ok",
				service: "hiai-docs",
				timestamp: new Date().toISOString(),
				storage: storageStatus,
			},
			headers,
		);
	})
	// Tenant context is resolved EXPLICITLY in each route handler via
	// `buildTenantContext(request)` (see `api/middleware/tenant.ts`).
	// Earlier designs used an Elysia plugin hook with AsyncLocalStorage
	// propagation + a `Bun.serve({ fetch: wrappedFetch })` override of
	// `app.fetch`; both layers were fragile and silently dropped the
	// context for parent-app routes. The explicit approach makes every
	// RLS-aware query visible at the call site and removes the
	// dependency on plugin hook scope or Bun.serve internals.
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
	.use(graphRoutes)
	.use(keysRoutes)
	.use(pluginsRoutes)
	.use(visibilityRoutes)
	.use(adminRoutes)
	.use(metricsRoutes);

app.listen({
	port: config.API_PORT,
	development: config.NODE_ENV !== "production",
	idleTimeout: 30,
});
logger.info({ port: config.API_PORT }, "hiai-docs API started");

// Graceful shutdown
const shutdown = async () => {
	logger.info("Shutting down...");
	await pipelineRuntime.close();
	await app.stop();
	process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export type App = typeof app;

/**
 * Admin maintenance endpoints.
 *
 * All endpoints live under `/api/admin` and are gated by a static API key
 * (`config.HIAI_DOCS_API_KEY`) supplied via the `x-api-key` header. These
 * routes are intentionally NOT scoped per-user — they are operator tooling
 * used by ops scripts and external services (e.g. the embedding monitor
 * from T3.2). They share `searchRateLimiter`, which already bypasses its
 * own bucket when a valid API key is presented, so a healthy ops pipeline
 * is never throttled but a misconfigured caller still gets 429s.
 */
import {
	documentEmbeddings,
	documents,
	documentTags,
} from "@hiai-docs/db/schema";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { getEmbedding } from "../../embedding";
import { config } from "../../lib/config";
import { db } from "../../lib/db";
import { enqueueEmbedding } from "../../lib/embedding-queue";
import { getGraphDb } from "../../lib/graph/init";
import { logger } from "../../lib/logger";
import {
	enqueueReembed,
	reembedDocsByTag,
	reembedDocsInFolder,
	reembedDocsInFolderAdmin,
} from "../../lib/reembed";
import { rateLimitHeaders, searchRateLimiter } from "../middleware/rate-limit";

/**
 * Verify the caller presented the configured admin API key. Returns
 * `true` when either (a) no key is configured (dev convenience) or
 * (b) the supplied key matches `config.HIAI_DOCS_API_KEY`.
 *
 * Intentionally permissive in development: if an operator hasn't set the
 * key, we still let requests through so local tooling can hit the
 * endpoints without ceremony. In production the key MUST be set — the
 * `config` module already enforces BETTER_AUTH_SECRET in production;
 * `HIAI_DOCS_API_KEY` is the same class of secret and the operator is
 * expected to set it.
 */
function verifyAdminKey(request: Request): boolean {
	const expected = config.HIAI_DOCS_API_KEY;
	if (!expected) {
		// No key configured — permissive mode (dev only).
		return true;
	}
	const supplied = request.headers.get("x-api-key");
	return supplied === expected;
}

/**
 * Extract a stable client IP for rate limiting. Mirrors the helper
 * pattern used by the public routes so the limiter's Redis bucket key
 * is consistent across the API surface.
 */
function clientIp(request: Request): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown"
	);
}

export const adminRoutes = new Elysia({ prefix: "/api/admin" })
	/**
	 * POST /api/admin/reindex/:docId
	 *
	 * Force re-embed a single document. Clears existing chunks and pushes
	 * the id onto the embedding queue so the worker picks it up on the
	 * next tick. Returns 404 when the document does not exist so callers
	 * can detect typos / stale ids.
	 */
	.post("/reindex/:docId", async ({ params, set, request }) => {
		const ip = clientIp(request);
		const rl = await searchRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		if (!verifyAdminKey(request)) {
			set.status = 401;
			return { error: "Invalid or missing admin API key" };
		}

		try {
			const existing = await db
				.select({ id: documents.id })
				.from(documents)
				.where(eq(documents.id, params.docId))
				.limit(1);
			if (existing.length === 0) {
				set.status = 404;
				return { error: "Document not found" };
			}

			// Drop existing chunks so the worker writes a clean set rather
			// than upserting on the (document_id, chunk_index) unique
			// index. The worker wraps the same delete+insert in a
			// transaction, but doing the delete here lets us report an
			// accurate "previous chunks removed" count in the response if
			// we ever need it, and avoids a brief window where the
			// document has 2x chunks visible to search.
			await db
				.delete(documentEmbeddings)
				.where(eq(documentEmbeddings.documentId, params.docId));

			enqueueEmbedding(params.docId);

			return {
				success: true,
				documentId: params.docId,
				message: "Existing embeddings cleared and document re-queued",
			};
		} catch (err) {
			logger.error({ err, docId: params.docId }, "Admin reindex failed");
			set.status = 500;
			return { error: "Failed to reindex document" };
		}
	})

	/**
	 * GET /api/admin/embedding-stats
	 *
	 * Embedding pipeline observability: how many documents have at least
	 * one chunk, total chunks across all docs, and how many of those
	 * chunks are empty (zero-vector fallback rows from a misconfigured
	 * provider). A non-zero `emptyChunks` count is a strong signal that
	 * `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` are
	 * missing or wrong.
	 */
	.get("/embedding-stats", async ({ set, request }) => {
		const ip = clientIp(request);
		const rl = await searchRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		if (!verifyAdminKey(request)) {
			set.status = 401;
			return { error: "Invalid or missing admin API key" };
		}

		try {
			// Three independent aggregates — run them in parallel so a
			// busy DB doesn't serialize them. Each one is a single scan
			// over `document_embeddings` (the smallest relevant table)
			// plus one over `documents` for the "with embeddings" count.
			const [docsWithEmbeddingsRow, totalChunksRow, emptyChunksRow] =
				await Promise.all([
					db
						.select({
							value: sql<number>`COUNT(DISTINCT ${documentEmbeddings.documentId})::int`,
						})
						.from(documentEmbeddings),
					db.select({ value: count() }).from(documentEmbeddings),
					db
						.select({
							value: sql<number>`SUM(CASE WHEN ${documentEmbeddings.embedding} IS NULL THEN 1 ELSE 0 END)::int`,
						})
						.from(documentEmbeddings),
				]);

			return {
				stats: {
					docsWithEmbeddings: docsWithEmbeddingsRow[0]?.value ?? 0,
					totalChunks: totalChunksRow[0]?.value ?? 0,
					emptyChunks: emptyChunksRow[0]?.value ?? 0,
				},
			};
		} catch (err) {
			logger.error({ err }, "Admin embedding-stats failed");
			set.status = 500;
			return { error: "Failed to compute embedding stats" };
		}
	})

	/**
	 * GET /api/admin/health/embeddings
	 *
	 * Run a single embedding call against a probe string and report
	 * whether the configured provider is reachable.
	 *
	 * Status semantics:
	 *   - `not-configured` — neither EMBEDDING_BASE_URL nor
	 *     EMBEDDING_MODEL are set; the pipeline is dormant. Semantic
	 *     search degrades to text-only.
	 *   - `degraded` — configured but the call returned a zero vector
	 *     (provider unreachable / auth failure) OR the provider raised
	 *     and the fallback also failed. Pipeline runs but produces
	 *     useless vectors.
	 *   - `ok` — non-zero vector returned. Pipeline is healthy.
	 */
	.get("/health/embeddings", async ({ set, request }) => {
		const ip = clientIp(request);
		const rl = await searchRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		if (!verifyAdminKey(request)) {
			set.status = 401;
			return { error: "Invalid or missing admin API key" };
		}

		const probe = "hiai-docs embedding provider health probe";

		if (!config.EMBEDDING_BASE_URL || !config.EMBEDDING_MODEL) {
			return {
				status: "not-configured",
				provider: {
					baseUrl: config.EMBEDDING_BASE_URL ?? null,
					model: config.EMBEDDING_MODEL ?? null,
				},
				details:
					"EMBEDDING_BASE_URL or EMBEDDING_MODEL is unset — embeddings will be zero vectors",
			};
		}

		const startedAt = Date.now();
		try {
			const vector = await getEmbedding(probe);
			const latencyMs = Date.now() - startedAt;
			const allZero = vector.every((v) => v === 0);

			if (allZero) {
				return {
					status: "degraded",
					provider: {
						baseUrl: config.EMBEDDING_BASE_URL,
						model: config.EMBEDDING_MODEL,
					},
					latencyMs,
					details:
						"Provider returned a zero vector — check API key, model name, and base URL",
				};
			}

			return {
				status: "ok",
				provider: {
					baseUrl: config.EMBEDDING_BASE_URL,
					model: config.EMBEDDING_MODEL,
				},
				latencyMs,
				dimensions: vector.length,
			};
		} catch (err) {
			const latencyMs = Date.now() - startedAt;
			logger.warn({ err }, "Embedding provider health probe failed");
			return {
				status: "degraded",
				provider: {
					baseUrl: config.EMBEDDING_BASE_URL,
					model: config.EMBEDDING_MODEL,
				},
				latencyMs,
				details:
					err instanceof Error
						? err.message
						: "Unknown embedding provider error",
			};
		}
	})
	/**
	 * POST /api/admin/reindex/model
	 *
	 * Targeted re-embedding for documents whose stored embedding_model
	 * does not match the currently-configured EMBEDDING_MODEL. Use this
	 * after changing EMBEDDING_MODEL in .env (and restarting) to refresh
	 * only the docs that actually need it, instead of running a full
	 * reindex across every document.
	 *
	 * Optional query param `?dryRun=true` returns the count of affected
	 * docs without enqueuing anything - cheap preview for operators.
	 */
	.post("/reindex/model", async ({ query, set, request }) => {
		const ip = clientIp(request);
		const rl = await searchRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		if (!verifyAdminKey(request)) {
			set.status = 401;
			return { error: "Invalid or missing admin API key" };
		}

		const currentModel = config.EMBEDDING_MODEL ?? "";
		const dryRun = query?.dryRun === "true";
		try {
			// Find every doc id whose latest stored embedding_model does not
			// match the current one. We DISTINCT ON (document_id, embedding_model)
			// then filter to docs whose embedding_model is stale.
			const rows = await db
				.selectDistinct({ documentId: documentEmbeddings.documentId })
				.from(documentEmbeddings)
				.where(ne(documentEmbeddings.embeddingModel, currentModel));

			const docIds = rows
				.map((r) => r.documentId)
				.filter((id): id is string => typeof id === "string");

			if (dryRun) {
				return {
					dryRun: true,
					currentModel,
					affectedDocs: docIds.length,
				};
			}

			const enqueued = await enqueueReembed(docIds);
			logger.info(
				{ currentModel, affectedDocs: docIds.length, enqueued },
				"Targeted reindex by embedding model mismatch",
			);
			return {
				success: true,
				currentModel,
				affectedDocs: docIds.length,
				enqueued,
			};
		} catch (err) {
			logger.error({ err, currentModel }, "Admin reindex by model failed");
			set.status = 500;
			return { error: "Failed to compute affected docs" };
		}
	})
	/**
	 * GET /api/admin/graph/stats
	 *
	 * GraphRAG inventory - returns counts of entities (per label)
	 * and relations (per type) currently stored in AGE. Returns
	 * `available: false` when AGE is not configured so the endpoint
	 * stays safe to call without graph infrastructure running.
	 */
	.get("/graph/stats", async ({ set, request }) => {
		const ip = clientIp(request);
		const rl = await searchRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		if (!verifyAdminKey(request)) {
			set.status = 401;
			return { error: "Invalid or missing admin API key" };
		}

		if (!config.GRAPH_SEARCH_ENABLED && !config.GRAPH_EXTRACT_ENABLED) {
			return { available: false, reason: "GraphRAG disabled" };
		}
		const sql = await getGraphDb();
		if (!sql) {
			return { available: false, reason: "AGE unreachable" };
		}

		try {
			// Two cheap COUNT queries - one over the whole graph, one for
			// relations. AGE does not expose label histograms cheaply, so
			// per-label / per-type counts are omitted. Operators who need
			// the breakdown can run MATCH (n:Label) RETURN count(n) directly.
			// AGE's `cypher()` requires a literal dollar-quoted string constant
			// (its parser inspects the second argument lexically) and rejects
			// bind parameters. We therefore use sql.unsafe() to pass the raw
			// SQL through. The cypher strings are hard-coded constants and
			// never include user input, so this is safe.
			const nodesResult = (await sql.unsafe(
				"SELECT count(*) AS count FROM cypher('docs_graph', $$ MATCH (n) RETURN count(n) $$) AS (count agtype)",
			)) as Array<{ count: string }>;
			const edgesResult = (await sql.unsafe(
				"SELECT count(*) AS count FROM cypher('docs_graph', $$ MATCH ()-[r]->() RETURN count(r) $$) AS (count agtype)",
			)) as Array<{ count: string }>;
			const nodes = Number(nodesResult[0]?.count ?? 0);
			const edges = Number(edgesResult[0]?.count ?? 0);
			return { available: true, nodes, edges };
		} catch (err) {
			logger.warn({ err }, "Admin graph/stats failed");
			return { available: false, reason: "Cypher query failed" };
		}
	})

	/**
	 * POST /api/admin/reindex/folder/:folderId
	 *
	 * Bulk re-embed every document in a folder. Operator-scoped:
	 * this endpoint intentionally crosses tenant boundaries because
	 * it is the path an admin uses after a model upgrade or other
	 * corpus-wide event that falls outside the targeted reindex.
	 * The matching user-scoped trigger is the same helper invoked by
	 * the PATCH/DELETE /api/folders/:id handlers (those still use
	 * the owner-scoped variant and are NOT replaced by this endpoint).
	 *
	 * Optional ?ownerId=<uuid> narrows both the dryRun preview and
	 * the re-embed to a single tenant. Default (no ownerId) is
	 * cross-tenant. Optional ?dryRun=true returns the affected count
	 * without enqueuing. Bounded by FOLDER_REEMBED_BATCH_SIZE (default 100).
	 *
	 * When `ADMIN_CROSS_TENANT=false` and no `ownerId` is provided,
	 * returns 400 with an error message.
	 */
	.post(
		"/reindex/folder/:folderId",
		async ({ params, query, set, request }) => {
			const ip = clientIp(request);
			const rl = await searchRateLimiter(ip, request);
			if (!rl.allowed) {
				set.status = 429;
				set.headers = rateLimitHeaders(0, rl.retryAfter);
				return { error: "Too many requests" };
			}
			set.headers = rateLimitHeaders(rl.remaining);

			if (!verifyAdminKey(request)) {
				set.status = 401;
				return { error: "Invalid or missing admin API key" };
			}

			const ownerId = query?.ownerId;
			const dryRun = query?.dryRun === "true";
			try {
				if (ownerId) {
					if (dryRun) {
						const rows = await db
							.select({ id: documents.id })
							.from(documents)
							.where(
								and(
									eq(documents.folderId, params.folderId),
									eq(documents.ownerId, ownerId),
								),
							);
						return {
							dryRun: true,
							affectedDocs: rows.length,
							folderId: params.folderId,
							ownerId,
						};
					}
					const affected = await reembedDocsInFolder(params.folderId, ownerId);
					logger.info(
						{ folderId: params.folderId, ownerId, affected },
						"Admin reindex by folder (owner-scoped)",
					);
					return {
						success: true,
						folderId: params.folderId,
						ownerId,
						affected,
					};
				}

				if (!config.ADMIN_CROSS_TENANT) {
					set.status = 400;
					return {
						error:
							"ownerId query parameter required when ADMIN_CROSS_TENANT is false",
					};
				}

				if (dryRun) {
					const rows = await db
						.select({ id: documents.id })
						.from(documents)
						.where(eq(documents.folderId, params.folderId));
					return {
						dryRun: true,
						affectedDocs: rows.length,
						folderId: params.folderId,
					};
				}
				// Use the same helper the rename/delete path uses so behavior stays
				// consistent: same batch cap, same Redis dedup, same logging.
				const affected = await reembedDocsInFolderAdmin(params.folderId);
				logger.info(
					{ folderId: params.folderId, affected },
					"Admin reindex by folder",
				);
				return { success: true, folderId: params.folderId, affected };
			} catch (err) {
				logger.error(
					{ err, folderId: params.folderId },
					"Admin reindex/folder failed",
				);
				set.status = 500;
				return { error: "Failed to reindex folder" };
			}
		},
	)

	/**
	 * POST /api/admin/reindex/tag/:tagId
	 *
	 * Bulk re-embed every document carrying a tag. Mirrors
	 * POST /api/admin/reindex/folder/:folderId but for tags.
	 *
	 * Optional `?ownerId=<uuid>` narrows the re-embed to a single tenant
	 * by filtering through documentTags JOIN documents WHERE
	 * documents.owner_id = ownerId. Default (no ownerId) is cross-tenant.
	 * Optional `?dryRun=true` returns the affected count. Bounded by
	 * TAG_REEMBED_BATCH_SIZE (default 500).
	 *
	 * When `ADMIN_CROSS_TENANT=false` and no `ownerId` is provided,
	 * returns 400 with an error message.
	 */
	.post("/reindex/tag/:tagId", async ({ params, query, set, request }) => {
		const ip = clientIp(request);
		const rl = await searchRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		if (!verifyAdminKey(request)) {
			set.status = 401;
			return { error: "Invalid or missing admin API key" };
		}

		const ownerId = query?.ownerId;
		const dryRun = query?.dryRun === "true";
		try {
			if (ownerId) {
				const whereClause = and(
					eq(documentTags.tagId, params.tagId),
					eq(documents.ownerId, ownerId),
				);
				const rows = await db
					.selectDistinct({ documentId: documentTags.documentId })
					.from(documentTags)
					.innerJoin(documents, eq(documentTags.documentId, documents.id))
					.where(whereClause);
				const docIds = rows.map((r) => r.documentId);

				if (dryRun) {
					return {
						dryRun: true,
						affectedDocs: docIds.length,
						tagId: params.tagId,
						ownerId,
					};
				}
				const affected = await enqueueReembed(docIds);
				logger.info(
					{ tagId: params.tagId, ownerId, affected },
					"Admin reindex by tag (owner-scoped)",
				);
				return { success: true, tagId: params.tagId, ownerId, affected };
			}

			if (!config.ADMIN_CROSS_TENANT) {
				set.status = 400;
				return {
					error:
						"ownerId query parameter required when ADMIN_CROSS_TENANT is false",
				};
			}

			if (dryRun) {
				const rows = await db
					.selectDistinct({ id: documentTags.documentId })
					.from(documentTags)
					.where(eq(documentTags.tagId, params.tagId));
				return { dryRun: true, affectedDocs: rows.length, tagId: params.tagId };
			}
			const affected = await reembedDocsByTag(params.tagId);
			logger.info({ tagId: params.tagId, affected }, "Admin reindex by tag");
			return { success: true, tagId: params.tagId, affected };
		} catch (err) {
			logger.error({ err, tagId: params.tagId }, "Admin reindex/tag failed");
			set.status = 500;
			return { error: "Failed to reindex tag" };
		}
	});

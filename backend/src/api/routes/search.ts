import { documentTags, tags as tagsTable } from "@hiai-docs/db/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { getEmbedding } from "../../embedding";
import type { EmbeddingResult } from "../../embedding/result";
import {
	type ContentAccess,
	canAccessContent,
	resolveContentAccess,
} from "../../lib/content-access";
import { logger } from "../../lib/logger";
import { resolveShareDocumentScope } from "../../lib/share-access";
import { withTenant } from "../../lib/with-tenant";
import type { GraphVisibilityScope } from "../../search/graph-retriever";
import { searchDocuments } from "../../search/orchestrator";
import type { SearchExplanation } from "../../search/types";
import { rateLimitHeaders, searchRateLimiter } from "../middleware/rate-limit";
import {
	adminTenantContext,
	shareGuestTenantContext,
} from "../middleware/tenant";

const searchQuerySchema = z.object({
	q: z.string().optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	sort: z
		.enum(["relevance", "date_desc", "date_asc", "name_asc", "name_desc"])
		.default("relevance"),
	folder: z.string().optional(),
	tags: z.string().optional(),
	/**
	 * Optional category UUID filter. When supplied, results are restricted to
	 * documents whose own `category_id` matches OR whose folder's
	 * `category_id` matches (so a single category scope covers both direct
	 * document membership and folder-level classification).
	 */
	category: z.string().uuid().optional(),
	dateFrom: z.string().optional(),
	dateTo: z.string().optional(),
	/** Deprecated compatibility fields. GraphRAG is now automatic for every search. */
	graph: z.coerce.boolean().optional().default(false),
	graphHops: z.coerce.number().int().min(1).max(3).optional(),
	graphBoost: z.coerce.number().min(0).max(2).optional(),
	/**
	 * When `true`, include the top-3 most relevant text chunks per
	 * document in the result items. Each chunk carries its character
	 * offsets and a cosine-distance score against the query embedding.
	 */
	includeChunks: z.coerce.boolean().optional().default(false),
});

const suggestQuerySchema = z.object({
	q: z.string().optional(),
});

type SearchResult = {
	id: string;
	title: string;
	snippet: string;
	score: number;
	folder_id: string | null;
	folder_name: string | null;
	created_at: string;
	updated_at: string;
	explanations: SearchExplanation[];
	tags?: Array<{ id: string; name: string; color: string | null }>;
	chunks?: Array<{
		chunkIndex: number;
		chunkText: string;
		charStart: number;
		charEnd: number;
		score: number;
	}>;
};

export type SearchChunk = NonNullable<SearchResult["chunks"]>[number];

/** Keep the top three finite-scored chunks per document in relevance order. */
export function rankChunkRows(rows: Array<Record<string, unknown>>) {
	const byDoc = new Map<string, SearchChunk[]>();
	for (const raw of rows) {
		const docId = String(raw.document_id ?? "");
		const score = Number(raw.score);
		if (!docId || !Number.isFinite(score)) continue;
		const list = byDoc.get(docId) ?? [];
		list.push({
			chunkIndex: Number(raw.chunk_index ?? 0),
			chunkText: String(raw.chunk_text ?? ""),
			charStart: Number(raw.char_start ?? 0),
			charEnd: Number(raw.char_end ?? 0),
			score,
		});
		list.sort(
			(left, right) =>
				right.score - left.score || left.chunkIndex - right.chunkIndex,
		);
		byDoc.set(docId, list.slice(0, 3));
	}
	return byDoc;
}
export function createSearchRoutes(
	search: typeof searchDocuments = searchDocuments,
	hydrate: typeof hydrateResults = hydrateResults,
	resolveAccess: typeof resolveContentAccess = resolveContentAccess,
	loadScopedDocumentIds: typeof loadCategoryDocumentIds = loadCategoryDocumentIds,
) {
	return new Elysia({ prefix: "/api/search" })
		.get("/", async ({ query, set, request }) => {
			const ip =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"unknown";
			const rl = await searchRateLimiter(ip, request);
			if (!rl.allowed) {
				set.status = 429;
				set.headers = rateLimitHeaders(0, rl.retryAfter);
				return { error: "Too many requests" };
			}
			set.headers = rateLimitHeaders(rl.remaining);

			const access = await resolveAccess(request);
			const ctx = access.ctx;
			let searchCtx = ctx;
			let shareDocumentIds: string[] | undefined;
			let scopedDocumentIds: string[] | undefined;
			let graphVisibilityScope: GraphVisibilityScope | undefined;
			if (!access.principal) {
				const shareToken = request.headers.get("x-share-token")?.trim();
				if (!shareToken) {
					set.status = 401;
					return { error: "Unauthorized" };
				}
				const shareScope = await resolveShareDocumentScope(
					adminTenantContext(),
					shareToken,
				);
				if (!shareScope) {
					set.status = 401;
					return { error: "Unauthorized" };
				}
				if (shareScope.passwordHash) {
					const password = request.headers.get("x-share-password");
					if (
						!password ||
						!(await Bun.password.verify(password, shareScope.passwordHash))
					) {
						set.status = 401;
						return { error: "Unauthorized" };
					}
				}
				searchCtx = shareGuestTenantContext(shareScope.ownerId);
				shareDocumentIds = shareScope.documentIds;
				graphVisibilityScope = {
					kind: "share",
					ownerId: shareScope.ownerId,
					allowedDocumentIds: shareScope.documentIds,
				};
			} else if (!canAccessContent(access, "read")) {
				set.status = 403;
				return { error: "Forbidden" };
			} else {
				if (access.restricted) {
					scopedDocumentIds = await loadScopedDocumentIds(access);
				}
				graphVisibilityScope = access.restricted
					? {
							kind: "share",
							ownerId: access.userId,
							allowedDocumentIds: scopedDocumentIds ?? [],
						}
					: ctx.role === "admin"
						? { kind: "admin" }
						: { kind: "tenant", ownerId: ctx.userId, includePublic: true };
			}
			const parsed = searchQuerySchema.safeParse(query);
			if (!parsed.success) {
				set.status = 400;
				return { error: "Invalid query", details: parsed.error.flatten() };
			}
			try {
				const {
					q: rawQ,
					page,
					limit,
					sort,
					folder,
					tags,
					category,
					dateFrom,
					dateTo,
					includeChunks,
				} = parsed.data;
				const q = rawQ ?? "";
				if (!q.trim()) return { items: [], total: 0, page, limit };
				const legacyGraphRequested = ["graph", "graphHops", "graphBoost"].some(
					(key) => request.url.includes(`${key}=`),
				);
				if (legacyGraphRequested) {
					set.headers.Deprecation = "true";
				}

				// The domain owns retrieval, confidence, GraphRAG, and RRF ranking. The
				// route only hydrates authorized display fields and applies presentation
				// filters so the public HTTP contract remains backwards compatible.
				const domain = await search(searchCtx, {
					query: q,
					page,
					limit,
					filters: {
						folderId: folder,
						tagNames: tags
							?.split(",")
							.map((tag) => tag.trim())
							.filter(Boolean),
						categoryId: category,
						dateFrom,
						dateTo,
						sort,
					},
					documentIds: shareDocumentIds ?? scopedDocumentIds,
					visibilityScope: graphVisibilityScope,
				});
				const authorizedDomain = scopedDocumentIds
					? restrictSearchResponse(domain, scopedDocumentIds)
					: domain;
				const rows = await hydrate(
					searchCtx,
					authorizedDomain.items,
					includeChunks,
					q,
					shareDocumentIds ?? scopedDocumentIds,
					authorizedDomain.queryEmbedding,
					authorizedDomain.visibleDocumentIds,
				);
				// `visibleTotal` is calculated over the complete filtered candidate set,
				// never from the current page. The hydrator may attach a refreshed count
				// when a document was deleted or hidden between retrieval and hydration.
				const hasDomainVisibilityMetadata =
					authorizedDomain.visibleTotal !== undefined ||
					authorizedDomain.visibleDocumentIds !== undefined;
				const visibleTotal =
					rows.visibleTotal ??
					(hasDomainVisibilityMetadata
						? (authorizedDomain.visibleTotal ?? authorizedDomain.total)
						: rows.length);
				return {
					items: rows,
					total: visibleTotal,
					page,
					limit,
					diagnostics: authorizedDomain.diagnostics,
				};
			} catch (err) {
				logger.error({ err }, "Search failed");
				set.status = 500;
				return { error: "Search failed" };
			}
		})
		.get("/suggest", async ({ query, set, request }) => {
			const ip =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"unknown";
			const rl = await searchRateLimiter(ip, request);
			if (!rl.allowed) {
				set.status = 429;
				set.headers = rateLimitHeaders(0, rl.retryAfter);
				return { error: "Too many requests" };
			}
			set.headers = rateLimitHeaders(rl.remaining);

			const access = await resolveAccess(request);
			const ctx = access.ctx;
			if (!access.principal) {
				set.status = 401;
				return { error: "Unauthorized" };
			}
			if (!canAccessContent(access, "read")) {
				set.status = 403;
				return { error: "Forbidden" };
			}
			const userId = ctx.userId;
			const parsed = suggestQuerySchema.safeParse(query);
			if (!parsed.success) {
				set.status = 400;
				return { error: "Invalid query", details: parsed.error.flatten() };
			}
			try {
				const q = parsed.data.q ?? "";
				if (!q.trim()) return [];
				const scopedIds = access.restricted
					? await loadScopedDocumentIds(access)
					: undefined;
				if (scopedIds?.length === 0) return [];
				const results = await withTenant(ctx, async (tx) => {
					return tx.execute(sql`
					SELECT id, title, similarity(title, ${q}) as score
					FROM documents
					WHERE owner_id = ${userId}
						${
							scopedIds
								? sql`AND id IN (${sql.join(
										scopedIds.map((id) => sql`${id}`),
										sql`, `,
									)})`
								: sql``
						}
						AND title % ${q}
					ORDER BY score DESC LIMIT 5
				`);
				});
				return results;
			} catch (err) {
				logger.error({ err }, "Suggest failed");
				set.status = 500;
				return { error: "Suggest failed" };
			}
		});
}

/** Defence-in-depth: no adapter or ranking bug may restore an out-of-scope ID. */
export function restrictSearchResponse<
	T extends {
		items: Array<{ documentId: string }>;
		total: number;
		visibleTotal?: number;
		visibleDocumentIds?: string[];
	},
>(response: T, allowedDocumentIds: string[]): T {
	const allowed = new Set(allowedDocumentIds);
	const items = response.items.filter((item) => allowed.has(item.documentId));
	const visibleDocumentIds = (
		response.visibleDocumentIds ?? items.map((i) => i.documentId)
	).filter((id) => allowed.has(id));
	return {
		...response,
		items,
		total: visibleDocumentIds.length,
		visibleTotal: visibleDocumentIds.length,
		visibleDocumentIds,
	};
}

/** Resolve the complete allow-list before retrieval so hidden candidates never rank. */
async function loadCategoryDocumentIds(
	access: ContentAccess,
): Promise<string[]> {
	if (!access.restricted || !access.categoryId) return [];
	const categoryId = access.categoryId;
	const { documents, folders } = await import("@hiai-docs/db/schema");
	const rows = await withTenant(access.ctx, (tx) =>
		tx
			.select({ id: documents.id })
			.from(documents)
			.leftJoin(
				folders,
				and(
					eq(folders.id, documents.folderId),
					eq(folders.ownerId, access.userId),
				),
			)
			.where(
				and(
					eq(documents.ownerId, access.userId),
					or(
						eq(documents.categoryId, categoryId),
						and(
							sql`${documents.categoryId} IS NULL`,
							eq(folders.categoryId, categoryId),
						),
					),
				),
			),
	);
	return rows.map((row) => row.id);
}

export const searchRoutes = createSearchRoutes();

async function hydrateResults(
	ctx: import("../../api/middleware/tenant").TenantContext,
	items: Array<{
		documentId: string;
		score: number;
		explanations: SearchExplanation[];
	}>,
	includeChunks: boolean,
	query: string,
	allowedDocumentIds?: string[],
	queryEmbedding?: EmbeddingResult,
	candidateIds?: string[],
): Promise<HydratedSearchResults> {
	if (items.length === 0 && (!candidateIds || candidateIds.length === 0))
		return [];
	const ids = items.map((item) => item.documentId);
	const visibleIds = [...new Set(candidateIds ?? ids)];
	const { documents, folders } = await import("@hiai-docs/db/schema");
	const rows = await withTenant(ctx, async (tx) =>
		tx
			.select({
				id: documents.id,
				title: documents.title,
				content: documents.content,
				folderId: documents.folderId,
				folderName: folders.name,
				createdAt: documents.createdAt,
				updatedAt: documents.updatedAt,
			})
			.from(documents)
			.leftJoin(
				folders,
				and(
					eq(folders.id, documents.folderId),
					eq(folders.ownerId, ctx.userId),
				),
			)
			.where(
				and(
					or(
						eq(documents.ownerId, ctx.userId),
						eq(documents.visibility, "public"),
					),
					inArray(documents.id, visibleIds),
					allowedDocumentIds
						? inArray(documents.id, allowedDocumentIds)
						: undefined,
				),
			),
	);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const hydrated: SearchResult[] = items.flatMap((item) => {
		const row = byId.get(item.documentId);
		if (!row) return [];
		return [
			{
				id: row.id,
				title: row.title,
				snippet: (row.content ?? "").slice(0, 200),
				score: item.score,
				folder_id: row.folderId,
				folder_name: row.folderName,
				created_at:
					row.createdAt instanceof Date
						? row.createdAt.toISOString()
						: String(row.createdAt ?? ""),
				updated_at:
					row.updatedAt instanceof Date
						? row.updatedAt.toISOString()
						: String(row.updatedAt ?? ""),
				explanations: item.explanations.slice(0, 3),
			},
		];
	});
	if (includeChunks && hydrated.length > 0) {
		// Chunk hydration is deliberately best-effort and tenant-scoped. Reuse one
		// query embedding and rank active, valid chunks by cosine similarity.
		try {
			const embedding = queryEmbedding ?? (await getEmbedding(query));
			if (embedding.ok) {
				const embeddingString = `[${embedding.vector.join(",")}]`;
				const chunks = await withTenant(ctx, async (tx) =>
					tx.execute(sql`
					SELECT de.document_id, de.chunk_index, de.chunk_text, de.char_start, de.char_end,
						(1 - (de.embedding <=> ${embeddingString}::vector))::double precision AS score
					FROM document_embeddings de
					JOIN documents d ON d.id = de.document_id
					WHERE de.document_id IN (${sql.join(
						ids.map((id) => sql`${id}`),
						sql`, `,
					)})
						AND d.owner_id = ${ctx.userId}
						AND d.embedding_status = 'ready'
						AND d.active_embedding_generation IS NOT NULL
						AND de.generation_id = d.active_embedding_generation
						AND de.is_valid = true
						AND de.embedding_dimensions = 1024
						AND de.embedding_profile = d.embedding_profile
						AND de.embedding_profile = ${embedding.profile}
						AND de.embedding IS NOT NULL
						AND vector_norm(de.embedding) > 0
					ORDER BY de.document_id, score DESC, de.chunk_index ASC
				`),
				);
				const byDoc = rankChunkRows(
					chunks as unknown as Array<Record<string, unknown>>,
				);
				for (const result of hydrated)
					result.chunks = byDoc.get(result.id) ?? [];
			} else {
				for (const result of hydrated) result.chunks = [];
			}
		} catch (err) {
			logger.warn({ err }, "Chunk hydration failed; continuing without chunks");
		}
	}
	const tagged = await withTags(ctx, hydrated);
	const result = tagged as HydratedSearchResults;
	// The query above is scoped to every authorized candidate ID, not only the
	// current page. This preserves global pagination while avoiding hidden counts.
	result.visibleTotal = rows.length;
	return result;
}

export type HydratedSearchResults = SearchResult[] & { visibleTotal?: number };

async function withTags<T extends { id: string }>(
	ctx: import("../../api/middleware/tenant").TenantContext,
	rows: T[],
): Promise<
	Array<T & { tags: Array<{ id: string; name: string; color: string | null }> }>
> {
	if (rows.length === 0) return [];
	const ids = rows.map((r) => r.id);
	const tagRows = await withTenant(ctx, async (tx) => {
		return tx
			.select({
				documentId: documentTags.documentId,
				id: tagsTable.id,
				name: tagsTable.name,
				color: tagsTable.color,
			})
			.from(documentTags)
			.innerJoin(tagsTable, eq(tagsTable.id, documentTags.tagId))
			.where(
				and(
					inArray(documentTags.documentId, ids),
					eq(tagsTable.ownerId, ctx.userId),
				),
			);
	});

	const byDoc = new Map<
		string,
		Array<{ id: string; name: string; color: string | null }>
	>();
	for (const t of tagRows) {
		const list = byDoc.get(t.documentId) ?? [];
		list.push({ id: t.id, name: t.name, color: t.color });
		byDoc.set(t.documentId, list);
	}
	return rows.map((r) => ({ ...r, tags: byDoc.get(r.id) ?? [] }));
}

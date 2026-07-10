import { documentTags, tags as tagsTable } from "@hiai-docs/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { getEmbedding } from "../../embedding";
import { config } from "../../lib/config";
import { expandResults } from "../../lib/graph/search-expansion";
import { logger } from "../../lib/logger";
import { withTenant } from "../../lib/with-tenant";
import { rateLimitHeaders, searchRateLimiter } from "../middleware/rate-limit";
import { buildTenantContext } from "../middleware/tenant";

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
	/**
	 * When `true`, expand the merged result list with related documents
	 * discovered through the AGE graph. Disabled by default because the
	 * extra AGE round-trip adds latency to every search. Feature-flagged
	 * separately by `GRAPH_SEARCH_ENABLED` — calling with `graph=true`
	 * is a no-op when graph search is disabled.
	 */
	graph: z.coerce.boolean().optional().default(false),
	/**
	 * Maximum graph traversal depth (1-3). Default 2 hops. Higher hops
	 * surface more related documents but with diminishing signal and
	 * O(branching^hops) cost in AGE.
	 */
	graphHops: z.coerce.number().int().min(1).max(3).optional(),
	/**
	 * Override for the graph boost weight. Range [0, 2]. When absent,
	 * falls back to the operator-configured GRAPH_EXPANSION_BOOST
	 * env var (default 0.3).
	 */
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

/**
 * Weight applied to graph-discovered documents when merging them into the
 * result list. Tuned so that a graph neighbor scores BELOW a single
 * semantic match (0.6 weight) but above a noisy zero — this keeps the
 * original ranking honest while broadening the visible surface area.
 *
 * Existing documents receive this same fraction as a multiplicative boost
 * (so a doc that matches both semantically AND by graph edges ranks
 * proportionally higher than either signal alone).
 */
// Graph boost defaults to config.GRAPH_EXPANSION_BOOST and can be
// overridden per-request via ?graphBoost=N. Read inside the handler.

type RawSearchResult = {
	id: string;
	title: string;
	snippet: string;
	score: number;
	folder_id: string | null;
	folder_name: string | null;
	created_at: string;
	updated_at: string;
};

type SearchResult = {
	id: string;
	title: string;
	snippet: string;
	score: number;
	folder_id: string | null;
	folder_name: string | null;
	created_at: string;
	updated_at: string;
	tags?: Array<{ id: string; name: string; color: string | null }>;
	chunks?: Array<{
		chunkIndex: number;
		chunkText: string;
		charStart: number;
		charEnd: number;
		score: number;
	}>;
};

/**
 * Hybrid search: combines full-text (tsvector) + semantic (pgvector cosine).
 * Results are merged and deduplicated with weighted scoring.
 */
export const searchRoutes = new Elysia({ prefix: "/api/search" })
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

		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
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
				graph,
				graphHops,
				graphBoost,
				includeChunks,
			} = parsed.data;
			const q = rawQ ?? "";
			const offset = (page - 1) * limit;

			if (!q.trim()) return { items: [], total: 0, page, limit };

			// Run full-text and semantic search in parallel
			const [textResults, semanticResults] = await Promise.all([
				fullTextSearch(ctx, q, limit * 2),
				semanticSearch(ctx, q, limit * 2),
			]);

			// Merge results with weighted scoring (0.4 text + 0.6 semantic).
			// When title-first boosting is active, ids in `boostedTitles` get a
			// 3x multiplier and are tagged with `titleMatch: true` so the
			// frontend can badge them.
			const merged = new Map<string, SearchResult>();

			function mapResult(row: RawSearchResult): SearchResult {
				return {
					id: row.id,
					title: row.title,
					snippet: row.snippet,
					score: row.score,
					folder_id: row.folder_id,
					folder_name: row.folder_name,
					created_at: row.created_at,
					updated_at: row.updated_at,
				};
			}

			for (const row of textResults as unknown as RawSearchResult[]) {
				const mapped = mapResult(row);
				mapped.score = row.score * config.HYBRID_TEXT_WEIGHT;
				merged.set(row.id, mapped);
			}

			for (const row of semanticResults as unknown as RawSearchResult[]) {
				const existing = merged.get(row.id);
				if (existing) {
					existing.score += row.score * config.HYBRID_SEMANTIC_WEIGHT;
				} else {
					const mapped = mapResult(row);
					mapped.score = row.score * config.HYBRID_SEMANTIC_WEIGHT;
					merged.set(row.id, mapped);
				}
			}

			// GraphRAG expansion. If the caller asked for graph-augmented
			// results AND graph search is enabled, walk 1-2 hops in AGE from
			// the merged seed docs. Discovered neighbors are merged in with
			// `graph_weight` * base relevance; already-present docs receive a
			// small boost so a document that's both semantically relevant
			// AND graph-related ranks higher than one that's only one of
			// those. Wrapped in try/catch — graph outages must NOT break
			// search.
			if (graph) {
				try {
					await applyGraphExpansion(ctx, merged, {
						maxHops: graphHops ?? 2,
						boost: graphBoost ?? config.GRAPH_EXPANSION_BOOST,
					});
				} catch (err) {
					logger.warn(
						{ err },
						"Graph expansion failed — returning non-graph results",
					);
				}
			}

			// When includeChunks=true, fetch the top-3 most relevant text
			// chunks per document using the same query embedding used for
			// semantic search. We re-compute the embedding here (vs. passing
			// it from semanticSearch) so each stage remains independently
			// callable and the graph-expansion path is unaffected.
			if (includeChunks && merged.size > 0) {
				const docIds = Array.from(merged.keys());
				const docIdList = sql.join(
					docIds.map((id) => sql`${id}`),
					sql`, `,
				);
				try {
					const queryEmbedding = await getEmbedding(q);
					if (!queryEmbedding.every((v) => v === 0)) {
						const embeddingStr = `[${queryEmbedding.join(",")}]`;
						const chunkRows = await withTenant(ctx, async (tx) => {
							return tx.execute(sql`
								SELECT de.document_id, de.chunk_index, de.chunk_text,
								       de.char_start, de.char_end,
								       de.embedding <=> ${embeddingStr}::vector AS score
								FROM document_embeddings de
								WHERE de.document_id IN (${docIdList})
								ORDER BY de.document_id, de.embedding <=> ${embeddingStr}::vector
							`);
						});

						// Group rows by document and keep only top-3 per doc
						const chunksByDoc = new Map<
							string,
							Array<{
								chunkIndex: number;
								chunkText: string;
								charStart: number;
								charEnd: number;
								score: number;
							}>
						>();
						for (const raw of chunkRows as unknown as Array<{
							document_id: string;
							chunk_index: number;
							chunk_text: string;
							char_start: number;
							char_end: number;
							score: number;
						}>) {
							const existing = chunksByDoc.get(raw.document_id) ?? [];
							if (existing.length < 3) {
								existing.push({
									chunkIndex: raw.chunk_index,
									chunkText: raw.chunk_text,
									charStart: raw.char_start,
									charEnd: raw.char_end,
									score: raw.score,
								});
								chunksByDoc.set(raw.document_id, existing);
							}
						}

						for (const [docId, chunks] of chunksByDoc) {
							const result = merged.get(docId);
							if (result) {
								result.chunks = chunks;
							}
						}
					}
				} catch (err) {
					logger.warn(
						{ err },
						"Chunk fetch failed — continuing without chunks",
					);
				}
			}

			// Apply filters (folder, date range, tags) before sort + pagination
			let filtered = Array.from(merged.values());

			if (folder) {
				filtered = filtered.filter((r) => r.folder_id === folder);
			}

			if (category) {
				// The category filter intersects with the merged set. A document
				// qualifies if either (a) its own `category_id` matches, or
				// (b) its folder's `category_id` matches. We resolve (b) by
				// looking up folder→category for every folder id present in
				// the result set, then build a Set for O(1) checks below.
				const allowed = await categoryFilter(ctx, category, filtered);
				filtered = filtered.filter((r) => allowed.has(r.id));
			}

			if (dateFrom) {
				const from = new Date(dateFrom);
				if (!Number.isNaN(from.getTime())) {
					filtered = filtered.filter((r) => new Date(r.created_at) >= from);
				}
			}

			if (dateTo) {
				const to = new Date(dateTo);
				if (!Number.isNaN(to.getTime())) {
					// Include the entire "to" day
					to.setHours(23, 59, 59, 999);
					filtered = filtered.filter((r) => new Date(r.created_at) <= to);
				}
			}

			if (tags) {
				const tagList = tags
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
				if (tagList.length > 0) {
					const allowedIds = await tagFilter(ctx, tagList);
					filtered = filtered.filter((r) => allowedIds.has(r.id));
				}
			}

			// Sort by selected order, then paginate
			switch (sort) {
				case "date_desc":
					filtered.sort(
						(a, b) =>
							new Date(b.created_at).getTime() -
							new Date(a.created_at).getTime(),
					);
					break;
				case "date_asc":
					filtered.sort(
						(a, b) =>
							new Date(a.created_at).getTime() -
							new Date(b.created_at).getTime(),
					);
					break;
				case "name_asc":
					filtered.sort((a, b) => a.title.localeCompare(b.title));
					break;
				case "name_desc":
					filtered.sort((a, b) => b.title.localeCompare(a.title));
					break;
				default:
					filtered.sort((a, b) => b.score - a.score);
					break;
			}
			const total = filtered.length;
			const items = filtered.slice(offset, offset + limit);

			const itemsWithTags = await withTags(ctx, items);
			return { items: itemsWithTags, total, page, limit };
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

		const ctx = await buildTenantContext(request);
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
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
			const results = await withTenant(ctx, async (tx) => {
				return tx.execute(sql`
					SELECT id, title, similarity(title, ${q}) as score
					FROM documents
					WHERE owner_id = ${userId} AND title % ${q}
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

/**
 * Graph-augmented merge step. Given the current `merged` Map of search
 * results, walk the AGE graph from each seed document, and:
 *
 *   - Boost the score of any seed that ALSO shows up as a graph neighbor
 *     (multiplicative — `score += GRAPH_WEIGHT * score`).
 *   - Insert any new (non-seed) graph neighbor with a fixed
 *     `GRAPH_WEIGHT` score. We hydrate its display fields from Postgres
 *     so the row matches the shape of the rest of the merged set, and
 *     we constrain the lookup to the current user so cross-tenant data
 *     never leaks into the result list.
 *
 * Empty map and disabled feature flag both short-circuit to a no-op via
 * `expandResults` — this function never has to defend against those cases.
 */
async function applyGraphExpansion(
	ctx: import("../../api/middleware/tenant").TenantContext,
	merged: Map<string, SearchResult>,
	opts: { maxHops?: number; boost?: number } = {},
): Promise<void> {
	const seedIds = Array.from(merged.keys());
	if (seedIds.length === 0) return;

	// Per-request boost overrides the env default. Used for both
	// boosting existing docs and seeding new neighbor scores so the
	// ranking stays consistent.
	const boost = opts.boost ?? config.GRAPH_EXPANSION_BOOST;

	const expansion = await expandResults(seedIds, opts.maxHops ?? 2);
	if (expansion.size === 0) return;

	const newNeighborIds = new Set<string>();
	for (const neighbors of expansion.values()) {
		for (const n of neighbors) {
			if (!merged.has(n.docId)) newNeighborIds.add(n.docId);
		}
	}

	// Boost already-merged docs that the graph also surfaced.
	for (const neighbors of expansion.values()) {
		for (const n of neighbors) {
			const existing = merged.get(n.docId);
			if (existing) {
				existing.score += boost * existing.score;
			}
		}
	}

	if (newNeighborIds.size === 0) return;

	// Hydrate new neighbor rows from Postgres so they look like the rest
	// of the merged set. `owner_id` is enforced via the RLS policy under
	// the current tenant context — a graph hit on another user's
	// document is silently dropped here so we never expose cross-tenant
	// data.
	const { documents, folders } = await import("@hiai-docs/db/schema");
	const rows = await withTenant(ctx, async (tx) => {
		return tx
			.select({
				id: documents.id,
				title: documents.title,
				folderId: documents.folderId,
				folderName: folders.name,
				createdAt: documents.createdAt,
				updatedAt: documents.updatedAt,
				content: documents.content,
			})
			.from(documents)
			.leftJoin(folders, eq(folders.id, documents.folderId))
			.where(
				and(
					eq(documents.ownerId, ctx.userId),
					inArray(documents.id, Array.from(newNeighborIds)),
				),
			);
	});

	for (const row of rows) {
		if (!row.id || merged.has(row.id)) continue;
		const content = row.content ?? "";
		merged.set(row.id, {
			id: row.id,
			title: row.title,
			snippet: content.slice(0, 200),
			score: boost,
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
		});
	}
}

/**
 * Title-match search used by the title-first hybrid stage.

/**
 * Full-text search using PostgreSQL tsvector + ts_rank.
 */
async function fullTextSearch(
	ctx: import("../../api/middleware/tenant").TenantContext,
	q: string,
	limit: number,
) {
	const tsQuery = sql`plainto_tsquery('english', ${q})`;

	return withTenant(ctx, async (tx) => {
		return tx.execute(sql`
			SELECT d.id, d.title, LEFT(d.content, 200) as snippet,
				ts_rank(d.search_vector, ${tsQuery}) as score,
				d.folder_id, f.name as folder_name, d.created_at, d.updated_at
			FROM documents d
			LEFT JOIN folders f ON f.id = d.folder_id
			WHERE d.owner_id = ${ctx.userId}
				AND d.search_vector @@ ${tsQuery}
			ORDER BY score DESC
			LIMIT ${limit}
		`);
	});
}

/**
 * Semantic search using pgvector cosine similarity.
 * Queries the document_embeddings table against the query embedding.
 */
async function semanticSearch(
	ctx: import("../../api/middleware/tenant").TenantContext,
	q: string,
	limit: number,
) {
	try {
		const queryEmbedding = await getEmbedding(q);

		// Skip if embedding is all zeros (provider failure)
		if (queryEmbedding.every((v) => v === 0)) {
			return [];
		}

		const embeddingStr = `[${queryEmbedding.join(",")}]`;

		return withTenant(ctx, async (tx) => {
			return tx.execute(sql`
				SELECT
					d.id, d.title, LEFT(d.content, 200) as snippet,
					1 - MIN(top.distance) as score,
					d.folder_id, f.name as folder_name, d.created_at, d.updated_at
				FROM (
					SELECT de.document_id, de.embedding <=> ${embeddingStr}::vector AS distance
					FROM document_embeddings de
					WHERE de.embedding IS NOT NULL
					ORDER BY de.embedding <=> ${embeddingStr}::vector
					LIMIT ${limit * 3}
				) top
				JOIN documents d ON d.id = top.document_id
				LEFT JOIN folders f ON f.id = d.folder_id
				WHERE d.owner_id = ${ctx.userId}
				GROUP BY d.id, d.title, d.content, d.folder_id, f.name,
					d.created_at, d.updated_at
				ORDER BY MIN(top.distance)
				LIMIT ${limit}
			`);
		});
	} catch (err) {
		logger.warn({ err }, "Semantic search failed, falling back to text-only");
		return [];
	}
}

/**
 * Resolve the set of document ids that match a category scope.
 *
 * A document is in scope when either:
 *   - its own `category_id` matches `categoryId`, or
 *   - its folder's `category_id` matches `categoryId`.
 *
 * Used to narrow a merged search result list by category. We only look at
 * the `folder_id`s present in `results` to keep the lookup bounded by the
 * candidate set (no full-table scan). Folder ownership is verified via the
 * folder→owner join so users cannot see documents in someone else's folder
 * just by guessing a category UUID.
 *
 * Returns the empty set when no candidates qualify (callers fall through
 * to an empty filtered list without an extra DB call).
 */
async function categoryFilter(
	ctx: import("../../api/middleware/tenant").TenantContext,
	categoryId: string,
	results: Array<{ id: string; folder_id: string | null }>,
): Promise<Set<string>> {
	if (results.length === 0) return new Set();

	const folderIds = Array.from(
		new Set(
			results
				.map((r) => r.folder_id)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	);

	// (1) Documents whose own category_id matches — fetched directly from
	// the DB because the merged result rows do not carry category_id.
	const { documents, folders } = await import("@hiai-docs/db/schema");
	const directRows = await withTenant(ctx, async (tx) => {
		return tx
			.select({ id: documents.id })
			.from(documents)
			.where(
				and(
					eq(documents.ownerId, ctx.userId),
					eq(documents.categoryId, categoryId),
				),
			);
	});
	const direct = new Set(directRows.map((r) => r.id));

	// (2) Documents whose folder's category_id matches.
	if (folderIds.length === 0) return direct;

	const folderRows = await withTenant(ctx, async (tx) => {
		return tx
			.select({ id: folders.id })
			.from(folders)
			.where(
				and(
					eq(folders.ownerId, ctx.userId),
					sql`${folders.id} IN (
						WITH RECURSIVE cat_folders AS (
							SELECT id FROM ${folders} WHERE category_id = ${categoryId} AND owner_id = ${ctx.userId}
							UNION ALL
							SELECT f.id FROM ${folders} f
							JOIN cat_folders cf ON f.parent_id = cf.id
						)
						SELECT id FROM cat_folders
					)`,
					inArray(folders.id, folderIds),
				),
			);
	});
	const matchingFolderIds = new Set(folderRows.map((r) => r.id));
	if (matchingFolderIds.size === 0) return direct;

	const out = new Set<string>(direct);
	for (const r of results) {
		if (r.folder_id && matchingFolderIds.has(r.folder_id)) out.add(r.id);
	}
	return out;
}

/**
 * Return the set of document ids owned by the current user that have at
 * least one of the supplied tag names (ANY semantics — a doc qualifies
 * if it carries any of the requested tags).
 */
async function tagFilter(
	ctx: import("../../api/middleware/tenant").TenantContext,
	tagNames: string[],
): Promise<Set<string>> {
	if (tagNames.length === 0) return new Set();

	// Look up tag ids by name (parameterised — safe against injection).
	const tagRows = await withTenant(ctx, async (tx) => {
		return tx
			.select({ id: tagsTable.id })
			.from(tagsTable)
			.where(
				and(
					eq(tagsTable.ownerId, ctx.userId),
					inArray(tagsTable.name, tagNames),
				),
			);
	});
	if (tagRows.length === 0) return new Set();

	const tagIds = tagRows.map((r) => r.id);

	const docRows = await withTenant(ctx, async (tx) => {
		return tx
			.selectDistinct({ documentId: documentTags.documentId })
			.from(documentTags)
			.where(inArray(documentTags.tagId, tagIds));
	});

	return new Set(docRows.map((r) => r.documentId));
}

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
			.where(inArray(documentTags.documentId, ids));
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

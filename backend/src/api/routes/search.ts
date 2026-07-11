import { documentTags, tags as tagsTable } from "@hiai-docs/db/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { withTenant } from "../../lib/with-tenant";
import { searchDocuments } from "../../search/orchestrator";
import type { SearchExplanation } from "../../search/types";
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
			const domain = await searchDocuments(ctx, {
				query: q,
				page: 1,
				limit: 100,
			});
			let rows = await hydrateResults(ctx, domain.items, includeChunks);
			if (folder) rows = rows.filter((row) => row.folder_id === folder);
			if (category) {
				const allowed = await categoryFilter(ctx, category, rows);
				rows = rows.filter((row) => allowed.has(row.id));
			}
			if (dateFrom) {
				const from = new Date(dateFrom);
				if (!Number.isNaN(from.getTime()))
					rows = rows.filter((row) => new Date(row.created_at) >= from);
			}
			if (dateTo) {
				const to = new Date(dateTo);
				if (!Number.isNaN(to.getTime())) {
					to.setHours(23, 59, 59, 999);
					rows = rows.filter((row) => new Date(row.created_at) <= to);
				}
			}
			if (tags) {
				const tagList = tags
					.split(",")
					.map((tag) => tag.trim())
					.filter(Boolean);
				if (tagList.length > 0) {
					const allowedIds = await tagFilter(ctx, tagList);
					rows = rows.filter((row) => allowedIds.has(row.id));
				}
			}
			switch (sort) {
				case "date_desc":
					rows.sort(
						(a, b) =>
							new Date(b.created_at).getTime() -
							new Date(a.created_at).getTime(),
					);
					break;
				case "date_asc":
					rows.sort(
						(a, b) =>
							new Date(a.created_at).getTime() -
							new Date(b.created_at).getTime(),
					);
					break;
				case "name_asc":
					rows.sort((a, b) => a.title.localeCompare(b.title));
					break;
				case "name_desc":
					rows.sort((a, b) => b.title.localeCompare(a.title));
					break;
				default:
					break;
			}
			const total = rows.length;
			const offset = (page - 1) * limit;
			return { items: rows.slice(offset, offset + limit), total, page, limit };
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

async function hydrateResults(
	ctx: import("../../api/middleware/tenant").TenantContext,
	items: Array<{
		documentId: string;
		score: number;
		explanations: SearchExplanation[];
	}>,
	includeChunks: boolean,
): Promise<SearchResult[]> {
	if (items.length === 0) return [];
	const ids = items.map((item) => item.documentId);
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
			.leftJoin(folders, eq(folders.id, documents.folderId))
			.where(
				and(
					or(
						eq(documents.ownerId, ctx.userId),
						eq(documents.visibility, "public"),
					),
					inArray(documents.id, ids),
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
		// Chunk hydration is deliberately best-effort and tenant-scoped. The
		// orchestrator already owns the query embedding and ranking decisions.
		try {
			const chunks = await withTenant(ctx, async (tx) =>
				tx.execute(sql`
				SELECT document_id, chunk_index, chunk_text, char_start, char_end,
					0::double precision AS score
				FROM document_embeddings
				WHERE document_id IN (${sql.join(
					ids.map((id) => sql`${id}`),
					sql`, `,
				)})
				ORDER BY document_id, chunk_index
			`),
			);
			const byDoc = new Map<string, SearchResult["chunks"]>();
			for (const raw of chunks as unknown as Array<Record<string, unknown>>) {
				const docId = String(raw.document_id ?? "");
				const list = byDoc.get(docId) ?? [];
				if (list.length < 3)
					list.push({
						chunkIndex: Number(raw.chunk_index ?? 0),
						chunkText: String(raw.chunk_text ?? ""),
						charStart: Number(raw.char_start ?? 0),
						charEnd: Number(raw.char_end ?? 0),
						score: Number(raw.score ?? 0),
					});
				byDoc.set(docId, list);
			}
			for (const result of hydrated) result.chunks = byDoc.get(result.id) ?? [];
		} catch (err) {
			logger.warn({ err }, "Chunk hydration failed; continuing without chunks");
		}
	}
	const tagged = await withTags(ctx, hydrated);
	return tagged;
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

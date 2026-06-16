import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { getEmbedding } from "../../embedding";
import { getSessionUserId } from "../../lib/auth-helpers";
import { db } from "../../lib/db";
import { logger } from "../../lib/logger";
import { rateLimitHeaders, searchRateLimiter } from "../middleware/rate-limit";

const searchQuerySchema = z.object({
	q: z.string().optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	sort: z
		.enum(["relevance", "date_desc", "date_asc", "name_asc", "name_desc"])
		.default("relevance"),
});

const suggestQuerySchema = z.object({
	q: z.string().optional(),
});

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
		const rl = await searchRateLimiter(ip);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const parsed = searchQuerySchema.safeParse(query);
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid query", details: parsed.error.flatten() };
		}
		try {
			const { q: rawQ, page, limit, sort } = parsed.data;
			const q = rawQ ?? "";
			const offset = (page - 1) * limit;

			if (!q.trim()) return { items: [], total: 0, page, limit };

			// Run full-text and semantic search in parallel
			const [textResults, semanticResults] = await Promise.all([
				fullTextSearch(userId, q, limit * 2),
				semanticSearch(userId, q, limit * 2),
			]);

			// Merge results with weighted scoring (0.4 text + 0.6 semantic)
			type RawSearchResult = {
				id: string;
				title: string;
				snippet: string;
				score: number;
				folder_id: string | null;
				created_at: string;
				updated_at: string;
			};
			type SearchResult = {
				id: string;
				title: string;
				snippet: string;
				score: number;
				folderId: string | null;
				createdAt: string;
				updatedAt: string;
			};
			const merged = new Map<string, SearchResult>();

			function mapResult(row: RawSearchResult): SearchResult {
				return {
					id: row.id,
					title: row.title,
					snippet: row.snippet,
					score: row.score,
					folderId: row.folder_id,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
				};
			}

			for (const row of textResults as unknown as RawSearchResult[]) {
				const mapped = mapResult(row);
				mapped.score = row.score * 0.4;
				merged.set(row.id, mapped);
			}

			for (const row of semanticResults as unknown as RawSearchResult[]) {
				const existing = merged.get(row.id);
				if (existing) {
					existing.score += row.score * 0.6;
				} else {
					const mapped = mapResult(row);
					mapped.score = row.score * 0.6;
					merged.set(row.id, mapped);
				}
			}

			// Sort by selected order, then paginate
			const allResults = Array.from(merged.values());
			switch (sort) {
				case "date_desc":
					allResults.sort(
						(a, b) =>
							new Date(b.createdAt).getTime() -
							new Date(a.createdAt).getTime(),
					);
					break;
				case "date_asc":
					allResults.sort(
						(a, b) =>
							new Date(a.createdAt).getTime() -
							new Date(b.createdAt).getTime(),
					);
					break;
				case "name_asc":
					allResults.sort((a, b) => a.title.localeCompare(b.title));
					break;
				case "name_desc":
					allResults.sort((a, b) => b.title.localeCompare(a.title));
					break;
				case "relevance":
				default:
					allResults.sort((a, b) => b.score - a.score);
					break;
			}
			const total = allResults.length;
			const items = allResults.slice(offset, offset + limit);

			return { items, total, page, limit };
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
		const rl = await searchRateLimiter(ip);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		const userId = await getSessionUserId(request.headers);
		if (!userId) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		const parsed = suggestQuerySchema.safeParse(query);
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid query", details: parsed.error.flatten() };
		}
		try {
			const q = parsed.data.q ?? "";
			if (!q.trim()) return [];
			const results = await db.execute(sql`
        SELECT id, title, similarity(title, ${q}) as score
        FROM documents
        WHERE owner_id = ${userId} AND title % ${q}
        ORDER BY score DESC LIMIT 5
      `);
			return results;
		} catch (err) {
			logger.error({ err }, "Suggest failed");
			set.status = 500;
			return { error: "Suggest failed" };
		}
	});

/**
 * Full-text search using PostgreSQL tsvector + ts_rank.
 */
async function fullTextSearch(userId: string, q: string, limit: number) {
	const tsQuery = sql`plainto_tsquery('english', ${q})`;

	return db.execute(sql`
    SELECT id, title, LEFT(content, 200) as snippet,
      ts_rank(search_vector, ${tsQuery}) as score,
      folder_id, created_at, updated_at
    FROM documents
    WHERE owner_id = ${userId}
      AND search_vector @@ ${tsQuery}
    ORDER BY score DESC
    LIMIT ${limit}
  `);
}

/**
 * Semantic search using pgvector cosine similarity.
 * Queries the document_embeddings table against the query embedding.
 */
async function semanticSearch(userId: string, q: string, limit: number) {
	try {
		const queryEmbedding = await getEmbedding(q);

		// Skip if embedding is all zeros (provider failure)
		if (queryEmbedding.every((v) => v === 0)) {
			return [];
		}

		const embeddingStr = `[${queryEmbedding.join(",")}]`;

		return db.execute(sql`
      SELECT DISTINCT ON (d.id)
        d.id, d.title, LEFT(d.content, 200) as snippet,
        1 - (de.embedding <=> ${embeddingStr}::vector) as score,
        d.folder_id, d.created_at, d.updated_at
      FROM document_embeddings de
      JOIN documents d ON d.id = de.document_id
      WHERE d.owner_id = ${userId}
        AND de.embedding IS NOT NULL
      ORDER BY d.id, de.embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `);
	} catch (err) {
		logger.warn({ err }, "Semantic search failed, falling back to text-only");
		return [];
	}
}

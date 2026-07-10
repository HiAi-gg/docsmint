/**
 * GraphRAG-aware API routes for external agents (hiai-bob, hiai-amigo, etc.).
 *
 * These endpoints expose the AGE knowledge graph so other agents can
 * build their own RAG context without re-implementing the underlying
 * Cypher traversal logic. All three are feature-flagged behind
 * `GRAPH_SEARCH_ENABLED` and gracefully degrade to empty responses when
 * AGE is unavailable — callers should treat empty `entities` / `related`
 * arrays as "graph lookup yielded nothing", not as an error.
 *
 * Endpoints:
 *   - GET  /api/graph/entities?docId=X
 *       List entities (Person / Organization / Concept / Location / Topic)
 *       linked to a single document via MENTIONS edges.
 *
 *   - GET  /api/graph/related/:docId
 *       Return related documents reachable in 1-2 hops from the given
 *       document, along with the edge type and hop distance.
 *
 *   - POST /api/graph/search
 *       Bulk variant of the two above — given a query and a seed set of
 *       document ids, return the union of all linked entities and related
 *       documents. Useful as a single-call context fetch for an agent
 *       turn.
 */

import { documents, folders } from "@hiai-docs/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { config } from "../../lib/config";
import { getGraphDb } from "../../lib/graph/init";
import {
	expandResults,
	type RelatedDoc,
} from "../../lib/graph/search-expansion";
import { logger } from "../../lib/logger";
import { withTenant } from "../../lib/with-tenant";
import { rateLimitHeaders, searchRateLimiter } from "../middleware/rate-limit";
import { buildTenantContext } from "../middleware/tenant";

const entitiesQuerySchema = z.object({
	docId: z.string().min(1),
});

const relatedParamsSchema = z.object({
	docId: z.string().min(1),
});

const graphSearchBodySchema = z.object({
	query: z.string().optional(),
	docIds: z.array(z.string().min(1)).min(1).max(50),
	maxResults: z.number().int().min(1).max(100).optional(),
});

export interface EntityRef {
	name: string;
	type: string;
}

export interface DocumentNeighbor {
	docId: string;
	relationType: string;
	hopDistance: number;
}

interface DocumentRow {
	id: string;
	title: string;
	content: string | null;
	folderId: string | null;
	folderName: string | null;
	createdAt: Date | string | null;
	updatedAt: Date | string | null;
}

/**
 * Graph endpoints. Registered at `/api/graph`. Each handler is rate-limited
 * with the same bucket as `/api/search` because they're operationally
 * similar (read-heavy, user-scoped, can be called by external agents).
 */
export const graphRoutes = new Elysia({ prefix: "/api/graph" })
	.get(
		"/entities",
		async ({ query, set, request }) => {
			const rl = await applyRateLimit(request, set);
			if (!rl.ok) return rl.response;

			const ctx = await buildTenantContext(request);
			if (ctx.role === "none") {
				set.status = 401;
				return { error: "Unauthorized" };
			}
			const parsed = entitiesQuerySchema.safeParse(query);
			if (!parsed.success) {
				set.status = 400;
				return { error: "Invalid query", details: parsed.error.flatten() };
			}

			if (!config.GRAPH_SEARCH_ENABLED) {
				return { entities: [] };
			}

			try {
				const entities = await fetchDocumentEntities(parsed.data.docId);
				return { entities };
			} catch (err) {
				logger.warn(
					{ err, docId: parsed.data.docId },
					"Graph entities lookup failed — returning empty",
				);
				return { entities: [] };
			}
		},
		{
			detail: {
				tags: ["Graph"],
				summary: "List entities linked to a document",
			},
		},
	)
	.get(
		"/related/:docId",
		async ({ params, set, request }) => {
			const rl = await applyRateLimit(request, set);
			if (!rl.ok) return rl.response;

			const ctx = await buildTenantContext(request);
			if (ctx.role === "none") {
				set.status = 401;
				return { error: "Unauthorized" };
			}
			const parsed = relatedParamsSchema.safeParse(params);
			if (!parsed.success) {
				set.status = 400;
				return { error: "Invalid params", details: parsed.error.flatten() };
			}

			if (!config.GRAPH_SEARCH_ENABLED) {
				return { related: [] };
			}

			try {
				const related = await fetchRelatedDocuments(ctx, parsed.data.docId);
				return { related };
			} catch (err) {
				logger.warn(
					{ err, docId: parsed.data.docId },
					"Graph related lookup failed — returning empty",
				);
				return { related: [] };
			}
		},
		{
			detail: {
				tags: ["Graph"],
				summary: "List related documents via graph traversal",
			},
		},
	)
	.post(
		"/search",
		async ({ body, set, request }) => {
			const rl = await applyRateLimit(request, set);
			if (!rl.ok) return rl.response;

			const ctx = await buildTenantContext(request);
			if (ctx.role === "none") {
				set.status = 401;
				return { error: "Unauthorized" };
			}
			const parsed = graphSearchBodySchema.safeParse(body);
			if (!parsed.success) {
				set.status = 400;
				return { error: "Invalid body", details: parsed.error.flatten() };
			}

			const { query, docIds, maxResults } = parsed.data;

			if (!config.GRAPH_SEARCH_ENABLED) {
				return { query, entities: [], relatedDocs: [] };
			}

			try {
				const result = await graphRagLookup(ctx, docIds, maxResults);
				return { query, ...result };
			} catch (err) {
				logger.warn(
					{ err, docIds: docIds.length },
					"Graph RAG search failed — returning empty",
				);
				return { query, entities: [], relatedDocs: [] };
			}
		},
		{
			detail: {
				tags: ["Graph"],
				summary: "Graph-aware RAG retrieval for agents",
			},
		},
	);

/**
 * Lightweight handle on the Elysia `set` object that lets us mutate
 * status + headers from a helper without depending on the framework's
 * exact `StatusCode` union. The shape mirrors the fields we actually
 * touch (`status` for HTTP code, `headers` for rate-limit headers).
 */
type GraphSet = {
	status?: number | string;
	headers?: Record<string, string | number>;
};

/**
 * Apply the same rate limit + header bookkeeping used by `/api/search` so
 * agent callers don't get a free pass just because they're hitting a
 * different route. Returns a tagged-union describing whether the request
 * is allowed or has been short-circuited with a 429.
 */
async function applyRateLimit(
	request: Request,
	set: GraphSet,
): Promise<
	{ ok: true } | { ok: false; response: { error: string; retryAfter?: number } }
> {
	const ip =
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown";
	const rl = await searchRateLimiter(ip, request);
	if (!rl.allowed) {
		set.status = 429;
		set.headers = rateLimitHeaders(0, rl.retryAfter);
		return { ok: false, response: { error: "Too many requests" } };
	}
	set.headers = rateLimitHeaders(rl.remaining);
	return { ok: true };
}

// ---------------------------------------------------------------------
// AGE lookups
// ---------------------------------------------------------------------

/**
 * Look up entities (Person / Organization / Concept / Location / Topic)
 * connected to the given Document via MENTIONS edges. Returns an empty
 * array if AGE is unreachable or the document has no linked entities.
 */
async function fetchDocumentEntities(docId: string): Promise<EntityRef[]> {
	const sql = await getGraphDb();
	if (!sql) return [];

	const cypher = `
		MATCH (d:Document {id: $docId})-[r:MENTIONS]->(e)
		RETURN labels(e) AS labels, e.name AS name
	`;
	// AGE's cypher() requires a literal dollar-quoted string constant,
	// not a bind parameter — see search-expansion.ts and admin.ts for
	// the same pattern.  cypherDocReplace already escapes $docId via
	// JSON.stringify, so inlining is safe.
	const queryStr = `SELECT * FROM cypher('docs_graph', $$ ${cypherDocReplace(cypher, docId)} $$) AS (labels agtype, name agtype)`;
	const rows = (await sql.unsafe(queryStr)) as Array<{
		labels: string;
		name: string;
	}>;

	const out: EntityRef[] = [];
	for (const row of rows) {
		const labels = parseLabels(row.labels);
		const name = stripQuotes(String(row.name ?? ""));
		if (!name || labels.length === 0) continue;
		const type = labels[0];
		if (!type) continue;
		out.push({ name, type });
	}
	return out;
}

/**
 * Look up related documents for a single seed doc. Returns neighbors
 * reachable in 1-2 hops with their edge type and hop distance. Hydrates
 * titles/snippets from Postgres so callers receive display-ready rows.
 * Cross-tenant docs are filtered out via the RLS policy under the
 * caller's tenant context.
 */
async function fetchRelatedDocuments(
	ctx: import("../../api/middleware/tenant").TenantContext,
	docId: string,
): Promise<DocumentNeighbor[]> {
	const expansion = await expandResults([docId], 2);
	const all = expansion.get(docId) ?? [];
	if (all.length === 0) return [];

	const neighborIds = Array.from(new Set(all.map((r) => r.docId)));
	if (neighborIds.length === 0) return [];

	const allowedIds = await filterToOwnedDocuments(ctx, neighborIds);
	return all.filter((r) => allowedIds.has(r.docId));
}

/**
 * Bulk lookup: for the union of seed documents, return all linked
 * entities and all 1-2 hop related documents. `maxResults` caps the
 * returned `relatedDocs` (entities are unbounded — typical entity sets
 * are small per document).
 */
async function graphRagLookup(
	ctx: import("../../api/middleware/tenant").TenantContext,
	docIds: string[],
	maxResults: number | undefined,
): Promise<{
	entities: EntityRef[];
	relatedDocs: Array<DocumentNeighbor & { title: string; snippet: string }>;
}> {
	const sql = await getGraphDb();
	if (!sql) return { entities: [], relatedDocs: [] };

	const seeds = Array.from(new Set(docIds));
	if (seeds.length === 0) return { entities: [], relatedDocs: [] };

	const entityMap = new Map<string, EntityRef>();
	for (const seed of seeds) {
		const entities = await fetchDocumentEntities(seed);
		for (const e of entities) {
			entityMap.set(`${e.type}:${e.name.toLowerCase()}`, e);
		}
	}

	const expansion = await expandResults(seeds, 2);
	const neighborMap = new Map<string, DocumentNeighbor>();
	for (const neighbors of expansion.values()) {
		for (const n of neighbors) {
			if (n.docId === neighborMap.get(n.docId)?.docId) continue;
			neighborMap.set(n.docId, n);
		}
	}

	const neighborIds = Array.from(neighborMap.keys());
	if (neighborIds.length === 0) {
		return { entities: Array.from(entityMap.values()), relatedDocs: [] };
	}

	const allowedIds = await filterToOwnedDocuments(ctx, neighborIds);
	const ownedNeighborIds = neighborIds.filter((id) => allowedIds.has(id));
	if (ownedNeighborIds.length === 0) {
		return { entities: Array.from(entityMap.values()), relatedDocs: [] };
	}

	const rows = await loadDocumentSummaries(ctx, ownedNeighborIds);
	const byId = new Map<string, DocumentRow>();
	for (const r of rows) byId.set(r.id, r);

	const relatedDocs: Array<
		DocumentNeighbor & { title: string; snippet: string }
	> = [];
	for (const id of ownedNeighborIds) {
		const meta = neighborMap.get(id);
		const row = byId.get(id);
		if (!meta || !row) continue;
		const content = row.content ?? "";
		relatedDocs.push({
			docId: id,
			relationType: meta.relationType,
			hopDistance: meta.hopDistance,
			title: row.title,
			snippet: content.slice(0, 200),
		});
		if (maxResults && relatedDocs.length >= maxResults) break;
	}

	return { entities: Array.from(entityMap.values()), relatedDocs };
}

// ---------------------------------------------------------------------
// Postgres helpers
// ---------------------------------------------------------------------

/**
 * Return the subset of `docIds` that are owned by the current user. Used
 * as a guard before returning any graph-derived row — AGE knows nothing
 * about per-user data isolation, so the RLS policy under the tenant
 * context is the safety boundary.
 */
async function filterToOwnedDocuments(
	ctx: import("../../api/middleware/tenant").TenantContext,
	docIds: string[],
): Promise<Set<string>> {
	if (docIds.length === 0) return new Set();
	const rows = await withTenant(ctx, async (tx) => {
		return tx
			.select({ id: documents.id })
			.from(documents)
			.where(
				and(eq(documents.ownerId, ctx.userId), inArray(documents.id, docIds)),
			);
	});
	return new Set(rows.map((r) => r.id));
}

/**
 * Load the display fields (title, content snippet, folder, timestamps) for
 * a list of document ids. Used by the graph RAG search endpoint so agent
 * callers receive enough information to render the result without an
 * additional fetch.
 */
async function loadDocumentSummaries(
	ctx: import("../../api/middleware/tenant").TenantContext,
	docIds: string[],
): Promise<DocumentRow[]> {
	if (docIds.length === 0) return [];
	return withTenant(ctx, async (tx) => {
		return tx
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
			.where(inArray(documents.id, docIds));
	});
}

// ---------------------------------------------------------------------
// Cypher / AGE result helpers
// ---------------------------------------------------------------------

/**
 * Substitute `$docId` in a Cypher string with a safely-escaped literal.
 * AGE doesn't expose a parameterized `id` slot in the version we use,
 * but the value comes from a validated route param (`z.string().min(1)`),
 * so the inlined literal can't be an injection vector. JSON.stringify
 * handles escaping of any embedded quotes / backslashes.
 */
function cypherDocReplace(cypher: string, docId: string): string {
	return cypher.replace("$docId", JSON.stringify(docId));
}

/**
 * AGE returns `labels(node)` as an agtype array literal like
 * `["Person"]` or `["Organization"]`. Strip the brackets and quotes so
 * we get plain label names back.
 */
function parseLabels(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "[]") return [];
	const inner =
		trimmed.startsWith("[") && trimmed.endsWith("]")
			? trimmed.slice(1, -1)
			: trimmed;
	return inner
		.split(",")
		.map((s) => stripQuotes(s.trim()))
		.filter((s) => s.length > 0);
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Test-only type alias re-export so consumers can type their helpers
 * without reaching into `init.ts`.
 */
export type { RelatedDoc };

/**
 * Test-only export of fetchDocumentEntities so unit tests can verify
 * that the cypher query is sent via sql.unsafe() with dollar-quoting
 * rather than as a postgres-js bind parameter. Not part of the public
 * API surface — prefixed with underscore per project convention.
 */
export { fetchDocumentEntities as _fetchDocumentEntitiesForTests };

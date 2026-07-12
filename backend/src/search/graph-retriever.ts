import { documents } from "@hiai-docs/db/schema";
import type { TenantContext } from "@hiai-docs/db/with-tenant";
import { and, eq, inArray, or } from "drizzle-orm";
import { config } from "../lib/config";
import {
	expandFromQueryPlan,
	expandResults,
	type RelatedDoc,
} from "../lib/graph/search-expansion";
import { withTenant } from "../lib/with-tenant";
import type { QueryPlan, SearchCandidate } from "./types";

export interface GraphRetrieverRequest {
	documentSeeds: string[];
	queryPlan: QueryPlan;
	limit?: number;
	maxHops?: number;
	visibilityScope?: GraphVisibilityScope;
}

export type GraphVisibilityScope =
	| { kind: "admin" }
	| { kind: "public" }
	| { kind: "tenant"; ownerId: string; includePublic: true }
	| { kind: "share"; ownerId: string; allowedDocumentIds: string[] };

interface GraphDocumentVisibilityRow {
	id: string;
	ownerId: string;
	visibility: "private" | "shared" | "public";
}

export interface GraphRetrieverAdapters {
	expandResults?: (
		documentSeeds: string[],
		maxHops: number,
	) => Promise<Map<string, RelatedDoc[]>>;
	expandFromQueryPlan?: (
		queryPlan: QueryPlan,
		limit: number,
	) => Promise<RelatedDoc[]>;
	/** Resolve visibility in the same tenant/share scope as the route. */
	visibleDocumentIds?: (
		ctx: TenantContext,
		documentIds: string[],
		scope: GraphVisibilityScope,
	) => Promise<Set<string>>;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_HOPS = 2;

/**
 * Retrieve graph candidates without allowing AGE to become a visibility
 * boundary. AGE only supplies IDs and relationship evidence; every ID is
 * checked through the caller's tenant scope before becoming a candidate.
 */
export async function retrieveGraphCandidates(
	ctx: TenantContext,
	request: GraphRetrieverRequest,
	adapters: GraphRetrieverAdapters = {},
): Promise<SearchCandidate[]> {
	if (!config.GRAPH_SEARCH_ENABLED) return [];
	const limit = clamp(
		request.limit ?? config.SEARCH_GRAPH_RESULT_LIMIT ?? DEFAULT_LIMIT,
	);
	const maxHops = clampHops(
		request.maxHops ?? config.SEARCH_GRAPH_MAX_HOPS ?? DEFAULT_HOPS,
	);
	const requestedSeeds = dedupe(request.documentSeeds).slice(
		0,
		config.SEARCH_GRAPH_SEED_LIMIT,
	);
	const visibilityScope =
		request.visibilityScope ?? _buildGraphVisibilityScope(ctx);
	const authorizedSeeds =
		requestedSeeds.length === 0
			? new Set<string>()
			: await resolveVisibleIds(
					ctx,
					requestedSeeds,
					adapters.visibleDocumentIds,
					visibilityScope,
				);
	const seeds = requestedSeeds.filter((id) => authorizedSeeds.has(id));
	const expand = adapters.expandResults ?? expandResults;
	const expandQuery = adapters.expandFromQueryPlan ?? expandFromQueryPlan;

	let related: RelatedDoc[] = [];
	if (seeds.length > 0) {
		const bySeed = await expand(seeds, maxHops);
		for (const values of bySeed.values()) related.push(...values);
	} else {
		// No direct seed is available: concepts/entities from the expanded
		// plan are resolved directly to visible documents in AGE.
		related = await expandQuery(request.queryPlan, limit);
	}

	const unique = new Map<string, RelatedDoc>();
	for (const candidate of related) {
		if (!candidate.docId || seeds.includes(candidate.docId)) continue;
		const previous = unique.get(candidate.docId);
		if (!previous || candidate.hopDistance < previous.hopDistance) {
			unique.set(candidate.docId, candidate);
		}
	}
	const ids = [...unique.keys()].slice(0, limit);
	if (ids.length === 0) return [];
	const visible = await resolveVisibleIds(
		ctx,
		ids,
		adapters.visibleDocumentIds,
		visibilityScope,
	);

	return ids
		.filter((id) => visible.has(id))
		.map((id, index) => {
			const evidence = unique.get(id);
			return {
				documentId: id,
				channel: "graph" as const,
				rank: index + 1,
				evidence: `Graph relationship ${evidence?.relationType ?? "RELATED_TO"} at ${evidence?.hopDistance ?? 1} hop(s)`,
			};
		});
}

async function resolveVisibleIds(
	ctx: TenantContext,
	ids: string[],
	adapter?: GraphRetrieverAdapters["visibleDocumentIds"],
	scope: GraphVisibilityScope = _buildGraphVisibilityScope(ctx),
): Promise<Set<string>> {
	if (adapter) return adapter(ctx, ids, scope);
	if (ids.length === 0) return new Set();
	const rows = await withTenant(ctx, async (tx) =>
		tx
			.select({
				id: documents.id,
				ownerId: documents.ownerId,
				visibility: documents.visibility,
			})
			.from(documents)
			.where(
				and(
					inArray(documents.id, ids),
					scope.kind === "admin"
						? undefined
						: scope.kind === "public"
							? eq(documents.visibility, "public")
							: scope.kind === "share"
								? inArray(documents.id, scope.allowedDocumentIds)
								: or(
										eq(documents.ownerId, scope.ownerId),
										eq(documents.visibility, "public"),
									),
				),
			),
	);
	return new Set(
		rows
			.filter((row) =>
				_isGraphDocumentVisible(scope, {
					id: row.id,
					ownerId: row.ownerId,
					visibility: row.visibility,
				}),
			)
			.map((row) => row.id),
	);
}

export function _buildGraphVisibilityScope(
	ctx: TenantContext,
	override?: GraphVisibilityScope,
): GraphVisibilityScope {
	if (override) return override;
	if (ctx.role === "admin") return { kind: "admin" };
	if (ctx.role === "none") return { kind: "public" };
	return { kind: "tenant", ownerId: ctx.userId, includePublic: true };
}

export function _isGraphDocumentVisible(
	scope: GraphVisibilityScope,
	document: GraphDocumentVisibilityRow,
): boolean {
	if (scope.kind === "admin") return true;
	if (scope.kind === "public") return document.visibility === "public";
	if (scope.kind === "share") {
		return scope.allowedDocumentIds.includes(document.id);
	}
	return (
		document.ownerId === scope.ownerId ||
		(scope.includePublic && document.visibility === "public")
	);
}

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = typeof value === "string" ? value.trim() : "";
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function clamp(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(100, Math.floor(value)));
}

function clampHops(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_HOPS;
	return Math.max(1, Math.min(3, Math.floor(value)));
}

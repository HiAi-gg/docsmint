import { documents } from "@hiai-docs/db/schema";
import type { TenantContext } from "@hiai-docs/db/with-tenant";
import { and, eq, inArray } from "drizzle-orm";
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
	const seeds = dedupe(request.documentSeeds).slice(
		0,
		config.SEARCH_GRAPH_SEED_LIMIT,
	);
	const expand = adapters.expandResults ?? expandResults;
	const expandQuery = adapters.expandFromQueryPlan ?? expandFromQueryPlan;

	let related: RelatedDoc[] = [];
	try {
		if (seeds.length > 0) {
			const bySeed = await expand(seeds, maxHops);
			for (const values of bySeed.values()) related.push(...values);
		} else {
			// No direct seed is available: concepts/entities from the expanded
			// plan are resolved directly to visible documents in AGE.
			related = await expandQuery(request.queryPlan, limit);
		}
	} catch {
		return [];
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
): Promise<Set<string>> {
	if (adapter) return adapter(ctx, ids);
	if (ids.length === 0) return new Set();
	const rows = await withTenant(ctx, async (tx) =>
		tx
			.select({ id: documents.id })
			.from(documents)
			.where(
				and(eq(documents.ownerId, ctx.userId), inArray(documents.id, ids)),
			),
	);
	return new Set(rows.map((row) => row.id));
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

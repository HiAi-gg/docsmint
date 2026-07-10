/**
 * GraphRAG search expansion.
 *
 * Given a set of seed document ids, traverse the AGE graph to find related
 * documents within `maxHops` relationship hops and return the edges we
 * crossed. Used by the search route to merge graph-discovered neighbors
 * into the merged result list — graph results are scored lower than direct
 * hits, so the user-visible ordering still favors semantic matches while
 * surface area is broadened by entity/relationship context.
 *
 * Feature-flagged: returns an empty Map when GRAPH_SEARCH_ENABLED is false,
 * when AGE is unreachable, or when no seed ids are provided.
 */

import { config } from "../config";
import { logger } from "../logger";
import { type GraphSqlClient, getGraphDb } from "./init";

const DEFAULT_MAX_HOPS = 2;

export interface RelatedDoc {
	docId: string;
	relationType: string;
	hopDistance: number;
}

/**
 * For each seed document id, find related documents reachable in at most
 * `maxHops` relationship hops in the AGE graph. Returns a Map keyed by
 * the seed doc id; an empty Map means "no graph expansion available".
 *
 * Each value is the list of related documents that the graph traversal
 * discovered from that seed, including the edge type and hop distance.
 */
export async function expandResults(
	docIds: string[],
	maxHops: number = DEFAULT_MAX_HOPS,
): Promise<Map<string, RelatedDoc[]>> {
	const out = new Map<string, RelatedDoc[]>();

	// Normalize the input — the caller-facing name is `docIds` (matches
	// the upstream search-route contract) but inside the function we treat
	// them as seeds for graph traversal.
	const seeds = dedupe(docIds);

	if (!config.GRAPH_SEARCH_ENABLED) return out;
	if (seeds.length === 0) return out;

	const clampedHops = Math.max(1, Math.min(Math.floor(maxHops), 3));

	const sql = await getGraphDb();
	if (!sql) return out;

	try {
		const cypher = buildTraversalCypher(seeds, clampedHops);
		// AGE's cypher() requires a literal dollar-quoted string constant,
		// not a bind parameter. The seed ids are already JSON.stringify-
		// escaped in buildTraversalCypher, so inlining is safe.
		const queryString = `SELECT * FROM cypher('docs_graph', $$ ${cypher} $$) AS (seed_id agtype, neighbor_id agtype, relation agtype, hops agtype)`;
		const rows = (await sql.unsafe(queryString)) as Array<{
			seed_id: string;
			neighbor_id: string;
			relation: string;
			hops: number;
		}>;

		for (const row of rows) {
			const seedId = stripQuotes(String(row.seed_id ?? ""));
			const neighborId = stripQuotes(String(row.neighbor_id ?? ""));
			if (!seedId || !neighborId || seedId === neighborId) continue;
			const relation = stripQuotes(String(row.relation ?? ""));
			const hops = Number(row.hops);
			const hopDistance = Number.isFinite(hops) ? hops : 1;
			const list = out.get(seedId) ?? [];
			list.push({ docId: neighborId, relationType: relation, hopDistance });
			out.set(seedId, list);
		}
	} catch (err) {
		logger.warn({ err, seeds: seeds.length }, "Graph expansion query failed");
	}

	return out;
}

/**
 * Build a Cypher query that, for each seed Document id, walks up to
 * `maxHops` relationship hops in the graph and returns:
 *   - `seed_id`     — the original document id
 *   - `neighbor_id` — a related Document id reachable from it
 *   - `relation`    — the FIRST edge type on the shortest path
 *   - `hops`        — the length of the shortest path
 *
 * Shortest-path semantics matter for ranking: closer neighbors should
 * carry more weight when the search route scores graph results.
 *
 * Path length is bounded to keep traversal cost predictable; AGE's path
 * expansion is `O(branching^hops)` in the worst case.
 */
function buildTraversalCypher(seedIds: string[], maxHops: number): string {
	const seedList = seedIds.map((id) => JSON.stringify(id)).join(", ");
	if (maxHops < 2) {
		return `
			MATCH (seed:Document) WHERE seed.id IN [${seedList}]
			RETURN seed.id AS seed_id, seed.id AS neighbor_id,
			       'MENTIONS' AS relation, 0 AS hops
		`;
	}
	return `
		MATCH (seed:Document)-[:MENTIONS]->(entity)<-[:MENTIONS]-(neighbor:Document)
		WHERE seed.id IN [${seedList}] AND seed <> neighbor
		RETURN DISTINCT seed.id AS seed_id,
		       neighbor.id AS neighbor_id,
		       'MENTIONS' AS relation,
		       2 AS hops
	`;
}

/**
 * Drop empty / duplicate ids so we don't bloat the IN-list passed to Cypher.
 */
function dedupe(ids: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (typeof id !== "string") continue;
		const trimmed = id.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * AGE returns string values wrapped in double quotes (e.g. `"foo"`). Strip
 * the quotes so callers receive plain string ids usable as document ids.
 */
function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Internal helper exposed for tests: build the Cypher used by the traversal.
 * Not part of the public API surface.
 */
export function _buildTraversalCypher(
	seedIds: string[],
	maxHops: number = DEFAULT_MAX_HOPS,
): string {
	return buildTraversalCypher(seedIds, maxHops);
}

/**
 * Test-only type alias — `GraphSqlClient` is re-exported so consumers can
 * write `import type { GraphSqlClient }` without reaching into `init.ts`.
 */
export type { GraphSqlClient };

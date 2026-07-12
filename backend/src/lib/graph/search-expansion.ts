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
 * Feature-flagged: returns an empty Map when GRAPH_SEARCH_ENABLED is false
 * or when no seed ids are provided. AGE query errors are rethrown so the
 * search orchestrator can mark graphFailed while degrading to direct hits.
 */

import type { QueryPlan } from "../../search/types";
import { config } from "../config";
import { logger } from "../logger";
import { type GraphSqlClient, getGraphDbRequired } from "./init";

const DEFAULT_MAX_HOPS = 2;

export interface RelatedDoc {
	docId: string;
	relationType: string;
	hopDistance: number;
}

/**
 * Resolve query-plan concepts and named entities to document vertices. This
 * is deliberately separate from document-seed expansion: a query with no
 * lexical/vector hit still gets one bounded AGE lookup without exposing any
 * hidden document metadata to the caller.
 */
export async function expandFromQueryPlan(
	plan: QueryPlan,
	limit = 20,
): Promise<RelatedDoc[]> {
	if (!config.GRAPH_SEARCH_ENABLED) return [];
	const terms = dedupe([
		...plan.concepts,
		...plan.namedEntities,
		...plan.translations,
		...plan.synonyms,
	]).map((term) => term.toLocaleLowerCase());
	if (terms.length === 0) return [];
	const sql = await getGraphDbRequired();
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));

	try {
		const cypher = buildQuerySeedCypher(terms, boundedLimit);
		const queryString = buildCypherSql(
			cypher,
			"neighbor_id agtype, relation agtype, hops agtype",
		);
		const rows = (await sql.unsafe(queryString)) as Array<{
			neighbor_id: string;
			relation: string;
			hops: number;
		}>;
		const seen = new Set<string>();
		const out: RelatedDoc[] = [];
		for (const row of rows) {
			const docId = stripQuotes(String(row.neighbor_id ?? ""));
			if (!docId || seen.has(docId)) continue;
			seen.add(docId);
			const hops = Number(row.hops);
			out.push({
				docId,
				relationType: stripQuotes(String(row.relation ?? "QUERY_ENTITY")),
				hopDistance: Number.isFinite(hops) ? Math.max(1, hops) : 1,
			});
			if (out.length >= boundedLimit) break;
		}
		return out;
	} catch (err) {
		logger.warn({ err, terms: terms.length }, "Graph query seed lookup failed");
		throw err;
	}
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

	const sql = await getGraphDbRequired();

	try {
		const cypher = buildTraversalCypher(seeds, clampedHops);
		// AGE's cypher() requires a literal dollar-quoted string constant,
		// not a bind parameter. The seed ids are already JSON.stringify-
		// escaped in buildTraversalCypher, so inlining is safe.
		const queryString = buildCypherSql(
			cypher,
			"seed_id agtype, neighbor_id agtype, relation agtype, hops agtype",
		);
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
		throw err;
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
	return `
			MATCH path=(seed:Document)-[:MENTIONS*1..${maxHops}]-(neighbor:Document)
			WHERE seed.id IN [${seedList}] AND seed <> neighbor
			RETURN DISTINCT seed.id AS seed_id,
			       neighbor.id AS neighbor_id,
			       'MENTIONS' AS relation,
			       length(path) AS hops
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

function buildQuerySeedCypher(terms: string[], limit: number): string {
	const termList = terms.map((term) => JSON.stringify(term)).join(", ");
	return `
		MATCH (entity)-[:MENTIONS]-(document:Document)
		WHERE toLower(entity.name) IN [${termList}]
		RETURN DISTINCT document.id AS neighbor_id,
		       'QUERY_ENTITY' AS relation,
		       1 AS hops
		LIMIT ${limit}
	`;
}

/**
 * AGE's cypher() accepts a literal dollar-quoted string, but a fixed `$$`
 * delimiter is unsafe when an LLM or user term contains the same sequence.
 * Select a deterministic tag that cannot occur in the generated body.
 */
function buildCypherSql(cypher: string, columns: string): string {
	let tag = "hiai";
	while (cypher.includes(`$${tag}$`)) tag = `${tag}_x`;
	const quoted = `$${tag}$ ${cypher} $${tag}$`;
	return `SELECT * FROM cypher('docs_graph', ${quoted}) AS (${columns})`;
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

/** Test-only query-seed cypher helper. */
export function _buildQuerySeedCypher(terms: string[], limit = 20): string {
	return buildQuerySeedCypher(
		dedupe(terms),
		Math.max(1, Math.min(Math.floor(limit), 100)),
	);
}

/** Test-only SQL wrapper used to lock down dollar-quote injection safety. */
export function _buildQuerySeedSql(terms: string[], limit = 20): string {
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
	return buildCypherSql(
		buildQuerySeedCypher(dedupe(terms), boundedLimit),
		"neighbor_id agtype, relation agtype, hops agtype",
	);
}

/**
 * Test-only type alias — `GraphSqlClient` is re-exported so consumers can
 * write `import type { GraphSqlClient }` without reaching into `init.ts`.
 */
export type { GraphSqlClient };

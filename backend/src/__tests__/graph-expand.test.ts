import { describe, expect, test } from "bun:test";

describe("graph expand module", () => {
	test("builds an AGE-compatible shared-entity traversal", async () => {
		const { _buildTraversalCypher } = await import(
			"../lib/graph/search-expansion"
		);
		const cypher = _buildTraversalCypher(["doc-1"], 2);
		expect(cypher).toContain("(seed:Document)-[:MENTIONS]->(entity)");
		expect(cypher).toContain("<-[:MENTIONS]-(neighbor:Document)");
		expect(cypher).toContain("RETURN DISTINCT");
		expect(cypher).not.toContain("shortestPath");
	});

	test("expandResults returns empty Map when GRAPH_SEARCH_ENABLED is false", async () => {
		// Force a fresh config read with the flag disabled. The default
		// in `.env` is `false` so the process-wide config already reflects
		// this, but a prior test could have set it via `process.env`.
		const prev = process.env.GRAPH_SEARCH_ENABLED;
		process.env.GRAPH_SEARCH_ENABLED = "false";
		const { _resetGraphForTests } = await import("../lib/graph/init");
		_resetGraphForTests();
		try {
			const { expandResults } = await import("../lib/graph/search-expansion");
			const result = await expandResults(["doc-1", "doc-2"], 2);
			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBe(0);
		} finally {
			if (prev === undefined) delete process.env.GRAPH_SEARCH_ENABLED;
			else process.env.GRAPH_SEARCH_ENABLED = prev;
		}
	});

	test("expandResults returns empty Map when no seed ids are provided", async () => {
		const { expandResults } = await import("../lib/graph/search-expansion");
		const empty = await expandResults([], 2);
		expect(empty.size).toBe(0);

		const withInvalid = await expandResults([""], 2);
		expect(withInvalid.size).toBe(0);
	});
});

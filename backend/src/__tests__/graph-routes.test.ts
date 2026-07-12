/**
 * Tests for graph route cypher safety — N1 remediation.
 *
 * Verifies that fetchDocumentEntities sends the cypher query via
 * sql.unsafe() with dollar-quoting ($$ ... $$) rather than as a
 * postgres-js bind parameter, which AGE's cypher() rejects.
 *
 * The same unsafe + $$ pattern is used by search-expansion.ts,
 * extract-entities.ts, and admin.ts — this test locks it in for
 * the graph route layer.
 *
 * IMPORTANT: mock.module specifiers are resolved RELATIVE TO THE
 * TEST FILE, not relative to the consumer. graph.ts imports from
 * "../../lib/graph/init" but the test at __tests__/graph-routes.test.ts
 * sees it as "../lib/graph/init".
 */

import { describe, expect, mock, test } from "bun:test";

describe("graph routes cypher safety (N1)", () => {
	test("fetchDocumentEntities calls sql.unsafe() with dollar-quoted cypher", async () => {
		// Arrange: mock getGraphDb to return a spy-able sql object
		let capturedQuery: string | undefined;
		const unsafeSpy = mock(async (query: string) => {
			capturedQuery = query;
			return [] as Array<{ labels: string; name: string }>;
		});
		const mockSql = { unsafe: unsafeSpy };

		// mock.module specifier relative to THIS FILE, not graph.ts
		mock.module("../lib/graph/init", () => ({
			getGraphDb: async () => mockSql,
			getGraphDbRequired: async () => mockSql,
			_resetGraphForTests: () => {},
		}));

		// GRAPH_SEARCH_ENABLED isn't checked inside fetchDocumentEntities
		// itself (only at the route-handler level), but set it for realism
		const prev = process.env.GRAPH_SEARCH_ENABLED;
		process.env.GRAPH_SEARCH_ENABLED = "true";
		try {
			const mod = await import("../api/routes/graph");

			// Act: call the test-exported function with a known docId
			await mod._fetchDocumentEntitiesForTests("test-doc-uuid-123");

			// Assert: unsafe() was called (not tagged-template `sql`...)
			expect(unsafeSpy).toHaveBeenCalledTimes(1);
			expect(capturedQuery).toBeDefined();

			// 1. Use cypher('docs_graph', $$ ... $$) — dollar-quoting
			expect(capturedQuery).toContain("$$");
			expect(capturedQuery).toMatch(/cypher\s*\(\s*'docs_graph'\s*,\s*\$\$/);

			// 2. Have the docId inlined in the cypher body
			expect(capturedQuery).toContain("test-doc-uuid-123");

			// 3. NOT contain a postgres-js bind param placeholder $1
			expect(capturedQuery).not.toMatch(/\$1/);

			// 4. Include the canonical cypher wrapper
			expect(capturedQuery).toContain("SELECT * FROM cypher");
			expect(capturedQuery).toContain("labels agtype");
			expect(capturedQuery).toContain("name agtype");
		} finally {
			if (prev === undefined) delete process.env.GRAPH_SEARCH_ENABLED;
			else process.env.GRAPH_SEARCH_ENABLED = prev;
		}
	});

	test("fetchDocumentEntities returns empty array when AGE is unavailable", async () => {
		// Mock getGraphDb to return null (AGE not configured / unreachable)
		mock.module("../lib/graph/init", () => ({
			getGraphDb: async () => null,
			getGraphDbRequired: async () => null,
			_resetGraphForTests: () => {},
		}));

		const mod = await import("../api/routes/graph");
		const result = await mod._fetchDocumentEntitiesForTests("some-doc-id");
		expect(result).toEqual([]);
	});

	test("fetchDocumentEntities safely escapes docId with special characters", async () => {
		let capturedQuery: string | undefined;
		const unsafeSpy = mock(async (query: string) => {
			capturedQuery = query;
			return [] as Array<{ labels: string; name: string }>;
		});
		const mockSql = { unsafe: unsafeSpy };

		mock.module("../lib/graph/init", () => ({
			getGraphDb: async () => mockSql,
			getGraphDbRequired: async () => mockSql,
			_resetGraphForTests: () => {},
		}));

		const mod = await import("../api/routes/graph");

		// docId with single quote and backslash
		await mod._fetchDocumentEntitiesForTests("doc'O'brien\\test");

		expect(unsafeSpy).toHaveBeenCalled();
		expect(capturedQuery).toBeDefined();

		// cypherDocReplace uses JSON.stringify which wraps in double quotes
		// and escapes internal quotes — the docId value should be JSON-safe
		expect(capturedQuery).toMatch(/\$\$.*"doc.*test".*\$\$/s);

		// The postgres-js tagged-template form would have $1 here — verify
		// no bind-param placeholder leaked into the query.
		expect(capturedQuery).not.toMatch(/\$\d/);
	});
});

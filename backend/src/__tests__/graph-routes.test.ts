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
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import type { ContentAccess } from "../lib/content-access";

type GraphAuthorizationTestHelper = (
	executor: {
		execute: (query: unknown) => Promise<unknown>;
	},
	access: ContentAccess,
	documentIds: string[],
) => Promise<Set<string>>;

const databaseUrl = process.env.CONTENT_ACCESS_TEST_DATABASE_URL;

describe("graph routes cypher safety (N1)", () => {
	test("exports the graph authorization helper used by route-level PostgreSQL coverage", async () => {
		const mod = await import("../api/routes/graph");
		const authorize = (
			mod as unknown as {
				_allowedGraphDocumentIdsForTests?: GraphAuthorizationTestHelper;
			}
		)._allowedGraphDocumentIdsForTests;

		expect(typeof authorize).toBe("function");
	});

	test.skipIf(!databaseUrl)(
		"authorizes grandparent-inherited category documents and excludes foreign graph IDs",
		async () => {
			const client = postgres(databaseUrl as string, { max: 1 });
			const dialect = new PgDialect();
			const actorId = crypto.randomUUID();
			const otherOwnerId = crypto.randomUUID();
			const categoryId = crypto.randomUUID();
			const grandparentId = crypto.randomUUID();
			const parentId = crypto.randomUUID();
			const inheritedDocumentId = crypto.randomUUID();
			const foreignDocumentId = crypto.randomUUID();
			const access: ContentAccess = {
				principal: { kind: "session", userId: actorId },
				ctx: {
					userId: actorId,
					role: "user",
					source: "external",
					workspaceId: "workspace-a",
					resourceScope: {
						kind: "category",
						categoryId,
						permissions: ["read"],
					},
				},
				userId: actorId,
				categoryId,
				permissions: new Set(["read"]),
				restricted: true,
				externalRole: "viewer",
			};
			try {
				await client.begin(async (tx) => {
					await tx`CREATE TEMP TABLE folders (id uuid PRIMARY KEY, owner_id uuid NOT NULL, workspace_id text, parent_id uuid, category_id uuid) ON COMMIT DROP`;
					await tx`CREATE TEMP TABLE documents (id uuid PRIMARY KEY, owner_id uuid NOT NULL, workspace_id text, folder_id uuid, category_id uuid, deleted_at timestamptz) ON COMMIT DROP`;
					await tx`SET LOCAL search_path TO pg_temp`;
					await tx`INSERT INTO folders (id, owner_id, workspace_id, parent_id, category_id) VALUES (${grandparentId}::uuid, ${otherOwnerId}::uuid, 'workspace-a', NULL, ${categoryId}::uuid), (${parentId}::uuid, ${otherOwnerId}::uuid, 'workspace-a', ${grandparentId}::uuid, NULL)`;
					await tx`INSERT INTO documents (id, owner_id, workspace_id, folder_id, category_id, deleted_at) VALUES (${inheritedDocumentId}::uuid, ${otherOwnerId}::uuid, 'workspace-a', ${parentId}::uuid, NULL, NULL), (${foreignDocumentId}::uuid, ${otherOwnerId}::uuid, 'workspace-b', NULL, ${categoryId}::uuid, NULL)`;
					const mod = await import("../api/routes/graph");
					const authorize = (
						mod as unknown as {
							_allowedGraphDocumentIdsForTests?: GraphAuthorizationTestHelper;
						}
					)._allowedGraphDocumentIdsForTests;
					expect(typeof authorize).toBe("function");
					if (!authorize) return;
					const executor = {
						execute: async (query: unknown) => {
							const rendered = dialect.sqlToQuery(
								query as Parameters<PgDialect["sqlToQuery"]>[0],
							);
							return tx.unsafe(rendered.sql, rendered.params as never[]);
						},
					};
					await expect(
						authorize(executor, access, [
							inheritedDocumentId,
							foreignDocumentId,
						]),
					).resolves.toEqual(new Set([inheritedDocumentId]));
					const legacyWorkspaceAccess: ContentAccess = {
						...access,
						categoryId: null,
						restricted: false,
						ctx: {
							...access.ctx,
							resourceScope: undefined,
						},
					};
					await expect(
						authorize(executor, legacyWorkspaceAccess, [
							inheritedDocumentId,
							foreignDocumentId,
						]),
					).resolves.toEqual(new Set([inheritedDocumentId]));
				});
			} finally {
				await client.end();
			}
		},
	);

	test("filters stale graph generations and orders current neighbors deterministically", async () => {
		const mod = await import("../api/routes/graph");
		const expansion = new Map([
			[
				"seed",
				[
					{
						docId: "alpha",
						generationId: "old-alpha",
						seedGenerationId: "seed-current",
						relationType: "MENTIONS",
						hopDistance: 1,
					},
					{
						docId: "gamma",
						generationId: "gamma-current",
						seedGenerationId: "seed-current",
						relationType: "MENTIONS",
						hopDistance: 2,
					},
					{
						docId: "beta",
						generationId: "beta-current",
						seedGenerationId: "seed-current",
						relationType: "MENTIONS",
						hopDistance: 1,
					},
					{
						docId: "delta",
						generationId: "delta-current",
						seedGenerationId: "old-seed",
						relationType: "MENTIONS",
						hopDistance: 1,
					},
				],
			],
		]);

		const result = mod._currentGraphNeighborsForTests(
			expansion,
			new Map([
				["seed", "seed-current"],
				["alpha", "alpha-current"],
				["beta", "beta-current"],
				["gamma", "gamma-current"],
				["delta", "delta-current"],
			]),
		);

		expect(result.map((neighbor) => neighbor.docId)).toEqual(["beta", "gamma"]);
	});

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
			await mod._fetchDocumentEntitiesForTests(
				"test-doc-uuid-123",
				"generation-current",
			);

			// Assert: unsafe() was called (not tagged-template `sql`...)
			expect(unsafeSpy).toHaveBeenCalledTimes(1);
			expect(capturedQuery).toBeDefined();

			// 1. Use a collision-resistant dollar-quoted Cypher literal.
			expect(capturedQuery).toContain("$hiai$");
			expect(capturedQuery).toMatch(
				/cypher\s*\(\s*'docs_graph'\s*,\s*\$hiai\$/,
			);

			// 2. Have the docId inlined in the cypher body
			expect(capturedQuery).toContain("test-doc-uuid-123");

			// 3. NOT contain a postgres-js bind param placeholder $1
			expect(capturedQuery).not.toMatch(/\$1/);

			// 4. Include the canonical cypher wrapper
			expect(capturedQuery).toContain("SELECT * FROM cypher");
			expect(capturedQuery).toContain("labels agtype");
			expect(capturedQuery).toContain("name agtype");
			expect(capturedQuery).toContain("generation_id agtype");
		} finally {
			if (prev === undefined) delete process.env.GRAPH_SEARCH_ENABLED;
			else process.env.GRAPH_SEARCH_ENABLED = prev;
		}
	});

	test("fetchDocumentEntities returns only rows from the active graph generation", async () => {
		const unsafeSpy = mock(async () => [
			{
				labels: '["Concept"]',
				name: '"Stale entity"',
				generation_id: '"generation-old"',
			},
			{
				labels: '["Topic"]',
				name: '"Current entity"',
				generation_id: '"generation-current"',
			},
		]);
		const mockSql = { unsafe: unsafeSpy };

		mock.module("../lib/graph/init", () => ({
			getGraphDb: async () => mockSql,
			getGraphDbRequired: async () => mockSql,
			_resetGraphForTests: () => {},
		}));

		const mod = await import("../api/routes/graph");
		const result = await mod._fetchDocumentEntitiesForTests(
			"document-id",
			"generation-current",
		);

		expect(result).toEqual([{ name: "Current entity", type: "Topic" }]);
	});

	test("fetchDocumentEntities returns empty array when AGE is unavailable", async () => {
		// Mock getGraphDb to return null (AGE not configured / unreachable)
		mock.module("../lib/graph/init", () => ({
			getGraphDb: async () => null,
			getGraphDbRequired: async () => null,
			_resetGraphForTests: () => {},
		}));

		const mod = await import("../api/routes/graph");
		const result = await mod._fetchDocumentEntitiesForTests(
			"some-doc-id",
			"generation-current",
		);
		expect(result).toEqual([]);
	});

	test("fetchDocumentEntities uses a collision-resistant delimiter", async () => {
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

		await mod._fetchDocumentEntitiesForTests(
			"doc$$payload",
			"generation-current",
		);

		expect(unsafeSpy).toHaveBeenCalled();
		expect(capturedQuery).toBeDefined();

		expect(capturedQuery).toContain('"doc$$payload"');
		expect(capturedQuery).not.toContain("cypher('docs_graph', $$");
		expect(capturedQuery).toContain("$hiai$");

		// The postgres-js tagged-template form would have $1 here — verify
		// no bind-param placeholder leaked into the query.
		expect(capturedQuery).not.toMatch(/\$\d/);
	});
});

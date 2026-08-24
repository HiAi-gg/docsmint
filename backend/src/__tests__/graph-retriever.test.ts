import { afterEach, describe, expect, test } from "bun:test";
import type { TenantContext } from "@hiai-docs/db/with-tenant";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const queryPlan = {
	original: "topic",
	normalized: "topic",
	detectedLanguage: "en",
	translations: [],
	synonyms: [],
	concepts: [],
	namedEntities: [],
};

async function enableGraphSearchForTest(): Promise<void> {
	const { config } = await import("../lib/config");
	config.GRAPH_SEARCH_ENABLED = true;
}

afterEach(async () => {
	const { config } = await import("../lib/config");
	config.GRAPH_SEARCH_ENABLED = false;
});

describe("graph visibility scope", () => {
	test("uses a workspace scope for legacy unscoped external assertions", async () => {
		const { _buildGraphVisibilityScope } = await import(
			"../search/graph-retriever"
		);

		expect(
			_buildGraphVisibilityScope({
				userId: OWNER,
				role: "user",
				source: "external",
				workspaceId: "workspace-a",
			}),
		).toEqual({ kind: "workspace", workspaceId: "workspace-a" });
	});

	test("drops stale graph generations and orders candidates by hop then document id", async () => {
		await enableGraphSearchForTest();
		const { retrieveGraphCandidates } = await import(
			"../search/graph-retriever"
		);
		const ctx: TenantContext = { userId: OWNER, role: "user" };
		const activeGenerations = new Map([
			["seed", "seed-new"],
			["alpha", "alpha-new"],
			["beta", "beta-new"],
			["gamma", "gamma-new"],
		]);
		const results = await retrieveGraphCandidates(
			ctx,
			{ documentSeeds: ["seed"], queryPlan },
			{
				visibleDocumentIds: async (_ctx, ids) => new Set(ids),
				visibleDocumentGenerations: async (_ctx, ids) =>
					new Map(ids.map((id) => [id, activeGenerations.get(id) ?? null])),
				expandResults: async () =>
					new Map([
						[
							"seed",
							[
								{
									docId: "alpha",
									generationId: "alpha-old",
									seedGenerationId: "seed-new",
									hopDistance: 1,
									relationType: "MENTIONS",
								},
								{
									docId: "gamma",
									generationId: "gamma-new",
									seedGenerationId: "seed-new",
									hopDistance: 1,
									relationType: "MENTIONS",
								},
								{
									docId: "beta",
									generationId: "beta-new",
									seedGenerationId: "seed-new",
									hopDistance: 1,
									relationType: "MENTIONS",
								},
								{
									docId: "alpha",
									generationId: "alpha-new",
									seedGenerationId: "seed-new",
									hopDistance: 2,
									relationType: "MENTIONS",
								},
								{
									docId: "discarded-seed-generation",
									generationId: "discarded-new",
									seedGenerationId: "seed-old",
									hopDistance: 1,
									relationType: "MENTIONS",
								},
							],
						],
					]),
				expandFromQueryPlan: async () => [],
			} as Parameters<typeof retrieveGraphCandidates>[2] & {
				visibleDocumentGenerations: (
					ctx: TenantContext,
					ids: string[],
				) => Promise<Map<string, string | null>>;
			},
		);

		expect(results.map((result) => result.documentId)).toEqual([
			"beta",
			"gamma",
			"alpha",
		]);
	});

	test("authorizes document seeds before they reach the AGE expand adapter", async () => {
		await enableGraphSearchForTest();
		const { retrieveGraphCandidates } = await import(
			"../search/graph-retriever"
		);
		const ctx: TenantContext = { userId: OWNER, role: "user" };
		const expandedSeeds: string[][] = [];
		const visibilityCalls: string[][] = [];

		await retrieveGraphCandidates(
			ctx,
			{
				documentSeeds: ["private-seed", "visible-seed"],
				queryPlan,
			},
			{
				visibleDocumentIds: async (_ctx, ids) => {
					visibilityCalls.push(ids);
					return new Set(ids.filter((id) => id === "visible-seed"));
				},
				expandResults: async (seeds) => {
					expandedSeeds.push(seeds);
					return new Map();
				},
				expandFromQueryPlan: async () => [],
			},
		);

		expect(visibilityCalls).toEqual([["private-seed", "visible-seed"]]);
		expect(expandedSeeds).toEqual([["visible-seed"]]);
	});

	test("falls back to query-plan graph seeds when no document seed is visible", async () => {
		await enableGraphSearchForTest();
		const { retrieveGraphCandidates } = await import(
			"../search/graph-retriever"
		);
		const ctx: TenantContext = { userId: OWNER, role: "user" };
		let queryPlanExpansionCalls = 0;
		let documentExpansionCalls = 0;

		const results = await retrieveGraphCandidates(
			ctx,
			{
				documentSeeds: ["private-seed"],
				queryPlan: { ...queryPlan, concepts: ["authentication"] },
			},
			{
				visibleDocumentIds: async (_ctx, ids) =>
					new Set(ids.filter((id) => id === "query-plan-doc")),
				visibleDocumentGenerations: async (_ctx, ids) =>
					new Map(ids.map((id) => [id, "query-plan-generation"])),
				expandResults: async () => {
					documentExpansionCalls += 1;
					return new Map();
				},
				expandFromQueryPlan: async () => {
					queryPlanExpansionCalls += 1;
					return [
						{
							docId: "query-plan-doc",
							generationId: "query-plan-generation",
							hopDistance: 1,
							relationType: "MENTIONS",
						},
					];
				},
			},
		);

		expect(documentExpansionCalls).toBe(0);
		expect(queryPlanExpansionCalls).toBe(1);
		expect(results[0]?.documentId).toBe("query-plan-doc");
	});

	test("includes public documents without exposing another private owner", async () => {
		const { _buildGraphVisibilityScope, _isGraphDocumentVisible } =
			await import("../search/graph-retriever");
		const ctx: TenantContext = { userId: OWNER, role: "user" };
		const scope = _buildGraphVisibilityScope(ctx);

		expect(scope).toEqual({
			kind: "tenant",
			ownerId: OWNER,
			includePublic: true,
		});
		expect(
			_isGraphDocumentVisible(scope, {
				id: "public-doc",
				ownerId: OTHER,
				visibility: "public",
			}),
		).toBe(true);
		expect(
			_isGraphDocumentVisible(scope, {
				id: "private-doc",
				ownerId: OTHER,
				visibility: "private",
			}),
		).toBe(false);
	});

	test("supports explicit share scopes and public-only contexts", async () => {
		const { _buildGraphVisibilityScope, _isGraphDocumentVisible } =
			await import("../search/graph-retriever");
		const shareScope = _buildGraphVisibilityScope(
			{ userId: OWNER, role: "user" },
			{ kind: "share", ownerId: OWNER, allowedDocumentIds: ["shared-doc"] },
		);
		expect(
			_isGraphDocumentVisible(shareScope, {
				id: "shared-doc",
				ownerId: OTHER,
				visibility: "private",
			}),
		).toBe(true);
		expect(
			_isGraphDocumentVisible(shareScope, {
				id: "other-doc",
				ownerId: OTHER,
				visibility: "private",
			}),
		).toBe(false);

		const publicScope = _buildGraphVisibilityScope({
			userId: "00000000-0000-0000-0000-000000000000",
			role: "none",
		});
		expect(publicScope).toEqual({ kind: "public" });
		expect(
			_isGraphDocumentVisible(publicScope, {
				id: "public-doc",
				ownerId: OTHER,
				visibility: "public",
			}),
		).toBe(true);
		expect(
			_isGraphDocumentVisible(publicScope, {
				id: "private-doc",
				ownerId: OWNER,
				visibility: "private",
			}),
		).toBe(false);
	});
});

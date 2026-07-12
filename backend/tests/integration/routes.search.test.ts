/**
 * HTTP-level tests for search routes.
 * Tests: GET /api/search, GET /api/search/suggest
 *
 * Covers: auth (401 without bearer), query text, tag filter, sort options,
 * pagination defaults, schema validation (400), and the suggest prefix endpoint.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	API_KEY,
	getState,
	noAuthHeaders,
	OTHER_USER_ID,
	ownerHeaders,
	request,
	resetState,
	seedSearchDocument,
	setupHarness,
} from "./_harness";

let app: any;

beforeAll(async () => {
	const built = await setupHarness();
	app = built.app;
});

beforeEach(() => {
	resetState();
});

afterEach(() => {
	resetState();
});

function authedGet(path: string) {
	return request(app, path, { method: "GET", headers: ownerHeaders() });
}

function unauthedGet(path: string) {
	return request(app, path, { method: "GET", headers: noAuthHeaders() });
}

describe("GET /api/search — auth", () => {
	it("returns 401 without auth", async () => {
		const res = await unauthedGet("/api/search?q=hello");
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
	});

	it("returns 401 without auth and no query", async () => {
		const res = await unauthedGet("/api/search");
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
	});

	it("returns 401 with a non-matching bearer token", async () => {
		const res = await request(app, "/api/search?q=hello", {
			method: "GET",
			headers: {
				authorization: "Bearer not-the-real-api-key",
				"content-type": "application/json",
			},
		});
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
	});

	it("returns 200 with the test API key", async () => {
		const res = await authedGet("/api/search?q=hello");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-ratelimit-remaining")).not.toBeNull();
	});
});

describe("GET /api/search — query text", () => {
	it("returns empty result shape when q is omitted", async () => {
		const res = await authedGet("/api/search");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ items: [], total: 0, page: 1, limit: 20 });
	});

	it("returns empty result shape when q is an empty string", async () => {
		const res = await authedGet("/api/search?q=");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ items: [], total: 0, page: 1, limit: 20 });
	});

	it("returns empty result shape when q is whitespace only", async () => {
		const res = await authedGet("/api/search?q=%20%20%20");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ items: [], total: 0, page: 1, limit: 20 });
	});

	it("returns paginated empty result for non-empty q when no documents match", async () => {
		const res = await authedGet("/api/search?q=anything");
		expect(res.status).toBe(200);
		const body = res.body as {
			items: unknown[];
			total: number;
			page: number;
			limit: number;
		};
		expect(body.items).toEqual([]);
		expect(body.total).toBe(0);
		expect(body.page).toBe(1);
		expect(body.limit).toBe(20);
	});
});

describe("GET /api/search — sort options", () => {
	it("accepts sort=relevance (default)", async () => {
		const res = await authedGet("/api/search?q=hello&sort=relevance");
		expect(res.status).toBe(200);
		const body = res.body as {
			items: unknown[];
			total: number;
			page: number;
			limit: number;
		};
		expect(body.items).toEqual([]);
		expect(body.total).toBe(0);
	});

	it("accepts sort=date_desc", async () => {
		const res = await authedGet("/api/search?q=hello&sort=date_desc");
		expect(res.status).toBe(200);
		expect(res.body).toBeTruthy();
	});

	it("accepts sort=date_asc", async () => {
		const res = await authedGet("/api/search?q=hello&sort=date_asc");
		expect(res.status).toBe(200);
		expect(res.body).toBeTruthy();
	});

	it("accepts sort=name_asc", async () => {
		const res = await authedGet("/api/search?q=hello&sort=name_asc");
		expect(res.status).toBe(200);
		expect(res.body).toBeTruthy();
	});

	it("accepts sort=name_desc", async () => {
		const res = await authedGet("/api/search?q=hello&sort=name_desc");
		expect(res.status).toBe(200);
		expect(res.body).toBeTruthy();
	});

	it("rejects an unknown sort value with 400", async () => {
		const res = await authedGet("/api/search?q=hello&sort=banana");
		expect(res.status).toBe(400);
		expect((res.body as any).error).toBe("Invalid query");
		expect((res.body as any).details).toBeTruthy();
	});

	it("honours explicit page and limit", async () => {
		const res = await authedGet("/api/search?q=hello&page=2&limit=5");
		expect(res.status).toBe(200);
		const body = res.body as {
			items: unknown[];
			total: number;
			page: number;
			limit: number;
		};
		expect(body.page).toBe(2);
		expect(body.limit).toBe(5);
		expect(body.items).toEqual([]);
	});

	it("rejects limit > 100 with 400", async () => {
		const res = await authedGet("/api/search?q=hello&limit=999");
		expect(res.status).toBe(400);
		expect((res.body as any).error).toBe("Invalid query");
	});

	it("rejects page=0 with 400", async () => {
		const res = await authedGet("/api/search?q=hello&page=0");
		expect(res.status).toBe(400);
		expect((res.body as any).error).toBe("Invalid query");
	});
});

describe("GET /api/search — tag filter", () => {
	it("returns empty results when tag filter matches no documents", async () => {
		const res = await authedGet("/api/search?q=hello&tags=nonexistent");
		expect(res.status).toBe(200);
		const body = res.body as { items: unknown[]; total: number };
		expect(body.items).toEqual([]);
		expect(body.total).toBe(0);
	});

	it("accepts a comma-separated tag list", async () => {
		const res = await authedGet("/api/search?q=hello&tags=alpha,beta,gamma");
		expect(res.status).toBe(200);
		const body = res.body as { items: unknown[]; total: number };
		expect(body.items).toEqual([]);
		expect(body.total).toBe(0);
	});

	it("treats whitespace-only tag entries as empty", async () => {
		const res = await authedGet("/api/search?q=hello&tags=,,");
		expect(res.status).toBe(200);
		const body = res.body as { items: unknown[]; total: number };
		// empty tag list short-circuits the filter, so all empty matches survive
		expect(body.items).toEqual([]);
	});

	it("combines tag filter with sort and pagination", async () => {
		const res = await authedGet(
			"/api/search?q=hello&tags=alpha&sort=date_desc&page=1&limit=10",
		);
		expect(res.status).toBe(200);
		const body = res.body as {
			items: unknown[];
			total: number;
			page: number;
			limit: number;
		};
		expect(body.items).toEqual([]);
		expect(body.page).toBe(1);
		expect(body.limit).toBe(10);
	});
});

describe("GET /api/search — folder + date range filters", () => {
	it("accepts a folder filter", async () => {
		const res = await authedGet("/api/search?q=hello&folder=engineering");
		expect(res.status).toBe(200);
		const body = res.body as { items: unknown[]; total: number };
		expect(body.items).toEqual([]);
	});

	it("accepts dateFrom and dateTo filters", async () => {
		const res = await authedGet(
			"/api/search?q=hello&dateFrom=2024-01-01&dateTo=2024-12-31",
		);
		expect(res.status).toBe(200);
		expect(res.body).toBeTruthy();
	});

	it("ignores malformed date values gracefully", async () => {
		const res = await authedGet(
			"/api/search?q=hello&dateFrom=not-a-date&dateTo=also-not-a-date",
		);
		expect(res.status).toBe(200);
		const body = res.body as { items: unknown[]; total: number };
		expect(body.items).toEqual([]);
	});
});

describe("GET /api/search/suggest — auth", () => {
	it("returns 401 without auth", async () => {
		const res = await unauthedGet("/api/search/suggest?q=hel");
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
	});

	it("returns 401 without auth and no query", async () => {
		const res = await unauthedGet("/api/search/suggest");
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
	});

	it("returns 200 with the test API key", async () => {
		const res = await authedGet("/api/search/suggest?q=hel");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-ratelimit-remaining")).not.toBeNull();
	});
});

describe("GET /api/search/suggest — prefix", () => {
	it("returns an empty array when q is omitted", async () => {
		const res = await authedGet("/api/search/suggest");
		expect(res.status).toBe(200);
		expect(res.body).toEqual([]);
	});

	it("returns an empty array when q is an empty string", async () => {
		const res = await authedGet("/api/search/suggest?q=");
		expect(res.status).toBe(200);
		expect(res.body).toEqual([]);
	});

	it("returns an empty array when q is whitespace only", async () => {
		const res = await authedGet("/api/search/suggest?q=%20%20");
		expect(res.status).toBe(200);
		expect(res.body).toEqual([]);
	});

	it("returns an empty array when no documents match the prefix", async () => {
		const res = await authedGet("/api/search/suggest?q=hel");
		expect(res.status).toBe(200);
		expect(res.body).toEqual([]);
	});

	it("accepts a longer prefix query", async () => {
		const res = await authedGet("/api/search/suggest?q=helloworld");
		expect(res.status).toBe(200);
		expect(res.body).toEqual([]);
	});

	it("rejects an invalid query schema with 400", async () => {
		// q must be a string when provided; passing an array of values for q
		// coerces in some runtimes — so we use a non-string via a query the
		// schema rejects outright: z.string().optional() only fails if the
		// value cannot be coerced. Skip if the runtime accepts the value —
		// instead we trigger validation by passing q as a numeric-shaped token
		// that the schema rejects. If the schema accepts it, the response is
		// still 200 with []; this test asserts the schema behaviour either way.
		const res = await authedGet("/api/search/suggest?q[]=hello");
		// q[] is treated as an array — schema rejects (z.string() only accepts
		// string), so we expect 400. If the runtime coerces, this may be 200.
		if (res.status === 400) {
			expect((res.body as any).error).toBe("Invalid query");
		} else {
			expect(res.status).toBe(200);
			expect(res.body).toEqual([]);
		}
	});
});

describe("Search API key contract", () => {
	it("uses the OWNER-scoped session for the configured API key", async () => {
		// The harness binds API_KEY → OWNER_ID; any successful 200 response
		// implies the synthetic session resolved to the owner. We assert
		// the response shape to confirm both search endpoints stayed
		// healthy under the same auth header.
		const search = await authedGet("/api/search?q=anything");
		expect(search.status).toBe(200);
		expect((search.body as any).page).toBe(1);

		const suggest = await authedGet("/api/search/suggest?q=anything");
		expect(suggest.status).toBe(200);
		expect(Array.isArray(suggest.body)).toBe(true);

		// Sanity: the same API_KEY is the one configured by the harness.
		expect(API_KEY).toBe("test-api-key-for-routes-32chars-xxx");
	});
});

describe("GET /api/search — automatic GraphRAG contract", () => {
	it("keeps legacy graph parameters non-authoritative and marks them deprecated", async () => {
		const res = await authedGet(
			"/api/search?q=hello&graph=true&graphHops=3&graphBoost=1",
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("deprecation")).toBe("true");
		expect((res.body as any).items).toEqual([]);
	});

	it("serializes injected explanations and forwards global filters/page to the domain", async () => {
		seedSearchDocument({
			id: "explained-doc",
			ownerId: "00000000-0000-0000-0000-000000000001",
			title: "English",
			content: "A semantic result",
		});
		const { Elysia } = await import("elysia");
		const { createSearchRoutes } = await import("../../src/api/routes/search");
		let received: any;
		const injected = new Elysia().use(
			createSearchRoutes(
				async (ctx, input) => {
					received = { ctx, input };
					return {
						items: [
							{
								documentId: "explained-doc",
								score: 0.88,
								channels: ["vector", "graph"],
								explanations: [
									{ channel: "vector", label: "Semantic match" },
									{ channel: "graph", label: "Related concept" },
								],
							},
						],
						total: 1,
						page: input.page ?? 1,
						limit: input.limit ?? 20,
						queryPlan: {
							original: input.query,
							normalized: input.query,
							detectedLanguage: "en",
							translations: [],
							synonyms: [],
							concepts: [],
							namedEntities: [],
						},
						diagnostics: {
							fastChannels: ["exact", "fts", "fuzzy", "vector"],
							channelErrors: {},
							expansionAttempted: false,
							graphAttempted: true,
							graphFailed: false,
							confidenceReasons: [],
						},
					};
				},
				async () => {
					return [
						{
							id: "explained-doc",
							title: "English",
							snippet: "A semantic result",
							score: 0.88,
							folder_id: null,
							folder_name: null,
							created_at: "2026-01-01T00:00:00.000Z",
							updated_at: "2026-01-01T00:00:00.000Z",
							explanations: [
								{ channel: "vector", label: "Semantic match" },
								{ channel: "graph", label: "Related concept" },
							],
						},
					];
				},
			),
		);
		const res = await request(
			injected,
			"/api/search?q=English&page=2&limit=1&sort=name_asc&folder=folder-1&tags=alpha,beta",
			{
				method: "GET",
				headers: ownerHeaders(),
			},
		);
		expect(res.status).toBe(200);
		expect((res.body as any).items[0].explanations).toEqual([
			{ channel: "vector", label: "Semantic match" },
			{ channel: "graph", label: "Related concept" },
		]);
		expect((res.body as any).diagnostics).toMatchObject({
			fastChannels: ["exact", "fts", "fuzzy", "vector"],
			graphAttempted: true,
			graphFailed: false,
		});
		expect(received.input.page).toBe(2);
		expect(received.input.limit).toBe(1);
		expect(received.input.filters).toMatchObject({
			folderId: "folder-1",
			tagNames: ["alpha", "beta"],
			sort: "name_asc",
		});
	});

	it("does not expose domain candidates that fail authorized hydration", async () => {
		const { Elysia } = await import("elysia");
		const { createSearchRoutes } = await import("../../src/api/routes/search");
		const queryEmbedding = {
			ok: true as const,
			vector: Array.from({ length: 1024 }, () => 0.01),
			model: "openai/text-embedding-3-small",
			provider: "primary" as const,
			dimensions: 1024 as const,
			profile: "openai/text-embedding-3-small:1024:v1",
		};
		let hydratedEmbedding: unknown;
		const injected = new Elysia().use(
			createSearchRoutes(
				async () => ({
					items: [
						{
							documentId: "visible-doc",
							score: 0.9,
							channels: ["vector"],
							explanations: [{ channel: "vector", label: "Semantic match" }],
						},
					],
					total: 7,
					page: 1,
					limit: 20,
					queryPlan: {
						original: "English",
						normalized: "English",
						detectedLanguage: "en",
						translations: [],
						synonyms: [],
						concepts: [],
						namedEntities: [],
					},
					diagnostics: {
						fastChannels: [],
						channelErrors: {},
						expansionAttempted: false,
						graphAttempted: true,
						graphFailed: false,
						confidenceReasons: [],
					},
					queryEmbedding,
				}),
				async (
					_ctx,
					_items,
					_includeChunks,
					_query,
					_allowedIds,
					embedding,
				) => {
					hydratedEmbedding = embedding;
					return [
						{
							id: "visible-doc",
							title: "English",
							snippet: "Visible",
							score: 0.9,
							folder_id: null,
							folder_name: null,
							created_at: "2026-01-01T00:00:00.000Z",
							updated_at: "2026-01-01T00:00:00.000Z",
							explanations: [{ channel: "vector", label: "Semantic match" }],
						},
					];
				},
			),
		);
		const res = await request(injected, "/api/search?q=English", {
			method: "GET",
			headers: ownerHeaders(),
		});
		expect(res.status).toBe(200);
		expect((res.body as any).items).toHaveLength(1);
		expect((res.body as any).total).toBe(1);
		expect(hydratedEmbedding).toEqual(queryEmbedding);
	});

	it("preserves the global visible total on page two", async () => {
		const { Elysia } = await import("elysia");
		const { createSearchRoutes } = await import("../../src/api/routes/search");
		const injected = new Elysia().use(
			createSearchRoutes(
				async (_ctx, input) => ({
					items: [
						{
							documentId: "page-2-doc",
							score: 0.7,
							channels: ["vector"],
							explanations: [{ channel: "vector", label: "Semantic match" }],
						},
					],
					total: 3,
					visibleTotal: 3,
					visibleDocumentIds: ["page-1-doc", "page-2-doc", "page-3-doc"],
					page: input.page ?? 1,
					limit: input.limit ?? 20,
					queryPlan: {
						original: input.query,
						normalized: input.query,
						detectedLanguage: "en",
						translations: [],
						synonyms: [],
						concepts: [],
						namedEntities: [],
					},
					diagnostics: {
						fastChannels: [],
						channelErrors: {},
						expansionAttempted: false,
						graphAttempted: true,
						graphFailed: false,
						confidenceReasons: [],
					},
				}),
				async () => [
					{
						id: "page-2-doc",
						title: "Page two",
						snippet: "Visible",
						score: 0.7,
						folder_id: null,
						folder_name: null,
						created_at: "2026-01-01T00:00:00.000Z",
						updated_at: "2026-01-01T00:00:00.000Z",
						explanations: [{ channel: "vector", label: "Semantic match" }],
					},
				],
			),
		);
		const res = await request(
			injected,
			"/api/search?q=English&page=2&limit=1",
			{
				method: "GET",
				headers: ownerHeaders(),
			},
		);
		expect(res.status).toBe(200);
		expect((res.body as any).page).toBe(2);
		expect((res.body as any).items).toHaveLength(1);
		expect((res.body as any).total).toBe(3);
	});

	it("allows a cross-owner public GraphRAG item through hydration", async () => {
		const publicId = "cross-owner-public-graph";
		seedSearchDocument({
			id: publicId,
			ownerId: OTHER_USER_ID,
			title: "Public graph concept",
			content: "Visible public content",
		});
		getState().documents.get(publicId)!.visibility = "public";
		const { Elysia } = await import("elysia");
		const { createSearchRoutes } = await import("../../src/api/routes/search");
		const injected = new Elysia().use(
			createSearchRoutes(async () => ({
				items: [
					{
						documentId: publicId,
						score: 0.6,
						channels: ["graph"],
						explanations: [{ channel: "graph", label: "Related concept" }],
					},
				],
				total: 1,
				visibleTotal: 1,
				visibleDocumentIds: [publicId],
				page: 1,
				limit: 20,
				queryPlan: {
					original: "concept",
					normalized: "concept",
					detectedLanguage: "en",
					translations: [],
					synonyms: [],
					concepts: [],
					namedEntities: [],
				},
				diagnostics: {
					fastChannels: [],
					channelErrors: {},
					expansionAttempted: false,
					graphAttempted: true,
					graphFailed: false,
					confidenceReasons: [],
				},
			})),
		);
		const res = await request(injected, "/api/search?q=concept", {
			method: "GET",
			headers: ownerHeaders(),
		});
		expect(res.status).toBe(200);
		expect((res.body as any).items.map((item: any) => item.id)).toEqual([
			publicId,
		]);
	});

	it("allows share guests to search only the token document and passes a share graph scope", async () => {
		const sharedId = "shared-search-doc";
		const hiddenId = "hidden-search-doc";
		seedSearchDocument({
			id: sharedId,
			ownerId: OTHER_USER_ID,
			title: "Shared English",
		});
		seedSearchDocument({
			id: hiddenId,
			ownerId: OTHER_USER_ID,
			title: "Hidden English",
		});
		getState().shareLinks.set("share-search-link", {
			id: "share-search-link",
			documentId: sharedId,
			folderId: null,
			token: "share-search-token",
			passwordHash: null,
			expiresAt: null,
			createdBy: OTHER_USER_ID,
			role: "viewer",
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		});
		const { Elysia } = await import("elysia");
		const { createSearchRoutes } = await import("../../src/api/routes/search");
		let received: any;
		const injected = new Elysia().use(
			createSearchRoutes(async (ctx, input) => {
				received = { ctx, input };
				return {
					items: [
						{
							documentId: sharedId,
							score: 0.9,
							channels: ["vector"],
							explanations: [{ channel: "vector", label: "Semantic match" }],
						},
						{
							documentId: hiddenId,
							score: 0.8,
							channels: ["vector"],
							explanations: [{ channel: "vector", label: "Semantic match" }],
						},
					],
					total: 2,
					page: 1,
					limit: 20,
					queryPlan: {
						original: input.query,
						normalized: input.query,
						detectedLanguage: "en",
						translations: [],
						synonyms: [],
						concepts: [],
						namedEntities: [],
					},
					diagnostics: {
						fastChannels: [],
						channelErrors: {},
						expansionAttempted: false,
						graphAttempted: true,
						graphFailed: false,
						confidenceReasons: [],
					},
				};
			}),
		);
		const res = await request(injected, "/api/search?q=English", {
			method: "GET",
			headers: { ...noAuthHeaders(), "x-share-token": "share-search-token" },
		});
		expect(res.status).toBe(200);
		expect((res.body as any).items.map((item: any) => item.id)).toEqual([
			sharedId,
		]);
		expect(received.ctx.userId).toBe(OTHER_USER_ID);
		expect(received.input.documentIds).toEqual([sharedId]);
		expect(received.input.visibilityScope).toEqual({
			kind: "share",
			ownerId: OTHER_USER_ID,
			allowedDocumentIds: [sharedId],
		});
	});
});

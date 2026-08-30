import { describe, expect, test } from "bun:test";

interface OpenApiOperation {
	security?: Array<Record<string, string[]>>;
	summary?: string;
	description?: string;
	responses?: Record<string, unknown>;
}

interface OpenApiDocument {
	info: { version: string };
	paths: Record<string, Record<string, OpenApiOperation>>;
	components: {
		schemas: Record<string, Record<string, unknown>>;
		securitySchemes: Record<
			string,
			{ type: string; in?: string; name?: string }
		>;
	};
}

const openApiUrl = new URL("../../../docs/openapi.json", import.meta.url);
const spec = (await Bun.file(openApiUrl).json()) as OpenApiDocument;
const committedInventory = (await Bun.file(
	new URL("../../../docs/http-route-inventory.json", import.meta.url),
).json()) as string[];
const HTTP_METHODS = new Set([
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"head",
	"options",
	"trace",
]);

const requiredOperations = [
	["post", "/api/auth/update-user"],
	["post", "/api/auth/change-email"],
	["post", "/api/keys/global"],
	["post", "/api/categories/{id}/keys"],
	["get", "/api/keys"],
	["get", "/api/keys/{id}/secret"],
	["delete", "/api/keys/{id}"],
	["get", "/api/categories"],
	["post", "/api/categories"],
	["patch", "/api/categories/{id}"],
	["delete", "/api/categories/{id}"],
	["get", "/api/documents/{id}/pipeline"],
	["post", "/api/documents/{id}/attachments/presign"],
	["post", "/api/documents/{id}/attachments/confirm"],
	["delete", "/api/attachments/{id}"],
	["get", "/api/attachments/remote-image"],
	["post", "/api/documents/{id}/publish"],
	["post", "/api/documents/{id}/unpublish"],
	["get", "/api/documents/{id}/versions/"],
	["post", "/api/documents/{id}/versions/"],
] as const;

const backendRouteEvidence = [
	["../api/routes/auth.ts", '"/update-user"'],
	["../api/routes/auth.ts", '"/change-email"'],
	["../api/routes/keys.ts", '.post("/keys/global"'],
	["../api/routes/keys.ts", '.post("/categories/:id/keys"'],
	["../api/routes/keys.ts", '.get("/keys/:id/secret"'],
	["../api/routes/keys.ts", '.get("/keys"'],
	["../api/routes/keys.ts", '.delete("/keys/:id"'],
	["../api/routes/categories.ts", '.get("/categories"'],
	["../api/routes/categories.ts", '.post("/categories"'],
	["../api/routes/categories.ts", '.patch("/categories/:id"'],
	["../api/routes/documents.ts", '.get("/documents/:id/pipeline"'],
	["../api/routes/attachments.ts", '"/documents/:id/attachments/presign"'],
	["../api/routes/attachments.ts", '"/documents/:id/attachments/confirm"'],
	["../api/routes/attachments.ts", '.delete("/attachments/:id"'],
	["../api/routes/attachments.ts", '.get("/attachments/remote-image"'],
	["../api/routes/visibility.ts", '.post("/documents/:id/publish"'],
	["../api/routes/visibility.ts", '.post("/documents/:id/unpublish"'],
	["../api/routes/versions.ts", 'prefix: "/api/documents/:id/versions"'],
	["../api/routes/versions.ts", '.post("/"'],
] as const;

describe("OpenAPI external integration contract", () => {
	test("matches the exact frozen runtime HTTP route and method inventory", () => {
		const openApiInventory = Object.entries(spec.paths)
			.flatMap(([path, operations]) =>
				Object.keys(operations)
					.filter((method) => HTTP_METHODS.has(method.toLowerCase()))
					.map((method) => `${method.toUpperCase()} ${path}`),
			)
			.sort();
		expect(openApiInventory).toEqual(committedInventory);
		expect(new Set(committedInventory).size).toBe(committedInventory.length);
	});
	test("tracks the release version and critical SDK, CLI, and MCP routes", () => {
		expect(spec.info.version).toBe("0.7.6");
		for (const [method, path] of requiredOperations) {
			expect(
				spec.paths[path]?.[method],
				`${method.toUpperCase()} ${path}`,
			).toBeDefined();
		}
	});

	test("documents signed category-scoped workspace assertions and index authorization", () => {
		const scope = spec.components.schemas.WorkspaceResourceScope;
		const assertion = spec.components.schemas.WorkspaceAssertionPayload;
		const pipeline = spec.components.schemas.DocsDocumentPipeline;
		const indexStatus = spec.components.schemas.DocsDocumentIndexStatus;
		const indexRefresh = spec.components.schemas.DocsDocumentIndexRefresh;
		if (!scope || !assertion || !pipeline || !indexStatus || !indexRefresh) {
			throw new Error("Workspace assertion schemas must be published");
		}
		expect(scope).toMatchObject({
			type: "object",
			properties: {
				kind: { type: "string", enum: ["category"] },
				categoryId: { format: "uuid" },
				permissions: { type: "array" },
			},
		});
		expect(assertion.description).toContain("server-to-server");
		expect(assertion.properties).toMatchObject({
			workspaceId: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				pattern: "^\\S(?:.*\\S)?$",
			},
		});
		expect(spec.paths["/api/documents/{id}/index-status"]?.get).toMatchObject({
			summary: "Read document index status",
		});
		expect(
			spec.paths["/api/documents/{id}/index-status"]?.get?.responses?.["200"],
		).toMatchObject({
			description: "Document index status.",
			content: {
				"application/json": {
					schema: { $ref: "#/components/schemas/DocsDocumentIndexStatus" },
				},
			},
		});
		expect(spec.paths["/api/documents/{id}/index/refresh"]?.post).toMatchObject(
			{
				summary: "Refresh document index",
			},
		);
		expect(
			spec.paths["/api/documents/{id}/index/refresh"]?.post?.description,
		).toContain("write");
		expect(
			spec.paths["/api/documents/{id}/index/refresh"]?.post?.responses?.["202"],
		).toMatchObject({
			description: "Document index refresh accepted.",
			content: {
				"application/json": {
					schema: { $ref: "#/components/schemas/DocsDocumentIndexRefresh" },
				},
			},
		});
		expect(indexStatus).toMatchObject({
			type: "object",
			required: [
				"documentId",
				"embeddingStatus",
				"activeGenerationId",
				"pendingGenerationId",
				"embeddingProfile",
				"embeddingErrorCode",
				"embeddingUpdatedAt",
				"searchable",
				"pipeline",
			],
		});
		expect(indexRefresh).toMatchObject({
			type: "object",
			required: ["documentId", "generationId", "deduplicated"],
		});
		expect(pipeline).toMatchObject({
			type: "object",
			nullable: true,
		});
		expect(
			(indexStatus.properties as Record<string, unknown>).pipeline,
		).toEqual({
			$ref: "#/components/schemas/DocsDocumentPipeline",
		});

		for (const operation of [
			spec.paths["/api/documents/{id}/index-status"]?.get,
			spec.paths["/api/documents/{id}/index/refresh"]?.post,
		]) {
			for (const status of ["400", "401", "403", "404", "429"]) {
				const response = operation?.responses?.[status] as {
					description?: unknown;
				};
				expect(response?.description).toEqual(expect.any(String));
				expect((response?.description as string).trim().length).toBeGreaterThan(
					0,
				);
			}
		}

		const assertNoReferenceSiblings = (value: unknown): void => {
			if (!value || typeof value !== "object") return;
			const record = value as Record<string, unknown>;
			if ("$ref" in record) expect(Object.keys(record)).toEqual(["$ref"]);
			for (const nested of Object.values(record)) {
				if (Array.isArray(nested)) nested.forEach(assertNoReferenceSiblings);
				else assertNoReferenceSiblings(nested);
			}
		};
		assertNoReferenceSiblings(spec.paths["/api/documents/{id}/index-status"]);
		assertNoReferenceSiblings(spec.paths["/api/documents/{id}/index/refresh"]);
	});

	test("matches the exact route fragments mounted by the backend", async () => {
		for (const [sourcePath, fragment] of backendRouteEvidence) {
			const source = await Bun.file(
				new URL(sourcePath, import.meta.url),
			).text();
			expect(source, `${sourcePath}: ${fragment}`).toContain(fragment);
		}
	});

	test("declares browser, bearer API-key, and operator header authentication", () => {
		expect(spec.components.securitySchemes.SessionAuth).toMatchObject({
			type: "apiKey",
			in: "cookie",
		});
		expect(spec.components.securitySchemes.BearerAuth).toMatchObject({
			type: "http",
		});
		expect(spec.components.securitySchemes.OperatorApiKey).toEqual(
			expect.objectContaining({
				type: "apiKey",
				in: "header",
				name: "x-api-key",
			}),
		);
	});

	test("does not claim that API keys can manage other API keys", () => {
		for (const [method, path] of [
			["post", "/api/keys/global"],
			["post", "/api/categories/{id}/keys"],
			["get", "/api/keys"],
			["get", "/api/keys/{id}/secret"],
			["delete", "/api/keys/{id}"],
		] as const) {
			expect(spec.paths[path]?.[method]?.security).toEqual([
				{ SessionAuth: [] },
			]);
		}
	});

	test("publishes the stable account-fence response for visibility and key revocation", async () => {
		for (const [method, path] of [
			["post", "/api/documents/{id}/publish"],
			["post", "/api/documents/{id}/unpublish"],
			["delete", "/api/keys/{id}"],
		] as const) {
			expect(spec.paths[path]?.[method]?.responses?.["409"]).toEqual({
				$ref: "#/components/responses/AccountPurgeFenced",
			});
		}
		for (const sourcePath of [
			"../api/routes/visibility.ts",
			"../api/routes/keys.ts",
		]) {
			const source = await Bun.file(
				new URL(sourcePath, import.meta.url),
			).text();
			expect(source).toContain("isAccountPurgeFencedError");
			expect(source).toContain("accountPurgeFencedResponse()");
		}
	});
});

import { describe, expect, test } from "bun:test";

interface OpenApiOperation {
	security?: Array<Record<string, string[]>>;
}

interface OpenApiDocument {
	info: { version: string };
	paths: Record<string, Record<string, OpenApiOperation>>;
	components: {
		securitySchemes: Record<
			string,
			{ type: string; in?: string; name?: string }
		>;
	};
}

const openApiUrl = new URL("../../../docs/openapi.json", import.meta.url);
const spec = (await Bun.file(openApiUrl).json()) as OpenApiDocument;

const requiredOperations = [
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
	["get", "/api/documents/{id}/versions"],
	["post", "/api/documents/{id}/versions"],
] as const;

const backendRouteEvidence = [
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
	test("tracks the release version and critical SDK, CLI, and MCP routes", () => {
		expect(spec.info.version).toBe("0.2.8");
		for (const [method, path] of requiredOperations) {
			expect(
				spec.paths[path]?.[method],
				`${method.toUpperCase()} ${path}`,
			).toBeDefined();
		}
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
});

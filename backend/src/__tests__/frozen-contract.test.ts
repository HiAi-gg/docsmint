import { expect, test } from "bun:test";

const root = new URL("../../../", import.meta.url);
const activeContractFiles = [
	"backend/src/lib/config-schema.ts",
	"backend/src/lib/external-tenant-context.ts",
	"backend/src/api/middleware/tenant.ts",
	"backend/src/lib/content-access.ts",
	"packages/sdk/src/client.ts",
	"packages/sdk/src/types.ts",
	"packages/sdk/src/workspace.ts",
	"frontend/src/lib/api/categories.ts",
	"docs/openapi.json",
	".env.example",
	"docker-compose.yml",
	"docker-compose.dev.yml.example",
] as const;

test("0.5.0 frozen contract has no active legacy workspace, category, or MinIO aliases", async () => {
	for (const file of activeContractFiles) {
		const source = await Bun.file(new URL(file, root)).text();
		expect(source, file).not.toContain("EXTERNAL_TENANT");
		expect(source, file).not.toContain("externalTenant");
		expect(source, file).not.toContain("x-hiai-tenant-context");
		expect(source, file).not.toContain('"general"');
		expect(source, file).not.toContain("minioadmin");
		expect(source, file).not.toContain("MINIO_");
	}
});

test("the canonical collaboration route is documented separately from HTTP OpenAPI", async () => {
	const collaboration = await Bun.file(
		new URL("backend/src/api/routes/collaboration.ts", root),
	).text();
	expect(collaboration).toContain('ws("/api/ws/collab/:documentId"');
	expect(collaboration).not.toContain('ws("/ws/collab/:documentId"');
	const api = await Bun.file(new URL("docs/API.md", root)).text();
	expect(api).toContain("/api/ws/collab/:documentId");
});

test("the executable collaboration router mounts only the canonical WebSocket path", async () => {
	const { collaborationRoutes } = await import("../api/routes/collaboration");
	const websocketPaths = collaborationRoutes.routes
		.filter((route) => route.method === "WS")
		.map((route) => route.path);
	expect(websocketPaths).toEqual(["/api/ws/collab/:documentId"]);
	expect(websocketPaths).not.toContain("/ws/collab/:documentId");
});

test("the complete 0.5.0 exports, extensions, workspace assertion, and routes match the frozen snapshot", async () => {
	const snapshot = (await Bun.file(
		new URL("docs/frozen-contract-0.5.0.json", root),
	).json()) as {
		version: string;
		packageExports: Record<string, unknown>;
		extensionManifestKeys: string[];
		workspace: {
			header: string;
			assertionFields: string[];
			actorRoles: string[];
			ttlSeconds: number;
		};
		httpRoutes: string[];
		webSocketRoutes: string[];
	};
	const manifest = (await Bun.file(
		new URL("package.public.json", root),
	).json()) as { version: string; exports: Record<string, unknown> };
	const routeInventory = (await Bun.file(
		new URL("docs/http-route-inventory.json", root),
	).json()) as string[];
	const extensionTypes = await Bun.file(
		new URL("frontend/src/lib/extensions/types.ts", root),
	).text();
	const workspaceTypes = await Bun.file(
		new URL("packages/sdk/src/workspace.ts", root),
	).text();

	expect(snapshot.version).toBe("0.5.0");
	expect(manifest.version).toMatch(/^0\.(?:5\.\d+|6\.\d+|7\.\d+|8\.\d+)$/);
	for (const [exportPath, exportContract] of Object.entries(
		snapshot.packageExports,
	)) {
		expect(manifest.exports[exportPath], exportPath).toEqual(exportContract);
	}
	for (const route of snapshot.httpRoutes) {
		expect(routeInventory, route).toContain(route);
	}
	for (const key of snapshot.extensionManifestKeys) {
		expect(extensionTypes, key).toContain(`${key}: readonly `);
	}
	expect(workspaceTypes).toContain(
		`DOCSMINT_WORKSPACE_CONTEXT_HEADER = "${snapshot.workspace.header}"`,
	);
	expect(workspaceTypes).toContain(
		`DOCSMINT_WORKSPACE_ASSERTION_TTL_SECONDS = ${snapshot.workspace.ttlSeconds}`,
	);
	for (const field of snapshot.workspace.assertionFields) {
		expect(workspaceTypes, field).toContain(`${field}:`);
	}
	for (const role of snapshot.workspace.actorRoles) {
		expect(workspaceTypes, role).toContain(`"${role}"`);
	}
	expect(workspaceTypes).toContain("resourceScope?: WorkspaceResourceScope");
	expect(snapshot.webSocketRoutes).toEqual(["WS /api/ws/collab/:documentId"]);
});

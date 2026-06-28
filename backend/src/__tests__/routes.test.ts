import { describe, expect, test } from "bun:test";

describe("API route modules", () => {
	test("documentRoutes loads without error", async () => {
		const mod = await import("../api/routes/documents");
		expect(mod.documentRoutes).toBeDefined();
	});

	test("folderRoutes loads without error", async () => {
		const mod = await import("../api/routes/folders");
		expect(mod.folderRoutes).toBeDefined();
	});

	test("tagRoutes loads without error", async () => {
		const mod = await import("../api/routes/tags");
		expect(mod.tagRoutes).toBeDefined();
	});

	test("searchRoutes loads without error", async () => {
		const mod = await import("../api/routes/search");
		expect(mod.searchRoutes).toBeDefined();
	});

	test("shareRoutes loads without error", async () => {
		const mod = await import("../api/routes/share");
		expect(mod.shareRoutes).toBeDefined();
	});

	test("versionRoutes loads without error", async () => {
		const mod = await import("../api/routes/versions");
		expect(mod.versionRoutes).toBeDefined();
	});

	test("authRoutes loads without error", async () => {
		const mod = await import("../api/routes/auth");
		expect(mod.authRoutes).toBeDefined();
	});

	test("graphRoutes loads without error", async () => {
		const mod = await import("../api/routes/graph");
		expect(mod.graphRoutes).toBeDefined();
	});
});

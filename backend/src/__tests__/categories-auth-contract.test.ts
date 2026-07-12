import { describe, expect, test } from "bun:test";

const ROUTE_PATH = new URL("../api/routes/categories.ts", import.meta.url)
	.pathname;

describe("category route authorization contract", () => {
	test("resolves scoped principals for every category handler", async () => {
		const source = await Bun.file(ROUTE_PATH).text();
		expect(source.match(/resolveContentAccess\(request\)/g)).toHaveLength(4);
		expect(source).not.toContain("buildTenantContext(request)");
	});

	test("requires read scope and restricts category keys to their category", async () => {
		const source = await Bun.file(ROUTE_PATH).text();
		expect(source).toContain('canAccessContent(access, "read")');
		expect(source).toContain("eq(categories.id, access.categoryId)");
		expect(source).toContain("if (!access.categoryId) return []");
	});

	test("does not expose API-access configuration to content keys", async () => {
		const source = await Bun.file(ROUTE_PATH).text();
		expect(source).toContain('access.principal?.kind === "api-key"');
		for (const field of [
			"apiMode",
			"apiPermissionRead",
			"apiPermissionEdit",
			"apiPermissionWrite",
		]) {
			expect(source).toContain(`${field}: _${field}`);
		}
	});

	test("keeps create, update, and delete in management scope", async () => {
		const source = await Bun.file(ROUTE_PATH).text();
		expect(
			source.match(/!isCategoryManager\(access\.principal\)/g),
		).toHaveLength(3);
		expect(
			source.match(/Browser session or operator credential required/g),
		).toHaveLength(3);
	});
});

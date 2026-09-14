import { describe, expect, test } from "bun:test";

const root = new URL("../../../", import.meta.url);

const saasProductTerms = [
	"/billing",
	"/subscription",
	"/stripe",
	"/checkout",
	"/invoice",
	"/api/chat",
	"/invite",
	"/invitation",
] as const;

describe("public 0.5.0 surface compatibility", () => {
	test("preserves frozen 0.5.0 exports, routes, and packaging identity without built artifacts", async () => {
		const snapshot = (await Bun.file(
			new URL("docs/frozen-contract-0.5.0.json", root),
		).json()) as {
			version: string;
			packageExports: Record<string, unknown>;
			httpRoutes: string[];
		};
		const published = (await Bun.file(
			new URL("package.public.json", root),
		).json()) as {
			version: string;
			exports: Record<string, unknown>;
			bin: Record<string, string>;
			files: string[];
		};
		const inventory = (await Bun.file(
			new URL("docs/http-route-inventory.json", root),
		).json()) as string[];

		expect(snapshot.version).toBe("0.5.0");
		expect(published.version).toMatch(/^0\.8\.\d+$/);
		for (const [exportPath, exportContract] of Object.entries(
			snapshot.packageExports,
		)) {
			expect(published.exports[exportPath], exportPath).toEqual(exportContract);
		}
		for (const route of snapshot.httpRoutes) {
			expect(inventory).toContain(route);
		}
		expect(published.bin["docsmint-mcp"]).toBe("./dist/mcp-cli.js");
		expect(published.files).toContain("dist");
		for (const term of saasProductTerms) {
			expect(inventory.join("\n")).not.toContain(term);
		}
	});
});

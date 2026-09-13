import { describe, expect, test } from "bun:test";
import { DocsClient } from "@hiai-docs/sdk";

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

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("public 0.5.0 surface compatibility", () => {
	test("resolves frozen 0.5.0 and published exports to in-place artifacts", async () => {
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

		const exportEntries = Object.values(published.exports);
		for (const entry of exportEntries) {
			const paths =
				typeof entry === "string"
					? [entry]
					: Object.values(entry as Record<string, string>);
			for (const relative of paths) {
				if (!relative.startsWith("./")) continue;
				const onDisk = relative.startsWith("./dist/")
					? new URL(`packages/sdk/${relative.slice(2)}`, root)
					: new URL(relative, root);
				expect(await Bun.file(onDisk).exists(), relative).toBe(true);
			}
		}
		expect(
			await Bun.file(new URL("packages/sdk/dist/index.js", root)).exists(),
		).toBe(true);
		expect(
			await Bun.file(new URL("packages/sdk/dist/mcp-server.js", root)).exists(),
		).toBe(true);
		expect(
			await Bun.file(new URL("packages/sdk/dist/mcp-cli.js", root)).exists(),
		).toBe(true);
		expect(published.bin["docsmint-mcp"]).toBe("./dist/mcp-cli.js");
		expect(published.files).toContain("dist");
		for (const term of saasProductTerms) {
			expect(inventory.join("\n")).not.toContain(term);
		}
	});

	test("SDK client exercises health, search, and document create without billing routes", async () => {
		const seen: string[] = [];
		const docs = new DocsClient({
			baseUrl: "https://docs.example.test",
			apiKey: "surface-key",
			retries: 0,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				seen.push(`${init?.method ?? "GET"} ${url}`);
				if (url.endsWith("/api/health")) {
					return jsonResponse({ status: "ok", service: "docsmint" });
				}
				if (url.includes("/api/search")) {
					return jsonResponse({ items: [], total: 0, page: 1, limit: 20 });
				}
				if (url.endsWith("/api/documents") && init?.method === "POST") {
					return jsonResponse({ id: "doc-1", title: "Created" }, 201);
				}
				return jsonResponse({ items: [], total: 0, page: 1, limit: 20 });
			}) as typeof fetch,
		});
		await expect(docs.health()).resolves.toMatchObject({
			service: "docsmint",
		});
		await expect(docs.search("locks")).resolves.toMatchObject({ total: 0 });
		await expect(docs.createDoc({ title: "Created" })).resolves.toMatchObject({
			id: "doc-1",
		});
		expect(seen.some((entry) => entry.includes("/api/health"))).toBe(true);
		expect(seen.some((entry) => entry.includes("/api/search"))).toBe(true);
		expect(seen.some((entry) => entry.includes("/api/documents"))).toBe(true);
		expect(seen.join("\n")).not.toContain("/billing");
		expect(seen.join("\n")).not.toContain("/api/chat");
	});
});

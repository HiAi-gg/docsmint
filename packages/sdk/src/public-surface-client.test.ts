import { describe, expect, test } from "bun:test";
import { DocsClient } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("public surface SDK client", () => {
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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { client } from "./client.js";
import { handler as exportDocument } from "./tools/export-document.js";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.HIAI_DOCS_URL;
const originalApiKey = process.env.HIAI_DOCS_API_KEY;

beforeEach(() => {
	process.env.HIAI_DOCS_URL = "https://docs.example.test/";
	process.env.HIAI_DOCS_API_KEY = "test-api-key";
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalUrl === undefined) delete process.env.HIAI_DOCS_URL;
	else process.env.HIAI_DOCS_URL = originalUrl;
	if (originalApiKey === undefined) delete process.env.HIAI_DOCS_API_KEY;
	else process.env.HIAI_DOCS_API_KEY = originalApiKey;
});

describe("hiai-docs MCP REST client contract", () => {
	test("sends the configured API key as a bearer authorization header", async () => {
		const fetchMock = mock(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ items: [], total: 0, page: 1, limit: 20 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await client.listDocuments({});

		const request = fetchMock.mock.calls[0];
		expect(request?.[0].toString()).toBe(
			"https://docs.example.test/api/documents",
		);
		expect(request?.[1]?.headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer test-api-key",
		});
	});

	test("creates snapshots through the versions collection endpoint", async () => {
		const fetchMock = mock(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ id: "version-1", isSnapshot: true }, { status: 201 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await client.createSnapshot("document/with slash", { label: "Release" });

		const request = fetchMock.mock.calls[0];
		expect(request?.[0].toString()).toBe(
			"https://docs.example.test/api/documents/document%2Fwith%20slash/versions",
		);
		expect(request?.[1]?.method).toBe("POST");
		expect(request?.[1]?.body).toBe(JSON.stringify({ label: "Release" }));
	});

	test("normalizes text/markdown exports to the documented object shape", async () => {
		globalThis.fetch = mock(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response("# Exported document\n", {
					headers: { "Content-Type": "text/markdown; charset=utf-8" },
				}),
		) as unknown as typeof fetch;

		await expect(client.exportDocument("document-1")).resolves.toEqual({
			markdown: "# Exported document\n",
		});
		await expect(exportDocument({ id: "document-1" })).resolves.toEqual({
			markdown: "# Exported document\n",
		});
	});
});

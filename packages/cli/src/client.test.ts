import { afterEach, describe, expect, test } from "bun:test";
import { client } from "./client.js";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.HIAI_DOCS_URL;
const originalApiKey = process.env.HIAI_DOCS_API_KEY;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalUrl === undefined) delete process.env.HIAI_DOCS_URL;
	else process.env.HIAI_DOCS_URL = originalUrl;
	if (originalApiKey === undefined) delete process.env.HIAI_DOCS_API_KEY;
	else process.env.HIAI_DOCS_API_KEY = originalApiKey;
});

describe("CLI API authentication", () => {
	test("sends the configured API key as an Authorization Bearer header", async () => {
		process.env.HIAI_DOCS_URL = "https://docs.example.test";
		process.env.HIAI_DOCS_API_KEY = "category-test-key";
		const captured: { authorization?: string | null } = {};
		globalThis.fetch = (async (_input, init) => {
			captured.authorization = new Headers(init?.headers).get("Authorization");
			return Response.json({ items: [], total: 0, page: 1, limit: 20 });
		}) as typeof fetch;

		await client.listDocuments({});

		expect(captured.authorization).toBe("Bearer category-test-key");
	});
});

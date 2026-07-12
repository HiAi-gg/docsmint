import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	apiKeyClipboardValue,
	categoryIdFromScopes,
	createCategoryApiKey,
	createGlobalApiKey,
	revealCategoryApiKey,
	revokeApiKey,
} from "./api-keys";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("API key client", () => {
	test("uses dedicated global and category issuance endpoints", async () => {
		const requests: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return new Response(
				JSON.stringify({ id: "id", prefix: "prefix", key: "raw" }),
				{
					status: 201,
					headers: { "content-type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;
		await createGlobalApiKey();
		await createCategoryApiKey("11111111-1111-4111-8111-111111111111");
		expect(requests).toEqual([
			"/api/keys/global",
			"/api/categories/11111111-1111-4111-8111-111111111111/keys",
		]);
	});

	test("revokes by encoded id and parses category metadata from scopes", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		await expect(revokeApiKey("key/id")).resolves.toEqual({ success: true });
		const categoryId = "11111111-1111-4111-8111-111111111111";
		expect(categoryIdFromScopes([`category:${categoryId}:read`])).toBe(
			categoryId,
		);
		expect(categoryIdFromScopes(["global"])).toBeNull();
	});

	test("copies a transient raw key and safely falls back to the stored prefix", () => {
		const key = { prefix: "hiai_abc123" };
		expect(apiKeyClipboardValue(key, "hiai_secret")).toBe("hiai_secret");
		expect(apiKeyClipboardValue(key)).toBe("hiai_abc123");
	});

	test("reveals a category key through the owner-authenticated secret endpoint", async () => {
		const requests: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return new Response(JSON.stringify({ key: "category-secret" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		await expect(revealCategoryApiKey("key/id")).resolves.toBe(
			"category-secret",
		);
		expect(requests).toEqual(["/api/keys/key%2Fid/secret"]);
	});
});

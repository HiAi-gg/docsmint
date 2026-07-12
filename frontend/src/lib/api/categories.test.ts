import { afterEach, describe, expect, mock, test } from "bun:test";
import { updateCategory, updateCategoryInputSchema } from "./categories";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("category API client", () => {
	test("preserves a zero order when validating a category reorder", () => {
		expect(updateCategoryInputSchema.parse({ order: 0 })).toEqual({ order: 0 });
	});

	test("sends the category order in the PATCH request body", async () => {
		let requestBody: BodyInit | null | undefined;
		globalThis.fetch = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = init?.body;
				return new Response(
					JSON.stringify({
						id: "category-id",
						name: "Category",
						order: 0,
						createdAt: "2026-07-12T00:00:00.000Z",
						updatedAt: "2026-07-12T00:00:00.000Z",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		) as unknown as typeof fetch;

		await updateCategory("category/id", { order: 0 });

		expect(requestBody).toBe(JSON.stringify({ order: 0 }));
	});
});

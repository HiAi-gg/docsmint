import { describe, expect, test } from "bun:test";
import {
	buildCategoryApiKeyScopes,
	categoryIdFromApiKeyScopes,
	GLOBAL_API_SCOPE,
} from "../lib/api-keys";

describe("API key access scopes", () => {
	const categoryId = "11111111-1111-4111-8111-111111111111";

	test("builds category scopes only from enabled permissions", () => {
		expect(
			buildCategoryApiKeyScopes(categoryId, {
				read: true,
				edit: false,
				write: true,
			}),
		).toEqual([`category:${categoryId}:read`, `category:${categoryId}:write`]);
	});

	test("recovers category identity without exposing key material", () => {
		expect(categoryIdFromApiKeyScopes([`category:${categoryId}:read`])).toBe(
			categoryId,
		);
		expect(categoryIdFromApiKeyScopes([GLOBAL_API_SCOPE])).toBeNull();
	});
});

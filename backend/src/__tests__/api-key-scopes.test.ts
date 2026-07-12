import { describe, expect, test } from "bun:test";
import {
	buildCategoryApiKeyScopes,
	categoryIdFromApiKeyScopes,
	GLOBAL_API_SCOPE,
	parseApiKeyScopes,
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

	test("accepts only canonical global and category permission scopes", () => {
		expect(parseApiKeyScopes([GLOBAL_API_SCOPE])).toEqual([GLOBAL_API_SCOPE]);
		expect(
			parseApiKeyScopes([
				`category:${categoryId}:read`,
				`category:${categoryId}:edit`,
			]),
		).toEqual([`category:${categoryId}:read`, `category:${categoryId}:edit`]);
	});

	test("fails closed on malformed, unknown, non-array, and duplicate scopes", () => {
		expect(parseApiKeyScopes(undefined)).toBeNull();
		expect(parseApiKeyScopes([])).toBeNull();
		expect(parseApiKeyScopes(["admin"])).toBeNull();
		expect(parseApiKeyScopes(["category:not-a-uuid:read"])).toBeNull();
		expect(parseApiKeyScopes([`category:${categoryId}:delete`])).toBeNull();
		expect(parseApiKeyScopes([GLOBAL_API_SCOPE, GLOBAL_API_SCOPE])).toBeNull();
	});
});

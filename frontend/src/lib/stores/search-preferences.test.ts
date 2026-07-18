import { describe, expect, test } from "bun:test";
import {
	DEFAULT_SEARCH_PREFERENCES,
	normalizeSearchPreferences,
	readSearchPreferences,
} from "./search-preferences";

describe("search preferences", () => {
	test("keeps GraphRAG enabled by default", () => {
		expect(DEFAULT_SEARCH_PREFERENCES.graphSearchEnabled).toBe(true);
	});

	test("accepts only an explicit graph preference", () => {
		expect(normalizeSearchPreferences({ graphSearchEnabled: false })).toEqual({
			graphSearchEnabled: false,
		});
		expect(normalizeSearchPreferences({ graphSearchEnabled: "false" })).toEqual(
			{
				graphSearchEnabled: true,
			},
		);
	});

	test("reads the persisted preference without requiring the Svelte runtime", () => {
		expect(
			readSearchPreferences({
				getItem: () => JSON.stringify({ graphSearchEnabled: false }),
			}),
		).toEqual({ graphSearchEnabled: false });
	});

	test("fails closed to the enabled default for malformed storage", () => {
		expect(readSearchPreferences({ getItem: () => "{" })).toEqual({
			graphSearchEnabled: true,
		});
	});
});

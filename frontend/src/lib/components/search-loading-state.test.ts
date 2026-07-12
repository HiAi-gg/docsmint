import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const searchPage = readFileSync(
	resolve(import.meta.dir, "../../routes/(app)/search/+page.svelte"),
	"utf8",
);

describe("semantic search loading state", () => {
	test("keeps the empty state hidden while adaptive search is running", () => {
		expect(searchPage).toContain("{#if loading}");
		expect(searchPage).toContain("{@render loadingState()}");
		expect(searchPage).toContain("{:else if !hasAnyLocalMatches}");
		expect(searchPage).toContain('aria-busy="true"');
		expect(searchPage).toContain("search_semantic_search_in_progress");
	});

	test("ignores stale completions from overlapping searches", () => {
		expect(searchPage).toContain(
			"const requestGeneration = ++searchRequestGeneration",
		);
		expect(
			searchPage.match(/requestGeneration !== searchRequestGeneration/g)
				?.length,
		).toBe(2);
		expect(searchPage).toContain("searchResponse = null");
	});
});

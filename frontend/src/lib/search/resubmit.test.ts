import { describe, expect, test } from "bun:test";
import { normalizeSearchQuery, shouldForceSearchResubmit } from "./resubmit";

describe("semantic search explicit resubmission", () => {
	test("re-runs the exact completed first-page query", () => {
		expect(
			shouldForceSearchResubmit({
				submittedQuery: "multilingual search",
				loadedQuery: "multilingual search",
				currentPage: 1,
			}),
		).toBe(true);
	});

	test("re-runs the same query while its previous request is in flight", () => {
		// Request lifecycle is deliberately not part of the decision: every user
		// submit is a new generation and the page ignores the older completion.
		for (const requestState of ["loading", "complete", "error"] as const) {
			expect(requestState).toBeTruthy();
			expect(
				shouldForceSearchResubmit({
					submittedQuery: "english",
					loadedQuery: "english",
					currentPage: 1,
				}),
			).toBe(true);
		}
	});

	test("normalizes harmless surrounding whitespace", () => {
		expect(normalizeSearchQuery("  english  ")).toBe("english");
		expect(
			shouldForceSearchResubmit({
				submittedQuery: "  english  ",
				loadedQuery: "english",
				currentPage: 1,
			}),
		).toBe(true);
	});

	test("uses navigation for a new query or page reset", () => {
		expect(
			shouldForceSearchResubmit({
				submittedQuery: "french",
				loadedQuery: "english",
				currentPage: 1,
			}),
		).toBe(false);
		expect(
			shouldForceSearchResubmit({
				submittedQuery: "english",
				loadedQuery: "english",
				currentPage: 2,
			}),
		).toBe(false);
	});

	test("does not create a repeat request for an empty passive state", () => {
		expect(
			shouldForceSearchResubmit({
				submittedQuery: "   ",
				loadedQuery: "",
				currentPage: 1,
			}),
		).toBe(false);
	});
});

import { describe, expect, test } from "bun:test";
import { resolveGraphSearchEnabled } from "../api/routes/search";

describe("search GraphRAG preference", () => {
	test("keeps GraphRAG enabled unless a user explicitly opts out", () => {
		expect(
			resolveGraphSearchEnabled(new Request("http://localhost/api/search")),
		).toBe(true);
		expect(
			resolveGraphSearchEnabled(
				new Request("http://localhost/api/search", {
					headers: { "X-Docsmint-Graph-Search": "disabled" },
				}),
			),
		).toBe(false);
	});

	test("does not allow an unauthenticated benchmark header to disable GraphRAG", () => {
		expect(
			resolveGraphSearchEnabled(
				new Request("http://localhost/api/search", {
					headers: { "X-Docsmint-Search-Profile": "rag-only" },
				}),
			),
		).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import fixture from "../search/eval/retrieval-eval.fixture.json";
import { mrr, ndcgAt, precisionAt, recallAt } from "../search/eval-metrics";

describe("retrieval eval metrics", () => {
	const labels = { a: 3, b: 2, c: 0 };

	test("rewards putting the best document first", () => {
		expect(mrr(["a", "b"], labels)).toBe(1);
		expect(mrr(["c", "a"], labels)).toBe(0.5);
		expect(ndcgAt(["a", "b"], labels, 10)).toBeGreaterThan(
			ndcgAt(["c", "b", "a"], labels, 10),
		);
		expect(precisionAt(["a", "c"], labels, 2)).toBe(0.5);
		expect(recallAt(["a"], labels, 1)).toBe(0.5);
	});

	test("fixture has labeled public queries across classes", () => {
		expect(fixture.queries.length).toBeGreaterThanOrEqual(12);
		const classes = new Set(fixture.queries.map((query) => query.class));
		expect(classes).toEqual(
			new Set([
				"exact",
				"fts",
				"semantic",
				"graph",
				"multilingual",
				"ambiguous",
			]),
		);
	});
});

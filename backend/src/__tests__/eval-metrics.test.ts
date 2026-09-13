import { describe, expect, test } from "bun:test";
import fixture from "../search/eval/retrieval-eval.fixture.json";
import {
	dcg,
	mrr,
	ndcgAt,
	precisionAt,
	recallAt,
} from "../search/eval-metrics";

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

	test("nDCG is DCG of the ranking divided by DCG of the ideal gain vector", () => {
		const graded = { a: 3, b: 2 };
		expect(ndcgAt(["b", "a"], graded, 10)).toBe(dcg([2, 3]) / dcg([3, 2]));
		expect(ndcgAt(["a", "b"], graded, 10)).toBe(1);
		expect(dcg([3])).toBe(3 / Math.log2(2));
		expect(dcg([3, 1])).toBe(3 / Math.log2(2) + 1 / Math.log2(3));
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

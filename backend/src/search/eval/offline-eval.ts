import { mrr, ndcgAt, precisionAt, recallAt } from "../eval-metrics";
import type { RankedSearchResult } from "../types";
import rawFixture from "./retrieval-eval.fixture.json";

export interface EvalDoc {
	id: string;
	title: string;
	text: string;
}

export interface EvalQuery {
	id: string;
	query: string;
	class: string;
	labels: Record<string, number>;
}

export interface OfflineEvalRow {
	id: string;
	class: string;
	mrr: number;
	ndcg10: number;
	p5: number;
	r10: number;
}

export interface OfflineEvalSummary {
	mode: "baseline";
	live: false;
	queryCount: number;
	MRR: number;
	nDCG10: number;
	P5: number;
	Recall10: number;
}

export function roundMetric(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function finiteLabels(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object") {
		throw new Error("eval query labels must be an object");
	}
	const labels: Record<string, number> = {};
	for (const [id, gain] of Object.entries(value)) {
		if (typeof gain !== "number" || !Number.isFinite(gain)) {
			throw new Error(`eval label ${id} must be a finite number`);
		}
		labels[id] = gain;
	}
	return labels;
}

export function loadEvalFixture(raw: {
	documents: readonly {
		id: string;
		title: string;
		text: string;
	}[];
	queries: readonly {
		id: string;
		query: string;
		class: string;
		labels: object;
	}[];
}): { documents: EvalDoc[]; queries: EvalQuery[] } {
	return {
		documents: raw.documents.map((document) => ({
			id: document.id,
			title: document.title,
			text: document.text,
		})),
		queries: raw.queries.map((query) => ({
			id: query.id,
			query: query.query,
			class: query.class,
			labels: finiteLabels(query.labels),
		})),
	};
}

function tokens(value: string): string[] {
	return value
		.toLocaleLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length > 1);
}

function overlapScore(query: string, text: string): number {
	const queryTokens = new Set(tokens(query));
	if (queryTokens.size === 0) return 0;
	const docTokens = tokens(text);
	let hits = 0;
	for (const token of docTokens) {
		if (queryTokens.has(token)) hits++;
	}
	return hits / queryTokens.size;
}

function rankByScore(
	scored: Array<{ id: string; score: number }>,
): RankedSearchResult[] {
	return [...scored]
		.sort((left, right) => right.score - left.score)
		.map((item) => ({
			documentId: item.id,
			score: item.score,
			channels: ["fts" as const],
			explanations: [],
		}));
}

/** Title-only overlap used by `eval:retrieval --mode=baseline`. */
export function lexicalRank(
	query: string,
	documents: readonly EvalDoc[],
): RankedSearchResult[] {
	return rankByScore(
		documents.map((doc) => ({
			id: doc.id,
			score: overlapScore(query, `${doc.title} ${doc.title}`),
		})),
	);
}

export function fullTextRank(
	query: string,
	documents: readonly EvalDoc[],
): RankedSearchResult[] {
	return rankByScore(
		documents.map((doc) => ({
			id: doc.id,
			score: overlapScore(query, `${doc.title} ${doc.text}`),
		})),
	);
}

export function evaluateOfflineBaseline(): {
	summary: OfflineEvalSummary;
	rows: OfflineEvalRow[];
	documents: EvalDoc[];
	queries: EvalQuery[];
} {
	const { documents, queries } = loadEvalFixture({
		documents: rawFixture.documents,
		queries: rawFixture.queries.map((query) => ({
			id: query.id,
			query: query.query,
			class: query.class,
			labels: query.labels,
		})),
	});
	const rows = queries.map((query) => {
		const ranked = lexicalRank(query.query, documents).map(
			(item) => item.documentId,
		);
		return {
			id: query.id,
			class: query.class,
			mrr: mrr(ranked, query.labels),
			ndcg10: ndcgAt(ranked, query.labels, 10),
			p5: precisionAt(ranked, query.labels, 5),
			r10: recallAt(ranked, query.labels, 10),
		};
	});
	const mean = (pick: (row: OfflineEvalRow) => number) =>
		rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
	return {
		documents,
		queries,
		rows: rows.map((row) => ({
			...row,
			mrr: roundMetric(row.mrr),
			ndcg10: roundMetric(row.ndcg10),
			p5: roundMetric(row.p5),
			r10: roundMetric(row.r10),
		})),
		summary: {
			mode: "baseline",
			live: false,
			queryCount: rows.length,
			MRR: roundMetric(mean((row) => row.mrr)),
			nDCG10: roundMetric(mean((row) => row.ndcg10)),
			P5: roundMetric(mean((row) => row.p5)),
			Recall10: roundMetric(mean((row) => row.r10)),
		},
	};
}

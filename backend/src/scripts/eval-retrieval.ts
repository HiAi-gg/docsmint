/**
 * Offline retrieval eval. Default mode never calls a provider.
 *
 * bun --env-file=.env backend/src/scripts/eval-retrieval.ts --mode=baseline
 * bun --env-file=.env backend/src/scripts/eval-retrieval.ts --mode=rerank --live
 */
import fixture from "../search/eval/retrieval-eval.fixture.json";
import {
	mrr,
	ndcgAt,
	percentile,
	precisionAt,
	recallAt,
} from "../search/eval-metrics";
import { applyRerankOrder } from "../search/rerank";
import { requestRerank } from "../search/rerank-provider";
import type { RankedSearchResult } from "../search/types";

interface EvalDoc {
	id: string;
	title: string;
	text: string;
}

interface EvalQuery {
	id: string;
	query: string;
	class: string;
	labels: Record<string, number>;
}

const docs = fixture.documents as unknown as EvalDoc[];
const queries = fixture.queries as unknown as EvalQuery[];

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

function lexicalRank(query: string): RankedSearchResult[] {
	return rankByScore(
		docs.map((doc) => ({
			id: doc.id,
			score: overlapScore(query, `${doc.title} ${doc.title}`),
		})),
	);
}

function fullTextRank(query: string): RankedSearchResult[] {
	return rankByScore(
		docs.map((doc) => ({
			id: doc.id,
			score: overlapScore(query, `${doc.title} ${doc.text}`),
		})),
	);
}

function parseArgs(argv: string[]): {
	mode: "baseline" | "rerank";
	live: boolean;
	topN: number;
} {
	let mode: "baseline" | "rerank" = "baseline";
	let live = false;
	let topN = 20;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--mode=rerank" || arg === "--mode=baseline") {
			mode = arg.endsWith("rerank") ? "rerank" : "baseline";
		}
		if (arg === "--live") live = true;
		if (arg.startsWith("--candidate-top-n=")) {
			topN = Number(arg.slice("--candidate-top-n=".length)) || 20;
		}
	}
	return { mode, live, topN };
}

async function rankQuery(
	query: EvalQuery,
	mode: "baseline" | "rerank",
	live: boolean,
	topN: number,
): Promise<string[]> {
	const baseline = lexicalRank(query.query);
	if (mode === "baseline") return baseline.map((item) => item.documentId);
	if (!live) {
		return fullTextRank(query.query).map((item) => item.documentId);
	}
	const window = baseline.slice(0, Math.min(topN, baseline.length));
	const result = await requestRerank({
		query: query.query,
		candidates: window.map((item) => {
			const doc = docs.find((entry) => entry.id === item.documentId);
			return {
				id: item.documentId,
				text: `${doc?.title ?? ""}\n${doc?.text ?? ""}`,
			};
		}),
		topN,
	});
	if (!result) return baseline.map((item) => item.documentId);
	return applyRerankOrder(baseline, result.hits, topN).map(
		(item) => item.documentId,
	);
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	const rows: Array<{
		id: string;
		class: string;
		mrr: number;
		ndcg10: number;
		p5: number;
		r10: number;
		ms: number;
	}> = [];
	for (const query of queries) {
		const started = performance.now();
		const ranked = await rankQuery(query, args.mode, args.live, args.topN);
		rows.push({
			id: query.id,
			class: query.class,
			mrr: mrr(ranked, query.labels),
			ndcg10: ndcgAt(ranked, query.labels, 10),
			p5: precisionAt(ranked, query.labels, 5),
			r10: recallAt(ranked, query.labels, 10),
			ms: performance.now() - started,
		});
	}
	const mean = (pick: (row: (typeof rows)[number]) => number) =>
		rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
	const summary = {
		mode: args.mode,
		live: args.live,
		queryCount: rows.length,
		MRR: mean((row) => row.mrr),
		nDCG10: mean((row) => row.ndcg10),
		P5: mean((row) => row.p5),
		Recall10: mean((row) => row.r10),
		p50: percentile(
			rows.map((row) => row.ms),
			50,
		),
		p95: percentile(
			rows.map((row) => row.ms),
			95,
		),
	};
	console.log(JSON.stringify({ summary, rows }, null, 2));
}

await main();

/**
 * Offline retrieval eval. Default mode never calls a provider.
 *
 * bun --env-file=.env backend/src/scripts/eval-retrieval.ts --mode=baseline
 * bun --env-file=.env backend/src/scripts/eval-retrieval.ts --mode=rerank --live
 */

import type { EvalDoc, EvalQuery } from "../search/eval/offline-eval";
import {
	evaluateOfflineBaseline,
	fullTextRank,
	lexicalRank,
	loadEvalFixture,
	roundMetric,
} from "../search/eval/offline-eval";
import rawFixture from "../search/eval/retrieval-eval.fixture.json";
import {
	mrr,
	ndcgAt,
	percentile,
	precisionAt,
	recallAt,
} from "../search/eval-metrics";
import { applyRerankOrder } from "../search/rerank";
import { requestRerank } from "../search/rerank-provider";

export type EvaluationArgs = {
	mode: "baseline" | "rerank";
	live: boolean;
	topN: number;
};

function parseArgs(argv: string[]): EvaluationArgs {
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

export async function rankEvaluationQuery(
	query: EvalQuery,
	documents: readonly EvalDoc[],
	args: EvaluationArgs,
	rerank: typeof requestRerank = requestRerank,
): Promise<string[]> {
	const baseline = lexicalRank(query.query, documents);
	if (args.mode === "baseline") {
		return baseline.map((item) => item.documentId);
	}
	if (!args.live) {
		return fullTextRank(query.query, documents).map((item) => item.documentId);
	}
	const window = baseline.slice(0, Math.min(args.topN, baseline.length));
	const result = await rerank({
		query: query.query,
		candidates: window.map((item) => {
			const doc = documents.find((entry) => entry.id === item.documentId);
			return {
				id: item.documentId,
				text: `${doc?.title ?? ""}\n${doc?.text ?? ""}`,
			};
		}),
		topN: args.topN,
	});
	return (
		result ? applyRerankOrder(baseline, result.hits, args.topN) : baseline
	).map((item) => item.documentId);
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	if (args.mode === "baseline" && !args.live) {
		const evaluated = evaluateOfflineBaseline();
		console.log(
			JSON.stringify(
				{ summary: evaluated.summary, rows: evaluated.rows },
				null,
				2,
			),
		);
		return;
	}
	const { documents, queries } = loadEvalFixture({
		documents: rawFixture.documents,
		queries: rawFixture.queries.map((query) => ({
			id: query.id,
			query: query.query,
			class: query.class,
			labels: query.labels,
		})),
	});
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
		const ranked = await rankEvaluationQuery(query, documents, args);
		rows.push({
			id: query.id,
			class: query.class,
			mrr: roundMetric(mrr(ranked, query.labels)),
			ndcg10: roundMetric(ndcgAt(ranked, query.labels, 10)),
			p5: roundMetric(precisionAt(ranked, query.labels, 5)),
			r10: roundMetric(recallAt(ranked, query.labels, 10)),
			ms: performance.now() - started,
		});
	}
	const mean = (pick: (row: (typeof rows)[number]) => number) =>
		rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
	const summary = {
		mode: args.mode,
		live: args.live,
		queryCount: rows.length,
		MRR: roundMetric(mean((row) => row.mrr)),
		nDCG10: roundMetric(mean((row) => row.ndcg10)),
		P5: roundMetric(mean((row) => row.p5)),
		Recall10: roundMetric(mean((row) => row.r10)),
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

if (import.meta.main) await main();

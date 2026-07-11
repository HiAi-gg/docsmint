#!/usr/bin/env bun
/**
 * Release-gate benchmark for the real adaptive search HTTP endpoint.
 *
 * Usage:
 *   bun run benchmark:search -- --base-url=http://127.0.0.1:50700 --api-key="$HIAI_DOCS_API_KEY"
 *
 * The fixture contains document IDs that a deployment may seed separately.
 * This script never writes documents, never prints query credentials, and
 * reports only bounded aggregate diagnostics.
 */

export interface RelevanceDocument {
	id: string;
	title: string;
	ownerId: string;
	visibility: string;
}

export interface RelevanceCase {
	id: string;
	description: string;
	query: string;
	relevantDocumentIds: string[];
	ownerId: string;
	forbiddenDocumentIds: string[];
}

export interface RelevanceFixture {
	version: string;
	description: string;
	documents: RelevanceDocument[];
	cases: RelevanceCase[];
}

export interface SearchProbe {
	caseId: string;
	query: string;
	resultIds: string[];
	latencyMs: number;
	expanded: boolean;
	graphContributed: boolean;
	allResultsHaveExplanations: boolean;
	forbiddenResultIds: string[];
	error?: string;
}

export interface BenchmarkSummary {
	fixtureVersion: string;
	caseCount: number;
	recallAt10: number;
	mrrAt10: number;
	fastP95Ms: number;
	expandedP95Ms: number;
	expansionRate: number;
	graphContributionRate: number;
	emptyCount: number;
	invalidVectors: number;
	tenantLeakageCount: number;
	explanationFailures: number;
	gates: {
		recall: boolean;
		mrr: boolean;
		fastP95: boolean;
		expandedP95: boolean;
		invalidVectors: boolean;
		tenantLeakage: boolean;
		explanations: boolean;
	};
	passed: boolean;
}

export function recallAtK(
	resultIds: readonly string[],
	relevantIds: readonly string[],
	k: number,
): number {
	if (relevantIds.length === 0) return resultIds.length === 0 ? 1 : 0;
	const expected = new Set(relevantIds);
	const found = new Set(resultIds.slice(0, Math.max(0, k)));
	let hits = 0;
	for (const id of expected) if (found.has(id)) hits += 1;
	return hits / expected.size;
}

export function mrrAtK(
	resultIds: readonly string[],
	relevantIds: readonly string[],
	k: number,
): number {
	if (relevantIds.length === 0) return resultIds.length === 0 ? 1 : 0;
	const expected = new Set(relevantIds);
	for (
		let index = 0;
		index < Math.min(resultIds.length, Math.max(0, k));
		index++
	) {
		if (expected.has(resultIds[index] as string)) return 1 / (index + 1);
	}
	return 0;
}

/** Nearest-rank percentile; p is expressed as a fraction in [0, 1]. */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = values
		.filter((value) => Number.isFinite(value) && value >= 0)
		.slice()
		.sort((left, right) => left - right);
	if (sorted.length === 0) return 0;
	const fraction = Math.min(1, Math.max(0, p));
	const index = Math.ceil(fraction * sorted.length) - 1;
	return sorted[Math.max(0, Math.min(index, sorted.length - 1))] as number;
}

export function summarizeBenchmark(
	fixture: RelevanceFixture,
	probes: readonly SearchProbe[],
	invalidVectors: number,
	k = 10,
): BenchmarkSummary {
	const byId = new Map(fixture.cases.map((item) => [item.id, item]));
	const scored = probes
		.map((probe) => ({ probe, expected: byId.get(probe.caseId) }))
		.filter(
			(value): value is { probe: SearchProbe; expected: RelevanceCase } =>
				value.expected !== undefined,
		);
	const judged = scored.filter(
		(value) => value.expected.relevantDocumentIds.length > 0,
	);
	const recall = judged.map((value) =>
		recallAtK(value.probe.resultIds, value.expected.relevantDocumentIds, k),
	);
	const mrr = judged.map((value) =>
		mrrAtK(value.probe.resultIds, value.expected.relevantDocumentIds, k),
	);
	const fast = probes
		.filter((probe) => !probe.expanded)
		.map((probe) => probe.latencyMs);
	const expanded = probes
		.filter((probe) => probe.expanded)
		.map((probe) => probe.latencyMs);
	const expansionRate =
		probes.length === 0 ? 0 : expanded.length / probes.length;
	const graphContributionRate =
		probes.length === 0
			? 0
			: probes.filter((probe) => probe.graphContributed).length / probes.length;
	const tenantLeakageCount = probes.reduce(
		(total, probe) => total + probe.forbiddenResultIds.length,
		0,
	);
	const explanationFailures = probes.filter(
		(probe) => !probe.allResultsHaveExplanations,
	).length;
	const metrics = {
		recallAt10: mean(recall),
		mrrAt10: mean(mrr),
		fastP95Ms: percentile(fast, 0.95),
		expandedP95Ms: percentile(expanded, 0.95),
	};
	const gates = {
		recall: metrics.recallAt10 >= 0.9,
		mrr: metrics.mrrAt10 >= 0.8,
		fastP95: metrics.fastP95Ms <= 500,
		expandedP95: metrics.expandedP95Ms <= 2500,
		invalidVectors: invalidVectors === 0,
		tenantLeakage: tenantLeakageCount === 0,
		explanations: explanationFailures === 0,
	};
	return {
		fixtureVersion: fixture.version,
		caseCount: probes.length,
		...metrics,
		expansionRate,
		graphContributionRate,
		emptyCount: probes.filter((probe) => probe.resultIds.length === 0).length,
		invalidVectors,
		tenantLeakageCount,
		explanationFailures,
		gates,
		passed: Object.values(gates).every(Boolean),
	};
}

interface SearchApiResponse {
	items?: Array<{
		id?: string;
		explanations?: unknown[];
	}>;
	diagnostics?: {
		expansionAttempted?: boolean;
	};
}

interface AdminMetricsSnapshot {
	metrics?: Record<string, number | number[]>;
}

interface CliArgs {
	baseUrl: string;
	apiKey: string;
	k: number;
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
	const output: CliArgs = {
		baseUrl: "http://127.0.0.1:50700",
		apiKey: "",
		k: 10,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		const [name, inlineValue] = arg.split("=", 2);
		const value = inlineValue ?? argv[index + 1];
		if (name === "--base-url" && value) {
			output.baseUrl = value;
			if (inlineValue === undefined) index += 1;
		} else if (name === "--api-key" && value) {
			output.apiKey = value;
			if (inlineValue === undefined) index += 1;
		} else if (name === "--k" && value) {
			output.k = Math.max(1, Number.parseInt(value, 10) || 10);
			if (inlineValue === undefined) index += 1;
		}
	}
	return output;
}

async function loadFixture(): Promise<RelevanceFixture> {
	const path = new URL(
		"../../tests/fixtures/search-relevance.json",
		import.meta.url,
	);
	return (await Bun.file(path).json()) as RelevanceFixture;
}

async function querySearch(
	baseUrl: string,
	apiKey: string,
	item: RelevanceCase,
	k: number,
): Promise<SearchProbe> {
	const params = new URLSearchParams({ q: item.query, limit: String(k) });
	const started = performance.now();
	try {
		const response = await fetch(
			`${baseUrl.replace(/\/$/, "")}/api/search?${params}`,
			{
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
			},
		);
		const latencyMs = performance.now() - started;
		if (!response.ok) throw new Error(`search returned ${response.status}`);
		const body = (await response.json()) as SearchApiResponse;
		const items = Array.isArray(body.items) ? body.items : [];
		const resultIds = items
			.map((result) => result.id)
			.filter((id): id is string => typeof id === "string");
		return {
			caseId: item.id,
			query: item.query,
			resultIds,
			latencyMs,
			expanded: body.diagnostics?.expansionAttempted === true,
			graphContributed: items.some(
				(result) =>
					Array.isArray(result.explanations) &&
					result.explanations.some(
						(explanation) =>
							typeof explanation === "object" &&
							(explanation as { channel?: unknown }).channel === "graph",
					),
			),
			allResultsHaveExplanations: items.every(
				(result) =>
					Array.isArray(result.explanations) && result.explanations.length > 0,
			),
			forbiddenResultIds: resultIds.filter((id) =>
				item.forbiddenDocumentIds.includes(id),
			),
		};
	} catch (error) {
		return {
			caseId: item.id,
			query: item.query,
			resultIds: [],
			latencyMs: performance.now() - started,
			expanded: false,
			graphContributed: false,
			allResultsHaveExplanations: false,
			forbiddenResultIds: [],
			error: error instanceof Error ? error.message : "search failed",
		};
	}
}

async function readInvalidVectorCount(
	baseUrl: string,
	apiKey: string,
): Promise<number> {
	try {
		const response = await fetch(
			`${baseUrl.replace(/\/$/, "")}/api/admin/embedding-stats`,
			{
				headers: { "x-api-key": apiKey, Accept: "application/json" },
			},
		);
		if (!response.ok) return -1;
		const body = (await response.json()) as {
			stats?: { activeInvalidRows?: number };
		};
		return body.stats?.activeInvalidRows ?? -1;
	} catch {
		return -1;
	}
}

async function readMetrics(
	baseUrl: string,
	apiKey: string,
): Promise<Record<string, number | number[]> | null> {
	try {
		const response = await fetch(
			`${baseUrl.replace(/\/$/, "")}/api/admin/metrics`,
			{ headers: { "x-api-key": apiKey, Accept: "application/json" } },
		);
		if (!response.ok) return null;
		const body = (await response.json()) as AdminMetricsSnapshot;
		return body.metrics ?? null;
	} catch {
		return null;
	}
}

function metricNumber(
	metrics: Record<string, number | number[]> | null,
	name: string,
): number {
	const value = metrics?.[name];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metricSamples(
	metrics: Record<string, number | number[]> | null,
	name: string,
): number[] {
	const value = metrics?.[name];
	return Array.isArray(value)
		? value.filter((sample): sample is number => Number.isFinite(sample))
		: [];
}

function deltaSamples(before: number[], after: number[]): number[] {
	return after.slice(Math.min(before.length, after.length));
}

async function main(): Promise<void> {
	const args = parseArgs();
	const fixture = await loadFixture();
	const metricsBefore = await readMetrics(args.baseUrl, args.apiKey);
	const probes = await Promise.all(
		fixture.cases.map((item) =>
			querySearch(args.baseUrl, args.apiKey, item, args.k),
		),
	);
	const metricsAfter = await readMetrics(args.baseUrl, args.apiKey);
	const invalidVectors = await readInvalidVectorCount(
		args.baseUrl,
		args.apiKey,
	);
	const summary = summarizeBenchmark(fixture, probes, invalidVectors, args.k);
	if (metricsAfter) {
		const fastSamples = deltaSamples(
			metricSamples(metricsBefore, "search_fast_duration_ms"),
			metricSamples(metricsAfter, "search_fast_duration_ms"),
		);
		const expandedSamples = deltaSamples(
			metricSamples(metricsBefore, "search_expanded_duration_ms"),
			metricSamples(metricsAfter, "search_expanded_duration_ms"),
		);
		const searchCount = probes.length;
		const expansionDelta =
			metricNumber(metricsAfter, "search_expansion_total") -
			metricNumber(metricsBefore, "search_expansion_total");
		const graphDelta =
			metricNumber(metricsAfter, "search_graph_contribution_total") -
			metricNumber(metricsBefore, "search_graph_contribution_total");
		summary.fastP95Ms = percentile(fastSamples, 0.95);
		summary.expandedP95Ms = percentile(expandedSamples, 0.95);
		summary.expansionRate =
			searchCount === 0 ? 0 : Math.max(0, expansionDelta) / searchCount;
		summary.graphContributionRate =
			searchCount === 0 ? 0 : Math.max(0, graphDelta) / searchCount;
		summary.gates.fastP95 = summary.fastP95Ms <= 500;
		summary.gates.expandedP95 = summary.expandedP95Ms <= 2500;
		summary.passed = Object.values(summary.gates).every(Boolean);
	}
	console.log(JSON.stringify(summary));
	if (!summary.passed) process.exitCode = 1;
}

function mean(values: readonly number[]): number {
	return values.length === 0
		? 0
		: values.reduce((total, value) => total + value, 0) / values.length;
}

if (import.meta.main) await main();

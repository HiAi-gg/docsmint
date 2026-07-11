#!/usr/bin/env bun
/**
 * Release-gate benchmark for the real adaptive search HTTP endpoint.
 *
 * Usage (the credential is read from the environment, never argv):
 *   export HIAI_DOCS_API_KEY
 *   bun run benchmark:search -- --base-url=http://127.0.0.1:50700
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
	crossLanguage?: boolean;
}

export interface RelevanceFixture {
	version: string;
	description: string;
	documents: RelevanceDocument[];
	cases: RelevanceCase[];
	minimumExpandedProbes?: number;
}

export interface SearchProbe {
	caseId: string;
	query: string;
	resultIds: string[];
	latencyMs: number;
	expanded: boolean;
	graphContributed: boolean;
	crossLanguageSuccess?: boolean;
	allResultsHaveExplanations: boolean;
	forbiddenResultIds: string[];
	error?: string;
}

export interface BenchmarkSummary {
	fixtureVersion: string;
	caseCount: number;
	recallAt10: number;
	mrrAt10: number;
	fastP95Ms: number | null;
	expandedP95Ms: number | null;
	fastSampleCount: number;
	expandedSampleCount: number;
	expandedProbeCount: number;
	minimumExpandedProbes: number;
	metricSamplesComplete: boolean;
	expansionRate: number;
	expansionEventCount: number;
	expansionCostMicrounits: number;
	expansionCostPerQueryMicrounits: number;
	graphContributionRate: number;
	graphContributionCount: number;
	crossLanguageCaseCount: number;
	crossLanguageSuccessCount: number;
	emptyCount: number;
	invalidVectors: number;
	tenantLeakageCount: number;
	explanationFailures: number;
	gates: {
		recall: boolean;
		mrr: boolean;
		fastP95: boolean;
		expandedP95: boolean;
		latencySamples: boolean;
		expandedProbeCoverage: boolean;
		invalidVectors: boolean;
		tenantLeakage: boolean;
		explanations: boolean;
	};
	passed: boolean;
}

export const HISTOGRAM_SAMPLE_CAP = 10_000;

export interface BenchmarkEvidence {
	fastSamples?: readonly number[];
	expandedSamples?: readonly number[];
	metricSamplesComplete?: boolean;
	expansionEventCount?: number;
	graphContributionCount?: number;
	crossLanguageSuccessCount?: number;
	estimatedCostMicrounits?: number;
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
	if (values.length === 0) return Number.NaN;
	const sorted = values
		.filter((value) => Number.isFinite(value) && value >= 0)
		.slice()
		.sort((left, right) => left - right);
	if (sorted.length === 0) return Number.NaN;
	const fraction = Math.min(1, Math.max(0, p));
	const index = Math.ceil(fraction * sorted.length) - 1;
	return sorted[Math.max(0, Math.min(index, sorted.length - 1))] as number;
}

export function summarizeBenchmark(
	fixture: RelevanceFixture,
	probes: readonly SearchProbe[],
	invalidVectors: number,
	k = 10,
	evidence: BenchmarkEvidence = {},
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
	const probeFast = probes
		.filter((probe) => !probe.expanded)
		.map((probe) => probe.latencyMs);
	const probeExpanded = probes
		.filter((probe) => probe.expanded)
		.map((probe) => probe.latencyMs);
	const fast = evidence.fastSamples ? [...evidence.fastSamples] : probeFast;
	const expanded = evidence.expandedSamples
		? [...evidence.expandedSamples]
		: probeExpanded;
	const minimumExpandedProbes = Math.max(1, fixture.minimumExpandedProbes ?? 1);
	const metricSamplesComplete = evidence.metricSamplesComplete ?? true;
	const expandedProbeCount =
		evidence.expansionEventCount ?? probeExpanded.length;
	const expansionEventCount = Math.max(0, expandedProbeCount);
	const expansionRate =
		probes.length === 0 ? 0 : expanded.length / probes.length;
	const graphContributionCount = Math.max(
		0,
		evidence.graphContributionCount ??
			probes.filter((probe) => probe.graphContributed).length,
	);
	const graphContributionRate =
		probes.length === 0 ? 0 : graphContributionCount / probes.length;
	const crossLanguageCases = scored.filter(
		(value) => value.expected.crossLanguage === true,
	);
	const crossLanguageCaseCount = crossLanguageCases.length;
	const crossLanguageSuccessCount = Math.max(
		0,
		evidence.crossLanguageSuccessCount ??
			crossLanguageCases.filter((value) => value.probe.crossLanguageSuccess)
				.length,
	);
	const expansionCostMicrounits = Math.max(
		0,
		evidence.estimatedCostMicrounits ?? 0,
	);
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
		fastP95Ms: fast.length > 0 ? percentile(fast, 0.95) : null,
		expandedP95Ms: expanded.length > 0 ? percentile(expanded, 0.95) : null,
	};
	const latencySamples =
		metricSamplesComplete &&
		fast.length > 0 &&
		expanded.length >= minimumExpandedProbes &&
		fast.length <= HISTOGRAM_SAMPLE_CAP &&
		expanded.length <= HISTOGRAM_SAMPLE_CAP;
	const gates = {
		recall: metrics.recallAt10 >= 0.9,
		mrr: metrics.mrrAt10 >= 0.8,
		fastP95:
			latencySamples && metrics.fastP95Ms !== null && metrics.fastP95Ms <= 500,
		expandedP95:
			latencySamples &&
			metrics.expandedP95Ms !== null &&
			metrics.expandedP95Ms <= 2500,
		latencySamples,
		expandedProbeCoverage:
			expansionEventCount >= minimumExpandedProbes && expanded.length > 0,
		invalidVectors: invalidVectors === 0,
		tenantLeakage: tenantLeakageCount === 0,
		explanations: explanationFailures === 0,
	};
	return {
		fixtureVersion: fixture.version,
		caseCount: probes.length,
		...metrics,
		fastSampleCount: fast.length,
		expandedSampleCount: expanded.length,
		expandedProbeCount: expansionEventCount,
		minimumExpandedProbes,
		metricSamplesComplete,
		expansionRate,
		expansionEventCount,
		expansionCostMicrounits,
		expansionCostPerQueryMicrounits:
			probes.length === 0 ? 0 : expansionCostMicrounits / probes.length,
		graphContributionRate,
		graphContributionCount,
		crossLanguageCaseCount,
		crossLanguageSuccessCount,
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
		expansionUsed?: boolean;
		crossLanguageSuccess?: boolean;
	};
}

interface AdminMetricsSnapshot {
	metrics?: Record<string, number | number[]>;
}

interface CliArgs {
	baseUrl: string;
	k: number;
	apiKeyFile?: string;
	apiKeyStdin: boolean;
}

export function parseArgs(
	argv: readonly string[] = process.argv.slice(2),
): CliArgs {
	const output: CliArgs = {
		baseUrl: "http://127.0.0.1:50700",
		k: 10,
		apiKeyStdin: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		const [name, inlineValue] = arg.split("=", 2);
		const value = inlineValue ?? argv[index + 1];
		if (name === "--base-url" && value) {
			output.baseUrl = value;
			if (inlineValue === undefined) index += 1;
		} else if (name === "--api-key") {
			throw new Error(
				"API keys must be provided via environment or --api-key-file/--api-key-stdin; command-line values are forbidden",
			);
		} else if (name === "--api-key-file") {
			if (!value || (inlineValue === undefined && value.startsWith("--"))) {
				throw new Error("--api-key-file requires a file path");
			}
			output.apiKeyFile = value;
			if (inlineValue === undefined) index += 1;
		} else if (name === "--api-key-stdin") {
			output.apiKeyStdin = true;
		} else if (name === "--k" && value) {
			output.k = Math.max(1, Number.parseInt(value, 10) || 10);
			if (inlineValue === undefined) index += 1;
		}
	}
	return output;
}

export function resolveApiKey(
	env: Record<string, string | undefined> = process.env,
	fileValue?: string,
): string {
	return (
		env.HIAI_DOCS_API_KEY ??
		env.BENCHMARK_API_KEY ??
		fileValue ??
		""
	).trim();
}

async function loadApiKey(args: CliArgs): Promise<string> {
	let fileValue: string | undefined;
	if (args.apiKeyFile) {
		fileValue = await Bun.file(args.apiKeyFile).text();
	}
	if (args.apiKeyStdin) {
		const stdinValue = await Bun.stdin.text();
		fileValue = stdinValue;
	}
	const key = resolveApiKey(process.env, fileValue);
	if (!key) {
		throw new Error(
			"Missing benchmark API key: set HIAI_DOCS_API_KEY or BENCHMARK_API_KEY, or use --api-key-file/--api-key-stdin",
		);
	}
	return key;
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
			expanded: body.diagnostics?.expansionUsed === true,
			crossLanguageSuccess: body.diagnostics?.crossLanguageSuccess === true,
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

function deltaSamples(
	before: number[],
	after: number[],
	expectedCount: number,
): { samples: number[]; complete: boolean } {
	const capReached =
		before.length >= HISTOGRAM_SAMPLE_CAP ||
		after.length >= HISTOGRAM_SAMPLE_CAP;
	const grew = after.length >= before.length;
	const samples = grew ? after.slice(before.length) : [];
	return {
		samples,
		complete: !capReached && grew && samples.length >= expectedCount,
	};
}

async function main(): Promise<void> {
	const args = parseArgs();
	const apiKey = await loadApiKey(args);
	const fixture = await loadFixture();
	const metricsBefore = await readMetrics(args.baseUrl, apiKey);
	const probes = await Promise.all(
		fixture.cases.map((item) =>
			querySearch(args.baseUrl, apiKey, item, args.k),
		),
	);
	const metricsAfter = await readMetrics(args.baseUrl, apiKey);
	const invalidVectors = await readInvalidVectorCount(args.baseUrl, apiKey);
	const summary = summarizeBenchmark(fixture, probes, invalidVectors, args.k);
	if (!metricsAfter || !metricsBefore) {
		summary.metricSamplesComplete = false;
		summary.gates.latencySamples = false;
		summary.gates.fastP95 = false;
		summary.gates.expandedP95 = false;
		summary.passed = Object.values(summary.gates).every(Boolean);
	}
	if (metricsAfter && metricsBefore) {
		const fastDelta = deltaSamples(
			metricSamples(metricsBefore, "search_fast_duration_ms"),
			metricSamples(metricsAfter, "search_fast_duration_ms"),
			probes.filter((probe) => !probe.expanded).length,
		);
		const expandedDelta = deltaSamples(
			metricSamples(metricsBefore, "search_expanded_duration_ms"),
			metricSamples(metricsAfter, "search_expanded_duration_ms"),
			probes.filter((probe) => probe.expanded).length,
		);
		const searchCount = probes.length;
		const expansionDelta =
			metricNumber(metricsAfter, "search_expansion_total") -
			metricNumber(metricsBefore, "search_expansion_total");
		const graphDelta =
			metricNumber(metricsAfter, "search_graph_contribution_total") -
			metricNumber(metricsBefore, "search_graph_contribution_total");
		const costDelta =
			metricNumber(metricsAfter, "search_expansion_estimated_cost_microunits") -
			metricNumber(metricsBefore, "search_expansion_estimated_cost_microunits");
		const crossLanguageDelta =
			metricNumber(metricsAfter, "search_cross_language_success_total") -
			metricNumber(metricsBefore, "search_cross_language_success_total");
		summary.fastP95Ms =
			fastDelta.samples.length > 0 ? percentile(fastDelta.samples, 0.95) : null;
		summary.expandedP95Ms =
			expandedDelta.samples.length > 0
				? percentile(expandedDelta.samples, 0.95)
				: null;
		summary.fastSampleCount = fastDelta.samples.length;
		summary.expandedSampleCount = expandedDelta.samples.length;
		summary.metricSamplesComplete =
			fastDelta.complete && expandedDelta.complete;
		summary.expandedProbeCount = Math.max(
			probes.filter((probe) => probe.expanded).length,
			Math.max(0, expansionDelta),
		);
		summary.expansionEventCount = Math.max(0, expansionDelta);
		summary.expansionCostMicrounits = Math.max(0, costDelta);
		summary.expansionCostPerQueryMicrounits =
			searchCount === 0 ? 0 : Math.max(0, costDelta) / searchCount;
		summary.graphContributionCount = Math.max(0, graphDelta);
		summary.crossLanguageSuccessCount = Math.max(0, crossLanguageDelta);
		summary.expansionRate =
			searchCount === 0 ? 0 : Math.max(0, expansionDelta) / searchCount;
		summary.graphContributionRate =
			searchCount === 0 ? 0 : Math.max(0, graphDelta) / searchCount;
		summary.gates.latencySamples =
			summary.metricSamplesComplete &&
			summary.fastSampleCount > 0 &&
			summary.expandedSampleCount >= summary.minimumExpandedProbes;
		summary.gates.expandedProbeCoverage =
			summary.expansionEventCount >= summary.minimumExpandedProbes;
		summary.gates.fastP95 =
			summary.gates.latencySamples &&
			summary.fastP95Ms !== null &&
			summary.fastP95Ms <= 500;
		summary.gates.expandedP95 =
			summary.gates.latencySamples &&
			summary.expandedP95Ms !== null &&
			summary.expandedP95Ms <= 2500;
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

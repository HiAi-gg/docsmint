/**
 * In-memory metrics registry.
 *
 * Provides lightweight counters and duration histograms for the embedding
 * and search pipelines. Zero external dependencies, zero allocations on the hot path
 * beyond an object lookup, and trivially snapshotable via `getMetrics()`.
 *
 * Scope: process-local only. Intended for `/api/admin/metrics` operator
 * dashboards and health checks — NOT a substitute for a real metrics
 * pipeline (Prometheus, OTLP, etc.). Restart the process to reset.
 *
 * Module boundaries: this file lives in `lib/` and MUST NOT import from
 * `api/` or `embedding/`. Callers (embedding pipeline, admin route) import
 * from here.
 */

interface CounterState {
	count: number;
}

import {
	emptyPipelineMetricSnapshot,
	type PipelineMetricName,
	type PipelineMetricSnapshot,
} from "../queue/health";

const PIPELINE_METRICS = emptyPipelineMetricSnapshot();

/** Fixed-cardinality queue metric update; arbitrary/user-derived keys are impossible. */
export function setPipelineMetric(
	name: PipelineMetricName,
	value: number,
): void {
	if (!Number.isFinite(value) || value < 0) return;
	PIPELINE_METRICS[name] = value;
}

export function incrementPipelineMetric(
	name: PipelineMetricName,
	amount = 1,
): void {
	if (!Number.isFinite(amount) || amount < 0) return;
	PIPELINE_METRICS[name] = (PIPELINE_METRICS[name] ?? 0) + amount;
}

export function getPipelineMetrics(): PipelineMetricSnapshot {
	return { ...PIPELINE_METRICS };
}

/** Search channels are deliberately finite. Never turn user input into a
 * metric label: each channel owns a fixed set of metric names below. */
export const SEARCH_CHANNELS = [
	"exact",
	"fts",
	"fuzzy",
	"vector",
	"expanded_fts",
	"expanded_fuzzy",
	"expanded_vector",
	"graph",
] as const;

export type SearchMetricChannel = (typeof SEARCH_CHANNELS)[number];

export type SearchExpansionReason =
	| "no_lexical_match"
	| "low_channel_agreement"
	| "low_vector_similarity"
	| "language_mismatch"
	| "empty_candidates";

export const SEARCH_EXPANSION_REASONS = [
	"no_lexical_match",
	"low_channel_agreement",
	"low_vector_similarity",
	"language_mismatch",
	"empty_candidates",
] as const satisfies readonly SearchExpansionReason[];

/**
 * Internal registry. Keys are metric names; values are either:
 *   - `{ count: number }` for monotonic counters
 *   - `{ durations: number[] }` for the duration histogram
 *
 * We use a discriminated shape (no class) so `JSON.stringify` on the
 * `getMetrics()` snapshot produces a clean operator-facing payload.
 */
type MetricEntry =
	| { kind: "counter"; count: number }
	| { kind: "histogram"; durations: number[] };

const REGISTRY: Map<string, MetricEntry> = new Map();

/**
 * Names of the known counters. Kept as a typed enum-like object so
 * callers and the admin route share the same string identities without
 * having to repeat string literals across files. The runtime shape is
 * plain — no enum, since this is ESM and we want the keys to be plain
 * string properties on the value object.
 */
export const METRIC_NAMES = {
	EMBEDDING_SUCCESS: "embedding_success",
	EMBEDDING_FALLBACK: "embedding_fallback",
	EMBEDDING_INVALID: "embedding_invalid",
	/** @deprecated Read alias retained for one release. */
	EMBEDDING_ZERO: "embedding_zero",
	EMBEDDING_DURATION_MS: "embedding_duration_ms",
	EMBEDDING_CHUNKS_TOTAL: "embedding_chunks_total",
	EMBEDDING_DOCS_TOTAL: "embedding_docs_total",
	EMBEDDING_RETRIES_TOTAL: "embedding_retries_total",
	EMBEDDING_DEAD_LETTER_TOTAL: "embedding_dead_letter_total",
	EMBEDDING_PENDING: "embedding_pending",
	EMBEDDING_PROCESSING: "embedding_processing",
	EMBEDDING_READY: "embedding_ready",
	EMBEDDING_FAILED: "embedding_failed",
	EMBEDDING_STALE: "embedding_stale",
	EMBEDDING_INVALID_ACTIVE: "embedding_invalid_active",
	SEARCH_FAST_DURATION_MS: "search_fast_duration_ms",
	SEARCH_EXPANDED_DURATION_MS: "search_expanded_duration_ms",
	SEARCH_EXPANSION_TOTAL: "search_expansion_total",
	SEARCH_EMPTY_TOTAL: "search_empty_total",
	SEARCH_GRAPH_CONTRIBUTION_TOTAL: "search_graph_contribution_total",
	SEARCH_CROSS_LANGUAGE_SUCCESS_TOTAL: "search_cross_language_success_total",
	SEARCH_EXPANSION_PRIMARY_TOTAL: "search_expansion_primary_total",
	SEARCH_EXPANSION_FALLBACK_TOTAL: "search_expansion_fallback_total",
	SEARCH_EXPANSION_ESTIMATED_COST_MICROUNITS:
		"search_expansion_estimated_cost_microunits",
	SEARCH_EXPANSION_NO_LEXICAL_MATCH_TOTAL:
		"search_expansion_reason_no_lexical_match_total",
	SEARCH_EXPANSION_LOW_CHANNEL_AGREEMENT_TOTAL:
		"search_expansion_reason_low_channel_agreement_total",
	SEARCH_EXPANSION_LOW_VECTOR_SIMILARITY_TOTAL:
		"search_expansion_reason_low_vector_similarity_total",
	SEARCH_EXPANSION_LANGUAGE_MISMATCH_TOTAL:
		"search_expansion_reason_language_mismatch_total",
	SEARCH_EXPANSION_EMPTY_CANDIDATES_TOTAL:
		"search_expansion_reason_empty_candidates_total",
	SEARCH_EXACT_DURATION_MS: "search_exact_duration_ms",
	SEARCH_EXACT_ERRORS_TOTAL: "search_exact_errors_total",
	SEARCH_EXACT_CANDIDATES_TOTAL: "search_exact_candidates_total",
	SEARCH_FTS_DURATION_MS: "search_fts_duration_ms",
	SEARCH_FTS_ERRORS_TOTAL: "search_fts_errors_total",
	SEARCH_FTS_CANDIDATES_TOTAL: "search_fts_candidates_total",
	SEARCH_FUZZY_DURATION_MS: "search_fuzzy_duration_ms",
	SEARCH_FUZZY_ERRORS_TOTAL: "search_fuzzy_errors_total",
	SEARCH_FUZZY_CANDIDATES_TOTAL: "search_fuzzy_candidates_total",
	SEARCH_VECTOR_DURATION_MS: "search_vector_duration_ms",
	SEARCH_VECTOR_ERRORS_TOTAL: "search_vector_errors_total",
	SEARCH_VECTOR_CANDIDATES_TOTAL: "search_vector_candidates_total",
	SEARCH_EXPANDED_FTS_DURATION_MS: "search_expanded_fts_duration_ms",
	SEARCH_EXPANDED_FTS_ERRORS_TOTAL: "search_expanded_fts_errors_total",
	SEARCH_EXPANDED_FTS_CANDIDATES_TOTAL: "search_expanded_fts_candidates_total",
	SEARCH_EXPANDED_FUZZY_DURATION_MS: "search_expanded_fuzzy_duration_ms",
	SEARCH_EXPANDED_FUZZY_ERRORS_TOTAL: "search_expanded_fuzzy_errors_total",
	SEARCH_EXPANDED_FUZZY_CANDIDATES_TOTAL:
		"search_expanded_fuzzy_candidates_total",
	SEARCH_EXPANDED_VECTOR_DURATION_MS: "search_expanded_vector_duration_ms",
	SEARCH_EXPANDED_VECTOR_ERRORS_TOTAL: "search_expanded_vector_errors_total",
	SEARCH_EXPANDED_VECTOR_CANDIDATES_TOTAL:
		"search_expanded_vector_candidates_total",
	SEARCH_GRAPH_DURATION_MS: "search_graph_duration_ms",
	SEARCH_GRAPH_ERRORS_TOTAL: "search_graph_errors_total",
	SEARCH_GRAPH_CANDIDATES_TOTAL: "search_graph_candidates_total",
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

/**
 * Get-or-create a counter entry. Counters are monotonic and identified by
 * their name. Centralised so the increment path stays a single Map
 * lookup and we never accidentally double-allocate.
 */
function getOrCreateCounter(name: string): CounterState {
	const canonicalName = canonicalMetricName(name);
	const existing = REGISTRY.get(canonicalName);
	if (existing?.kind === "counter") {
		return { count: existing.count };
	}
	REGISTRY.set(canonicalName, { kind: "counter", count: 0 });
	const entry = REGISTRY.get(canonicalName);
	if (entry?.kind !== "counter") {
		// Unreachable: we just inserted it.
		throw new Error(`metrics: counter ${canonicalName} missing after create`);
	}
	return { count: entry.count };
}

/**
 * Get-or-create the duration histogram entry. Stored as a plain array so
 * `getMetrics()` can return it directly without copying.
 */
function getOrCreateHistogram(name: string): number[] {
	const existing = REGISTRY.get(name);
	if (existing?.kind === "histogram") {
		return existing.durations;
	}
	REGISTRY.set(name, { kind: "histogram", durations: [] });
	const entry = REGISTRY.get(name);
	if (entry?.kind !== "histogram") {
		// Unreachable: we just inserted it.
		throw new Error(`metrics: histogram ${name} missing after create`);
	}
	return entry.durations;
}

/**
 * Increment a counter by 1. Idempotent w.r.t. metric identity — calling
 * with a previously-unknown name creates a new counter at 0 then bumps
 * it to 1.
 *
 * Non-positive increments are not supported; this is a counter API and
 * monotonic semantics keep `/api/admin/metrics` honest.
 */
export function incrementCounter(name: string): void {
	incrementCounterBy(name, 1);
}

/** Increment a counter by a finite non-negative amount. */
export function incrementCounterBy(name: string, amount: number): void {
	if (!Number.isFinite(amount) || amount < 0) return;
	const canonicalName = canonicalMetricName(name);
	const entry = getOrCreateCounter(canonicalName);
	entry.count += amount;
	const stored = REGISTRY.get(canonicalName);
	if (stored && stored.kind === "counter") {
		stored.count = entry.count;
	}
}

/**
 * Add a duration sample to the named histogram. Samples are stored as a
 * plain array so `getMetrics()` can return them directly. Samples are capped
 * at 10,000 entries so a long-lived process cannot grow without bound.
 */
export function recordDuration(name: string, ms: number): void {
	if (!Number.isFinite(ms) || ms < 0) return;
	const durations = getOrCreateHistogram(name);
	// Keep the process-local registry bounded under a long-running workload.
	if (durations.length >= 10_000) durations.shift();
	durations.push(ms);
}

/**
 * Snapshot all metrics as a plain JSON-serialisable object. Counters
 * surface as their integer count; the duration histogram surfaces as
 * the raw sample array (operators can compute p50/p95 externally).
 *
 * The map iteration order matches insertion order so the output is
 * stable across calls — helpful for log diffing and golden tests.
 */
export function getMetrics(
	options: { includeReserved?: boolean } = {},
): Record<string, number | number[]> {
	const out: Record<string, number | number[]> = {};
	for (const [name, entry] of REGISTRY) {
		if (entry.kind === "counter") {
			out[name] = entry.count;
			if (name === METRIC_NAMES.EMBEDDING_INVALID) {
				out[METRIC_NAMES.EMBEDDING_ZERO] = entry.count;
			}
		} else {
			out[name] = entry.durations.slice();
		}
	}
	if (options.includeReserved) {
		for (const name of Object.values(METRIC_NAMES)) {
			const canonicalName = canonicalMetricName(name);
			if (out[canonicalName] === undefined) {
				out[canonicalName] = HISTOGRAM_METRICS.has(canonicalName) ? [] : 0;
			}
			if (name === METRIC_NAMES.EMBEDDING_ZERO) {
				out[name] = out[canonicalName] ?? 0;
			}
		}
	}
	return out;
}

/**
 * Clear all metrics. Intended for tests — the admin route never calls
 * this. After reset, `getMetrics()` returns `{}` and the next
 * `incrementCounter` / `recordDuration` re-creates the entries lazily.
 */
export function resetMetrics(): void {
	REGISTRY.clear();
	Object.assign(PIPELINE_METRICS, emptyPipelineMetricSnapshot());
}

const SEARCH_METRIC_MAP: Record<
	SearchMetricChannel,
	{ duration: string; errors: string; candidates: string }
> = {
	exact: {
		duration: METRIC_NAMES.SEARCH_EXACT_DURATION_MS,
		errors: METRIC_NAMES.SEARCH_EXACT_ERRORS_TOTAL,
		candidates: METRIC_NAMES.SEARCH_EXACT_CANDIDATES_TOTAL,
	},
	fts: {
		duration: METRIC_NAMES.SEARCH_FTS_DURATION_MS,
		errors: METRIC_NAMES.SEARCH_FTS_ERRORS_TOTAL,
		candidates: METRIC_NAMES.SEARCH_FTS_CANDIDATES_TOTAL,
	},
	fuzzy: {
		duration: METRIC_NAMES.SEARCH_FUZZY_DURATION_MS,
		errors: METRIC_NAMES.SEARCH_FUZZY_ERRORS_TOTAL,
		candidates: METRIC_NAMES.SEARCH_FUZZY_CANDIDATES_TOTAL,
	},
	vector: {
		duration: METRIC_NAMES.SEARCH_VECTOR_DURATION_MS,
		errors: METRIC_NAMES.SEARCH_VECTOR_ERRORS_TOTAL,
		candidates: METRIC_NAMES.SEARCH_VECTOR_CANDIDATES_TOTAL,
	},
	expanded_fts: {
		duration: METRIC_NAMES.SEARCH_EXPANDED_FTS_DURATION_MS,
		errors: METRIC_NAMES.SEARCH_EXPANDED_FTS_ERRORS_TOTAL,
		candidates: METRIC_NAMES.SEARCH_EXPANDED_FTS_CANDIDATES_TOTAL,
	},
	expanded_fuzzy: {
		duration: METRIC_NAMES.SEARCH_EXPANDED_FUZZY_DURATION_MS,
		errors: METRIC_NAMES.SEARCH_EXPANDED_FUZZY_ERRORS_TOTAL,
		candidates: METRIC_NAMES.SEARCH_EXPANDED_FUZZY_CANDIDATES_TOTAL,
	},
	expanded_vector: {
		duration: METRIC_NAMES.SEARCH_EXPANDED_VECTOR_DURATION_MS,
		errors: METRIC_NAMES.SEARCH_EXPANDED_VECTOR_ERRORS_TOTAL,
		candidates: METRIC_NAMES.SEARCH_EXPANDED_VECTOR_CANDIDATES_TOTAL,
	},
	graph: {
		duration: METRIC_NAMES.SEARCH_GRAPH_DURATION_MS,
		errors: METRIC_NAMES.SEARCH_GRAPH_ERRORS_TOTAL,
		candidates: METRIC_NAMES.SEARCH_GRAPH_CANDIDATES_TOTAL,
	},
};

export function recordSearchChannelMetrics(input: {
	channel: SearchMetricChannel;
	durationMs: number;
	candidateCount: number;
	errorCode?: string;
}): void {
	const names = SEARCH_METRIC_MAP[input.channel];
	if (!names) return;
	recordDuration(names.duration, input.durationMs);
	incrementCounterBy(names.candidates, Math.max(0, input.candidateCount));
	if (input.errorCode) incrementCounter(names.errors);
}

export function recordSearchExpansionMetrics(input: {
	reasons: readonly SearchExpansionReason[];
	used?: boolean;
	model?: string;
	primaryModel?: string;
	fallbackModel?: string;
	estimatedCostMicrounits?: number;
}): void {
	if (input.used !== false) {
		incrementCounter(METRIC_NAMES.SEARCH_EXPANSION_TOTAL);
	}
	for (const reason of input.reasons) {
		switch (reason) {
			case "no_lexical_match":
				incrementCounter(METRIC_NAMES.SEARCH_EXPANSION_NO_LEXICAL_MATCH_TOTAL);
				break;
			case "low_channel_agreement":
				incrementCounter(
					METRIC_NAMES.SEARCH_EXPANSION_LOW_CHANNEL_AGREEMENT_TOTAL,
				);
				break;
			case "low_vector_similarity":
				incrementCounter(
					METRIC_NAMES.SEARCH_EXPANSION_LOW_VECTOR_SIMILARITY_TOTAL,
				);
				break;
			case "language_mismatch":
				incrementCounter(METRIC_NAMES.SEARCH_EXPANSION_LANGUAGE_MISMATCH_TOTAL);
				break;
			case "empty_candidates":
				incrementCounter(METRIC_NAMES.SEARCH_EXPANSION_EMPTY_CANDIDATES_TOTAL);
				break;
		}
	}
	if (
		input.used !== false &&
		input.model &&
		input.model === input.fallbackModel
	) {
		incrementCounter(METRIC_NAMES.SEARCH_EXPANSION_FALLBACK_TOTAL);
	} else if (input.used !== false && input.model) {
		incrementCounter(METRIC_NAMES.SEARCH_EXPANSION_PRIMARY_TOTAL);
	}
	if (input.used !== false) {
		incrementCounterBy(
			METRIC_NAMES.SEARCH_EXPANSION_ESTIMATED_COST_MICROUNITS,
			Math.max(0, input.estimatedCostMicrounits ?? 0),
		);
	}
}

export function recordSearchOutcomeMetrics(input: {
	empty?: boolean;
	graphContribution?: boolean;
	crossLanguageEligible?: boolean;
	crossLanguageSuccess?: boolean;
}): void {
	if (input.empty) incrementCounter(METRIC_NAMES.SEARCH_EMPTY_TOTAL);
	if (input.graphContribution)
		incrementCounter(METRIC_NAMES.SEARCH_GRAPH_CONTRIBUTION_TOTAL);
	if (input.crossLanguageEligible && input.crossLanguageSuccess)
		incrementCounter(METRIC_NAMES.SEARCH_CROSS_LANGUAGE_SUCCESS_TOTAL);
}

export function getEmbeddingStateInventory(): Record<string, number> {
	const metrics = getMetrics();
	return {
		pending: valueOrZero(metrics[METRIC_NAMES.EMBEDDING_PENDING]),
		processing: valueOrZero(metrics[METRIC_NAMES.EMBEDDING_PROCESSING]),
		ready: valueOrZero(metrics[METRIC_NAMES.EMBEDDING_READY]),
		failed: valueOrZero(metrics[METRIC_NAMES.EMBEDDING_FAILED]),
		stale: valueOrZero(metrics[METRIC_NAMES.EMBEDDING_STALE]),
		invalidActive: valueOrZero(metrics[METRIC_NAMES.EMBEDDING_INVALID_ACTIVE]),
	};
}

function valueOrZero(value: number | number[] | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function canonicalMetricName(name: string): string {
	return name === METRIC_NAMES.EMBEDDING_ZERO
		? METRIC_NAMES.EMBEDDING_INVALID
		: name;
}

const HISTOGRAM_METRICS = new Set<string>([
	METRIC_NAMES.EMBEDDING_DURATION_MS,
	METRIC_NAMES.SEARCH_FAST_DURATION_MS,
	METRIC_NAMES.SEARCH_EXPANDED_DURATION_MS,
	METRIC_NAMES.SEARCH_EXACT_DURATION_MS,
	METRIC_NAMES.SEARCH_FTS_DURATION_MS,
	METRIC_NAMES.SEARCH_FUZZY_DURATION_MS,
	METRIC_NAMES.SEARCH_VECTOR_DURATION_MS,
	METRIC_NAMES.SEARCH_EXPANDED_FTS_DURATION_MS,
	METRIC_NAMES.SEARCH_EXPANDED_FUZZY_DURATION_MS,
	METRIC_NAMES.SEARCH_EXPANDED_VECTOR_DURATION_MS,
	METRIC_NAMES.SEARCH_GRAPH_DURATION_MS,
]);

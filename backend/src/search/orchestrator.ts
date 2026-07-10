import type { TenantContext } from "@hiai-docs/db/with-tenant";
import { getEmbedding } from "../embedding";
import { config } from "../lib/config";
import { evaluateConfidence } from "./confidence";
import { retrieveGraphCandidates } from "./graph-retriever";
import { analyzeQuery } from "./query-analyzer";
import { expandQuery } from "./query-expander";
import { retrieveFastChannels } from "./retrievers";
import { fuseCandidates } from "./rrf";
import type {
	ChannelResult,
	QueryPlan,
	RankedSearchResult,
	SearchCandidate,
	SearchChannel,
} from "./types";

export interface SearchRequest {
	query: string;
	page?: number;
	limit?: number;
	maxGraphHops?: number;
}

export interface SearchDiagnostics {
	reason?: "no_relevant_candidates";
	fastChannels: string[];
	channelErrors: Record<string, string>;
	expansionAttempted: boolean;
	expansionModel?: string;
	graphAttempted: boolean;
	graphFailed: boolean;
	confidenceReasons: string[];
}

export interface SearchResponse {
	items: RankedSearchResult[];
	total: number;
	page: number;
	limit: number;
	queryPlan: QueryPlan;
	diagnostics: SearchDiagnostics;
}

export interface SearchAdapterOptions {
	retrieveFast?: typeof retrieveFastChannels;
	retrieveExpanded?: (
		ctx: TenantContext,
		plan: QueryPlan,
		options?: { limit?: number },
	) => Promise<ChannelResult[]>;
	expand?: typeof expandQuery;
	retrieveGraph?: typeof retrieveGraphCandidates;
}

const CHANNELS = ["exact", "fts", "fuzzy", "vector"] as const;
const EXPANDED_CHANNELS = new Set<SearchChannel>(["fts", "fuzzy", "vector"]);

/**
 * Search-domain orchestration. The HTTP layer owns validation and hydration;
 * this function owns retrieval sequencing and failure isolation.
 */
export async function searchDocuments(
	ctx: TenantContext,
	request: SearchRequest,
	adapters: SearchAdapterOptions = {},
): Promise<SearchResponse> {
	const page = clampPage(request.page);
	const limit = clampLimit(request.limit);
	const plan = analyzeQuery(request.query);
	const retrieveFast = adapters.retrieveFast ?? retrieveFastChannels;
	const retrieveExpanded =
		adapters.retrieveExpanded ?? defaultExpandedRetriever;
	const expand = adapters.expand ?? expandQuery;
	const retrieveGraph = adapters.retrieveGraph ?? retrieveGraphCandidates;
	const channelErrors: Record<string, string> = {};

	let fast: ChannelResult[];
	try {
		fast = await retrieveFast(ctx, plan, { limit: limit * 2 });
	} catch {
		fast = CHANNELS.map((channel) => ({
			channel,
			candidates: [],
			durationMs: 0,
			errorCode: "query_failed",
		}));
	}
	for (const result of fast) {
		if (result.errorCode) channelErrors[result.channel] = result.errorCode;
	}

	const confidence = evaluateConfidence(fast, plan, {
		vectorMinSimilarity: config.SEARCH_VECTOR_MIN_SIMILARITY,
	});
	let expandedPlan: QueryPlan | null = null;
	let expansionModel: string | undefined;
	let expansionAttempted = false;
	let expanded: ChannelResult[] = [];
	if (!confidence.confident) {
		expansionAttempted = true;
		try {
			const expansion = await expand(plan, {
				tenantScope: ctx.userId,
				ownerId: ctx.userId,
			});
			if (expansion) {
				expandedPlan = expansion.plan;
				expansionModel = expansion.model;
				try {
					expanded = await retrieveExpanded(ctx, expandedPlan, {
						limit: limit * 2,
					});
				} catch {
					expanded = [];
				}
			}
		} catch {
			// Expansion is optional; fast-pass results remain valid.
		}
	}

	const direct = fuseCandidates(
		[...fast, ...expanded].flatMap((result) => result.candidates),
		{
			rrfK: config.SEARCH_RRF_K,
			exactBoost: config.SEARCH_EXACT_BOOST,
			channelAgreementBoost: config.SEARCH_CHANNEL_AGREEMENT_BOOST,
			graphMaxContribution: config.SEARCH_GRAPH_MAX_CONTRIBUTION,
			vectorMinSimilarity: config.SEARCH_VECTOR_MIN_SIMILARITY,
		},
	);
	const graphPlan = expandedPlan ?? plan;
	const graphSeeds = direct
		.slice(0, config.SEARCH_GRAPH_SEED_LIMIT)
		.map((result) => result.documentId);
	let graph: SearchCandidate[] = [];
	let graphFailed = false;
	try {
		graph = await retrieveGraph(ctx, {
			documentSeeds: graphSeeds,
			queryPlan: graphPlan,
			limit: Math.min(limit * 2, config.SEARCH_GRAPH_RESULT_LIMIT),
			maxHops: request.maxGraphHops ?? config.SEARCH_GRAPH_MAX_HOPS,
		});
	} catch {
		graphFailed = true;
	}

	const ranked = fuseCandidates(
		[
			...fast.flatMap((result) => result.candidates),
			...expanded.flatMap((result) => result.candidates),
			...graph,
		],
		{
			rrfK: config.SEARCH_RRF_K,
			exactBoost: config.SEARCH_EXACT_BOOST,
			channelAgreementBoost: config.SEARCH_CHANNEL_AGREEMENT_BOOST,
			graphMaxContribution: config.SEARCH_GRAPH_MAX_CONTRIBUTION,
			vectorMinSimilarity: config.SEARCH_VECTOR_MIN_SIMILARITY,
		},
	);
	const offset = (page - 1) * limit;
	const items = ranked.slice(offset, offset + limit);
	const diagnostics: SearchDiagnostics = {
		...(ranked.length === 0
			? { reason: "no_relevant_candidates" as const }
			: {}),
		fastChannels: fast.map((result) => result.channel),
		channelErrors,
		expansionAttempted,
		...(expansionModel ? { expansionModel } : {}),
		graphAttempted: true,
		graphFailed,
		confidenceReasons: confidence.reasons,
	};
	return {
		items,
		total: ranked.length,
		page,
		limit,
		queryPlan: plan,
		diagnostics,
	};
}

async function defaultExpandedRetriever(
	ctx: TenantContext,
	plan: QueryPlan,
	options: { limit?: number } = {},
): Promise<ChannelResult[]> {
	const variants = dedupe([
		...plan.translations,
		...plan.synonyms,
		...plan.concepts,
		...plan.namedEntities,
	]);
	if (variants.length === 0) return [];
	const limit = options.limit ?? 20;
	const embeddingCache = new Map<string, ReturnType<typeof getEmbedding>>();
	const results = await Promise.allSettled(
		variants.map(async (variant) => {
			const variantPlan: QueryPlan = { ...plan, normalized: variant };
			const result = await retrieveFastChannels(ctx, variantPlan, {
				limit,
				getEmbedding: async (text) => {
					const cached = embeddingCache.get(text);
					if (cached) return cached;
					const pending = getEmbedding(text);
					embeddingCache.set(text, pending);
					return pending;
				},
			});
			return result
				.filter((channel) => EXPANDED_CHANNELS.has(channel.channel))
				.map((channel) => ({
					...channel,
					channel: `expanded_${channel.channel}` as SearchChannel,
					candidates: channel.candidates.map((candidate) => ({
						...candidate,
						channel: `expanded_${candidate.channel}` as SearchChannel,
						queryVariant: variant,
					})),
				}));
		}),
	);
	return results.flatMap((result) =>
		result.status === "fulfilled" ? result.value : [],
	);
}

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = value.trim().normalize("NFKC").toLocaleLowerCase();
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function clampLimit(value: number | undefined): number {
	if (!Number.isFinite(value)) return 20;
	return Math.max(1, Math.min(100, Math.floor(value as number)));
}

function clampPage(value: number | undefined): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.floor(value as number));
}

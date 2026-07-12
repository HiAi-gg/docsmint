import { documents, documentTags, folders, tags } from "@hiai-docs/db/schema";
import type { TenantContext } from "@hiai-docs/db/with-tenant";
import { and, eq, inArray, or } from "drizzle-orm";
import { getEmbedding } from "../embedding";
import type { EmbeddingResult } from "../embedding/result";
import { config } from "../lib/config";
import {
	METRIC_NAMES,
	recordDuration,
	recordSearchChannelMetrics,
	recordSearchExpansionMetrics,
	recordSearchOutcomeMetrics,
} from "../lib/metrics";
import { withTenant } from "../lib/with-tenant";
import { evaluateConfidence } from "./confidence";
import {
	_buildGraphVisibilityScope,
	type GraphVisibilityScope,
	retrieveGraphCandidates,
} from "./graph-retriever";
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
	SearchFilters,
} from "./types";

export interface SearchRequest {
	query: string;
	page?: number;
	limit?: number;
	maxGraphHops?: number;
	filters?: SearchFilters;
	/** Restricts every lexical/vector channel to an authorized document set. */
	documentIds?: string[];
	visibilityScope?: GraphVisibilityScope;
}

export interface SearchDiagnostics {
	reason?: "no_relevant_candidates";
	fastChannels: string[];
	channelErrors: Record<string, string>;
	expansionAttempted: boolean;
	expansionUsed?: boolean;
	expansionModel?: string;
	crossLanguageSuccess?: boolean;
	graphAttempted: boolean;
	graphFailed: boolean;
	confidenceReasons: string[];
}

export interface SearchResponse {
	items: RankedSearchResult[];
	total: number;
	/** Count of all filtered, visibility-authorized candidates before pagination. */
	visibleTotal?: number;
	/** Candidate IDs used to calculate visibleTotal across the complete result set. */
	visibleDocumentIds?: string[];
	page: number;
	limit: number;
	queryPlan: QueryPlan;
	diagnostics: SearchDiagnostics;
	/** Request-scoped query embedding for authorized result hydration. */
	queryEmbedding?: EmbeddingResult;
}

export interface SearchAdapterOptions {
	retrieveFast?: typeof retrieveFastChannels;
	getEmbedding?: (text: string) => Promise<EmbeddingResult>;
	retrieveExpanded?: (
		ctx: TenantContext,
		plan: QueryPlan,
		options?: {
			limit?: number;
			documentIds?: string[];
			getEmbedding?: (text: string) => Promise<EmbeddingResult>;
		},
	) => Promise<ChannelResult[]>;
	expand?: typeof expandQuery;
	retrieveGraph?: typeof retrieveGraphCandidates;
}

/** A folder category is usable only when the joined folder belongs to the caller. */
export function folderCategoryMatchesOwner(
	row: {
		folderCategoryId: string | null;
		folderOwnerId: string | null;
	},
	categoryId: string,
	ownerId: string,
): boolean {
	return row.folderOwnerId === ownerId && row.folderCategoryId === categoryId;
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
	const embeddingProvider = adapters.getEmbedding ?? getEmbedding;
	const expand = adapters.expand ?? expandQuery;
	const retrieveGraph = adapters.retrieveGraph ?? retrieveGraphCandidates;
	const channelErrors: Record<string, string> = {};
	// The vector channel and chunk hydration are part of one request. Keep a
	// promise cache at this boundary so both consumers share the same provider
	// result (including the active model/profile and failure code).
	const embeddingCache = new Map<string, Promise<EmbeddingResult>>();
	const getCachedEmbedding = (text: string): Promise<EmbeddingResult> => {
		const key = text.normalize("NFKC");
		const cached = embeddingCache.get(key);
		if (cached) return cached;
		// Resolve provider failures into a stable result. A rejected promise would
		// be caught by the vector channel, but chunk hydration would then call the
		// provider again because no queryEmbedding could be forwarded to the route.
		// The resolved failure sentinel keeps this request scoped and single-flight.
		const pending = Promise.resolve()
			.then(() =>
				resolveSearchEmbedding(
					embeddingProvider(text),
					config.SEARCH_VECTOR_PROVIDER_TIMEOUT_MS ?? 2_500,
				),
			)
			.catch(
				(): EmbeddingResult => ({
					ok: false,
					code: "provider_error",
				}),
			);
		embeddingCache.set(key, pending);
		return pending;
	};

	let fast: ChannelResult[];
	const fastStarted = performance.now();
	try {
		fast = await retrieveFast(ctx, plan, {
			limit: limit * 2,
			documentIds: request.documentIds,
			getEmbedding: getCachedEmbedding,
		} as Parameters<typeof retrieveFastChannels>[2]);
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
		recordSearchChannelMetrics({
			channel: result.channel,
			durationMs: result.durationMs,
			candidateCount: result.candidates.length,
			errorCode: result.errorCode,
		});
	}
	recordDuration(
		METRIC_NAMES.SEARCH_FAST_DURATION_MS,
		performance.now() - fastStarted,
	);

	const confidence = evaluateConfidence(fast, plan, {
		vectorMinSimilarity: config.SEARCH_VECTOR_MIN_SIMILARITY,
		minChannelAgreement: config.SEARCH_MIN_CHANNEL_AGREEMENT,
		languageMismatch:
			plan.detectedLanguage !== "en" && plan.detectedLanguage !== "und",
	});
	let expandedPlan: QueryPlan | null = null;
	let expansionModel: string | undefined;
	let expansionAttempted = false;
	let expansionUsed = false;
	let expanded: ChannelResult[] = [];
	if (!confidence.confident) {
		expansionAttempted = true;
		const expandedStarted = performance.now();
		try {
			const expansion = await expand(plan, {
				tenantScope: ctx.userId,
				ownerId: ctx.userId,
			});
			if (expansion) {
				expansionUsed = true;
				expandedPlan = expansion.plan;
				expansionModel = expansion.model;
				try {
					expanded = await retrieveExpanded(ctx, expandedPlan, {
						limit: limit * 2,
						documentIds: request.documentIds,
						getEmbedding: getCachedEmbedding,
					});
				} catch {
					expanded = [];
				}
			}
		} catch {
			// Expansion is optional; fast-pass results remain valid.
		}
		for (const result of expanded) {
			recordSearchChannelMetrics({
				channel: result.channel,
				durationMs: result.durationMs,
				candidateCount: result.candidates.length,
				errorCode: result.errorCode,
			});
		}
		recordSearchExpansionMetrics({
			reasons: confidence.reasons,
			used: expansionUsed,
			model: expansionModel,
			primaryModel: config.SEARCH_EXPANSION_MODEL,
			fallbackModel: config.SEARCH_EXPANSION_FALLBACK_MODEL,
			estimatedCostMicrounits: expansionUsed
				? config.SEARCH_EXPANSION_ESTIMATED_COST_MICROUNITS
				: 0,
		});
		recordDuration(
			METRIC_NAMES.SEARCH_EXPANDED_DURATION_MS,
			performance.now() - expandedStarted,
		);
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
	const graphStarted = performance.now();
	try {
		graph = await retrieveGraph(ctx, {
			documentSeeds: graphSeeds,
			queryPlan: graphPlan,
			limit: Math.min(limit * 2, config.SEARCH_GRAPH_RESULT_LIMIT),
			maxHops: request.maxGraphHops ?? config.SEARCH_GRAPH_MAX_HOPS,
			visibilityScope: request.visibilityScope,
		});
	} catch {
		graphFailed = true;
	}
	recordSearchChannelMetrics({
		channel: "graph",
		durationMs: performance.now() - graphStarted,
		candidateCount: graph.length,
		errorCode: graphFailed ? "query_failed" : undefined,
	});

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
	const filters = request.filters;
	const hasFilters = Boolean(
		filters &&
			Object.values(filters).some((value) =>
				Array.isArray(value) ? value.length > 0 : value !== undefined,
			),
	);
	const filtered = hasFilters
		? await applySearchFilters(
				ctx,
				ranked,
				filters as SearchFilters,
				request.visibilityScope,
			)
		: ranked;
	const offset = (page - 1) * limit;
	const items = filtered.slice(offset, offset + limit);
	const graphContribution = items.some((item) =>
		item.channels.includes("graph"),
	);
	const crossLanguageEligible =
		confidence.reasons.includes("language_mismatch");
	const crossLanguageSuccess =
		crossLanguageEligible &&
		expandedPlan !== null &&
		expanded.some((result) => result.candidates.length > 0);
	recordSearchOutcomeMetrics({
		empty: filtered.length === 0,
		graphContribution,
		crossLanguageEligible,
		crossLanguageSuccess,
	});
	const diagnostics: SearchDiagnostics = {
		...(ranked.length === 0
			? { reason: "no_relevant_candidates" as const }
			: {}),
		fastChannels: fast.map((result) => result.channel),
		channelErrors,
		expansionAttempted,
		expansionUsed,
		crossLanguageSuccess,
		...(expansionModel ? { expansionModel } : {}),
		graphAttempted: true,
		graphFailed,
		confidenceReasons: confidence.reasons,
	};
	return {
		items,
		total: filtered.length,
		visibleTotal: filtered.length,
		visibleDocumentIds: filtered.map((item) => item.documentId),
		page,
		limit,
		queryPlan: plan,
		diagnostics,
		...(await getCachedQueryEmbedding(embeddingCache, plan.normalized)),
	};
}

/** Bound optional vector retrieval independently from ingestion/reindex SLAs. */
export async function resolveSearchEmbedding(
	pending: Promise<EmbeddingResult>,
	timeoutMs: number,
): Promise<EmbeddingResult> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<EmbeddingResult>((resolve) => {
				timeout = setTimeout(
					() => resolve({ ok: false, code: "provider_error" }),
					Math.max(1, timeoutMs),
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function getCachedQueryEmbedding(
	cache: Map<string, Promise<EmbeddingResult>>,
	query: string,
): Promise<{ queryEmbedding: EmbeddingResult } | Record<string, never>> {
	const pending = cache.get(query.normalize("NFKC"));
	if (!pending) return {};
	try {
		return { queryEmbedding: await pending };
	} catch {
		return {};
	}
}

async function defaultExpandedRetriever(
	ctx: TenantContext,
	plan: QueryPlan,
	options: {
		limit?: number;
		documentIds?: string[];
		getEmbedding?: (text: string) => Promise<EmbeddingResult>;
	} = {},
): Promise<ChannelResult[]> {
	const variants = dedupe([
		...plan.translations,
		...plan.synonyms,
		...plan.concepts,
		...plan.namedEntities,
	]);
	if (variants.length === 0) return [];
	const limit = options.limit ?? 20;
	const results = await Promise.allSettled(
		variants.map(async (variant) => {
			const variantPlan: QueryPlan = { ...plan, normalized: variant };
			const result = await retrieveFastChannels(ctx, variantPlan, {
				limit,
				documentIds: options.documentIds,
				getEmbedding: options.getEmbedding,
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

async function applySearchFilters(
	ctx: TenantContext,
	items: RankedSearchResult[],
	filters: SearchFilters,
	visibilityScope?: GraphVisibilityScope,
): Promise<RankedSearchResult[]> {
	if (items.length === 0) return [];
	const ids = items.map((item) => item.documentId);
	const scope = visibilityScope ?? _buildGraphVisibilityScope(ctx);
	const visibility =
		scope.kind === "admin"
			? undefined
			: scope.kind === "public"
				? eq(documents.visibility, "public")
				: scope.kind === "share"
					? inArray(documents.id, scope.allowedDocumentIds)
					: scope.includePublic
						? or(
								eq(documents.ownerId, scope.ownerId),
								eq(documents.visibility, "public"),
							)
						: eq(documents.ownerId, scope.ownerId);
	const rows = await withTenant(ctx, async (tx) =>
		tx
			.select({
				id: documents.id,
				folderId: documents.folderId,
				categoryId: documents.categoryId,
				folderCategoryId: folders.categoryId,
				folderOwnerId: folders.ownerId,
				title: documents.title,
				createdAt: documents.createdAt,
			})
			.from(documents)
			.leftJoin(
				folders,
				and(
					eq(folders.id, documents.folderId),
					eq(folders.ownerId, ctx.userId),
				),
			)
			.where(and(visibility, inArray(documents.id, ids))),
	);
	const byId = new Map(rows.map((row) => [row.id, row]));
	let filtered = items.filter((item) => {
		const row = byId.get(item.documentId);
		if (!row) return false;
		if (
			filters.folderId &&
			(row.folderId !== filters.folderId || row.folderOwnerId !== ctx.userId)
		)
			return false;
		if (
			filters.categoryId &&
			row.categoryId !== filters.categoryId &&
			!folderCategoryMatchesOwner(row, filters.categoryId, ctx.userId)
		)
			return false;
		const created = new Date(row.createdAt).getTime();
		if (filters.dateFrom) {
			const from = new Date(filters.dateFrom).getTime();
			if (Number.isFinite(from) && created < from) return false;
		}
		if (filters.dateTo) {
			const toDate = new Date(filters.dateTo);
			if (!Number.isNaN(toDate.getTime())) {
				toDate.setHours(23, 59, 59, 999);
				if (created > toDate.getTime()) return false;
			}
		}
		return true;
	});
	if (filters.tagNames && filters.tagNames.length > 0) {
		const tagRows = await withTenant(ctx, async (tx) =>
			tx
				.select({ documentId: documentTags.documentId })
				.from(documentTags)
				.innerJoin(tags, eq(tags.id, documentTags.tagId))
				.where(
					and(
						eq(tags.ownerId, ctx.userId),
						inArray(tags.name, filters.tagNames ?? []),
						inArray(documentTags.documentId, ids),
					),
				),
		);
		const tagged = new Set(tagRows.map((row) => row.documentId));
		filtered = filtered.filter((item) => tagged.has(item.documentId));
	}
	if (filters.sort && filters.sort !== "relevance") {
		filtered.sort((left, right) => {
			const a = byId.get(left.documentId);
			const b = byId.get(right.documentId);
			if (!a || !b) return 0;
			if (filters.sort === "date_desc")
				return +new Date(b.createdAt) - +new Date(a.createdAt);
			if (filters.sort === "date_asc")
				return +new Date(a.createdAt) - +new Date(b.createdAt);
			const cmp = a.title.localeCompare(b.title);
			return filters.sort === "name_desc" ? -cmp : cmp;
		});
	}
	return filtered;
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

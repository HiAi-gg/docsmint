import type { TenantContext } from "@hiai-docs/db/with-tenant";
import { withTenant } from "@hiai-docs/db/with-tenant";
import { sql } from "drizzle-orm";
import { getEmbedding } from "../embedding";
import type { EmbeddingResult } from "../embedding/result";
import { config } from "../lib/config";
import type {
	ChannelResult,
	QueryPlan,
	SearchCandidate,
	SearchChannel,
} from "./types";

type Row = Record<string, unknown>;
type SearchQueryExecutor = (
	channel: SearchChannel,
	ctx: TenantContext,
	query: unknown,
) => Promise<unknown[]>;

export interface RetrieverOptions {
	limit?: number;
	/** Optional document allow-list used by share guests and scoped callers. */
	documentIds?: string[];
	vectorMinSimilarity?: number;
	fuzzyMinSimilarity?: number;
	chunkLimitPerDocument?: number;
	queryEmbedding?: EmbeddingResult;
	getEmbedding?: (text: string) => Promise<EmbeddingResult>;
	/** Test adapter; production uses withTenant and a pinned transaction. */
	execute?: SearchQueryExecutor;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_CHUNK_LIMIT = 3;

/**
 * Run the inexpensive retrieval channels in parallel. Every production query
 * executes inside the tenant transaction and also carries an owner predicate;
 * the owner check on returned rows is a final defence for adapter failures.
 */
export async function retrieveFastChannels(
	ctx: TenantContext,
	plan: QueryPlan,
	options: RetrieverOptions = {},
): Promise<ChannelResult[]> {
	const limit = clampLimit(options.limit ?? DEFAULT_LIMIT);
	const execute = options.execute ?? productionExecutor;
	const vectorMinSimilarity =
		options.vectorMinSimilarity ?? config.SEARCH_VECTOR_MIN_SIMILARITY;
	const fuzzyMinSimilarity =
		options.fuzzyMinSimilarity ?? config.SEARCH_FUZZY_MIN_SIMILARITY;
	const chunkLimitPerDocument = Math.max(
		1,
		Math.floor(options.chunkLimitPerDocument ?? DEFAULT_CHUNK_LIMIT),
	);
	if (options.documentIds && options.documentIds.length === 0) {
		return ["exact", "fts", "fuzzy", "vector"].map((channel) => ({
			channel: channel as SearchChannel,
			candidates: [],
			durationMs: 0,
		}));
	}
	const scopedOptions = options.documentIds
		? sql`AND d.id IN (${sql.join(
				options.documentIds.map((id) => sql`${id}`),
				sql`, `,
			)})`
		: sql``;

	const tasks: Array<Promise<ChannelResult>> = [
		measure("exact", () =>
			retrieveExact(ctx, plan, limit, execute, scopedOptions),
		),
		measure("fts", () => retrieveFts(ctx, plan, limit, execute, scopedOptions)),
		measure("fuzzy", () =>
			retrieveFuzzy(
				ctx,
				plan,
				limit,
				fuzzyMinSimilarity,
				execute,
				scopedOptions,
			),
		),
		measure("vector", () =>
			retrieveVector(
				ctx,
				plan,
				limit,
				vectorMinSimilarity,
				chunkLimitPerDocument,
				execute,
				options.queryEmbedding,
				options.getEmbedding,
				scopedOptions,
			),
		),
	];

	const settled = await Promise.allSettled(tasks);
	return settled.map((item, index) => {
		const channel = ["exact", "fts", "fuzzy", "vector"][index] as SearchChannel;
		if (item.status === "fulfilled") return item.value;
		return {
			channel,
			candidates: [],
			durationMs: 0,
			errorCode: "query_failed",
		};
	});
}

async function measure(
	channel: SearchChannel,
	work: () => Promise<SearchCandidate[] | VectorFailure>,
): Promise<ChannelResult> {
	const start = Date.now();
	try {
		const result = await work();
		if (isVectorFailure(result)) {
			return {
				channel,
				candidates: [],
				durationMs: Date.now() - start,
				errorCode: result.code,
			};
		}
		return { channel, candidates: result, durationMs: Date.now() - start };
	} catch {
		return {
			channel,
			candidates: [],
			durationMs: Date.now() - start,
			errorCode: "query_failed",
		};
	}
}

interface VectorFailure {
	code: string;
}

function isVectorFailure(
	value: SearchCandidate[] | VectorFailure,
): value is VectorFailure {
	return !Array.isArray(value);
}

async function retrieveExact(
	ctx: TenantContext,
	plan: QueryPlan,
	limit: number,
	execute: SearchQueryExecutor,
	scope: ReturnType<typeof sql>,
): Promise<SearchCandidate[]> {
	const query = sql`
		SELECT d.id AS document_id, d.owner_id, d.title,
			1.0::double precision AS score
		FROM documents d
		WHERE d.owner_id = ${ctx.userId}
			${scope}
			AND (
				lower(trim(d.title)) = lower(trim(${plan.normalized}))
				OR regexp_replace(lower(d.title), '[^[:alnum:]]+', '', 'g') =
					regexp_replace(lower(${plan.normalized}), '[^[:alnum:]]+', '', 'g')
				OR (
					lower(trim(${plan.normalized})) ~ '^[[:alnum:]_./:-]+$'
					AND EXISTS (
						SELECT 1
						FROM regexp_split_to_table(lower(d.title), '[^[:alnum:]]+') AS title_token
						WHERE title_token = lower(trim(${plan.normalized}))
					)
				)
			)
		ORDER BY score DESC, d.id ASC
		LIMIT ${limit}
	`;
	const rows = await execute("exact", ctx, query);
	return rowsToCandidates(
		rows,
		ctx,
		"exact",
		"Exact title or identifier match",
	);
}

async function retrieveFts(
	ctx: TenantContext,
	plan: QueryPlan,
	limit: number,
	execute: SearchQueryExecutor,
	scope: ReturnType<typeof sql>,
): Promise<SearchCandidate[]> {
	const query = sql`
		WITH lexical AS (
			SELECT d.id AS document_id, d.owner_id,
				ts_rank(d.search_vector, websearch_to_tsquery('english', ${plan.normalized})) AS score
			FROM documents d
			WHERE d.owner_id = ${ctx.userId}
				${scope}
				AND d.search_vector @@ websearch_to_tsquery('english', ${plan.normalized})
			UNION ALL
			SELECT d.id AS document_id, d.owner_id,
				ts_rank(d.search_vector_simple, websearch_to_tsquery('simple', ${plan.normalized})) AS score
			FROM documents d
			WHERE d.owner_id = ${ctx.userId}
				${scope}
				AND d.search_vector_simple @@ websearch_to_tsquery('simple', ${plan.normalized})
		)
		SELECT document_id, owner_id, MAX(score)::double precision AS score
		FROM lexical
		GROUP BY document_id, owner_id
		ORDER BY score DESC, document_id ASC
		LIMIT ${limit}
	`;
	const rows = await execute("fts", ctx, query);
	return rowsToCandidates(
		rows,
		ctx,
		"fts",
		"English or language-neutral lexical match",
	);
}

async function retrieveFuzzy(
	ctx: TenantContext,
	plan: QueryPlan,
	limit: number,
	minimum: number,
	execute: SearchQueryExecutor,
	scope: ReturnType<typeof sql>,
): Promise<SearchCandidate[]> {
	const query = sql`
		SELECT d.id AS document_id, d.owner_id,
			similarity(d.title, ${plan.normalized})::double precision AS score
		FROM documents d
		WHERE d.owner_id = ${ctx.userId}
			${scope}
			AND d.title % ${plan.normalized}
			AND similarity(d.title, ${plan.normalized}) >= ${minimum}
		ORDER BY score DESC, d.id ASC
		LIMIT ${limit}
	`;
	const rows = await execute("fuzzy", ctx, query);
	return rowsToCandidates(rows, ctx, "fuzzy", "Typo-tolerant title match");
}

async function retrieveVector(
	ctx: TenantContext,
	plan: QueryPlan,
	limit: number,
	minimum: number,
	chunkLimit: number,
	execute: SearchQueryExecutor,
	providedEmbedding?: EmbeddingResult,
	embeddingProvider: (text: string) => Promise<EmbeddingResult> = getEmbedding,
	scope: ReturnType<typeof sql> = sql``,
): Promise<SearchCandidate[] | VectorFailure> {
	let queryEmbedding = providedEmbedding;
	if (!queryEmbedding) {
		try {
			queryEmbedding = await embeddingProvider(plan.normalized);
		} catch {
			return { code: "provider_error" };
		}
	}
	if (!queryEmbedding.ok) return { code: queryEmbedding.code };

	const embeddingString = `[${queryEmbedding.vector.join(",")}]`;
	const query = sql`
		WITH ranked_chunks AS (
			SELECT
				de.document_id,
				d.owner_id,
				(1 - (de.embedding <=> ${embeddingString}::vector))::double precision AS score,
				row_number() OVER (
					PARTITION BY de.document_id
					ORDER BY de.embedding <=> ${embeddingString}::vector
				) AS chunk_rank
			FROM document_embeddings de
			JOIN documents d ON d.id = de.document_id
			WHERE d.owner_id = ${ctx.userId}
				${scope}
				AND d.embedding_status = 'ready'
				AND d.active_embedding_generation IS NOT NULL
				AND de.generation_id = d.active_embedding_generation
				AND de.is_valid = true
				AND de.embedding_dimensions = 1024
				AND de.embedding_profile = d.embedding_profile
				AND de.embedding_profile = ${queryEmbedding.profile}
				AND de.embedding IS NOT NULL
				AND vector_norm(de.embedding) > 0
		), top_chunks AS (
			SELECT document_id, owner_id, score
			FROM ranked_chunks
			WHERE chunk_rank <= ${chunkLimit}
		)
		SELECT document_id, owner_id, MAX(score)::double precision AS score
		FROM top_chunks
		WHERE score >= ${minimum}
		GROUP BY document_id, owner_id
		ORDER BY score DESC, document_id ASC
		LIMIT ${limit}
	`;
	const rows = await execute("vector", ctx, query);
	return rowsToCandidates(rows, ctx, "vector", "Semantic match", minimum);
}

function rowsToCandidates(
	rows: unknown[],
	ctx: TenantContext,
	channel: SearchChannel,
	evidence: string,
	minimumScore?: number,
): SearchCandidate[] {
	const valid = rows
		.map((value) =>
			value && typeof value === "object" ? (value as Row) : null,
		)
		.filter((row): row is Row => row !== null)
		.filter((row) => row.owner_id === ctx.userId)
		.map((row) => ({
			documentId: String(row.document_id ?? ""),
			rawScore: toFiniteNumber(row.score),
			isValid: row.is_valid,
			isActive: row.is_active,
			profileCompatible: row.profile_compatible,
		}))
		.filter(
			(row) =>
				row.documentId.length > 0 &&
				row.rawScore !== undefined &&
				(minimumScore === undefined || row.rawScore >= minimumScore) &&
				(row.isValid === undefined || row.isValid === true) &&
				(row.isActive === undefined || row.isActive === true) &&
				(row.profileCompatible === undefined || row.profileCompatible === true),
		)
		.sort((a, b) => {
			if (b.rawScore !== a.rawScore)
				return (b.rawScore ?? 0) - (a.rawScore ?? 0);
			return a.documentId.localeCompare(b.documentId);
		});

	return valid.map((row, index) => ({
		documentId: row.documentId,
		channel,
		rank: index + 1,
		rawScore: row.rawScore,
		evidence,
	}));
}

function toFiniteNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function clampLimit(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(100, Math.floor(value)));
}

async function productionExecutor(
	_channel: SearchChannel,
	ctx: TenantContext,
	query: unknown,
): Promise<unknown[]> {
	return withTenant(ctx, async (tx) => {
		const result = await tx.execute(query as Parameters<typeof tx.execute>[0]);
		return result as unknown as unknown[];
	});
}

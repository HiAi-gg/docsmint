import { z } from "zod";
import { config } from "../lib/config";
import {
	type ChatProviderConfig,
	requestStructuredChat,
	resolveChatProviderKey,
} from "../lib/openai-compatible-chat";
import { redis } from "../lib/redis";
import type { QueryPlan } from "./types";

export type { QueryPlan } from "./types";

export interface ExpansionScope {
	tenantScope?: string;
	tenantId?: string;
	ownerId?: string;
}

const EXPANSION_SCHEMA_VERSION = "v1";
const expansionOutputSchema = z.object({
	translations: z.array(z.string()),
	synonyms: z.array(z.string()),
	concepts: z.array(z.string()),
	namedEntities: z.array(z.string()),
});

/**
 * Perform one bounded structured expansion pass. Provider and cache failures
 * return null so the caller can continue with the fast retrieval plan.
 */
export async function expandQuery(
	plan: QueryPlan,
	scope: ExpansionScope | string,
): Promise<{ plan: QueryPlan; model: string } | null> {
	if (!config.SEARCH_EXPANSION_ENABLED) return null;

	const tenantScope =
		typeof scope === "string"
			? scope.trim()
			: (scope.tenantScope ?? scope.tenantId ?? scope.ownerId ?? "").trim();
	if (!tenantScope || !plan.normalized.trim()) return null;

	const primary = providerConfig(
		config.SEARCH_EXPANSION_BASE_URL,
		config.SEARCH_EXPANSION_API_KEY,
		config.SEARCH_EXPANSION_MODEL,
	);
	const fallback = providerConfig(
		config.SEARCH_EXPANSION_FALLBACK_BASE_URL,
		config.SEARCH_EXPANSION_FALLBACK_API_KEY,
		config.SEARCH_EXPANSION_FALLBACK_MODEL,
	);
	const providerCount = fallback.baseUrl ? 2 : 1;
	const providerTimeoutMs = Math.max(
		250,
		Math.floor(config.SEARCH_EXPANSION_TIMEOUT_MS / providerCount),
	);
	primary.timeoutMs = providerTimeoutMs;
	fallback.timeoutMs = providerTimeoutMs;
	const key = await expansionCacheKey(
		tenantScope,
		plan.normalized,
		primary,
		fallback,
	);
	const ttl = config.SEARCH_EXPANSION_CACHE_TTL_SECONDS;

	if (ttl > 0) {
		try {
			const cached = await redis.get(key);
			if (cached) {
				const parsed = JSON.parse(cached) as unknown;
				const valid = cachedResultSchema.safeParse(parsed);
				if (valid.success) {
					return {
						model: valid.data.model,
						plan: {
							...valid.data.plan,
							translations: cleanVariants(
								valid.data.plan.translations,
								[valid.data.plan.original, valid.data.plan.normalized],
								config.SEARCH_EXPANSION_MAX_VARIANTS,
							),
							synonyms: cleanVariants(
								valid.data.plan.synonyms,
								[valid.data.plan.original, valid.data.plan.normalized],
								config.SEARCH_EXPANSION_MAX_VARIANTS,
							),
							concepts: cleanVariants(
								valid.data.plan.concepts,
								[valid.data.plan.original, valid.data.plan.normalized],
								config.SEARCH_EXPANSION_MAX_VARIANTS,
							),
							namedEntities: cleanVariants(
								valid.data.plan.namedEntities,
								[valid.data.plan.original, valid.data.plan.normalized],
								config.SEARCH_EXPANSION_MAX_VARIANTS,
							),
						},
					};
				}
			}
		} catch {
			// Redis is an optimization. Continue to the provider on cache errors.
		}
	}

	const result = await requestStructuredChat({
		primary,
		fallback,
		messages: [
			{
				role: "system",
				content:
					"Return JSON only with arrays named translations, synonyms, concepts, and namedEntities. Do not explain your answer.",
			},
			{
				role: "user",
				content: JSON.stringify({
					query: plan.original,
					locale: plan.detectedLanguage,
				}),
			},
		],
		outputSchema: expansionOutputSchema,
		maxTokens: 512,
		temperature: 0,
	});
	const local = localQueryVariants(plan);
	if (!result && local.every((values) => values.length === 0)) return null;
	const providerData = result?.data ?? {
		translations: [],
		synonyms: [],
		concepts: [],
		namedEntities: [],
	};
	const localFallback = result ? ([[], [], [], []] as typeof local) : local;

	const expandedPlan: QueryPlan = {
		original: plan.original,
		normalized: plan.normalized,
		detectedLanguage: plan.detectedLanguage,
		translations: cleanVariants(
			[...plan.translations, ...providerData.translations, ...localFallback[0]],
			[plan.original, plan.normalized],
			config.SEARCH_EXPANSION_MAX_VARIANTS,
		),
		synonyms: cleanVariants(
			[...plan.synonyms, ...providerData.synonyms, ...localFallback[1]],
			[plan.original, plan.normalized],
			config.SEARCH_EXPANSION_MAX_VARIANTS,
		),
		concepts: cleanVariants(
			[...plan.concepts, ...providerData.concepts, ...localFallback[2]],
			[plan.original, plan.normalized],
			config.SEARCH_EXPANSION_MAX_VARIANTS,
		),
		namedEntities: cleanVariants(
			[
				...plan.namedEntities,
				...providerData.namedEntities,
				...localFallback[3],
			],
			[plan.original, plan.normalized],
			config.SEARCH_EXPANSION_MAX_VARIANTS,
		),
	};
	const output = {
		plan: expandedPlan,
		model: result?.model ?? "local-lexicon-v1",
	};

	if (ttl > 0) {
		try {
			await redis.set(key, JSON.stringify(output), "EX", ttl);
		} catch {
			// Cache write failure does not invalidate a successful expansion.
		}
	}
	return output;
}

/** Deterministic multilingual safety net for high-value language concepts. */
function localQueryVariants(
	plan: QueryPlan,
): [string[], string[], string[], string[]] {
	const query = plan.normalized.toLocaleLowerCase();
	const translations: string[] = [];
	const concepts: string[] = [];
	if (/английск/u.test(query)) translations.push("english");
	if (/француз/u.test(query)) translations.push("french");
	if (/португал/u.test(query)) translations.push("portuguese");
	if (/язык/u.test(query)) {
		translations.push("language", "languages");
		concepts.push(
			"english",
			"french",
			"portuguese",
			"английский",
			"французский",
			"португальский",
		);
	}
	return [translations, [], concepts, []];
}

const cachedResultSchema = z.object({
	plan: z.object({
		original: z.string(),
		normalized: z.string(),
		detectedLanguage: z.string(),
		translations: z.array(z.string()),
		synonyms: z.array(z.string()),
		concepts: z.array(z.string()),
		namedEntities: z.array(z.string()),
	}),
	model: z.string(),
});

export async function expansionCacheKey(
	tenantScope: string,
	normalizedQuery: string,
	primary: ChatProviderConfig = providerConfig(
		config.SEARCH_EXPANSION_BASE_URL,
		config.SEARCH_EXPANSION_API_KEY,
		config.SEARCH_EXPANSION_MODEL,
	),
	fallback: ChatProviderConfig | undefined = undefined,
): Promise<string> {
	const modelProfile = [
		primary.baseUrl,
		primary.model,
		fallback?.baseUrl ?? "",
		fallback?.model ?? "",
	].join("|");
	const input = [
		tenantScope,
		normalizedQuery,
		modelProfile,
		EXPANSION_SCHEMA_VERSION,
	].join("\u001f");
	const digest = new Bun.CryptoHasher("sha256").update(input).digest("hex");
	return `hiai-docs:search:expansion:${digest}`;
}

function providerConfig(
	baseUrl: string,
	explicitKey: string | undefined,
	model: string,
): ChatProviderConfig {
	return {
		baseUrl,
		model,
		apiKey: resolveChatProviderKey(
			baseUrl,
			explicitKey,
			config.OPENROUTER_API_KEY,
		),
		timeoutMs: config.SEARCH_EXPANSION_TIMEOUT_MS,
	};
}

function cleanVariants(
	values: string[],
	originals: readonly string[],
	max: number,
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const originalKeys = new Set(originals.map(normalizeVariant));
	for (const value of values) {
		const cleaned = value.trim();
		const key = normalizeVariant(cleaned);
		if (!cleaned || !key || originalKeys.has(key) || seen.has(key)) continue;
		seen.add(key);
		out.push(cleaned);
		if (out.length >= max) break;
	}
	return out;
}

function normalizeVariant(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.replace(/\s+/g, " ")
		.toLocaleLowerCase();
}

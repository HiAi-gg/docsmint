import { config } from "../lib/config";
import { logger } from "../lib/logger";
import {
	incrementCounter,
	incrementCounterBy,
	METRIC_NAMES,
	recordDuration,
} from "../lib/metrics";
import { resolveChatProviderKey } from "../lib/openai-compatible-chat";
import type { RerankHit, RerankProviderResult, RerankRequest } from "./rerank";

interface RerankSlot {
	baseUrl: string;
	apiKey: string;
	model: string;
}

function configuredSlots(): RerankSlot[] {
	const slots: Array<{
		baseUrl?: string;
		apiKey?: string;
		model?: string;
	}> = [
		{
			baseUrl: config.SEARCH_RERANK_BASE_URL,
			apiKey: config.SEARCH_RERANK_API_KEY,
			model: config.SEARCH_RERANK_MODEL,
		},
		{
			baseUrl: config.SEARCH_RERANK_FALLBACK_BASE_URL,
			apiKey: config.SEARCH_RERANK_FALLBACK_API_KEY,
			model: config.SEARCH_RERANK_FALLBACK_MODEL,
		},
		{
			baseUrl: config.SEARCH_RERANK_FALLBACK_2_BASE_URL,
			apiKey: config.SEARCH_RERANK_FALLBACK_2_API_KEY,
			model: config.SEARCH_RERANK_FALLBACK_2_MODEL,
		},
	];
	const seen = new Set<string>();
	const unique: RerankSlot[] = [];
	for (const slot of slots) {
		if (!slot.baseUrl || !slot.model) continue;
		const identity = `${slot.baseUrl}|${slot.model}`;
		if (seen.has(identity)) continue;
		seen.add(identity);
		unique.push({
			baseUrl: slot.baseUrl,
			model: slot.model,
			apiKey: resolveChatProviderKey(
				slot.baseUrl,
				slot.apiKey,
				config.OPENROUTER_API_KEY,
			),
		});
	}
	return unique;
}

function rerankUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/$/, "");
	return normalized.endsWith("/rerank") ? normalized : `${normalized}/rerank`;
}

/**
 * Call the configured OpenRouter-compatible /rerank chain. Timeouts and
 * provider errors return null so the orchestrator can keep RRF order.
 */
export async function requestRerank(
	input: RerankRequest,
): Promise<RerankProviderResult | null> {
	const documents = input.candidates
		.map((candidate) => candidate.text.trim())
		.filter((text) => text.length > 0);
	if (documents.length === 0) return null;
	const ids = input.candidates.map((candidate) => candidate.id);
	const topN = Math.min(
		input.topN ?? config.SEARCH_RERANK_TOP_N,
		documents.length,
	);
	const timeoutMs = config.SEARCH_RERANK_TIMEOUT_MS;
	const started = performance.now();
	incrementCounterBy(
		METRIC_NAMES.SEARCH_RERANK_CANDIDATES_TOTAL,
		documents.length,
	);
	try {
		for (const slot of configuredSlots()) {
			try {
				const hits = await callRerankSlot(slot, input.query, documents, ids, {
					topN,
					timeoutMs,
				});
				if (hits.length === 0) continue;
				incrementCounter(METRIC_NAMES.SEARCH_RERANK_SUCCESS_TOTAL);
				return { hits, model: slot.model };
			} catch (error) {
				logger.warn(
					{ err: error, model: slot.model },
					"Rerank provider failed, trying next configured provider",
				);
			}
		}
		incrementCounter(METRIC_NAMES.SEARCH_RERANK_FALLBACK_TOTAL);
		return null;
	} finally {
		recordDuration(
			METRIC_NAMES.SEARCH_RERANK_DURATION_MS,
			performance.now() - started,
		);
	}
}

async function callRerankSlot(
	slot: RerankSlot,
	query: string,
	documents: string[],
	ids: string[],
	options: { topN: number; timeoutMs: number },
): Promise<RerankHit[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (slot.apiKey) headers.Authorization = `Bearer ${slot.apiKey}`;
	try {
		const response = await fetch(rerankUrl(slot.baseUrl), {
			method: "POST",
			headers,
			signal: controller.signal,
			body: JSON.stringify({
				model: slot.model,
				query,
				documents,
				top_n: options.topN,
			}),
		});
		if (!response.ok) {
			throw new Error(`rerank provider returned ${response.status}`);
		}
		const body = (await response.json()) as {
			results?: Array<{ index?: number; relevance_score?: number }>;
		};
		const hits: RerankHit[] = [];
		for (const [rank, row] of (body.results ?? []).entries()) {
			if (typeof row.index !== "number" || row.index < 0) continue;
			const id = ids[row.index];
			if (!id) continue;
			const score =
				typeof row.relevance_score === "number" &&
				Number.isFinite(row.relevance_score)
					? row.relevance_score
					: 0;
			hits.push({ id, score, rank: rank + 1 });
		}
		return hits;
	} finally {
		clearTimeout(timer);
	}
}

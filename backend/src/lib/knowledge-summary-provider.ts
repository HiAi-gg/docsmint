import { z } from "zod";
import { config } from "./config";
import type {
	KnowledgeSummaryDocument,
	KnowledgeSummaryProviderResult,
} from "./knowledge-summary";
import {
	type ChatProviderConfig,
	requestStructuredChatDetailed,
	resolveChatProviderKey,
} from "./openai-compatible-chat";

const summarySchema = z.object({
	language: z.string().min(1).max(32),
	description: z.string().min(1).max(2_000),
	keywords: z.array(z.string().min(1).max(100)).max(20),
});

const systemPrompt = [
	"Summarize a knowledge-base document for retrieval metadata.",
	"Return only JSON with language, description, and keywords.",
	"Use a concise factual description and at most 20 distinct keywords.",
].join("\n");

function provider(
	baseUrl: string | undefined,
	apiKey: string | undefined,
	model: string | undefined,
): ChatProviderConfig | undefined {
	if (!baseUrl || !model) return undefined;
	return {
		baseUrl,
		model,
		apiKey: resolveChatProviderKey(baseUrl, apiKey, config.OPENROUTER_API_KEY),
		timeoutMs: config.GRAPH_EXTRACT_TIMEOUT_MS,
		reasoningEffort: config.GRAPH_EXTRACT_REASONING_EFFORT,
	};
}

/** Use the OSS knowledge-provider profile; downstream hosts never call a provider. */
export async function requestKnowledgeSummary(
	document: KnowledgeSummaryDocument,
): Promise<KnowledgeSummaryProviderResult | null> {
	const primary = provider(
		config.GRAPH_EXTRACT_BASE_URL,
		config.GRAPH_EXTRACT_API_KEY,
		config.GRAPH_EXTRACT_MODEL,
	);
	if (!primary) return null;
	const fallbacks = [
		provider(
			config.GRAPH_EXTRACT_FALLBACK_BASE_URL,
			config.GRAPH_EXTRACT_FALLBACK_API_KEY,
			config.GRAPH_EXTRACT_FALLBACK_MODEL,
		),
		provider(
			config.GRAPH_EXTRACT_FALLBACK_2_BASE_URL,
			config.GRAPH_EXTRACT_FALLBACK_2_API_KEY,
			config.GRAPH_EXTRACT_FALLBACK_2_MODEL,
		),
	].filter((item): item is NonNullable<typeof item> => Boolean(item));
	const attempt = await requestStructuredChatDetailed({
		primary,
		fallbacks,
		messages: [
			{ role: "system", content: systemPrompt },
			{
				role: "user",
				content: `Title: ${document.title}\n\n${document.content.slice(0, 50_000)}`,
			},
		],
		outputSchema: summarySchema,
		maxTokens: 768,
		temperature: 0,
	});
	if (!attempt.ok) throw attempt.error;
	return { ...attempt.result.data, model: attempt.result.model };
}

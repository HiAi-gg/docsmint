import type { z } from "zod";

export interface ChatProviderConfig {
	baseUrl: string;
	model: string;
	apiKey?: string;
	timeoutMs: number;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
}

export interface ChatMessage {
	role: "system" | "user";
	content: string;
}

export interface StructuredChatOptions<T> {
	primary: ChatProviderConfig;
	fallback?: ChatProviderConfig;
	messages: readonly ChatMessage[];
	outputSchema: z.ZodType<T>;
	maxTokens?: number;
	temperature?: number;
}

export interface StructuredChatResult<T> {
	data: T;
	model: string;
}

/**
 * Resolve a provider credential without allowing a shared OpenRouter key to
 * leak to local or custom OpenAI-compatible endpoints.
 */
export function resolveChatProviderKey(
	baseUrl: string,
	explicitKey: string | undefined,
	sharedOpenRouterKey: string | undefined,
): string {
	const explicit = explicitKey?.trim();
	if (explicit) return explicit;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return "";
	}
	if (hostname !== "openrouter.ai" && hostname !== "www.openrouter.ai")
		return "";
	return sharedOpenRouterKey?.trim() ?? "";
}

/**
 * Call an OpenAI-compatible chat endpoint and validate its JSON response.
 * Provider failures, malformed JSON, schema failures, and timeouts are all
 * safe failures; the fallback is attempted before returning null.
 */
export async function requestStructuredChat<T>(
	options: StructuredChatOptions<T>,
): Promise<StructuredChatResult<T> | null> {
	const providers = [options.primary, options.fallback].filter(
		(provider): provider is ChatProviderConfig => Boolean(provider?.baseUrl),
	);
	for (const provider of providers) {
		try {
			const raw = await requestChatContent(provider, options);
			const parsed = parseJson(raw);
			const result = options.outputSchema.safeParse(parsed);
			if (!result.success) continue;
			return { data: result.data, model: provider.model };
		} catch {
			// Expansion and extraction are enrichment. Continue with the next
			// provider and let callers degrade gracefully when both fail.
		}
	}
	return null;
}

async function requestChatContent<T>(
	provider: ChatProviderConfig,
	options: StructuredChatOptions<T>,
): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

	try {
		const response = await fetch(chatCompletionsUrl(provider.baseUrl), {
			method: "POST",
			headers,
			signal: controller.signal,
			body: JSON.stringify({
				model: provider.model,
				messages: options.messages,
				max_tokens: options.maxTokens ?? 512,
				temperature: options.temperature ?? 0,
				response_format: { type: "json_object" },
				...(provider.reasoningEffort
					? { reasoning_effort: provider.reasoningEffort }
					: {}),
			}),
		});
		if (!response.ok)
			throw new Error(`chat provider returned ${response.status}`);
		const body = (await response.json()) as {
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		const content = body.choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim()) {
			throw new Error("chat provider returned empty content");
		}
		return content;
	} finally {
		clearTimeout(timeout);
	}
}

function chatCompletionsUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/$/, "");
	return normalized.endsWith("/chat/completions")
		? normalized
		: `${normalized}/chat/completions`;
}

function parseJson(raw: string): unknown {
	const trimmed = raw.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return JSON.parse(fenced?.[1] ?? trimmed);
}

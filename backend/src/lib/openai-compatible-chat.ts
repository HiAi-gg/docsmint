import type { z } from "zod";
import { PipelineProviderError } from "./pipeline-error";

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
	fallbacks?: ChatProviderConfig[];
	messages: readonly ChatMessage[];
	outputSchema: z.ZodType<T>;
	maxTokens?: number;
	temperature?: number;
}

export interface StructuredChatResult<T> {
	data: T;
	model: string;
}

export type StructuredChatAttempt<T> =
	| { ok: true; result: StructuredChatResult<T> }
	| { ok: false; error: PipelineProviderError };

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

/** Drop empty and duplicate chat providers while preserving configured order. */
export function uniqueChatProviders(
	providers: Array<ChatProviderConfig | undefined>,
): ChatProviderConfig[] {
	const seen = new Set<string>();
	const unique: ChatProviderConfig[] = [];
	for (const provider of providers) {
		if (!provider?.baseUrl || !provider.model) continue;
		const identity = [
			provider.baseUrl,
			provider.model,
			provider.apiKey ?? "",
		].join("|");
		if (seen.has(identity)) continue;
		seen.add(identity);
		unique.push(provider);
	}
	return unique;
}

/**
 * Call an OpenAI-compatible chat endpoint and validate its JSON response.
 * Provider failures, malformed JSON, schema failures, and timeouts are all
 * safe failures; remaining fallbacks are attempted before returning null.
 */
export async function requestStructuredChat<T>(
	options: StructuredChatOptions<T>,
): Promise<StructuredChatResult<T> | null> {
	const attempt = await requestStructuredChatDetailed(options);
	return attempt.ok ? attempt.result : null;
}

export async function requestStructuredChatDetailed<T>(
	options: StructuredChatOptions<T>,
): Promise<StructuredChatAttempt<T>> {
	const providers = uniqueChatProviders([
		options.primary,
		options.fallback,
		...(options.fallbacks ?? []),
	]);
	let lastError = new PipelineProviderError(
		"provider_unavailable",
		false,
		"No chat provider was configured",
	);
	for (const provider of providers) {
		try {
			const raw = await requestChatContent(provider, options);
			let parsed: unknown;
			try {
				parsed = parseJson(raw);
			} catch {
				lastError = new PipelineProviderError(
					"invalid_provider_response",
					true,
				);
				continue;
			}
			const result = options.outputSchema.safeParse(parsed);
			if (!result.success) {
				lastError = new PipelineProviderError(
					"permanent_validation_failure",
					false,
				);
				continue;
			}
			return {
				ok: true,
				result: { data: result.data, model: provider.model },
			};
		} catch (error) {
			lastError =
				error instanceof PipelineProviderError
					? error
					: error instanceof Error && error.name === "AbortError"
						? new PipelineProviderError("provider_timeout", true)
						: new PipelineProviderError("provider_failure", true);
			// Expansion and extraction are enrichment. Continue with the next
			// provider and let callers degrade gracefully when the chain fails.
		}
	}
	return { ok: false, error: lastError };
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
			throw new PipelineProviderError(
				"provider_failure",
				true,
				`chat provider returned ${response.status}`,
			);
		let body: {
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		try {
			body = (await response.json()) as typeof body;
		} catch {
			throw new PipelineProviderError("invalid_provider_response", true);
		}
		const content = body.choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim()) {
			throw new PipelineProviderError("invalid_provider_response", true);
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

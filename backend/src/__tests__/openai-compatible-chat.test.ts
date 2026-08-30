import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
	requestStructuredChat,
	resolveChatProviderKey,
	uniqueChatProviders,
} from "../lib/openai-compatible-chat";

describe("shared OpenRouter credential resolution", () => {
	test("allows the canonical OpenRouter hostnames", () => {
		expect(
			resolveChatProviderKey(
				"https://openrouter.ai/api/v1",
				undefined,
				"shared-key",
			),
		).toBe("shared-key");
		expect(
			resolveChatProviderKey(
				"https://WWW.OPENROUTER.AI/api/v1",
				undefined,
				"shared-key",
			),
		).toBe("shared-key");
	});

	test("does not send the shared key to lookalike or malformed hosts", () => {
		for (const baseUrl of [
			"https://openrouter.ai.evil.example/api/v1",
			"https://openrouter.ai@evil.example/api/v1",
			"https://evil.example/openrouter.ai/api/v1",
			"not-a-url-containing-openrouter.ai",
		]) {
			expect(resolveChatProviderKey(baseUrl, undefined, "shared-key")).toBe("");
		}
	});

	test("keeps an explicit provider key independent of host validation", () => {
		expect(
			resolveChatProviderKey(
				"http://ollama:11434/v1",
				"provider-key",
				"shared-key",
			),
		).toBe("provider-key");
	});
});

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function chatProvider(
	model: string,
	baseUrl = `https://${model}.test/v1`,
): {
	baseUrl: string;
	model: string;
	timeoutMs: number;
} {
	return { baseUrl, model, timeoutMs: 1_000 };
}

function completion(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("structured chat fallback chain", () => {
	const outputSchema = z.object({ ok: z.boolean() });

	test("uniqueChatProviders drops empty and duplicate slots", () => {
		expect(
			uniqueChatProviders([
				chatProvider("a"),
				undefined,
				{ ...chatProvider("a"), apiKey: "" },
				chatProvider("b"),
				{ baseUrl: "", model: "c", timeoutMs: 1_000 },
			]).map((provider) => provider.model),
		).toEqual(["a", "b"]);
	});

	test("tries primary then two fallbacks before succeeding", async () => {
		const models: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("primary.test")) {
				models.push("primary");
				return completion("not-json", 503);
			}
			if (url.includes("fallback.test")) {
				models.push("fallback");
				throw new Error("fallback down");
			}
			models.push("fallback_2");
			return completion(JSON.stringify({ ok: true }));
		}) as unknown as typeof fetch;

		const result = await requestStructuredChat({
			primary: chatProvider("primary", "https://primary.test/v1"),
			fallbacks: [
				chatProvider("fallback", "https://fallback.test/v1"),
				chatProvider("fallback_2", "https://fallback2.test/v1"),
			],
			messages: [{ role: "user", content: "q" }],
			outputSchema,
		});
		expect(result).toEqual({ data: { ok: true }, model: "fallback_2" });
		expect(models).toEqual(["primary", "fallback", "fallback_2"]);
	});

	test("returns null after every provider in the chain fails", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("unavailable");
		}) as unknown as typeof fetch;
		const result = await requestStructuredChat({
			primary: chatProvider("primary"),
			fallback: chatProvider("fallback"),
			fallbacks: [chatProvider("fallback_2")],
			messages: [{ role: "user", content: "q" }],
			outputSchema,
		});
		expect(result).toBeNull();
	});
});

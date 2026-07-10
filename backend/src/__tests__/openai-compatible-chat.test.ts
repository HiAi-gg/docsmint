import { describe, expect, test } from "bun:test";
import { resolveChatProviderKey } from "../lib/openai-compatible-chat";

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

import { describe, expect, it } from "bun:test";
import { chunkText, sanitizeEmbeddingText } from "../embedding/chunker";
import { chunkHash } from "../lib/chunk-hash";

describe("chunkText", () => {
	it("returns empty array for empty string", () => {
		expect(chunkText("")).toEqual([]);
	});

	it("returns empty array for whitespace only", () => {
		expect(chunkText("   \n\n  ")).toEqual([]);
	});

	it("returns single chunk for short text", () => {
		const result = chunkText("Hello world");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toBe("Hello world");
	});

	it("splits long text with paragraphs into multiple chunks", () => {
		// Create text > 2000 chars with paragraph boundaries
		const para = "word ".repeat(200); // ~1000 chars per paragraph
		const longText = [para, para, para, para].join("\n\n");
		const result = chunkText(longText);
		expect(result.length).toBeGreaterThan(1);
	});

	it("respects paragraph boundaries", () => {
		const text =
			"First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
		const result = chunkText(text);
		expect(result.length).toBeGreaterThanOrEqual(1);
		// All content should be preserved
		const combined = result.map((c) => c.text).join("\n\n");
		expect(combined).toContain("First paragraph");
		expect(combined).toContain("Second paragraph");
		expect(combined).toContain("Third paragraph");
	});

	it("handles text with overlapping chunks", () => {
		// Create text that requires multiple chunks
		const paragraphs = Array(5).fill("word ".repeat(500)).join("\n\n");
		const result = chunkText(paragraphs);
		expect(result.length).toBeGreaterThan(1);
		// Each chunk should be non-empty
		for (const chunk of result) {
			expect(chunk.text.trim().length).toBeGreaterThan(0);
		}
	});

	it("handles single very long paragraph by splitting sentences", () => {
		// Single paragraph > TARGET_CHARS * 1.5, with sentence endings
		const longPara = "This is a sentence. ".repeat(200); // ~4000 chars
		const result = chunkText(longPara);
		expect(result.length).toBeGreaterThanOrEqual(1);
	});

	it("hard-splits punctuation-free paragraphs into bounded chunks", () => {
		const result = chunkText("A".repeat(2_000_000));
		expect(result.length).toBeGreaterThan(100);
		expect(
			Math.max(...result.map((chunk) => chunk.text.length)),
		).toBeLessThanOrEqual(2202);
	});

	it("omits large inline data payloads from semantic chunks", () => {
		const payload = "A".repeat(2_000_000);
		const result = chunkText(
			`Before ![](data:image/png;base64,${payload}) after`,
		);
		const combined = result.map((chunk) => chunk.text).join(" ");
		expect(combined).toContain("Before");
		expect(combined).toContain("inline binary asset omitted");
		expect(combined).toContain("after");
		expect(combined).not.toContain(payload.slice(0, 1000));
	});

	it("sanitizes inline data URLs without changing ordinary data prose", () => {
		expect(sanitizeEmbeddingText("data: quarterly report")).toBe(
			"data: quarterly report",
		);
		expect(sanitizeEmbeddingText("src='data:text/plain;base64,SGVsbG8='")).toBe(
			"src='[inline binary asset omitted]'",
		);
	});

	it("handles many invalid data prefixes in linear time", () => {
		const input = "data:x".repeat(300_000);
		const startedAt = performance.now();
		expect(sanitizeEmbeddingText(input)).toBe(input);
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	});

	it("preserves content across chunks", () => {
		const text = `${"A".repeat(1000)}\n\n${"B".repeat(1000)}\n\n${"C".repeat(1000)}`;
		const result = chunkText(text);
		const combined = result.map((c) => c.text).join("");
		expect(combined).toContain("A");
		expect(combined).toContain("B");
		expect(combined).toContain("C");
	});
});

describe("chunkText hash field", () => {
	it("returns hash equal to chunkHash(text)", () => {
		const result = chunkText("Hello world");
		expect(result).toHaveLength(1);
		const chunk = result[0];
		expect(chunk).toBeDefined();
		expect(chunk?.hash).toBe(chunkHash(chunk?.text ?? ""));
	});

	it("produces stable hashes for identical input", () => {
		const a = chunkText("Stable input text for hashing");
		const b = chunkText("Stable input text for hashing");
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
		expect(a[0]?.hash).toBe(b[0]?.hash);
	});

	it("produces different hashes for different input", () => {
		const a = chunkText("Alpha content");
		const b = chunkText("Beta content");
		expect(a[0]?.hash).not.toBe(b[0]?.hash);
	});

	it("returns hex-formatted SHA-256 hash (64 chars)", () => {
		const result = chunkText("Hello world");
		const hash = result[0]?.hash ?? "";
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("per-chunk hash matches chunkHash of just that chunk text", () => {
		// Create multi-chunk text and verify each chunk's hash is consistent
		// with calling chunkHash() directly on the chunk text.
		const para = "word ".repeat(200);
		const longText = [para, para, para, para].join("\n\n");
		const result = chunkText(longText);
		expect(result.length).toBeGreaterThan(1);
		for (const chunk of result) {
			expect(chunk.hash).toBe(chunkHash(chunk.text));
		}
	});
});

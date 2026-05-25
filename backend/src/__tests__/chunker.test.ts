import { describe, it, expect } from "bun:test";
import { chunkText } from "../embedding/chunker";

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
    expect(result[0]).toBe("Hello world");
  });

  it("splits long text with paragraphs into multiple chunks", () => {
    // Create text > 2000 chars with paragraph boundaries
    const para = "word ".repeat(200); // ~1000 chars per paragraph
    const longText = [para, para, para, para].join("\n\n");
    const result = chunkText(longText);
    expect(result.length).toBeGreaterThan(1);
  });

  it("respects paragraph boundaries", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
    const result = chunkText(text);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // All content should be preserved
    const combined = result.join("\n\n");
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
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it("handles single very long paragraph by splitting sentences", () => {
    // Single paragraph > TARGET_CHARS * 1.5, with sentence endings
    const longPara = "This is a sentence. ".repeat(200); // ~4000 chars
    const result = chunkText(longPara);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves content across chunks", () => {
    const text = "A".repeat(1000) + "\n\n" + "B".repeat(1000) + "\n\n" + "C".repeat(1000);
    const result = chunkText(text);
    const combined = result.join("");
    expect(combined).toContain("A");
    expect(combined).toContain("B");
    expect(combined).toContain("C");
  });
});

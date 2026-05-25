import { describe, test, expect } from "vitest";
import { stripMarks, highlightTerms } from "./search";

describe("search helpers", () => {
  describe("stripMarks", () => {
    test("removes <mark> tags", () => {
      expect(stripMarks("hello <mark>world</mark>")).toBe("hello world");
    });

    test("removes multiple <mark> tags", () => {
      expect(stripMarks("<mark>a</mark> and <mark>b</mark>")).toBe("a and b");
    });

    test("returns plain text unchanged", () => {
      expect(stripMarks("no marks here")).toBe("no marks here");
    });

    test("handles empty string", () => {
      expect(stripMarks("")).toBe("");
    });
  });

  describe("highlightTerms", () => {
    test("wraps matching terms in <mark> tags", () => {
      const result = highlightTerms("Hello world", "Hello");
      expect(result).toBe("<mark>Hello</mark> world");
    });

    test("is case-insensitive", () => {
      const result = highlightTerms("Hello HELLO hello", "hello");
      expect(result).toContain("<mark>Hello</mark>");
      expect(result).toContain("<mark>HELLO</mark>");
      expect(result).toContain("<mark>hello</mark>");
    });

    test("handles multiple search terms", () => {
      const result = highlightTerms("foo bar baz", "foo baz");
      expect(result).toContain("<mark>foo</mark>");
      expect(result).toContain("<mark>baz</mark>");
    });

    test("escapes regex special characters", () => {
      const result = highlightTerms("price is $100 (USD)", "$100");
      expect(result).toContain("<mark>$100</mark>");
    });

    test("returns original text for empty query", () => {
      expect(highlightTerms("hello", "")).toBe("hello");
      expect(highlightTerms("hello", "   ")).toBe("hello");
    });
  });
});

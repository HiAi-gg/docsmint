import { describe, expect, test } from "bun:test";
import {
	analyzeQuery,
	detectLanguage,
	normalizeQuery,
} from "../search/query-analyzer";

describe("query analyzer", () => {
	test("normalizes whitespace and composed/decomposed Unicode", () => {
		expect(normalizeQuery("  cafe\u0301   notes \n  ")).toBe("café notes");
		expect(normalizeQuery("английский   язык")).toBe("английский язык");
	});

	test("preserves quoted phrases, paths, and identifier punctuation", () => {
		const query = '  "English language"   docs /api/v1/auth  OAuth2::Token  ';
		expect(normalizeQuery(query)).toBe(
			'"English language" docs /api/v1/auth OAuth2::Token',
		);
	});

	test("detects Russian, English, mixed, and undefined language", () => {
		expect(detectLanguage("английский язык")).toBe("ru");
		expect(detectLanguage("English language")).toBe("en");
		expect(detectLanguage("английский English")).toBe("mixed");
		expect(detectLanguage("123 /api/v1 ::")).toBe("und");
	});

	test("creates a provider-independent query plan", () => {
		expect(analyzeQuery("  English   docs ")).toEqual({
			original: "  English   docs ",
			normalized: "English docs",
			detectedLanguage: "en",
			translations: [],
			synonyms: [],
			concepts: [],
			namedEntities: [],
		});
	});
});

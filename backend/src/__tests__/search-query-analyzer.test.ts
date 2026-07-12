import { describe, expect, test } from "bun:test";
import {
	analyzeQuery,
	detectLanguage,
	normalizeQuery,
} from "../search/query-analyzer";

const russianWord =
	"\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439";
const russianPhrase = `${russianWord} \u044f\u0437\u044b\u043a`;

describe("query analyzer", () => {
	test("normalizes whitespace and composed/decomposed Unicode", () => {
		expect(normalizeQuery("  cafe\u0301   notes \n  ")).toBe("café notes");
		expect(normalizeQuery(`${russianWord}   \u044f\u0437\u044b\u043a`)).toBe(
			russianPhrase,
		);
	});

	test("preserves whitespace inside quoted phrases while normalizing outside", () => {
		const query = '\t"English   language"\n  docs \t /api/v1/auth';
		expect(normalizeQuery(query)).toBe(
			'"English   language" docs /api/v1/auth',
		);
	});

	test("preserves quoted phrases, paths, and identifier punctuation", () => {
		const query = '  "English language"   docs /api/v1/auth  OAuth2::Token  ';
		expect(normalizeQuery(query)).toBe(
			'"English language" docs /api/v1/auth OAuth2::Token',
		);
	});

	test("detects Russian, English, mixed, and undefined language", () => {
		expect(detectLanguage(russianPhrase)).toBe("ru");
		expect(detectLanguage("English language")).toBe("en");
		expect(detectLanguage(`${russianWord} English`)).toBe("mixed");
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

import type { QueryPlan } from "./types";

const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

/** Normalize a user query without changing meaningful punctuation or paths. */
export function normalizeQuery(query: string): string {
	return query.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** Detect the dominant script locally; no provider or network call is involved. */
export function detectLanguage(query: string): "ru" | "en" | "mixed" | "und" {
	const normalized = normalizeQuery(query);
	let cyrillic = 0;
	let latin = 0;

	for (const token of normalized.split(" ")) {
		// Slash-delimited values are paths/URLs/identifiers, not language evidence.
		if (token.includes("/")) continue;
		for (const character of token) {
			if (!LETTER.test(character)) continue;
			if (CYRILLIC_LETTER.test(character)) cyrillic += 1;
			else if (LATIN_LETTER.test(character)) latin += 1;
		}
	}

	if (cyrillic > 0 && latin > 0) return "mixed";
	if (cyrillic > 0) return "ru";
	if (latin > 0) return "en";
	return "und";
}

export function analyzeQuery(query: string): QueryPlan {
	return {
		original: query,
		normalized: normalizeQuery(query),
		detectedLanguage: detectLanguage(query),
		translations: [],
		synonyms: [],
		concepts: [],
		namedEntities: [],
	};
}

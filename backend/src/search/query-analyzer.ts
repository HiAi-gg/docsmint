import type { QueryPlan } from "./types";

const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

/** Normalize a user query without changing meaningful punctuation or paths. */
export function normalizeQuery(query: string): string {
	const normalized = query.normalize("NFC");
	let result = "";
	let inQuotedPhrase = false;
	let escaped = false;
	let pendingWhitespace = false;

	for (const character of normalized) {
		if (inQuotedPhrase) {
			result += character;
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === '"') {
				inQuotedPhrase = false;
			}
			continue;
		}

		if (character === '"') {
			if (pendingWhitespace && result.length > 0) result += " ";
			pendingWhitespace = false;
			result += character;
			inQuotedPhrase = true;
			continue;
		}

		if (/\s/u.test(character)) {
			pendingWhitespace = true;
			continue;
		}

		if (pendingWhitespace && result.length > 0) result += " ";
		pendingWhitespace = false;
		result += character;
	}

	return result;
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

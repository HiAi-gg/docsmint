export interface SearchPreferences {
	/** Keep GraphRAG expansion enabled for normal searches. */
	graphSearchEnabled: boolean;
}

export const DEFAULT_SEARCH_PREFERENCES: Readonly<SearchPreferences> = {
	graphSearchEnabled: true,
};

export const SEARCH_PREFERENCES_KEY = "docsmint:search-preferences";

type SearchPreferenceStorage = Readonly<{
	getItem(key: string): string | null;
}>;

export function normalizeSearchPreferences(value: unknown): SearchPreferences {
	if (!value || typeof value !== "object") {
		return { ...DEFAULT_SEARCH_PREFERENCES };
	}

	const candidate = value as Partial<SearchPreferences>;
	return {
		graphSearchEnabled:
			typeof candidate.graphSearchEnabled === "boolean"
				? candidate.graphSearchEnabled
				: DEFAULT_SEARCH_PREFERENCES.graphSearchEnabled,
	};
}

export function readSearchPreferences(
	storage: SearchPreferenceStorage | null = typeof localStorage === "undefined"
		? null
		: localStorage,
): SearchPreferences {
	if (!storage) return { ...DEFAULT_SEARCH_PREFERENCES };
	try {
		return normalizeSearchPreferences(
			JSON.parse(storage.getItem(SEARCH_PREFERENCES_KEY) ?? "null"),
		);
	} catch {
		return { ...DEFAULT_SEARCH_PREFERENCES };
	}
}

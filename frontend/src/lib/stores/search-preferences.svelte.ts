import {
	DEFAULT_SEARCH_PREFERENCES,
	normalizeSearchPreferences,
	SEARCH_PREFERENCES_KEY,
	type SearchPreferences,
} from "./search-preferences";

let initialized = false;
let preferences = $state<SearchPreferences>({ ...DEFAULT_SEARCH_PREFERENCES });

function persist() {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(SEARCH_PREFERENCES_KEY, JSON.stringify(preferences));
	} catch {
		// The preference remains active for this tab when storage is unavailable.
	}
}

function init() {
	if (initialized || typeof window === "undefined") return;
	initialized = true;
	try {
		preferences = normalizeSearchPreferences(
			JSON.parse(localStorage.getItem(SEARCH_PREFERENCES_KEY) ?? "null"),
		);
	} catch {
		preferences = { ...DEFAULT_SEARCH_PREFERENCES };
	}
}

function update(next: Partial<SearchPreferences>) {
	preferences = { ...preferences, ...next };
	persist();
}

export const searchPreferences = {
	get graphSearchEnabled(): boolean {
		return preferences.graphSearchEnabled;
	},
	init,
	update,
};

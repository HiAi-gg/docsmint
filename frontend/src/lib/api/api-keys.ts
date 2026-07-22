import { apiFetch } from "./client.js";

export interface ApiKeySummary {
	id: string;
	name: string;
	prefix: string;
	scopes: string[];
	lastUsedAt: string | null;
	expiresAt: string | null;
	createdAt: string;
	recoverable: boolean;
}

export interface IssuedApiKey {
	id: string;
	prefix: string;
	key: string;
}

export function listApiKeys(
	fetcher?: typeof fetch,
): Promise<{ keys: ApiKeySummary[] }> {
	return apiFetch("/api/keys", {}, fetcher);
}

export function createGlobalApiKey(
	name?: string,
	fetcher?: typeof fetch,
): Promise<IssuedApiKey> {
	return apiFetch(
		"/api/keys/global",
		{ method: "POST", body: { name } },
		fetcher,
	);
}

export function createCategoryApiKey(
	categoryId: string,
	name?: string,
	fetcher?: typeof fetch,
): Promise<IssuedApiKey> {
	return apiFetch(
		`/api/categories/${encodeURIComponent(categoryId)}/keys`,
		{
			method: "POST",
			body: { name },
		},
		fetcher,
	);
}

export function revokeApiKey(
	id: string,
	fetcher?: typeof fetch,
): Promise<{ success: true }> {
	return apiFetch(
		`/api/keys/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		fetcher,
	);
}

export async function revealCategoryApiKey(
	id: string,
	fetcher?: typeof fetch,
): Promise<string> {
	const result = await apiFetch<{ key: string }>(
		`/api/keys/${encodeURIComponent(id)}/secret`,
		{},
		fetcher,
	);
	return result.key;
}

export function categoryIdFromScopes(scopes: string[]): string | null {
	for (const scope of scopes) {
		const match = /^category:([0-9a-f-]{36}):(read|edit|write)$/i.exec(scope);
		if (match?.[1]) return match[1];
	}
	return null;
}

export function apiKeyClipboardValue(
	key: Pick<ApiKeySummary, "prefix">,
	rawKey?: string,
): string {
	return rawKey ?? key.prefix;
}

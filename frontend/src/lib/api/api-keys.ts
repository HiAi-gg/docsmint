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

export function listApiKeys(): Promise<{ keys: ApiKeySummary[] }> {
	return apiFetch("/api/keys");
}

export function createGlobalApiKey(name?: string): Promise<IssuedApiKey> {
	return apiFetch("/api/keys/global", { method: "POST", body: { name } });
}

export function createCategoryApiKey(
	categoryId: string,
	name?: string,
): Promise<IssuedApiKey> {
	return apiFetch(`/api/categories/${encodeURIComponent(categoryId)}/keys`, {
		method: "POST",
		body: { name },
	});
}

export function revokeApiKey(id: string): Promise<{ success: true }> {
	return apiFetch(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function revealCategoryApiKey(id: string): Promise<string> {
	const result = await apiFetch<{ key: string }>(
		`/api/keys/${encodeURIComponent(id)}/secret`,
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

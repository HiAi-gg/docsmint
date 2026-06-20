import { authClient } from "$lib/auth-client";
import { apiFetch } from "./client.js";

export interface UserProfile {
	id: string;
	name: string;
	email: string;
	avatar: string | null;
}

export interface EmbeddingConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	fallbackBaseUrl: string | null;
	fallbackApiKey: string | null;
	fallbackModel: string | null;
}

// --- Profile (uses Better Auth session) ---

export async function getProfile(): Promise<UserProfile> {
	try {
		const session = await apiFetch<{ user?: UserProfile }>(
			"/api/auth/get-session",
		);
		if (session.user?.name || session.user?.email) {
			return session.user;
		}
	} catch {
		/* fall through */
	}

	// Fallback: try client-side getSession (works even when server-side
	// /api/auth/session returns empty, e.g. for newly registered users).
	const { data } = await authClient.getSession();
	if (data?.user) {
		return {
			id: data.user.id ?? "",
			name: data.user.name ?? "User",
			email: data.user.email ?? "",
			avatar: null,
		};
	}
	return { id: "", name: "User", email: "", avatar: null };
}

export async function updateProfile(data: {
	name?: string;
}): Promise<UserProfile> {
	return apiFetch("/api/auth/update-user", {
		method: "POST",
		body: JSON.stringify({ name: data.name }),
	});
}

// --- Embedding Config (stored in localStorage for OSS simplicity) ---

const EMBEDDING_KEY = "hiai-docs:embedding-config";

export function getEmbeddingConfig(): EmbeddingConfig {
	if (typeof window === "undefined") {
		return {
			baseUrl: "",
			apiKey: "",
			model: "",
			fallbackBaseUrl: null,
			fallbackApiKey: null,
			fallbackModel: null,
		};
	}
	try {
		const stored = localStorage.getItem(EMBEDDING_KEY);
		if (stored) return JSON.parse(stored);
	} catch {
		/* ignore */
	}
	return {
		baseUrl: "",
		apiKey: "",
		model: "",
		fallbackBaseUrl: null,
		fallbackApiKey: null,
		fallbackModel: null,
	};
}

export function updateEmbeddingConfig(
	data: Partial<EmbeddingConfig>,
): EmbeddingConfig {
	const current = getEmbeddingConfig();
	const updated = { ...current, ...data };
	localStorage.setItem(EMBEDDING_KEY, JSON.stringify(updated));
	return updated;
}

// --- Delete Account ---

export async function deleteAccount(): Promise<void> {
	await apiFetch("/api/auth/delete-user", { method: "POST" });
}

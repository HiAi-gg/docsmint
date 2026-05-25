import { apiFetch } from "./client.js";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
}

export interface EmbeddingConfig {
  provider: "ollama" | "openrouter" | "voyage";
  model: string;
  fallbackProvider: string | null;
  fallbackModel: string | null;
}

// --- Profile (uses Better Auth session) ---

export async function getProfile(): Promise<UserProfile> {
  try {
    const session = await apiFetch<{ user?: UserProfile }>("/api/auth/session");
    return session.user ?? { id: "", name: "User", email: "", avatar: null };
  } catch {
    return { id: "", name: "User", email: "", avatar: null };
  }
}

export async function updateProfile(data: { name?: string; email?: string }): Promise<UserProfile> {
  return apiFetch("/api/auth/update-user", { method: "POST", body: JSON.stringify(data) });
}

// --- Embedding Config (stored in localStorage for OSS simplicity) ---

const EMBEDDING_KEY = "hiai-docs:embedding-config";

export function getEmbeddingConfig(): EmbeddingConfig {
  if (typeof window === "undefined") {
    return { provider: "ollama", model: "nomic-embed-text", fallbackProvider: "openrouter", fallbackModel: "openai/text-embedding-3-small" };
  }
  try {
    const stored = localStorage.getItem(EMBEDDING_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return { provider: "ollama", model: "nomic-embed-text", fallbackProvider: "openrouter", fallbackModel: "openai/text-embedding-3-small" };
}

export function updateEmbeddingConfig(data: Partial<EmbeddingConfig>): EmbeddingConfig {
  const current = getEmbeddingConfig();
  const updated = { ...current, ...data };
  localStorage.setItem(EMBEDDING_KEY, JSON.stringify(updated));
  return updated;
}

// --- Delete Account ---

export async function deleteAccount(): Promise<void> {
  await apiFetch("/api/auth/delete-user", { method: "POST" });
}

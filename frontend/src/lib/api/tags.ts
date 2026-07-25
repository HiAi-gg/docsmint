import { z } from "zod";
import { apiFetch } from "./client.js";

export interface Tag {
	id: string;
	name: string;
	color: string | null;
	createdAt: string;
	documentCount?: number;
}

// Frontend cap is 50 chars; backend hard limit is 100 (see backend/src/api/routes/tags.ts).

export const createTagInputSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Name is required")
		.max(50, "Name must be 50 characters or less"),
	color: z.string().max(20, "Color must be 20 characters or less").optional(),
});

export const updateTagInputSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Name is required")
		.max(50, "Name must be 50 characters or less")
		.optional(),
	color: z.string().max(20, "Color must be 20 characters or less").optional(),
});

export type CreateTagInput = z.infer<typeof createTagInputSchema>;
export type UpdateTagInput = z.infer<typeof updateTagInputSchema>;

// --- API Functions ---

export async function listTags(fetcher?: typeof fetch): Promise<Tag[]> {
	return apiFetch("/api/tags", {}, fetcher);
}

export function getTag(id: string, fetcher?: typeof fetch): Promise<Tag> {
	return apiFetch(`/api/tags/${id}`, {}, fetcher);
}

export function createTag(
	name: string,
	color?: string,
	fetcher?: typeof fetch,
): Promise<Tag> {
	const input = createTagInputSchema.parse({ name, color });
	return apiFetch(
		"/api/tags",
		{ method: "POST", body: JSON.stringify(input) },
		fetcher,
	);
}

export function updateTag(
	id: string,
	data: { name?: string; color?: string },
	fetcher?: typeof fetch,
): Promise<Tag> {
	const input = updateTagInputSchema.parse(data);
	return apiFetch(
		`/api/tags/${id}`,
		{ method: "PATCH", body: JSON.stringify(input) },
		fetcher,
	);
}

export function deleteTag(id: string, fetcher?: typeof fetch): Promise<void> {
	return apiFetch(`/api/tags/${id}`, { method: "DELETE" }, fetcher);
}

export function addTagToDocument(
	documentId: string,
	tagId: string,
	fetcher?: typeof fetch,
): Promise<void> {
	const input = z.object({ tagId: z.string().uuid() }).parse({ tagId });
	return apiFetch(
		`/api/documents/${documentId}/tags`,
		{ method: "POST", body: JSON.stringify(input) },
		fetcher,
	);
}

export function removeTagFromDocument(
	documentId: string,
	tagId: string,
	fetcher?: typeof fetch,
): Promise<void> {
	return apiFetch(
		`/api/documents/${documentId}/tags/${tagId}`,
		{ method: "DELETE" },
		fetcher,
	);
}

// categories.ts — REST client for the `/api/categories` endpoints and the
// category-id assignment endpoints on documents and folders. Mirrors the
// shape exposed by the backend route file at
// `backend/src/api/routes/categories.ts` and the PATCH body shape used by
// the document/folder routes (`categoryId` is a nullable UUID).

import { z } from "zod";
import { apiFetch } from "./client.js";

export interface Category {
	id: string;
	name: string;
	order: number;
	apiMode?: "unavailable" | "global" | "general" | "category" | null;
	apiPermissionRead?: boolean | null;
	apiPermissionEdit?: boolean | null;
	apiPermissionWrite?: boolean | null;
	createdAt: string;
	updatedAt: string;
	/** Count of documents the user owns that have this category. */
	documentCount?: number;
	/** Count of folders the user owns that have this category. */
	folderCount?: number;
}

export const createCategoryInputSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Name is required")
		.max(255, "Name must be 255 characters or less"),
	apiMode: z.enum(["unavailable", "global", "general", "category"]).optional(),
	apiPermissionRead: z.boolean().optional(),
	apiPermissionEdit: z.boolean().optional(),
	apiPermissionWrite: z.boolean().optional(),
});

export const updateCategoryInputSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Name is required")
		.max(255, "Name must be 255 characters or less")
		.optional(),
	order: z.number().int().nonnegative().optional(),
	apiMode: z.enum(["unavailable", "global", "general", "category"]).optional(),
	apiPermissionRead: z.boolean().optional(),
	apiPermissionEdit: z.boolean().optional(),
	apiPermissionWrite: z.boolean().optional(),
});

export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategoryInputSchema>;

/** List all categories for the current user. */
export function listCategories(fetcher?: typeof fetch): Promise<Category[]> {
	return apiFetch<Category[]>("/api/categories", {}, fetcher);
}

/**
 * Create a new category. The backend enforces name uniqueness per owner
 * and returns 409 if a category with the same name already exists.
 */
export function createCategory(
	inputOrName: string | CreateCategoryInput,
): Promise<Category> {
	const input = createCategoryInputSchema.parse(
		typeof inputOrName === "string" ? { name: inputOrName } : inputOrName,
	);
	return apiFetch<Category>("/api/categories", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

/** Rename a category or update its order. */
export function updateCategory(
	id: string,
	data: UpdateCategoryInput,
): Promise<Category> {
	const input = updateCategoryInputSchema.parse(data);
	return apiFetch<Category>(`/api/categories/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

/** Delete a category. The backend uses `ON DELETE SET NULL` to detach
 *  the category from any folders/documents. */
export function deleteCategory(id: string): Promise<void> {
	return apiFetch<void>(`/api/categories/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

/** Assign (or clear) the category on a document. Uses the existing
 *  `PATCH /api/documents/:id` endpoint which already accepts a
 *  `categoryId` field (see `backend/src/api/routes/documents.ts`).
 *  Pass `null` to remove the category from the document. */
export function setDocumentCategory(
	docId: string,
	categoryId: string | null,
): Promise<void> {
	return apiFetch<void>(`/api/documents/${encodeURIComponent(docId)}`, {
		method: "PATCH",
		body: JSON.stringify({ categoryId }),
	});
}

/** Assign (or clear) the category on a folder. Pass `null` to clear. */
export function setFolderCategory(
	folderId: string,
	categoryId: string | null,
): Promise<void> {
	return apiFetch<void>(`/api/folders/${encodeURIComponent(folderId)}`, {
		method: "PATCH",
		body: JSON.stringify({ categoryId }),
	});
}

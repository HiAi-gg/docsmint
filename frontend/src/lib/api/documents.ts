import { apiFetch } from "./client";

export interface Document {
	id: string;
	title: string;
	content: string;
	contentJson?: unknown;
	folderId?: string | null;
	folderName?: string;
	/**
	 * Optional category assignment. `null`/`undefined` means unfiled.
	 * Used by the sidebar to bucket root-level (no-folder) docs by
	 * category so users can drag them directly between categories.
	 */
	categoryId?: string | null;
	tags?: Array<{ id: string; name: string; color: string }>;
	excerpt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface DocumentListResponse {
	items: Document[];
	total: number;
	page: number;
	limit: number;
}

/**
 * Per-file result from a multi-file import. The backend returns one of
 * these for every uploaded file so the UI can show per-file status
 * (uploading, processing, done, error).
 */
export interface ImportResult {
	filename: string;
	status: "ok" | "error";
	document?: Document;
	error?: string;
}

export interface ImportResponse {
	items: ImportResult[];
	imported: number;
	failed: number;
}

// ---------------------------------------------------------------------------
// listDocuments dedup + TTL cache
// ---------------------------------------------------------------------------
//
// On a cold page load three components race to fetch the document list:
//   - RecentDocs (limit=6)
//   - FolderTree (limit=100)
//   - Dashboard (limit=6)
//
// The inflight layer collapses IDENTICAL concurrent calls into a single
// network request. The TTL layer (5s) additionally absorbs near-simultaneous
// retries — e.g. when a component re-mounts and re-fires the same call
// while a previous one is still resolving, or when two components request
// the same `{ limit: 6, tag: null, page: 1 }` payload within a few ms of
// each other on a cold load. RecentDocs and Dashboard share this exact
// shape, so they collapse to one network request; FolderTree asks for
// limit=100 and therefore issues its own call.
//
// The cache key intentionally includes `limit` so callers never receive a
// smaller payload than they asked for — a limit=100 caller must not be
// served the limit=6 result.
//
// TTL is intentionally short (5s) so subsequent user actions (filter by
// tag, navigate to a folder) are not served stale data.

interface CacheEntry {
	promise: Promise<DocumentListResponse>;
	timestamp: number;
}

const listDocumentsInflight = new Map<string, Promise<DocumentListResponse>>();
const listDocumentsTtl = new Map<string, CacheEntry>();
const LIST_CACHE_TTL_MS = 5000;

export function clearDocumentsCache(): void {
	listDocumentsInflight.clear();
	listDocumentsTtl.clear();
}

interface ListCacheKey {
	folderId?: string;
	tag?: string;
	page?: number;
	limit?: number;
}

function listDocumentsCacheKey(params?: ListCacheKey): string {
	if (!params) return "all";
	return JSON.stringify({
		folderId: params.folderId ?? null,
		tag: params.tag ?? null,
		page: params.page ?? 1,
		limit: params.limit ?? null,
	});
}

function getTtlEntry(key: string): CacheEntry | undefined {
	const entry = listDocumentsTtl.get(key);
	if (!entry) return undefined;
	if (Date.now() - entry.timestamp >= LIST_CACHE_TTL_MS) {
		listDocumentsTtl.delete(key);
		return undefined;
	}
	return entry;
}

function setTtlEntry(
	key: string,
	promise: Promise<DocumentListResponse>,
): void {
	listDocumentsTtl.set(key, { promise, timestamp: Date.now() });
	// Schedule cleanup so the map does not grow unbounded for long-lived
	// sessions. The check inside `getTtlEntry` is the source of truth for
	// freshness — this timer just releases the reference.
	setTimeout(() => {
		listDocumentsTtl.delete(key);
	}, LIST_CACHE_TTL_MS);
}

export function listDocuments(params?: {
	folderId?: string;
	tag?: string;
	page?: number;
	limit?: number;
}): Promise<DocumentListResponse> {
	const key = listDocumentsCacheKey(params);

	// Identical in-flight call: share the same promise.
	const inflight = listDocumentsInflight.get(key);
	if (inflight) return inflight;

	// Recent call (within TTL) with matching params: reuse the promise.
	const ttl = getTtlEntry(key);
	if (ttl) return ttl.promise;

	const searchParams = new URLSearchParams();
	if (params?.folderId) searchParams.set("folderId", params.folderId);
	if (params?.tag) searchParams.set("tag", params.tag);
	if (params?.page) searchParams.set("page", String(params.page));
	if (params?.limit) searchParams.set("limit", String(params.limit));
	const qs = searchParams.toString();

	// Wrap the fetch so a rejection evicts the cache entry instead of
	// pinning the rejected promise in the TTL slot. Without this, every
	// caller within the 5s window would `await` the same rejected promise
	// and surface the same 429 — even after the rate-limit window has
	// already rolled over. The `.catch` re-throws so the caller's normal
	// error handling is preserved.
	const promise = apiFetch<DocumentListResponse>(
		`/api/documents${qs ? `?${qs}` : ""}`,
	).catch((err) => {
		listDocumentsTtl.delete(key);
		throw err;
	});

	listDocumentsInflight.set(key, promise);
	setTtlEntry(key, promise);

	// Use finally so the inflight slot is freed whether the request
	// resolves or rejects (a 429/500 must not block the next call).
	promise.finally(() => {
		listDocumentsInflight.delete(key);
	});

	return promise;
}

export function getDocument(
	id: string,
	fetcher?: typeof fetch,
): Promise<Document> {
	return apiFetch(`/api/documents/${id}`, {}, fetcher);
}

export function createDocument(
	data: {
		title: string;
		content?: string;
		folderId?: string;
		categoryId?: string;
	},
	fetcher?: typeof fetch,
): Promise<Document> {
	clearDocumentsCache();
	return apiFetch(
		"/api/documents",
		{
			method: "POST",
			body: JSON.stringify(data),
		},
		fetcher,
	);
}

export function updateDocument(
	id: string,
	data: {
		title?: string;
		content?: string;
		folderId?: string | null;
		categoryId?: string | null;
		contentJson?: unknown;
	},
): Promise<Document> {
	clearDocumentsCache();
	return apiFetch(`/api/documents/${id}`, {
		method: "PATCH",
		body: JSON.stringify(data),
	});
}

export function deleteDocument(id: string): Promise<void> {
	clearDocumentsCache();
	return apiFetch(`/api/documents/${id}`, { method: "DELETE" });
}

export function importDocument(
	file: File,
	folderId?: string,
): Promise<Document> {
	clearDocumentsCache();
	const formData = new FormData();
	formData.append("file", file);
	if (folderId) formData.append("folderId", folderId);
	return apiFetch("/api/documents/import", { method: "POST", body: formData });
}

/**
 * Import one or more documents. Accepts any combination of supported
 * file types (markdown, text, JSON, DOCX). The backend endpoint accepts
 * a multipart body with multiple `file` parts and returns an
 * `ImportResponse` describing per-file success/failure.
 */
export function importDocuments(
	files: File[],
	folderId?: string,
): Promise<ImportResponse> {
	clearDocumentsCache();
	const formData = new FormData();
	for (const file of files) {
		formData.append("file", file);
	}
	if (folderId) formData.append("folderId", folderId);
	return apiFetch<ImportResponse>("/api/documents/import", {
		method: "POST",
		body: formData,
	});
}

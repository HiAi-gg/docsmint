/**
 * hiai-docs REST API client.
 *
 * Bun-native `fetch` wrapper. All authenticated requests send
 * `Authorization: Bearer <apiKey>`. Non-OK responses throw
 * `DocsApiError` carrying the HTTP status and parsed body. Transient
 * failures (502 / 503 / 504 / timeout / network reset) are retried
 * with exponential backoff up to `config.retries` attempts.
 */

import type {
	DocsApiKeyCreated,
	DocsApiKeyListResponse,
	DocsAttachment,
	DocsAttachmentConfirmInput,
	DocsAttachmentListResponse,
	DocsAttachmentPresignInput,
	DocsAttachmentPresignResponse,
	DocsCategory,
	DocsCategoryInput,
	DocsCategoryUpdate,
	DocsDocument,
	DocsDocumentCreateInput,
	DocsDocumentListResponse,
	DocsDocumentPipeline,
	DocsDocumentUpdateInput,
	DocsFolder,
	DocsFolderCreateInput,
	DocsFolderUpdateInput,
	DocsGraphEntitiesResponse,
	DocsGraphRelatedResponse,
	DocsGraphSearchResponse,
	DocsHealthResponse,
	DocsRequestContext,
	DocsSearchOptions,
	DocsSearchResponse,
	DocsSearchSuggestItem,
	DocsSharedContent,
	DocsShareLink,
	DocsShareListResponse,
	DocsShareRole,
	DocsTag,
	DocsVersion,
	DocsVersionDiff,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

export interface DocsClientConfig {
	/** Base URL of the hiai-docs API, e.g. `http://localhost:50700`. */
	baseUrl: string;
	/** Bearer token used as `Authorization: Bearer <apiKey>`. */
	apiKey?: string;
	/** Default request-scoped credentials forwarded to every request. */
	requestContext?: DocsRequestContext;
	/** Injectable fetch implementation for hosts and contract tests. */
	fetch?: typeof fetch;
	/** Per-request timeout in milliseconds. Default: 10 000. */
	timeout?: number;
	/** Retry attempts for transient failures. Default: 3. */
	retries?: number;
	/** Initial backoff in milliseconds (doubles each attempt). Default: 250. */
	retryBackoffMs?: number;
}

type ResolvedConfig = {
	baseUrl: string;
	apiKey?: string;
	requestContext?: DocsRequestContext;
	fetch: typeof fetch;
	timeout: number;
	retries: number;
	retryBackoffMs: number;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DocsApiError extends Error {
	readonly status: number;
	readonly body: unknown;
	readonly url?: string;
	readonly requestId?: string;

	constructor(
		status: number,
		body: unknown,
		message?: string,
		metadata?: { url?: string; requestId?: string },
	) {
		super(message ?? `hiai-docs API error ${status}`);
		this.name = "DocsApiError";
		this.status = status;
		this.body = body;
		this.url = metadata?.url;
		this.requestId = metadata?.requestId;
	}
}

export class DocsNetworkError extends Error {
	readonly requestId?: string;

	constructor(
		message: string,
		options?: { cause?: unknown; requestId?: string },
	) {
		super(message, { cause: options?.cause });
		this.name = "DocsNetworkError";
		this.requestId = options?.requestId;
	}
}

export class DocsTimeoutError extends DocsNetworkError {
	readonly timeout: number;

	constructor(
		timeout: number,
		options?: { cause?: unknown; requestId?: string },
	) {
		super(`hiai-docs request timed out after ${timeout}ms`, options);
		this.name = "DocsTimeoutError";
		this.timeout = timeout;
	}
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class DocsClient {
	private readonly config: ResolvedConfig;

	constructor(config: DocsClientConfig) {
		if (!config.baseUrl) {
			throw new Error("DocsClient: `baseUrl` is required");
		}
		this.config = {
			baseUrl: config.baseUrl.replace(/\/+$/, ""),
			apiKey: config.apiKey,
			requestContext: config.requestContext,
			fetch: config.fetch ?? fetch,
			timeout: config.timeout ?? 10_000,
			retries: config.retries ?? 3,
			retryBackoffMs: config.retryBackoffMs ?? 250,
		};
	}

	/** Return a client with a merged request context for an incoming request. */
	withRequestContext(context: DocsRequestContext): DocsClient {
		return new DocsClient({
			...this.config,
			requestContext: this.mergeContext(this.config.requestContext, context),
		});
	}

	// ── Documents ────────────────────────────────────────────────────────

	async createDoc(
		input: DocsDocumentCreateInput,
		context?: DocsRequestContext,
	): Promise<DocsDocument> {
		return this.request<DocsDocument>(
			"POST",
			"/api/documents",
			{ json: input },
			context,
		);
	}

	async getDoc(
		id: string,
		context?: DocsRequestContext,
	): Promise<DocsDocument> {
		return this.request<DocsDocument>(
			"GET",
			`/api/documents/${encodeURIComponent(id)}`,
			undefined,
			context,
		);
	}

	/**
	 * Fetch a document as raw markdown via the public export endpoint.
	 * Returns just the markdown body as a string.
	 */
	async getDocMarkdown(
		id: string,
		context?: DocsRequestContext,
	): Promise<string> {
		const res = await this.fetchRaw(
			"GET",
			`/api/documents/${encodeURIComponent(id)}/export`,
			undefined,
			context,
		);
		if (!res.ok) {
			throw await this.toApiError(res);
		}
		return res.text();
	}

	async updateDoc(
		id: string,
		updates: DocsDocumentUpdateInput,
		context?: DocsRequestContext,
	): Promise<DocsDocument> {
		return this.request<DocsDocument>("PATCH", `/api/documents/${encodeURIComponent(id)}`, {
			json: updates,
		}, context);
	}

	async deleteDoc(id: string, context?: DocsRequestContext): Promise<void> {
		await this.request<unknown>("DELETE", `/api/documents/${encodeURIComponent(id)}`, undefined, context);
	}

	async listDocs(options?: {
		folderId?: string;
		tag?: string;
		page?: number;
		limit?: number;
	}, context?: DocsRequestContext): Promise<DocsDocumentListResponse> {
		return this.request<DocsDocumentListResponse>("GET", "/api/documents", {
			query: this.cleanQuery({
				folderId: options?.folderId,
				tag: options?.tag,
				page: options?.page,
				limit: options?.limit,
			}),
		}, context);
	}

	async duplicateDoc(id: string, context?: DocsRequestContext): Promise<DocsDocument> {
		return this.request<DocsDocument>(
			"POST",
			`/api/documents/${encodeURIComponent(id)}/duplicate`,
			undefined,
			context,
		);
	}

	async getDocumentPipeline(
		id: string,
		context?: DocsRequestContext,
	): Promise<DocsDocumentPipeline> {
		return this.request<DocsDocumentPipeline>(
			"GET",
			`/api/documents/${encodeURIComponent(id)}/pipeline`,
			undefined,
			context,
		);
	}

	async publishDoc(
		id: string,
		context?: DocsRequestContext,
	): Promise<DocsDocument> {
		return this.request<DocsDocument>(
			"POST",
			`/api/documents/${encodeURIComponent(id)}/publish`,
			undefined,
			context,
		);
	}

	async unpublishDoc(
		id: string,
		context?: DocsRequestContext,
	): Promise<DocsDocument> {
		return this.request<DocsDocument>(
			"POST",
			`/api/documents/${encodeURIComponent(id)}/unpublish`,
			undefined,
			context,
		);
	}

	/**
	 * Convenience alias for `getDocMarkdown` — both go through the same
	 * `/api/documents/:id/export` endpoint on the backend.
	 */
	async exportDoc(id: string, context?: DocsRequestContext): Promise<string> {
		return this.getDocMarkdown(id, context);
	}

	/**
	 * Import a document from raw content. Posts JSON to
	 * `POST /api/documents/import`.
	 */
	async importDoc(input: {
		title?: string;
		content: string;
		folderId?: string;
	}, context?: DocsRequestContext): Promise<DocsDocument> {
		return this.request<DocsDocument>("POST", "/api/documents/import", { json: input }, context);
	}

	// ── Folders ──────────────────────────────────────────────────────────

	async listFolders(parentId?: string, context?: DocsRequestContext): Promise<DocsFolder[]> {
		return this.request<DocsFolder[]>("GET", "/api/folders", {
			query: this.cleanQuery({ parentId }),
		}, context);
	}

	async getFolder(id: string, context?: DocsRequestContext): Promise<DocsFolder> {
		return this.request<DocsFolder>("GET", `/api/folders/${encodeURIComponent(id)}`, undefined, context);
	}

	async createFolder(input: DocsFolderCreateInput, context?: DocsRequestContext): Promise<DocsFolder> {
		return this.request<DocsFolder>("POST", "/api/folders", {
			json: input,
		}, context);
	}

	async updateFolder(
		id: string,
		updates: DocsFolderUpdateInput,
		context?: DocsRequestContext,
	): Promise<DocsFolder> {
		return this.request<DocsFolder>("PATCH", `/api/folders/${encodeURIComponent(id)}`, {
			json: updates,
		}, context);
	}

	async deleteFolder(id: string, context?: DocsRequestContext): Promise<void> {
		await this.request<unknown>("DELETE", `/api/folders/${encodeURIComponent(id)}`, undefined, context);
	}

	// ── Tags ─────────────────────────────────────────────────────────────

	async listTags(context?: DocsRequestContext): Promise<DocsTag[]> {
		return this.request<DocsTag[]>("GET", "/api/tags", undefined, context);
	}

	async createTag(input: { name: string; color?: string }, context?: DocsRequestContext): Promise<DocsTag> {
		return this.request<DocsTag>("POST", "/api/tags", { json: input }, context);
	}

	async updateTag(id: string, updates: { name?: string; color?: string }, context?: DocsRequestContext): Promise<DocsTag> {
		return this.request<DocsTag>("PATCH", `/api/tags/${encodeURIComponent(id)}`, {
			json: updates,
		}, context);
	}

	async deleteTag(id: string, context?: DocsRequestContext): Promise<void> {
		await this.request<unknown>("DELETE", `/api/tags/${encodeURIComponent(id)}`, undefined, context);
	}

	async addTagToDoc(documentId: string, tagId: string, context?: DocsRequestContext): Promise<void> {
		await this.request<unknown>(
			"POST",
			`/api/documents/${encodeURIComponent(documentId)}/tags`,
			{ json: { tagId } },
			context,
		);
	}

	async removeTagFromDoc(
		documentId: string,
		tagId: string,
		context?: DocsRequestContext,
	): Promise<void> {
		await this.request<unknown>(
			"DELETE",
			`/api/documents/${encodeURIComponent(documentId)}/tags/${encodeURIComponent(tagId)}`,
			undefined,
			context,
		);
	}

	// ── Categories ───────────────────────────────────────────────────────

	async listCategories(context?: DocsRequestContext): Promise<DocsCategory[]> {
		return this.request<DocsCategory[]>(
			"GET",
			"/api/categories",
			undefined,
			context,
		);
	}

	async createCategory(
		input: DocsCategoryInput,
		context?: DocsRequestContext,
	): Promise<DocsCategory> {
		return this.request<DocsCategory>(
			"POST",
			"/api/categories",
			{ json: input },
			context,
		);
	}

	async updateCategory(
		id: string,
		updates: DocsCategoryUpdate,
		context?: DocsRequestContext,
	): Promise<DocsCategory> {
		return this.request<DocsCategory>(
			"PATCH",
			`/api/categories/${encodeURIComponent(id)}`,
			{ json: updates },
			context,
		);
	}

	async deleteCategory(
		id: string,
		context?: DocsRequestContext,
	): Promise<void> {
		await this.request<unknown>(
			"DELETE",
			`/api/categories/${encodeURIComponent(id)}`,
			undefined,
			context,
		);
	}

	// API key lifecycle endpoints require a browser session. Pass one via
	// requestContext.cookie or requestContext.authorization.
	async createGlobalApiKey(
		name?: string,
		context?: DocsRequestContext,
	): Promise<DocsApiKeyCreated> {
		return this.request<DocsApiKeyCreated>(
			"POST",
			"/api/keys/global",
			{ json: name ? { name } : {} },
			context,
		);
	}

	async createCategoryApiKey(
		categoryId: string,
		name?: string,
		context?: DocsRequestContext,
	): Promise<DocsApiKeyCreated> {
		return this.request<DocsApiKeyCreated>(
			"POST",
			`/api/categories/${encodeURIComponent(categoryId)}/keys`,
			{ json: name ? { name } : {} },
			context,
		);
	}

	async listApiKeys(
		context?: DocsRequestContext,
	): Promise<DocsApiKeyListResponse> {
		return this.request<DocsApiKeyListResponse>(
			"GET",
			"/api/keys",
			undefined,
			context,
		);
	}

	async revealCategoryApiKey(
		id: string,
		context?: DocsRequestContext,
	): Promise<{ key: string }> {
		return this.request<{ key: string }>(
			"GET",
			`/api/keys/${encodeURIComponent(id)}/secret`,
			undefined,
			context,
		);
	}

	async revokeApiKey(
		id: string,
		context?: DocsRequestContext,
	): Promise<{ success: true }> {
		return this.request<{ success: true }>(
			"DELETE",
			`/api/keys/${encodeURIComponent(id)}`,
			undefined,
			context,
		);
	}

	// ── Search ───────────────────────────────────────────────────────────

	async search(
		query: string,
		options?: DocsSearchOptions,
		context?: DocsRequestContext,
	): Promise<DocsSearchResponse> {
		return this.request<DocsSearchResponse>("GET", "/api/search", {
			query: this.cleanQuery({
				q: query,
				folder: options?.folder,
				tags: options?.tags,
				category: options?.category,
				dateFrom: options?.dateFrom,
				dateTo: options?.dateTo,
				sort: options?.sort,
				page: options?.page,
				limit: options?.limit,
				graph: options?.graph,
				graphHops: options?.graphHops,
				graphBoost: options?.graphBoost,
				includeChunks: options?.includeChunks,
			}),
		}, context);
	}

	async suggest(query: string, context?: DocsRequestContext): Promise<DocsSearchSuggestItem[]> {
		return this.request<DocsSearchSuggestItem[]>("GET", "/api/search/suggest", {
			query: this.cleanQuery({ q: query }),
		}, context);
	}

	// ── Graph metadata ───────────────────────────────────────────────────

	/** Return entities linked to a document through the AGE graph. */
	async getGraphEntities(docId: string, context?: DocsRequestContext): Promise<DocsGraphEntitiesResponse> {
		return this.request<DocsGraphEntitiesResponse>("GET", "/api/graph/entities", {
			query: this.cleanQuery({ docId }),
		}, context);
	}

	async listGraphEntities(docId: string, context?: DocsRequestContext): Promise<DocsGraphEntitiesResponse> {
		return this.getGraphEntities(docId, context);
	}

	/** Return graph-related documents and their relation metadata. */
	async getRelatedDocuments(docId: string, context?: DocsRequestContext): Promise<DocsGraphRelatedResponse> {
		return this.request<DocsGraphRelatedResponse>(
			"GET",
			`/api/graph/related/${encodeURIComponent(docId)}`,
			undefined,
			context,
		);
	}

	async listRelatedDocuments(
		docId: string,
		context?: DocsRequestContext,
	): Promise<DocsGraphRelatedResponse> {
		return this.getRelatedDocuments(docId, context);
	}

	/** Bulk graph lookup for agent and product integrations. */
	async graphSearch(
		input: { query?: string; docIds: string[]; maxResults?: number },
		context?: DocsRequestContext,
	): Promise<DocsGraphSearchResponse> {
		return this.request<DocsGraphSearchResponse>("POST", "/api/graph/search", {
			json: input,
		}, context);
	}

	/** Compatibility alias for callers that prefer verb-first naming. */
	async searchGraph(
		input: { query?: string; docIds: string[]; maxResults?: number },
		context?: DocsRequestContext,
	): Promise<DocsGraphSearchResponse> {
		return this.graphSearch(input, context);
	}

	// ── Share ────────────────────────────────────────────────────────────

	async createShare(input: {
		documentId?: string;
		folderId?: string;
		password?: string;
		expiresIn?: "1h" | "1d" | "7d" | "30d" | "never";
		role?: DocsShareRole;
	}, context?: DocsRequestContext): Promise<DocsShareLink> {
		return this.request<DocsShareLink>("POST", "/api/share", { json: input }, context);
	}

	async listShares(context?: DocsRequestContext): Promise<DocsShareListResponse> {
		return this.request<DocsShareListResponse>("GET", "/api/share", undefined, context);
	}

	async deleteShare(id: string, context?: DocsRequestContext): Promise<void> {
		await this.request<unknown>("DELETE", `/api/share/${encodeURIComponent(id)}`, undefined, context);
	}

	async updateShare(
		id: string,
		updates: { role?: DocsShareRole; expiresIn?: "1h" | "1d" | "7d" | "30d" | "never" },
		context?: DocsRequestContext,
	): Promise<DocsShareLink> {
		return this.request<DocsShareLink>(
			"PATCH",
			`/api/share/${encodeURIComponent(id)}`,
			{ json: updates },
			context,
		);
	}

	/**
	 * Public endpoint — still sends `Authorization` if configured, but
	 * the backend does not require it.
	 */
	async getShareByToken(
		token: string,
		context?: DocsRequestContext,
	): Promise<DocsSharedContent> {
		return this.request<DocsSharedContent>(
			"GET",
			`/api/share/${encodeURIComponent(token)}`,
			undefined,
			context,
		);
	}

	// ── Attachments ──────────────────────────────────────────────────────

	async uploadAttachment(
		documentId: string,
		file: Blob | ArrayBuffer | Uint8Array,
		filename: string,
		mimeType: string,
		context?: DocsRequestContext,
	): Promise<DocsAttachment> {
		const form = new FormData();
		const blob = this.toBlob(file, mimeType);
		form.append("file", blob, filename);

		const res = await this.fetchRaw(
			"POST",
			`/api/documents/${encodeURIComponent(documentId)}/attachments`,
			{ body: form },
			context,
		);
		if (!res.ok) {
			throw await this.toApiError(res);
		}
		return (await res.json()) as DocsAttachment;
	}

	async presignAttachment(
		documentId: string,
		input: DocsAttachmentPresignInput,
		context?: DocsRequestContext,
	): Promise<DocsAttachmentPresignResponse> {
		return this.request<DocsAttachmentPresignResponse>(
			"POST",
			`/api/documents/${encodeURIComponent(documentId)}/attachments/presign`,
			{ json: input },
			context,
		);
	}

	async confirmAttachment(
		documentId: string,
		input: DocsAttachmentConfirmInput,
		context?: DocsRequestContext,
	): Promise<DocsAttachment> {
		return this.request<DocsAttachment>(
			"POST",
			`/api/documents/${encodeURIComponent(documentId)}/attachments/confirm`,
			{ json: input },
			context,
		);
	}

	async listAttachments(
		documentId: string,
		context?: DocsRequestContext,
	): Promise<DocsAttachmentListResponse> {
		return this.request<DocsAttachmentListResponse>(
			"GET",
			`/api/documents/${encodeURIComponent(documentId)}/attachments`,
			undefined,
			context,
		);
	}

	async deleteAttachment(
		id: string,
		context?: DocsRequestContext,
	): Promise<void> {
		await this.request<unknown>(
			"DELETE",
			`/api/attachments/${encodeURIComponent(id)}`,
			undefined,
			context,
		);
	}

	// ── Versions ─────────────────────────────────────────────────────────

	async listVersions(
		documentId: string,
		options?: { onlySnapshots?: boolean; limit?: number },
		context?: DocsRequestContext,
	): Promise<DocsVersion[]> {
		return this.request<DocsVersion[]>(
			"GET",
			`/api/documents/${encodeURIComponent(documentId)}/versions`,
			{
				query: this.cleanQuery({
					onlySnapshots: options?.onlySnapshots,
					limit: options?.limit,
				}),
			},
			context,
		);
	}

	async getVersion(
		documentId: string,
		versionId: string,
		context?: DocsRequestContext,
	): Promise<DocsVersion> {
		return this.request<DocsVersion>(
			"GET",
			`/api/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}`,
			undefined,
			context,
		);
	}

	async createSnapshot(
		documentId: string,
		input: { label: string; description?: string },
		context?: DocsRequestContext,
	): Promise<DocsVersion> {
		return this.request<DocsVersion>(
			"POST",
			`/api/documents/${encodeURIComponent(documentId)}/versions`,
			{ json: input },
			context,
		);
	}

	async restoreVersion(
		documentId: string,
		versionId: string,
		context?: DocsRequestContext,
	): Promise<DocsDocument> {
		return this.request<DocsDocument>(
			"POST",
			`/api/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/restore`,
			undefined,
			context,
		);
	}

	async diffVersions(
		documentId: string,
		from: string,
		to: string,
		context?: DocsRequestContext,
	): Promise<DocsVersionDiff> {
		return this.request<DocsVersionDiff>(
			"GET",
			`/api/documents/${encodeURIComponent(documentId)}/versions/diff`,
			{ query: { from, to } },
			context,
		);
	}

	// ── Health ───────────────────────────────────────────────────────────

	async health(context?: DocsRequestContext): Promise<DocsHealthResponse> {
		return this.request<DocsHealthResponse>(
			"GET",
			"/api/health",
			undefined,
			context,
		);
	}

	// ─────────────────────────────────────────────────────────────────────
	// Internal: HTTP plumbing
	// ─────────────────────────────────────────────────────────────────────

	private async request<T>(
		method: string,
		path: string,
		options?: { json?: unknown; query?: Record<string, string | number | boolean | undefined> },
		context?: DocsRequestContext,
	): Promise<T> {
		const res = await this.fetchRaw(method, path, {
			json: options?.json,
			query: options?.query,
		}, context);
		if (!res.ok) {
			throw await this.toApiError(res);
		}
		// 204 / empty bodies: return undefined cast to T
		const contentType = res.headers.get("content-type") ?? "";
		if (res.status === 204 || res.body === null) {
			return undefined as T;
		}
		if (contentType.includes("application/json")) {
			return (await res.json()) as T;
		}
		// Fall back to text for non-JSON success responses (e.g. raw markdown export).
		return (await res.text()) as unknown as T;
	}

	private async fetchRaw(
		method: string,
		path: string,
		options?: {
			json?: unknown;
			query?: Record<string, string | number | boolean | undefined>;
			body?: BodyInit;
		},
		context?: DocsRequestContext,
	): Promise<Response> {
		const url = this.buildUrl(path, options?.query);
		const requestContext = this.mergeContext(
			this.config.requestContext,
			context,
		);
		const headers = new Headers(requestContext?.headers);
		if (!headers.has("Authorization") && this.config.apiKey) {
			headers.set("Authorization", `Bearer ${this.config.apiKey}`);
		}
		if (requestContext?.authorization)
			headers.set("Authorization", requestContext.authorization);
		if (requestContext?.cookie) headers.set("Cookie", requestContext.cookie);
		if (requestContext?.requestId)
			headers.set("X-Request-Id", requestContext.requestId);

		let body: BodyInit | undefined;
		if (options?.body !== undefined) {
			// Caller-supplied body (e.g. FormData) — set Content-Type if it's a Blob.
			body = options.body;
		} else if (options?.json !== undefined) {
			body = JSON.stringify(options.json);
			headers.set("Content-Type", "application/json");
		}

		const init: RequestInit = { method, headers };
		if (body !== undefined) init.body = body;

		let lastError: unknown = null;
		const maxAttempts = Math.max(1, this.config.retries);
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const timeoutSignal = AbortSignal.timeout(this.config.timeout);
			const signal = requestContext?.signal
				? AbortSignal.any([requestContext.signal, timeoutSignal])
				: timeoutSignal;
			try {
				const res = await this.config.fetch(url, { ...init, signal });
				if (this.shouldRetryStatus(res.status) && attempt < maxAttempts - 1) {
					await this.sleep(this.backoffDelay(attempt), requestContext?.signal);
					continue;
				}
				return res;
			} catch (err) {
				lastError = err;
				// A caller cancellation is authoritative. Do not retry it and do
				// not turn it into a timeout merely because the internal timeout
				// signal is also part of AbortSignal.any(). Preserving the original
				// error keeps standard AbortController semantics for hosts.
				if (requestContext?.signal?.aborted) {
					throw requestContext.signal.reason ?? err;
				}
				if (!this.isRetryableError(err) || attempt === maxAttempts - 1) {
					if (this.isTimeoutError(err)) {
						throw new DocsTimeoutError(this.config.timeout, {
							cause: err,
							requestId: requestContext?.requestId,
						});
					}
					throw this.wrapNetworkError(err, requestContext?.requestId);
				}
				await this.sleep(this.backoffDelay(attempt), requestContext?.signal);
			}
		}

		// Should be unreachable — the loop above either returns or throws.
		throw this.wrapNetworkError(lastError, requestContext?.requestId);
	}

	private buildUrl(
		path: string,
		query?: Record<string, string | number | boolean | undefined>,
	): string {
		let url = `${this.config.baseUrl}${path}`;
		if (query && Object.keys(query).length > 0) {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(query)) {
				if (value === undefined || value === null) continue;
				params.append(key, String(value));
			}
			const qs = params.toString();
			if (qs) url += (url.includes("?") ? "&" : "?") + qs;
		}
		return url;
	}

	private cleanQuery(
		query: Record<string, string | number | boolean | undefined | null>,
	): Record<string, string | number | boolean | undefined> {
		const out: Record<string, string | number | boolean | undefined> = {};
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null) continue;
			out[key] = value;
		}
		return out;
	}

	private shouldRetryStatus(status: number): boolean {
		return status === 502 || status === 503 || status === 504;
	}

	private isRetryableError(err: unknown): boolean {
		if (!(err instanceof Error)) return false;
		// AbortSignal.timeout surfaces as DOMException with name "TimeoutError"
		// or as a plain Error with name "AbortError" in some runtimes.
		if (err.name === "TimeoutError" || err.name === "AbortError") return true;
		// Connection resets / DNS failures etc. come through as TypeError
		// wrapping a system error code.
		const cause = (err as Error & { cause?: { code?: string } }).cause;
		if (cause?.code === "ECONNRESET") return true;
		if (cause?.code === "ECONNREFUSED") return true;
		if (cause?.code === "ETIMEDOUT") return true;
		return false;
	}

	private backoffDelay(attempt: number): number {
		// Exponential backoff: 1x, 2x, 4x ... with light jitter.
		const base = this.config.retryBackoffMs * 2 ** attempt;
		const jitter = Math.random() * base * 0.25;
		return Math.floor(base + jitter);
	}

	private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw (
				signal.reason ??
				new DOMException("The operation was aborted", "AbortError")
			);
		}
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(
					signal?.reason ??
						new DOMException("The operation was aborted", "AbortError"),
				);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private async toApiError(res: Response): Promise<DocsApiError> {
		const contentType = res.headers.get("content-type") ?? "";
		let body: unknown;
		try {
			body = contentType.includes("application/json")
				? await res.json()
				: await res.text();
		} catch {
			body = null;
		}
		const message =
			body &&
			typeof body === "object" &&
			"error" in body &&
			typeof body.error === "string"
				? body.error
				: body &&
						typeof body === "object" &&
						"message" in body &&
						typeof body.message === "string"
					? body.message
					: `hiai-docs API error ${res.status}`;
		return new DocsApiError(res.status, body, message, {
			url: res.url || undefined,
			requestId: res.headers.get("x-request-id") ?? undefined,
		});
	}

	private wrapNetworkError(err: unknown, requestId?: string): Error {
		if (err instanceof Error) {
			return new DocsNetworkError(`hiai-docs network error: ${err.message}`, {
				cause: err,
				requestId,
			});
		}
		return new DocsNetworkError(`hiai-docs network error: ${String(err)}`, {
			requestId,
		});
	}

	private isTimeoutError(err: unknown): boolean {
		return (
			err instanceof Error &&
			(err.name === "TimeoutError" || err.name === "AbortError")
		);
	}

	private mergeContext(
		base?: DocsRequestContext,
		override?: DocsRequestContext,
	): DocsRequestContext | undefined {
		if (!base && !override) return undefined;
		return {
			...base,
			...override,
			headers: {
				...(base?.headers
					? Object.fromEntries(new Headers(base.headers).entries())
					: {}),
				...(override?.headers
					? Object.fromEntries(new Headers(override.headers).entries())
					: {}),
			},
		};
	}

	private toBlob(
		file: Blob | ArrayBuffer | Uint8Array,
		mimeType: string,
	): Blob {
		if (file instanceof Blob) {
			// Re-wrap with explicit MIME if the caller passed one.
			if (file.type && file.type !== mimeType) {
				return new Blob([file], { type: mimeType });
			}
			return file;
		}
		if (file instanceof ArrayBuffer) {
			return new Blob([file], { type: mimeType });
		}
		if (file instanceof Uint8Array) {
			// TS 5.9 widened `Uint8Array<ArrayBufferLike>` which is not a
			// direct `BlobPart`. Copy into a fresh `Uint8Array<ArrayBuffer>`
			// to satisfy the Blob constructor.
			const copy = new Uint8Array(file.byteLength);
			copy.set(file);
			return new Blob([copy], { type: mimeType });
		}
		// Unreachable — covered by the union — but TS strict requires it.
		throw new Error("DocsClient.uploadAttachment: unsupported file type");
	}
}

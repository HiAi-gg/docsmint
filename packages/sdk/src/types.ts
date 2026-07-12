/**
 * TypeScript interfaces for the hiai-docs REST API.
 *
 * All shapes are derived from the actual Elysia routes in
 * `backend/src/api/routes/` — keep this file in sync if the backend
 * response shapes change.
 */

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Full document record returned by `GET /api/documents/:id` and the
 * create / duplicate / update endpoints. The list endpoint returns a
 * trimmed shape (`DocsDocumentListItem`) — `DocsDocumentListItem` is a
 * structural superset of `DocsDocument` and the list item omits the
 * full `content` (only the first 200 chars), `contentJson`, and
 * `metadata` fields.
 */
export interface DocsDocument {
	id: string;
	ownerId: string;
	folderId: string | null;
	categoryId: string | null;
	title: string;
	content: string;
	contentJson?: unknown;
	metadata?: unknown;
	visibility: DocsDocumentVisibility;
	createdAt: string;
	updatedAt: string;
	tags?: DocsTag[];
	folderName?: string | null;
}

export type DocsDocumentVisibility = "private" | "shared" | "public";

export interface DocsDocumentCreateInput {
	title?: string;
	content?: string;
	folderId?: string;
	categoryId?: string | null;
	visibility?: DocsDocumentVisibility;
}

export interface DocsDocumentUpdateInput {
	title?: string;
	content?: string;
	contentJson?: unknown;
	metadata?: unknown;
	folderId?: string | null;
	categoryId?: string | null;
	visibility?: DocsDocumentVisibility;
}

/**
 * Document item returned by `GET /api/documents` (list endpoint).
 * `content` is truncated to 200 chars server-side, `contentJson` and
 * `metadata` are not included.
 */
export interface DocsDocumentListItem {
	id: string;
	title: string;
	content: string;
	folderId: string | null;
	createdAt: string;
	updatedAt: string;
	tags: DocsTag[];
}

export interface DocsDocumentListResponse {
	items: DocsDocumentListItem[];
	total: number;
	page: number;
	limit: number;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export interface DocsFolder {
	id: string;
	ownerId: string;
	parentId: string | null;
	name: string;
	createdAt: string;
	updatedAt: string;
	categoryId?: string | null;
	order?: number;
	documentCount?: number;
	subfolderCount?: number;
	children?: DocsFolder[];
	documents?: DocsDocumentListItem[];
}

export interface DocsFolderCreateInput {
	name: string;
	parentId?: string | null;
	categoryId?: string | null;
}

export interface DocsFolderUpdateInput {
	name?: string;
	parentId?: string | null;
	categoryId?: string | null;
	order?: number;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type DocsCategoryApiMode =
	| "unavailable"
	| "global"
	| "general"
	| "category";

export interface DocsCategory {
	id: string;
	name: string;
	order: number;
	apiMode: DocsCategoryApiMode;
	apiPermissionRead: boolean;
	apiPermissionEdit: boolean;
	apiPermissionWrite: boolean;
	createdAt: string;
	updatedAt: string;
	documentCount?: number;
	folderCount?: number;
}

export interface DocsCategoryInput {
	name: string;
	apiMode?: DocsCategoryApiMode;
	apiPermissionRead?: boolean;
	apiPermissionEdit?: boolean;
	apiPermissionWrite?: boolean;
}

export interface DocsCategoryUpdate extends Partial<DocsCategoryInput> {
	order?: number;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Full tag record returned by create / update / list.
 * `listTags()` also returns `documentCount` and `createdAt`; create
 * and update return the bare row. Both shapes are accommodated.
 */
export interface DocsTag {
	id: string;
	name: string;
	color: string | null;
	createdAt?: string;
	documentCount?: number;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search hit as returned by `GET /api/search`. The backend uses
 * snake_case in the JSON payload — we mirror that exactly here so
 * consumers don't need to remap.
 */
export interface DocsSearchResult {
	id: string;
	title: string;
	snippet: string;
	score: number;
	folder_id: string | null;
	folder_name: string | null;
	created_at: string;
	updated_at: string;
	tags?: DocsTag[];
	/** Top matching text chunks, present when `includeChunks=true`. */
	chunks?: DocsSearchChunk[];
}

export interface DocsSearchChunk {
	chunkIndex: number;
	chunkText: string;
	charStart: number;
	charEnd: number;
	score: number;
}

export interface DocsSearchResponse {
	items: DocsSearchResult[];
	total: number;
	page: number;
	limit: number;
}

export interface DocsSearchOptions {
	folder?: string;
	tags?: string;
	category?: string;
	dateFrom?: string;
	dateTo?: string;
	sort?: string;
	page?: number;
	limit?: number;
	graph?: boolean;
	graphHops?: number;
	graphBoost?: number;
	includeChunks?: boolean;
}

// ---------------------------------------------------------------------------
// Graph metadata
// ---------------------------------------------------------------------------

export interface DocsGraphEntity {
	name: string;
	type: string;
}

export interface DocsGraphDocumentNeighbor {
	docId: string;
	relationType: string;
	hopDistance: number;
}

export interface DocsGraphRelatedDocument extends DocsGraphDocumentNeighbor {
	title: string;
	snippet: string;
}

export interface DocsGraphEntitiesResponse {
	entities: DocsGraphEntity[];
}

export interface DocsGraphRelatedResponse {
	related: DocsGraphDocumentNeighbor[];
}

export interface DocsGraphSearchResponse {
	query?: string;
	entities: DocsGraphEntity[];
	relatedDocs: DocsGraphRelatedDocument[];
}

/**
 * Suggestion hit returned by `GET /api/search/suggest`.
 */
export interface DocsSearchSuggestItem {
	id: string;
	title: string;
	score: number;
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

export interface DocsShareLink {
	id: string;
	token: string;
	documentId: string | null;
	folderId: string | null;
	expiresAt: string | null;
	hasPassword: boolean;
	role?: DocsShareRole;
	createdAt: string;
}

export type DocsShareRole = "viewer" | "commenter" | "editor";

/**
 * `GET /api/share` returns a richer list item with `title` and `type`
 * derived from the joined document / folder row.
 */
export interface DocsShareLinkListItem {
	id: string;
	token: string;
	documentId: string | null;
	folderId: string | null;
	hasPassword: boolean;
	expiresAt: string | null;
	createdAt: string;
	title: string;
	type: "document" | "folder";
	role?: DocsShareRole;
}

export interface DocsShareListResponse {
	links: DocsShareLinkListItem[];
}

/**
 * Response of `GET /api/share/:token` (public, no auth). The shape is
 * a discriminated union — narrow on `type` to access the right `data`.
 */
export type DocsSharedContent =
	| {
			type: "document";
			data: {
				id: string;
				title: string;
				content: string | null;
				contentJson: unknown;
				metadata: unknown;
				createdAt: string;
				updatedAt: string;
			};
	  }
	| {
			type: "folder";
			data: {
				id: string;
				name: string;
				createdAt: string;
				updatedAt: string;
				folders?: Array<{
					id: string;
					name: string;
					createdAt: string;
					updatedAt: string;
				}>;
				documents: Array<{
					id: string;
					title: string;
					createdAt: string;
					updatedAt: string;
				}>;
			};
	  };

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface DocsAttachment {
	id: string;
	filename: string;
	mimeType: string;
	size: number;
	url: string;
	documentId?: string;
	createdAt?: string;
}

export interface DocsAttachmentListResponse {
	items: DocsAttachment[];
}

export interface DocsAttachmentPresignInput {
	filename: string;
	contentType: string;
	size: number;
}

export interface DocsAttachmentPresignResponse {
	url: string;
	key: string;
	maxSize: number;
	expiresIn: number;
}

export interface DocsAttachmentConfirmInput extends DocsAttachmentPresignInput {
	key: string;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export type DocsApiKeyScope =
	| "global"
	| `category:${string}:${"read" | "edit" | "write"}`;

export interface DocsApiKeyCreated {
	id: string;
	key: string;
	prefix: string;
}

export interface DocsApiKeyListItem {
	id: string;
	name: string;
	prefix: string;
	scopes: DocsApiKeyScope[];
	lastUsedAt: string | null;
	expiresAt: string | null;
	createdAt: string;
	recoverable: boolean;
}

export interface DocsApiKeyListResponse {
	keys: DocsApiKeyListItem[];
}

// ---------------------------------------------------------------------------
// Document pipeline
// ---------------------------------------------------------------------------

export type DocsPipelineStatus =
	| "pending"
	| "processing"
	| "ready"
	| "retrying"
	| "failed"
	| "ready_with_warnings"
	| "skipped"
	| "cancelled";

export interface DocsDocumentPipeline {
	documentId: string;
	generationId: string;
	status: DocsPipelineStatus;
	revision: string;
	stages: {
		prepare: DocsPipelineStatus;
		embed: DocsPipelineStatus;
		graph: DocsPipelineStatus;
		summarize: DocsPipelineStatus;
		finalize: DocsPipelineStatus;
	};
	batches: { total: number; completed: number; failed: number };
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface DocsVersion {
	id: string;
	documentId: string;
	content: string;
	contentJson?: unknown;
	createdBy: string;
	createdAt: string;
	label?: string | null;
	description?: string | null;
	isSnapshot?: boolean;
	restoredFrom?: string | null;
}

export interface DocsVersionDiff {
	v1: { id: string; label?: string | null; createdAt: string };
	v2: { id: string; label?: string | null; createdAt: string };
	changes: { added: number; removed: number; modified: number };
	hunks: Array<{ type: "add" | "remove" | "unchanged"; lines: string[] }>;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface DocsHealthResponse {
	status: string;
	service: string;
	timestamp: string;
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/**
 * Request-scoped credentials and cancellation metadata. This is intentionally
 * transport-shaped so a host can forward an incoming hiai-docs session without
 * exposing auth internals to the SDK.
 */
export interface DocsRequestContext {
	/** Raw Authorization header value, e.g. `Bearer <token>`. */
	authorization?: string;
	cookie?: string;
	requestId?: string;
	headers?: HeadersInit;
	signal?: AbortSignal;
}

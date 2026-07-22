const declarations: Record<string, string> = {
	"app-shell.d.ts": `import type { Component, Snippet } from "svelte";
export interface DocsmintNavigationOptions {
  replaceState?: boolean;
  noScroll?: boolean;
  keepFocus?: boolean;
  invalidateAll?: boolean;
  state?: App.PageState;
}
export interface DocsmintRouteAdapter {
  pathname: string;
  resolve(path: string): string;
  navigate?(path: string, options?: DocsmintNavigationOptions): void | Promise<void>;
}
export interface DocsmintRequestAdapter { fetch: typeof fetch; }
export interface DocsmintAppShellHostProps { route: DocsmintRouteAdapter; request?: DocsmintRequestAdapter; extensions?: Record<string, unknown>; children: Snippet; }
export declare const DocsmintAppShellHost: Component<DocsmintAppShellHostProps>;
export declare function getDocsmintRequestAdapter(): DocsmintRequestAdapter;
`,
	"dashboard.d.ts": 'import type { Component } from "svelte";\nexport declare const DocsmintDashboardHost: Component;\n',
	"search.d.ts": 'import type { Component } from "svelte";\nexport declare const DocsmintSearchHost: Component;\n',
	"shared-document.d.ts": `import type { Component } from "svelte";
export declare const DocsmintSharedDocumentHost: Component;
export interface ProseMirrorNode {
  type: string;
  text?: string;
  content?: ProseMirrorNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}
export type ProseMirrorDoc = ProseMirrorNode & { content?: ProseMirrorNode[] };
export type SharedAttachmentObjectUrls = string[];
export declare function renderSharedDocument(doc: ProseMirrorDoc): string;
export declare function markMarkdownTaskItems(html: string): string;
export declare function sharedAttachmentHeaders(token: string, password?: string): HeadersInit;
export declare function hydrateSharedAttachmentImages(root: ParentNode, token: string, password?: string): Promise<SharedAttachmentObjectUrls>;
export declare function waitForSharedDocumentImages(root: ParentNode): Promise<void>;
`,
	"extension.d.ts": `import type { Component, ComponentType, Snippet, SvelteComponent } from "svelte";
export interface ExtensionVisibilityContext {
  userId?: string;
  pathname?: string;
  capabilities?: Readonly<Record<string, boolean>>;
  permissions?: Readonly<Record<string, boolean>>;
}
export type ExtensionVisibility = (context: ExtensionVisibilityContext) => boolean;
export type ExtensionIcon = ComponentType<SvelteComponent>;
export interface DocTabPanelProps { documentId: string; content: string; contentJson: object | undefined; }
export interface DocTabDefinition { id: string; label: string; component: Component<DocTabPanelProps>; order?: number; icon?: ExtensionIcon; disabled?: boolean; }
export interface NavigationExtension { id: string; label: string; href?: string; icon?: ExtensionIcon; order?: number; badge?: string | number; disabled?: boolean; visible?: ExtensionVisibility; }
export interface SidebarTopExtension { id: string; component: Component<{ collapsed: boolean }>; order?: number; visible?: ExtensionVisibility; }
export interface DashboardWidgetProps { userId?: string; }
export interface DashboardWidgetExtension { id: string; title?: string; component: Component<DashboardWidgetProps>; order?: number; colSpan?: 1 | 2 | 3 | 4 | 6 | 12; visible?: ExtensionVisibility; }
export interface SearchWidgetProps { query: string; loading: boolean; total?: number; }
export interface SearchWidgetExtension { id: string; title?: string; component: Component<SearchWidgetProps>; order?: number; visible?: ExtensionVisibility; }
export interface EditorActionContext { documentId: string; content: string; contentJson: object | undefined; selection?: unknown; commands?: Readonly<Record<string, (...args: unknown[]) => unknown>>; }
export type ExtensionAction = (context: EditorActionContext) => void | Promise<void>;
export interface EditorActionExtension { id: string; label: string; icon?: ExtensionIcon; order?: number; disabled?: boolean | ((context: EditorActionContext) => boolean); visible?: ExtensionVisibility; run: ExtensionAction; }
export interface DocumentMenuActionContext extends EditorActionContext { title?: string; }
export type DocumentMenuAction = (context: DocumentMenuActionContext) => void | Promise<void>;
export interface DocumentMenuActionExtension { id: string; label: string; icon?: ExtensionIcon; order?: number; destructive?: boolean; disabled?: boolean | ((context: DocumentMenuActionContext) => boolean); visible?: ExtensionVisibility; run: DocumentMenuAction; }
export interface SettingsSectionProps { userId?: string; }
export interface SettingsSectionExtension { id: string; label: string; component: Component<SettingsSectionProps>; order?: number; description?: string; visible?: ExtensionVisibility; }
export interface CommandPaletteActionContext { query?: string; }
export type CommandPaletteAction = (context: CommandPaletteActionContext) => void | Promise<void>;
export interface CommandPaletteActionExtension { id: string; label: string; keywords?: readonly string[]; group?: string; shortcut?: string; icon?: ExtensionIcon; order?: number; disabled?: boolean; visible?: ExtensionVisibility; run: CommandPaletteAction; }
export interface SharedDocumentExtensionCapability { id: string; expiresAt: string; }
export interface SharedDocumentExtensionContext { documentId: string; title: string; content: string; contentJson?: object; role: "viewer" | "commenter" | "editor"; capability: SharedDocumentExtensionCapability; permissions: { read: true; annotate: boolean; edit: boolean; export: boolean; }; }
export interface SharedDocumentExtension { id: string; label: string; icon?: ExtensionIcon; order?: number; permission: "annotate" | "edit"; visible?: (context: SharedDocumentExtensionContext) => boolean; component: Component<{ context: SharedDocumentExtensionContext }>; }
export interface DocsmintFrontendExtensions { sidebarTop: readonly SidebarTopExtension[]; navigation: readonly NavigationExtension[]; dashboardWidgets: readonly DashboardWidgetExtension[]; searchWidgets: readonly SearchWidgetExtension[]; documentTabs: readonly DocTabDefinition[]; editorActions: readonly EditorActionExtension[]; documentMenuActions: readonly DocumentMenuActionExtension[]; settingsSections: readonly SettingsSectionExtension[]; commandPaletteActions: readonly CommandPaletteActionExtension[]; sharedDocumentHeaderActions: readonly SharedDocumentExtension[]; sharedDocumentTabs: readonly SharedDocumentExtension[]; sharedDocumentNotesModes: readonly SharedDocumentExtension[]; sharedDocumentEditorModes: readonly SharedDocumentExtension[]; }
/** @deprecated Use DocsmintFrontendExtensions. */
export type HiaiDocsFrontendExtensions = DocsmintFrontendExtensions;
export type FrontendExtensions = DocsmintFrontendExtensions;
export interface DocsmintExtensionProviderProps { extensions?: Partial<DocsmintFrontendExtensions>; children: Snippet; }
export declare const DocsmintExtensionProvider: Component<DocsmintExtensionProviderProps>;
`,
	"components/sidebar.d.ts": 'import type { Component } from "svelte";\nexport declare const Sidebar: Component;\n',
	"components/settings.d.ts": 'import type { Component } from "svelte";\nexport declare const SettingsDialog: Component;\n',
	"theme.d.ts": 'export type ThemeMode = "light" | "dark" | "system";\nexport declare const theme: { readonly value: ThemeMode; readonly isDark: boolean };\nexport declare function setTheme(value: ThemeMode): void;\nexport declare function toggleTheme(): void;\n',
	"i18n.d.ts": 'export type Locale = string;\nexport declare const messages: Record<string, unknown>;\nexport declare const supportedLocales: readonly Locale[];\nexport declare function setLocale(locale: Locale): unknown;\nexport declare function getMessage(name: string): unknown;\n',
};

declarations["api/categories.d.ts"] = `
import type { z } from "zod";
export interface CategoryDto { id: string; name: string; order: number; apiMode?: "unavailable" | "global" | "general" | "category" | null; apiPermissionRead?: boolean | null; apiPermissionEdit?: boolean | null; apiPermissionWrite?: boolean | null; createdAt: string; updatedAt: string; documentCount?: number; folderCount?: number; }
export type Category = CategoryDto;
export interface CreateCategoryInput { name: string; apiMode?: "unavailable" | "global" | "general" | "category"; apiPermissionRead?: boolean; apiPermissionEdit?: boolean; apiPermissionWrite?: boolean; }
export interface UpdateCategoryInput { name?: string; order?: number; apiMode?: "unavailable" | "global" | "general" | "category"; apiPermissionRead?: boolean; apiPermissionEdit?: boolean; apiPermissionWrite?: boolean; }
export declare const createCategoryInputSchema: z.ZodType<CreateCategoryInput>;
export declare const updateCategoryInputSchema: z.ZodType<UpdateCategoryInput>;
export declare function listCategories(fetcher?: typeof fetch): Promise<CategoryDto[]>;
export declare function createCategory(inputOrName: string | CreateCategoryInput): Promise<CategoryDto>;
export declare function updateCategory(id: string, data: UpdateCategoryInput): Promise<CategoryDto>;
export declare function deleteCategory(id: string): Promise<void>;
export declare function setDocumentCategory(documentId: string, categoryId: string | null): Promise<void>;
export declare function setFolderCategory(folderId: string, categoryId: string | null): Promise<void>;
`;
declarations["api/documents.d.ts"] = `
export interface DocumentTagDto { id: string; name: string; color: string; }
export interface DocumentDto { id: string; title: string; content: string; contentJson?: unknown; folderId?: string | null; folderName?: string; categoryId?: string | null; tags?: DocumentTagDto[]; excerpt?: string; createdAt: string; updatedAt: string; }
export type Document = DocumentDto;
export interface DocumentListResponse { items: DocumentDto[]; total: number; page: number; limit: number; }
export interface UpdateDocumentInput { title?: string; content?: string; folderId?: string | null; categoryId?: string | null; contentJson?: unknown; expectedUpdatedAt?: string; }
export interface ImportResult { filename: string; status: "ok" | "error"; document?: DocumentDto; error?: string; }
export interface ImportResponse { items: ImportResult[]; imported: number; failed: number; }
export declare function listDocuments(params?: { folderId?: string; tag?: string; page?: number; limit?: number }, fetcher?: typeof fetch): Promise<DocumentListResponse>;
export declare function getDocument(id: string, fetcher?: typeof fetch): Promise<DocumentDto>;
export declare function createDocument(data: { title: string; content?: string; folderId?: string; categoryId?: string }, fetcher?: typeof fetch): Promise<DocumentDto>;
export declare function updateDocument(id: string, data: UpdateDocumentInput): Promise<DocumentDto>;
export declare function deleteDocument(id: string): Promise<void>;
export declare function importDocument(file: File, folderId?: string): Promise<DocumentDto>;
export declare function importDocuments(files: File[], folderId?: string): Promise<ImportResponse>;
export declare function clearDocumentsCache(...args: readonly unknown[]): void;
`;
declarations["api/folders.d.ts"] = `
export interface FolderDocumentDto { id: string; title: string; content?: string; folderId: string | null; folderName: string; categoryId?: string | null; tags: string[]; createdAt: string; updatedAt: string; excerpt: string; }
export interface FolderDto { id: string; name: string; parentId: string | null; categoryId?: string | null; order: number; documentCount: number; subfolderCount: number; children: FolderDto[]; documents: FolderDocumentDto[]; createdAt: string; updatedAt: string; }
export type Folder = FolderDto;
export interface CreateFolderData { name: string; parentId?: string | null; categoryId?: string | null; }
export interface UpdateFolderData { name?: string; parentId?: string | null; categoryId?: string | null; order?: number; }
export declare function listFolders(parentId?: string | null, all?: boolean, fetcher?: typeof fetch): Promise<FolderDto[]>;
export declare function getFolder(id: string, fetcher?: typeof fetch): Promise<FolderDto>;
export declare function getFolderPath(folderId: string, fetcher?: typeof fetch): Promise<Array<{ id: string; name: string }>>;
export declare function createFolder(data: CreateFolderData): Promise<FolderDto>;
export declare function updateFolder(id: string, data: UpdateFolderData): Promise<FolderDto>;
export declare function deleteFolder(id: string): Promise<void>;
export declare function duplicateDocument(documentId: string): Promise<FolderDocumentDto>;
export declare function deleteDocument(documentId: string): Promise<void>;
`;
declarations["api/tags.d.ts"] = `
import type { z } from "zod";
export interface TagDto { id: string; name: string; color: string | null; createdAt: string; documentCount?: number; }
export type Tag = TagDto;
export interface CreateTagInput { name: string; color?: string; }
export interface UpdateTagInput { name?: string; color?: string; }
export declare const createTagInputSchema: z.ZodType<CreateTagInput>;
export declare const updateTagInputSchema: z.ZodType<UpdateTagInput>;
export declare function listTags(fetcher?: typeof fetch): Promise<TagDto[]>;
export declare function getTag(id: string): Promise<TagDto>;
export declare function createTag(name: string, color?: string): Promise<TagDto>;
export declare function updateTag(id: string, data: UpdateTagInput): Promise<TagDto>;
export declare function deleteTag(id: string): Promise<void>;
export declare function addTagToDocument(documentId: string, tagId: string): Promise<void>;
export declare function removeTagFromDocument(documentId: string, tagId: string): Promise<void>;
`;
declarations["api/settings.d.ts"] = `
export interface ProfileDto { id: string; name: string; email: string; avatar: string | null; }
export type UserProfile = ProfileDto;
export interface EmbeddingConfigDto { baseUrl: string; apiKey: string; model: string; fallbackBaseUrl: string | null; fallbackApiKey: string | null; fallbackModel: string | null; }
export type EmbeddingConfig = EmbeddingConfigDto;
export declare function getProfile(): Promise<ProfileDto>;
export declare function updateProfile(data: { name?: string }): Promise<ProfileDto>;
export declare function getEmbeddingConfig(): EmbeddingConfigDto;
export declare function updateEmbeddingConfig(data: Partial<EmbeddingConfigDto>): EmbeddingConfigDto;
export declare function deleteAccount(): Promise<void>;
`;


declarations["types.d.ts"] = `export interface Document { id: string; title: string; content?: string; folderId: string | null; folderName: string; categoryId?: string | null; tags: string[]; createdAt: string; updatedAt: string; excerpt: string; }
export interface Folder { id: string; name: string; parentId: string | null; categoryId?: string | null; order: number; documentCount: number; subfolderCount: number; children: Folder[]; documents: Document[]; createdAt: string; updatedAt: string; }
export interface Tag { id: string; name: string; color: string; }
export type ViewMode = "grid" | "list";
export type SortOption = "name" | "updated" | "created";
export type SortDirection = "asc" | "desc";
`;
declarations["keyboard.d.ts"] = `export type ShortcutScope = "global" | "editor" | "dialog" | "list";
export interface Shortcut { id: string; keys: string; handler: (event: KeyboardEvent) => void; scope?: ShortcutScope; description: string; enabled?: boolean; overrideInput?: boolean; }
export declare function normaliseKeys(keys: string): string;
export declare function registerShortcut(shortcut: Shortcut): void;
export declare function unregisterShortcut(id: string): void;
export declare function getShortcut(id: string): Shortcut | undefined;
export declare function getShortcutsByScope(scope: ShortcutScope): Shortcut[];
export declare function clearShortcuts(): void;
export declare function toggleQuickSearch(): void;
export declare function setQuickSearchOpen(open: boolean): void;
export declare function toggleShortcutHelp(): void;
export declare function setShortcutHelpOpen(open: boolean): void;
export declare function registerDefaultShortcuts(): void;
export declare function handleKeyEvent(event: KeyboardEvent): boolean;
`;
declarations["folder-refresh.d.ts"] = `export declare function refreshFolders(): void;
export declare function getGlobalFolderRefreshNonce(): number;
export declare function bumpSubfoldersRefresh(folderId: string): void;
export declare function getSubfoldersRefresh(folderId: string): number;
export declare function registerFolder(id: string, parentId: string | null, categoryId: string | null, order: number): void;
export declare function registerDocument(id: string, folderId: string | null, categoryId: string | null): void;
export declare function publishDocumentPlacement(id: string, folderId: string | null, categoryId: string | null): number;
export declare function acknowledgeDocumentPlacement(id: string, version: number): void;
`;
declarations["utils.d.ts"] = `import type { ClassValue } from "clsx";
export declare function cn(...inputs: ClassValue[]): string;
export type WithElementRef<T> = T & { ref?: Element | null };
export declare function formatRelativeTime(isoDate: string): string;
`;
declarations["utils/clipboard.d.ts"] = "export declare function copyToClipboard(text: string): Promise<boolean>;\n";
declarations["utils/dndzone.d.ts"] = `import type { ActionReturn } from "svelte/action";
import type { DndEvent, DndZoneAttributes, Item, Options } from "svelte-dnd-action";
export type { DndEvent, Item, Options };
export declare function dndzone<T extends Item>(node: HTMLElement, options: Options<T>): ActionReturn<Options<T>, DndZoneAttributes<T>>;
`;
declarations["api/share.d.ts"] = `export interface ShareLink { id: string; token: string; documentId?: string; folderId?: string; categoryId?: string; hasPassword: boolean; expiresAt?: string | null; createdAt: string; title?: string; type?: "document" | "folder" | "category"; guestEmails: string[]; }
export interface CreateShareLinkInput { documentId?: string; folderId?: string; categoryId?: string; password?: string; expiresIn?: "1h" | "1d" | "7d" | "30d" | "never"; guestEmails?: string[]; }
export declare function createShareLink(data: CreateShareLinkInput): Promise<ShareLink>;
export declare function listShareLinks(params?: { documentId?: string }): Promise<{ links: ShareLink[] }>;
export declare function revokeShareLink(id: string): Promise<void>;
`;
declarations["api/attachments.d.ts"] = `export interface Attachment { id: string; filename: string; mimeType: string; size: number; url: string; }
export interface AttachmentListResponse { items: Attachment[]; }
export declare function uploadAttachment(documentId: string, file: File): Promise<Attachment>;
export declare function listAttachments(documentId: string): Promise<AttachmentListResponse>;
export declare function isImageFile(file: File): boolean;
export declare function isFileSizeAllowed(file: File): boolean;
`;
declarations["collaboration.d.ts"] = `import type { WebsocketProvider } from "y-websocket";
import type * as Y from "yjs";
export interface CollaborationSession { provider: WebsocketProvider; doc: Y.Doc; destroy(): void; }
export declare function startCollaboration(documentId: string, accessToken: string, onUpdate?: (update: Uint8Array) => void): CollaborationSession;
export declare function stopCollaboration(): void;
export declare function getActiveSession(): CollaborationSession | null;
`;
declarations["components/create-snapshot-dialog.d.ts"] = 'import type { Component } from "svelte";\nexport declare const CreateSnapshotDialog: Component;\n';
declarations["components/delete-dialog.d.ts"] = 'import type { Component } from "svelte";\nexport declare const DeleteDialog: Component;\n';
declarations["components/category-dialog.d.ts"] = 'import type { Component } from "svelte";\nexport declare const CategoryDialog: Component;\n';
declarations["components/folder-node.d.ts"] = 'import type { Component } from "svelte";\nexport interface FolderNodeItem { id: string; name: string; categoryId?: string | null; parentId?: string | null; order?: number; }\nexport declare const FolderNode: Component;\n';
declarations["document-drop-coordinator.d.ts"] = `export interface SidebarDocumentPlacement { folderId: string | null; categoryId: string | null; }
export declare function createDocumentDropCoordinator(options: { persist(id: string, placement: SidebarDocumentPlacement): void; }): { pendingId(token: number): string | null; begin(id: string, token: number): void; end(id: string, token: number): void; cancel(): void; zone(id: string, placement: SidebarDocumentPlacement): void; header(id: string, placement: SidebarDocumentPlacement): void; };
`;
declarations["offline/identity.d.ts"] = `export interface OfflineIdentity { appId: string; deploymentId: string; ownerId: string; tenantId?: string; }
export declare function offlineAccessEnabled(): boolean;
export declare function enableOfflineAccess(identity: OfflineIdentity): void;
export declare function disableOfflineAccess(): void;
export declare function offlineDbName(identity: OfflineIdentity): string;
export declare function resolveOfflineIdentity(): Promise<OfflineIdentity>;
`;
declarations["doc-tabs.d.ts"] = `import type { Component, ComponentType } from "svelte";
export interface DocTabPanelProps { documentId: string; content: string; contentJson: object | undefined; }
export interface DocTabDefinition { id: string; label: string; component: Component<DocTabPanelProps>; order?: number; icon?: ComponentType; disabled?: boolean; }
export declare const docTabRegistry: DocTabDefinition[];
export declare function createDocTabRegistry(initial?: readonly DocTabDefinition[]): DocTabDefinition[];
export declare function registerDocTabIn(registry: DocTabDefinition[], tab: DocTabDefinition): void;
export declare function registerDocTab(tab: DocTabDefinition): void;
`;

declarations["components/editor/document-editor.d.ts"] = 'import type { Component } from "svelte";\nexport interface EditorOutput { markdown: string; json: object; }\nexport declare const DocsmintDocumentEditorHost: Component;\n';
declarations["components/folder-tree-selector.d.ts"] = 'import type { Component } from "svelte";\nexport declare const FolderTreeSelector: Component;\n';
declarations["components/save-as-dialog.d.ts"] = 'import type { Component } from "svelte";\nexport declare const SaveAsDialog: Component;\n';
declarations["components/share-dialog.d.ts"] = 'import type { Component } from "svelte";\nexport declare const ShareDialog: Component;\n';
declarations["components/tag-create-dialog.d.ts"] = 'import type { Component } from "svelte";\nexport declare const TagCreateDialog: Component;\n';
declarations["components/version-history.d.ts"] = 'import type { Component } from "svelte";\nexport declare const VersionHistory: Component;\n';
declarations["components/editor/document-title.d.ts"] = 'import type { Component } from "svelte";\nexport declare const DocumentTitle: Component;\n';
declarations["components/editor/markdown-toggle.d.ts"] = 'import type { Component } from "svelte";\nexport declare const MarkdownToggle: Component;\n';
declarations["components/editor/extensions.d.ts"] = 'import type { Extensions } from "@tiptap/core";\nexport declare const editorExtensions: Extensions;\n';
declarations["components/editor/markdown.d.ts"] = 'export declare function markdownToJson(markdown: string): Promise<object>;\n';

declarations["components/editor/docx-serializer.d.ts"] = "import type { File } from \"docx\";\nexport declare const customSerializerAsync: { serializeAsync(document: unknown, options?: unknown): Promise<File> };\n";

const out = new URL("../dist/frontend/", import.meta.url);
for (const [name, contents] of Object.entries(declarations)) {
	await Bun.write(new URL(name, out), contents);
}

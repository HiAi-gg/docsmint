import type { Component } from "svelte";
import type {
	DocTabDefinition,
	DocTabIcon,
	DocTabPanelProps,
} from "./doc-tabs";

/**
 * Runtime information supplied to extension visibility predicates.
 *
 * The object is intentionally data-only. Extensions can therefore be
 * evaluated during SSR without reaching for browser globals or a module-level
 * store.
 */
export interface ExtensionVisibilityContext {
	userId?: string;
	pathname?: string;
	capabilities?: Readonly<Record<string, boolean>>;
	permissions?: Readonly<Record<string, boolean>>;
}

export type ExtensionVisibility = (
	context: ExtensionVisibilityContext,
) => boolean;

/** Icon shape shared with the existing document-tab contract. */
export type ExtensionIcon = DocTabIcon;

export interface NavigationExtension {
	id: string;
	label: string;
	href?: string;
	icon?: ExtensionIcon;
	order?: number;
	badge?: string | number;
	disabled?: boolean;
	visible?: ExtensionVisibility;
}

/** Optional host content rendered above the stock sidebar search control. */
export interface SidebarTopExtension {
	id: string;
	component: Component<{ collapsed: boolean }>;
	order?: number;
	visible?: ExtensionVisibility;
}

/** Optional host action rendered beside Settings, or above it when collapsed. */
export interface SidebarFooterActionExtension {
	id: string;
	component: Component<{ collapsed: boolean }>;
	order?: number;
	visible?: ExtensionVisibility;
}

export interface DashboardWidgetProps {
	userId?: string;
}

export interface DashboardWidgetExtension {
	id: string;
	title?: string;
	component: Component<DashboardWidgetProps>;
	order?: number;
	colSpan?: 1 | 2 | 3 | 4 | 6 | 12;
	/** Render the component without the host card so it can own a transient shell. */
	chrome?: boolean;
	visible?: ExtensionVisibility;
}

/**
 * Read-only state supplied to a search extension.
 *
 * Search extensions deliberately receive result metadata only. They cannot
 * alter retrieval, ranking, filters, or the authenticated API client.
 */
export interface SearchWidgetProps {
	query: string;
	loading: boolean;
	total?: number;
}

export interface SearchWidgetExtension {
	id: string;
	title?: string;
	component: Component<SearchWidgetProps>;
	order?: number;
	visible?: ExtensionVisibility;
}

export interface EditorActionContext {
	documentId: string;
	content: string;
	contentJson: object | undefined;
	selection?: unknown;
	/** The host supplies an editor command facade; no editor implementation leaks into the contract. */
	commands?: Readonly<Record<string, (...args: unknown[]) => unknown>>;
}

export type ExtensionAction = (
	context: EditorActionContext,
) => void | Promise<void>;

export interface EditorActionExtension {
	id: string;
	label: string;
	icon?: ExtensionIcon;
	order?: number;
	disabled?: boolean | ((context: EditorActionContext) => boolean);
	visible?: ExtensionVisibility;
	run: ExtensionAction;
}

export interface DocumentMenuActionContext extends EditorActionContext {
	title?: string;
}

export type DocumentMenuAction = (
	context: DocumentMenuActionContext,
) => void | Promise<void>;

export interface DocumentMenuActionExtension {
	id: string;
	label: string;
	icon?: ExtensionIcon;
	order?: number;
	destructive?: boolean;
	disabled?: boolean | ((context: DocumentMenuActionContext) => boolean);
	visible?: ExtensionVisibility;
	run: DocumentMenuAction;
}

export interface SettingsSectionProps {
	userId?: string;
}

export interface SettingsSectionExtension {
	id: string;
	label: string;
	component: Component<SettingsSectionProps>;
	order?: number;
	description?: string;
	visible?: ExtensionVisibility;
}

export interface CommandPaletteActionContext {
	query?: string;
}

export type CommandPaletteAction = (
	context: CommandPaletteActionContext,
) => void | Promise<void>;

export interface CommandPaletteActionExtension {
	id: string;
	label: string;
	keywords?: readonly string[];
	group?: string;
	shortcut?: string;
	icon?: ExtensionIcon;
	order?: number;
	disabled?: boolean;
	visible?: ExtensionVisibility;
	run: CommandPaletteAction;
}

/**
 * Opaque, non-bearer capability metadata issued by a host after its own
 * server-side share/session validation. It must never contain a share token,
 * password, workspace assertion, cookie, authorization value, or signature.
 */
export interface SharedDocumentExtensionCapability {
	id: string;
	expiresAt: string;
}

/** Safe capability hints for a public shared-document extension. */
export interface SharedDocumentExtensionContext {
	documentId: string;
	title: string;
	content: string;
	contentJson?: object;
	role: "viewer" | "commenter" | "editor";
	capability: SharedDocumentExtensionCapability;
	permissions: {
		read: true;
		annotate: boolean;
		edit: boolean;
		export: boolean;
	};
}

export interface SharedDocumentExtension {
	id: string;
	label: string;
	icon?: ExtensionIcon;
	order?: number;
	permission: "annotate" | "edit";
	visible?: (context: SharedDocumentExtensionContext) => boolean;
	component: Component<{ context: SharedDocumentExtensionContext }>;
}

/**
 * Complete frontend extension manifest consumed by the DocsMint app shell and
 * page components. Arrays are readonly to keep registration request-scoped
 * and to prevent extensions mutating one another during SSR.
 */
export interface DocsmintFrontendExtensions {
	sidebarTop: readonly SidebarTopExtension[];
	sidebarFooterActions: readonly SidebarFooterActionExtension[];
	navigation: readonly NavigationExtension[];
	dashboardWidgets: readonly DashboardWidgetExtension[];
	searchWidgets: readonly SearchWidgetExtension[];
	documentTabs: readonly DocTabDefinition[];
	editorActions: readonly EditorActionExtension[];
	documentMenuActions: readonly DocumentMenuActionExtension[];
	settingsSections: readonly SettingsSectionExtension[];
	profileActions: readonly SettingsSectionExtension[];
	commandPaletteActions: readonly CommandPaletteActionExtension[];
	sharedDocumentHeaderActions: readonly SharedDocumentExtension[];
	sharedDocumentTabs: readonly SharedDocumentExtension[];
	sharedDocumentNotesModes: readonly SharedDocumentExtension[];
	sharedDocumentEditorModes: readonly SharedDocumentExtension[];
}

/** @deprecated Use DocsmintFrontendExtensions. */
export type HiaiDocsFrontendExtensions = DocsmintFrontendExtensions;

/** Backwards-compatible, concise name for consumers defining a manifest. */
export type FrontendExtensions = DocsmintFrontendExtensions;

/** Props used by a document tab component in extension manifests. */
export type { DocTabDefinition, DocTabPanelProps };

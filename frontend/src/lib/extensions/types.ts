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

export interface DashboardWidgetProps {
	userId?: string;
}

export interface DashboardWidgetExtension {
	id: string;
	title?: string;
	component: Component<DashboardWidgetProps>;
	order?: number;
	colSpan?: 1 | 2 | 3 | 4 | 6 | 12;
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
 * Complete frontend extension manifest consumed by hiai-docs app-shell and
 * page components. Arrays are readonly to keep registration request-scoped
 * and to prevent extensions mutating one another during SSR.
 */
export interface HiaiDocsFrontendExtensions {
	navigation: readonly NavigationExtension[];
	dashboardWidgets: readonly DashboardWidgetExtension[];
	documentTabs: readonly DocTabDefinition[];
	editorActions: readonly EditorActionExtension[];
	documentMenuActions: readonly DocumentMenuActionExtension[];
	settingsSections: readonly SettingsSectionExtension[];
	commandPaletteActions: readonly CommandPaletteActionExtension[];
}

/** Backwards-compatible, concise name for consumers defining a manifest. */
export type FrontendExtensions = HiaiDocsFrontendExtensions;

/** Props used by a document tab component in extension manifests. */
export type { DocTabDefinition, DocTabPanelProps };

/**
 * Public entrypoint for the hiai-docs frontend extension package.
 *
 * Keep this barrel limited to SSR-safe contracts and pure helpers. Hosts such
 * as DocsMint import this path from the published package; route modules and
 * mutable app singletons are intentionally not part of the public surface.
 */

export type {
	ProseMirrorDoc,
	ProseMirrorNode,
	SharedAttachmentObjectUrls,
} from "./components/editor/shared-document";
export {
	hydrateSharedAttachmentImages,
	renderSharedDocument,
	sharedAttachmentHeaders,
} from "./components/editor/shared-document";
export {
	createFrontendExtensions,
	getFrontendExtensions,
	getHiaiDocsExtensions,
	provideFrontendExtensions,
	setFrontendExtensions,
	setHiaiDocsExtensions,
} from "./extensions/context";
export type {
	DocTabDefinition,
	DocTabIcon,
	DocTabPanelProps,
} from "./extensions/doc-tabs";
export type {
	CommandPaletteAction,
	CommandPaletteActionContext,
	CommandPaletteActionExtension,
	DashboardWidgetExtension,
	DashboardWidgetProps,
	DocumentMenuAction,
	DocumentMenuActionContext,
	DocumentMenuActionExtension,
	EditorActionContext,
	EditorActionExtension,
	ExtensionAction,
	ExtensionIcon,
	ExtensionVisibility,
	ExtensionVisibilityContext,
	FrontendExtensions,
	HiaiDocsFrontendExtensions,
	NavigationExtension,
	SettingsSectionExtension,
	SettingsSectionProps,
} from "./extensions/types";

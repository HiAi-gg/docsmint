/**
 * public entrypoint / barrel file for hiai-docs frontend package
 */

export {
	type DocTabDefinition,
	type DocTabIcon,
	type DocTabPanelProps,
	createDocTabRegistry,
	docTabRegistry,
	registerDocTabIn,
	registerDocTab,
} from "./stores/doc-tab-registry.svelte";

export {
	createFrontendExtensions,
	getFrontendExtensions,
	getHiaiDocsExtensions,
	provideFrontendExtensions,
	setFrontendExtensions,
	setHiaiDocsExtensions,
} from "./extensions/context";
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
export {
	hydrateSharedAttachmentImages,
	renderSharedDocument,
	sharedAttachmentHeaders,
} from "./components/editor/shared-document";
export type {
	ProseMirrorDoc,
	ProseMirrorNode,
	SharedAttachmentObjectUrls,
} from "./components/editor/shared-document";

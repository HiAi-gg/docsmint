import { createContext } from "svelte";
import type { HiaiDocsFrontendExtensions } from "./types";

/**
 * Create a fresh manifest for one app/request.
 *
 * A new array is created for every category so an SSR request or HMR update
 * cannot mutate another request's extension set.
 */
export function createFrontendExtensions(
	initial: Partial<HiaiDocsFrontendExtensions> = {},
): HiaiDocsFrontendExtensions {
	return {
		sidebarTop: [...(initial.sidebarTop ?? [])],
		sidebarFooterActions: [...(initial.sidebarFooterActions ?? [])],
		navigation: [...(initial.navigation ?? [])],
		dashboardWidgets: [...(initial.dashboardWidgets ?? [])],
		searchWidgets: [...(initial.searchWidgets ?? [])],
		documentTabs: [...(initial.documentTabs ?? [])],
		editorActions: [...(initial.editorActions ?? [])],
		documentMenuActions: [...(initial.documentMenuActions ?? [])],
		settingsSections: [...(initial.settingsSections ?? [])],
		profileActions: [...(initial.profileActions ?? [])],
		commandPaletteActions: [...(initial.commandPaletteActions ?? [])],
		sharedDocumentHeaderActions: [
			...(initial.sharedDocumentHeaderActions ?? []),
		],
		sharedDocumentTabs: [...(initial.sharedDocumentTabs ?? [])],
		sharedDocumentNotesModes: [...(initial.sharedDocumentNotesModes ?? [])],
		sharedDocumentEditorModes: [...(initial.sharedDocumentEditorModes ?? [])],
	};
}

/**
 * Svelte's context storage is scoped to a component tree, which makes this
 * safe for concurrent SSR requests. Do not replace this with a module-level
 * mutable registry.
 */
const [getProvidedFrontendExtensions, setFrontendExtensions] =
	createContext<HiaiDocsFrontendExtensions>();

export { setFrontendExtensions };

/**
 * Read the request-scoped manifest, defaulting to an empty manifest for the
 * standalone open-source application. This keeps every host backward
 * compatible when no extension provider is mounted above it.
 */
export function getFrontendExtensions(): HiaiDocsFrontendExtensions {
	return getProvidedFrontendExtensions() ?? createFrontendExtensions();
}

/** Stable aliases for hosts that prefer the product name in their imports. */
export const getHiaiDocsExtensions = getFrontendExtensions;
export const setHiaiDocsExtensions = setFrontendExtensions;

export function provideFrontendExtensions(
	initial: Partial<HiaiDocsFrontendExtensions> = {},
): HiaiDocsFrontendExtensions {
	const extensions = createFrontendExtensions(initial);
	setFrontendExtensions(extensions);
	return extensions;
}

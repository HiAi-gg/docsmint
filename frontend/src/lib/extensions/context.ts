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
		navigation: [...(initial.navigation ?? [])],
		dashboardWidgets: [...(initial.dashboardWidgets ?? [])],
		documentTabs: [...(initial.documentTabs ?? [])],
		editorActions: [...(initial.editorActions ?? [])],
		documentMenuActions: [...(initial.documentMenuActions ?? [])],
		settingsSections: [...(initial.settingsSections ?? [])],
		commandPaletteActions: [...(initial.commandPaletteActions ?? [])],
	};
}

/**
 * Svelte's context storage is scoped to a component tree, which makes this
 * safe for concurrent SSR requests. Do not replace this with a module-level
 * mutable registry.
 */
export const [getFrontendExtensions, setFrontendExtensions] =
	createContext<HiaiDocsFrontendExtensions>();

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

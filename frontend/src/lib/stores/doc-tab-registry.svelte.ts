/**
 * doc-tab-registry.svelte.ts
 *
 * Lightweight open registry for document-page tabs.
 *
 * hiai-docs ships this file empty - no tabs are registered out of the box.
 * External projects (e.g. hiai-admin, commercial forks) call registerDocTab()
 * from their own +layout.svelte to inject custom tabs alongside the built-in
 * editor without modifying any hiai-docs core files.
 *
 * Usage in an external project's layout:
 *   import { registerDocTab } from "$lib/stores/doc-tab-registry.svelte";
 *   import HtmlRenditionPanel from "./HtmlRenditionPanel.svelte";
 *   registerDocTab({ id: "html-rendition", label: "HTML Preview", component: HtmlRenditionPanel });
 *
 * STABILITY NOTICE:
 * The interfaces `DocTabPanelProps` and `DocTabDefinition` and functions/states
 * `registerDocTab` and `docTabRegistry` are considered stable public APIs.
 * Breaking changes to these will be announced as major version bumps.
 */

import type { DocTabDefinition } from "../extensions/doc-tabs";

export type {
	DocTabDefinition,
	DocTabIcon,
	DocTabPanelProps,
} from "../extensions/doc-tabs";

/**
 * Reactive array of registered doc tabs.
 * Read by the document page to render the tab bar and panels.
 * Mutate only via registerDocTab() to guarantee idempotency.
 */
export const docTabRegistry: DocTabDefinition[] = $state([]);

/**
 * Create an isolated tab collection for a host-provided extension manifest.
 * The legacy `docTabRegistry` export remains available for existing clients,
 * while new app-shell integrations should keep their tabs request-scoped.
 */
export function createDocTabRegistry(
	initial: readonly DocTabDefinition[] = [],
): DocTabDefinition[] {
	return [...initial];
}

/** Register a tab in an isolated collection, preserving idempotency. */
export function registerDocTabIn(
	registry: DocTabDefinition[],
	tab: DocTabDefinition,
): void {
	if (!registry.find((existing) => existing.id === tab.id)) {
		registry.push(tab);
	}
}

/**
 * Register a custom document tab.
 *
 * Safe to call multiple times (e.g. across HMR reloads) - duplicate ids
 * are silently ignored so layout-level registrations do not stack up.
 *
 * @param tab - Tab definition to register.
 */
export function registerDocTab(tab: DocTabDefinition): void {
	registerDocTabIn(docTabRegistry, tab);
}

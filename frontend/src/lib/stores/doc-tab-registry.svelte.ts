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

import type { IconProps } from "lucide-svelte";
import type { Component, ComponentType, SvelteComponent } from "svelte";

export type DocTabIcon = ComponentType<SvelteComponent<IconProps>>;

/**
 * Props passed to every registered tab panel component.
 * Keep this stable - breaking changes here break all registered tabs.
 */
export interface DocTabPanelProps {
	/** The document server-assigned ID */
	documentId: string;
	/** Latest markdown content string */
	content: string;
	/** Latest ProseMirror JSON (undefined when not yet loaded) */
	contentJson: object | undefined;
}

/**
 * Definition of a single registerable document tab.
 */
export interface DocTabDefinition {
	/**
	 * Stable unique identifier for this tab.
	 * Used as the active-tab key and must not change between re-renders.
	 */
	id: string;
	/** Human-readable label shown in the tab button. */
	label: string;
	/**
	 * Svelte component rendered when this tab is active.
	 * It receives DocTabPanelProps as props.
	 */
	component: Component<DocTabPanelProps>;
	/**
	 * Optional sort order. Tabs with smaller values are shown first.
	 * Default is 0.
	 */
	order?: number;
	/**
	 * Optional icon component (e.g. from Lucide-Svelte) rendered next to the tab label.
	 */
	icon?: DocTabIcon;
	/**
	 * Optional flag to disable the tab button (renders greyed out and unclickable).
	 */
	disabled?: boolean;
}

/**
 * Reactive array of registered doc tabs.
 * Read by the document page to render the tab bar and panels.
 * Mutate only via registerDocTab() to guarantee idempotency.
 */
export const docTabRegistry: DocTabDefinition[] = $state([]);

/**
 * Register a custom document tab.
 *
 * Safe to call multiple times (e.g. across HMR reloads) - duplicate ids
 * are silently ignored so layout-level registrations do not stack up.
 *
 * @param tab - Tab definition to register.
 */
export function registerDocTab(tab: DocTabDefinition): void {
	if (!docTabRegistry.find((t) => t.id === tab.id)) {
		docTabRegistry.push(tab);
	}
}

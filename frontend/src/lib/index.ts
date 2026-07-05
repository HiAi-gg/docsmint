/**
 * public entrypoint / barrel file for hiai-docs frontend package
 */

export {
	type DocTabDefinition,
	type DocTabPanelProps,
	docTabRegistry,
	registerDocTab,
} from "./stores/doc-tab-registry.svelte";

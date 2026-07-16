/**
 * Public application hosts.
 *
 * These components preserve the standalone HiAi-Docs routes while allowing a
 * product build to mount typed, additive frontend extensions.
 */

export { default as DocsmintSharedDocumentHost } from "./DocsmintSharedDocumentHost.svelte";
export type { HiaiDocsDashboardData } from "./HiaiDocsDashboardHost.svelte";
/** @deprecated Use DocsmintDashboardHost. */
export {
	default as HiaiDocsDashboardHost,
	default as DocsmintDashboardHost,
} from "./HiaiDocsDashboardHost.svelte";
/** Canonical extension provider. */
export {
	default as HiaiDocsExtensionProvider,
	default as DocsmintExtensionProvider,
} from "./HiaiDocsExtensionProvider.svelte";
export type { HiaiDocsSearchData } from "./HiaiDocsSearchHost.svelte";
/** @deprecated Use DocsmintSearchHost. */
export {
	default as HiaiDocsSearchHost,
	default as DocsmintSearchHost,
} from "./HiaiDocsSearchHost.svelte";

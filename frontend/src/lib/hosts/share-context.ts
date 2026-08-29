import { getContext, setContext } from "svelte";
import type { DocsmintShareAdapter } from "./types";

const SHARE_ADAPTER = Symbol("docsmint-share-adapter");

const standaloneShare: DocsmintShareAdapter = {
	displayMode: "standalone",
};

export function provideDocsmintShareAdapter(
	adapter: DocsmintShareAdapter,
): void {
	setContext(SHARE_ADAPTER, adapter);
}

/**
 * Reads the host share contour. Standalone OSS (no AppShellHost share prop)
 * always gets a public-link dialog.
 */
export function getDocsmintShareAdapter(): DocsmintShareAdapter {
	return getContext<DocsmintShareAdapter>(SHARE_ADAPTER) ?? standaloneShare;
}

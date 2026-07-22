import { getContext, setContext } from "svelte";
import type { DocsmintRequestAdapter } from "./types";

const REQUEST_ADAPTER = Symbol("docsmint-request-adapter");

export function provideDocsmintRequestAdapter(
	adapter: DocsmintRequestAdapter,
): void {
	setContext(REQUEST_ADAPTER, adapter);
}

/** Reads the host transport while retaining standalone browser behaviour. */
export function getDocsmintRequestAdapter(): DocsmintRequestAdapter {
	return getContext<DocsmintRequestAdapter>(REQUEST_ADAPTER) ?? { fetch };
}

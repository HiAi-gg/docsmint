import { getContext, setContext } from "svelte";
import type { DocsmintRealtimeAdapter } from "./types";

const REALTIME_ADAPTER = Symbol("docsmint-realtime-adapter");

export function provideDocsmintRealtimeAdapter(
	adapter: DocsmintRealtimeAdapter,
): void {
	setContext(REALTIME_ADAPTER, adapter);
}

/** Returns an embedded host resolver, when one was provided. */
export function getDocsmintRealtimeAdapter():
	| DocsmintRealtimeAdapter
	| undefined {
	return getContext<DocsmintRealtimeAdapter>(REALTIME_ADAPTER);
}

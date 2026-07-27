// The public stylesheet is the consumer-facing global contract. Keep this
// dependency-free rather than importing the standalone Tailwind application
// stylesheet into an SSR component bundle.
import "../../../frontend/src/lib/styles/layer-contract.css";

export { default as DocsmintAppShellHost } from "../../../frontend/src/lib/hosts/DocsmintAppShellHost.svelte";
export type {
	DocsmintNavigationOptions,
	DocsmintRealtimeAdapter,
	DocsmintRequestAdapter,
	DocsmintRouteAdapter,
} from "../../../frontend/src/lib/hosts/types";
export { getDocsmintRealtimeAdapter } from "../../../frontend/src/lib/hosts/realtime-context";

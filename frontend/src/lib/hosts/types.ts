/**
 * Host-owned route contract for an embedded DocsMint application shell.
 *
 * The adapter keeps product route prefixes (for example `/w/acme`) outside
 * the OSS package. It is data-only and therefore safe to construct per SSR
 * request; callers retain ownership of navigation and request handling.
 */
export interface DocsmintNavigationOptions {
	replaceState?: boolean;
	noScroll?: boolean;
	keepFocus?: boolean;
	invalidateAll?: boolean;
	state?: App.PageState;
}

export interface DocsmintRouteAdapter {
	pathname: string;
	resolve(path: string): string;
	navigate?(
		path: string,
		options?: DocsmintNavigationOptions,
	): void | Promise<void>;
}

/**
 * Request-scoped browser/SSR transport for embedded DocsMint hosts.
 * Consumers can add tenant headers without replacing global window.fetch.
 */
export interface DocsmintRequestAdapter {
	fetch: typeof fetch;
}

export type { DocsmintRealtimeAdapter } from "../realtime";

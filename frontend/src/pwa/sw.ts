/// <reference lib="webworker" />

import { setCacheNameDetails } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { matchPrecache, precacheAndRoute } from "workbox-precaching";
import {
	NavigationRoute,
	registerRoute,
	setCatchHandler,
} from "workbox-routing";
import { CacheFirst, NetworkOnly } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope;

const appId = import.meta.env.VITE_APP_ID ?? "hiai-docs";
const deploymentId =
	import.meta.env.VITE_DEPLOYMENT_ID ?? "hiai-docs-pwa-local";
export const CACHE_PREFIX = `${appId}::${deploymentId}::pwa-v1`;
setCacheNameDetails({ prefix: CACHE_PREFIX });

self.addEventListener("install", () => {
	// A broken previous shell cannot show the in-app update prompt because
	// its JS/CSS already 404. Activate this worker without waiting for
	// every tab to close.
	void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

// Precache shell/static assets injected by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST);

// Never cache authenticated SSR/navigation responses. If the network is down,
// serve the public, data-free offline shell instead.
registerRoute(new NavigationRoute(new NetworkOnly()));

setCatchHandler(async ({ request }) => {
	if (request.mode === "navigate") {
		// `/offline` is a client-only SvelteKit route and therefore has no
		// deterministic HTML artifact to precache. Keep the navigation fallback
		// independent from SSR by serving the data-free static shell that is part
		// of the injected precache manifest.
		return (await matchPrecache("/offline.html")) ?? Response.error();
	}
	return Response.error();
});

// Static assets: CacheFirst
registerRoute(
	({ url }) => url.pathname.startsWith("/_app/immutable/"),
	new CacheFirst({
		cacheName: `${CACHE_PREFIX}::static-assets`,
		plugins: [
			new ExpirationPlugin({
				maxEntries: 200,
				maxAgeSeconds: 30 * 24 * 60 * 60,
			}),
		],
	}),
);

// Private APIs, auth endpoints, mutations and websocket traffic are network-only.
registerRoute(({ url }) => url.pathname.startsWith("/api/"), new NetworkOnly());

// Auth: NEVER cache (A3) — must always hit the network so Better Auth cookies
// and session handling are never intercepted by a stale cached response.
registerRoute(
	({ url }) => url.pathname.startsWith("/api/auth/"),
	new NetworkOnly(),
);

// Static site assets: CacheFirst
registerRoute(
	({ url }) => /\/(favicon|logo|manifest|icon-.*\.png)/.test(url.pathname),
	new CacheFirst({ cacheName: `${CACHE_PREFIX}::static-site` }),
);

// Fonts: CacheFirst
registerRoute(
	({ url }) => url.origin === "https://fonts.gstatic.com",
	new CacheFirst({ cacheName: `${CACHE_PREFIX}::google-fonts` }),
);

// Listen for skip-waiting message from the auto-injected PWA register script
// (registerType: "prompt"). When the user accepts the update, the script sends
// SKIP_WAITING so the new service worker can activate.
self.addEventListener("message", (event) => {
	if (event.data?.type === "SKIP_WAITING") {
		self.skipWaiting();
	} else if (
		event.data?.type === "CLEAR_HOST_CACHES" &&
		event.data.cachePrefix === CACHE_PREFIX
	) {
		event.waitUntil(
			caches
				.keys()
				.then((names) =>
					Promise.all(
						names
							.filter(
								(name) =>
									name.startsWith(`${CACHE_PREFIX}::`) ||
									name.startsWith(`${CACHE_PREFIX}-`),
							)
							.map((name) => caches.delete(name)),
					),
				),
		);
	}
});

// De-localize incoming URLs (e.g. /de/about -> /about) before SvelteKit routes them.
// Required by the paraglide v2 SvelteKit integration even when only the source
// language is configured, so adding more locales is a settings.json change.

import type { Reroute } from "@sveltejs/kit/hooks";
import { deLocalizeUrl } from "#lib/paraglide/runtime.js";

export const reroute: Reroute = (request) => {
	return deLocalizeUrl(request.url).pathname;
};

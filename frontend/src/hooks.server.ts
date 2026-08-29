import type { Handle, HandleServerError } from "@sveltejs/kit";
import { getLocale } from "$lib/paraglide/runtime";

export const handle: Handle = async ({ event, resolve }) => {
	const locale = getLocale();
	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace("%lang%", locale).replace("%dir%", "ltr"),
	});

	// `frame-ancestors` is ignored in a CSP meta element by browsers. It must
	// be delivered as a response header to protect the rendered application.
	response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
	response.headers.set("X-Frame-Options", "DENY");
	// HTML shells must not stick in the browser after a hashed-asset deploy.
	// A cached `/login` document still pointing at `./_app/...` 404s CSS/JS
	// and renders the unstyled page.
	if (response.headers.get("content-type")?.includes("text/html")) {
		response.headers.set("Cache-Control", "no-store");
	}
	return response;
};

export const handleError: HandleServerError = ({ error }) => {
	console.error("DETAILED SERVER ERROR:", error);
	return {
		message: "Internal Error",
	};
};

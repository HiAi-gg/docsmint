import type { ServerLoadEvent } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { hasSessionCookie } from "$lib/server/session-cookie";

export async function load({ params, cookies }: ServerLoadEvent) {
	if (!hasSessionCookie(cookies)) {
		throw redirect(302, "/login");
	}
	return { id: params.id };
}

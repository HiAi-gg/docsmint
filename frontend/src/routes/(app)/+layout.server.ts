import { redirect } from "@sveltejs/kit";
import { hasSessionCookie } from "$lib/server/session-cookie";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ cookies }) => {
	if (!hasSessionCookie(cookies)) throw redirect(302, "/login");
	return {};
};

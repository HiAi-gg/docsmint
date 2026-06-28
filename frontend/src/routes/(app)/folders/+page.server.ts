import type { ServerLoadEvent } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";

export async function load({ cookies }: ServerLoadEvent) {
	const sessionCookie = cookies.get("better-auth.session_token");
	if (!sessionCookie) {
		throw redirect(302, "/login");
	}
	return {};
}

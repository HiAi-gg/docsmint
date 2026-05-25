import { redirect } from "@sveltejs/kit";
import type { ServerLoadEvent } from "@sveltejs/kit";

export async function load({ params, cookies }: ServerLoadEvent) {
  const sessionCookie = cookies.get("better-auth.session_token");
  if (!sessionCookie) {
    throw redirect(302, "/login");
  }
  return { id: params.id };
}

export interface CookieReader {
	get(name: string): string | undefined;
}

export function hasSessionCookie(cookies: CookieReader): boolean {
	return Boolean(
		cookies.get("better-auth.session_token") ??
			cookies.get("__Secure-better-auth.session_token"),
	);
}

import { resolveAuthPrincipal } from "./auth-principal";

/**
 * Extract user ID from request headers.
 * Checks API key first (Bearer token), then falls back to Better Auth session.
 * Returns null if no valid session.
 */
export async function getSessionUserId(
	headers: Headers,
): Promise<string | null> {
	return (await resolveAuthPrincipal(headers))?.userId ?? null;
}

import { resolveAuthPrincipal } from "./auth-principal";

type PrincipalResolver = (
	headers: Headers,
) => Promise<{ userId: string } | null>;

export function createSessionUserIdResolver(
	resolvePrincipal: PrincipalResolver,
) {
	return async (headers: Headers): Promise<string | null> =>
		(await resolvePrincipal(headers))?.userId ?? null;
}

/**
 * Extract user ID from request headers.
 * Checks API key first (Bearer token), then falls back to Better Auth session.
 * Returns null if no valid session.
 */
export const getSessionUserId =
	createSessionUserIdResolver(resolveAuthPrincipal);

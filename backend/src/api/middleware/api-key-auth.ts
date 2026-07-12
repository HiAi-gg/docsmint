import { Elysia } from "elysia";
import { validateApiKey } from "../../lib/api-keys";

/**
 * Elysia middleware that validates API key Bearer tokens.
 *
 * Uses `.derive()` so it doesn't block invalid keys — it falls through
 * to Better Auth session checks. On a valid key it sets `userId` and
 * `authType = 'api-key'` on the context.
 */
export const apiKeyAuthMiddleware = new Elysia().derive(async ({ request }) => {
	const authHeader = request.headers.get("authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return {};
	}

	const key = authHeader.slice(7);
	const result = await validateApiKey(key);
	if (!result) {
		return {};
	}

	return {
		userId: result.ownerId,
		apiKeyId: result.id,
		apiKeyScopes: result.scopes,
		authType: "api-key" as const,
	};
});

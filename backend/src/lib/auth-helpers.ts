import { auth } from "./auth";
import { config } from "./config";

/**
 * Extract user ID from request headers.
 * Checks API key first (Bearer token), then falls back to Better Auth session.
 * Returns null if no valid session.
 */
export async function getSessionUserId(headers: Headers): Promise<string | null> {
  // Check API key first
  const apiKey = config.HIAI_DOCS_API_KEY;
  if (apiKey) {
    const authHeader = headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token === apiKey) {
        return config.OWNER_ID;
      }
    }
  }

  // Fall back to Better Auth session
  const session = await auth.api.getSession({ headers });
  return session?.user?.id ?? null;
}

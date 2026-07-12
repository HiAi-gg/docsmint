import { type ApiKeyScope, validateApiKey } from "./api-keys";
import { auth } from "./auth";
import { config } from "./config";

export type AuthPrincipal =
	| { kind: "session"; userId: string }
	| { kind: "operator"; userId: string }
	| { kind: "api-key"; userId: string; keyId: string; scopes: ApiKeyScope[] };

function bearerToken(headers: Headers): string | null {
	const header = headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice(7);
	return token.length > 0 ? token : null;
}

/** Resolve the credential once without erasing API-key identity or scopes. */
export async function resolveAuthPrincipal(
	headers: Headers,
): Promise<AuthPrincipal | null> {
	const token = bearerToken(headers);
	if (token && config.HIAI_DOCS_API_KEY && token === config.HIAI_DOCS_API_KEY) {
		return { kind: "operator", userId: config.OWNER_ID };
	}
	if (token) {
		try {
			const result = await validateApiKey(token);
			if (result) {
				return {
					kind: "api-key",
					userId: result.ownerId,
					keyId: result.id,
					scopes: result.scopes,
				};
			}
		} catch {
			// An unavailable key store must not bypass normal session resolution.
		}
	}
	const session = await auth.api.getSession({ headers });
	return session?.user?.id
		? { kind: "session", userId: session.user.id }
		: null;
}

/** Key issuance, disclosure, listing, and revocation require a real session. */
export async function resolveBrowserSessionUserId(
	headers: Headers,
): Promise<string | null> {
	const session = await auth.api.getSession({ headers });
	return session?.user?.id ?? null;
}

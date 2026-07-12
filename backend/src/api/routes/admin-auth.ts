import { config } from "../../lib/config";

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("authorization")?.trim();
	if (!authorization) return null;

	const match = /^Bearer\s+(.+)$/i.exec(authorization);
	return match?.[1]?.trim() || null;
}

/** Authenticate operator routes through either documented header form. */
export function verifyAdminKey(request: Request): boolean {
	const expected = config.HIAI_DOCS_API_KEY;
	if (!expected) return false;

	const headerKey = request.headers.get("x-api-key")?.trim();
	return headerKey === expected || bearerToken(request) === expected;
}

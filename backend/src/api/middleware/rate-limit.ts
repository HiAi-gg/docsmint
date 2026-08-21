import { config } from "../../lib/config";
import {
	createRateLimiter as createRateLimiterFromLib,
	type RateLimitConfig,
} from "../../lib/rate-limit-factory";

function _getClientIp(request: Request): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown"
	);
}

export function isInternalRequest(
	request?: Request,
	expected = config.HIAI_DOCS_API_KEY,
): boolean {
	if (!request) return false;
	if (!expected) return false;
	const headerKey = request.headers.get("x-api-key")?.trim();
	const bearer = /^Bearer\s+(.+)$/i
		.exec(request.headers.get("authorization")?.trim() ?? "")?.[1]
		?.trim();
	return headerKey === expected || bearer === expected;
}

export type { RateLimitConfig } from "../../lib/rate-limit-factory";
// Re-export factory from lib
export { createRateLimiterFromLib as createRateLimiter };

// Bypass wrapper — adds internal-request skip over the pure lib factory
function _limiterWithBypass(config: RateLimitConfig) {
	const base = createRateLimiterFromLib(config);
	return async (ip: string, request?: Request) => {
		if (request && isInternalRequest(request)) {
			return { allowed: true, remaining: 999 };
		}
		return base(ip);
	};
}

export const searchRateLimiter = _limiterWithBypass({
	windowSec: 60,
	max: 20,
	keyPrefix: "search",
});
// Document rate limiter covers both reads (listDocuments, getDocument) and
// document-level write operations. The sidebar mounts two listDocuments
// callers (RecentDocs with limit=6, FolderTree with limit=100) and the
// dashboard makes its own listDocuments call (limit=6) — three
// concurrent fetches at cold load. Threshold raised to 1000/60s so a
// normal session can issue reads from the sidebar plus a generous pool
// of writes per minute without tripping 429s. The shareRateLimiter /
// writeRateLimiter still gate the truly expensive write paths
// separately.
//
// Combined with client-side request deduplication in
// `frontend/src/lib/api/documents.ts`, identical concurrent calls (e.g.
// RecentDocs and Dashboard both ask for limit=6 with no tag) collapse to
// a single network request, so this 1000/60s budget is more than enough
// for any realistic session burst.
export const documentRateLimiter = _limiterWithBypass({
	windowSec: 60,
	max: 1000,
	keyPrefix: "docs",
});
export const writeRateLimiter = _limiterWithBypass({
	windowSec: 60,
	max: 60,
	keyPrefix: "write",
});
export const shareRateLimiter = _limiterWithBypass({
	windowSec: 60,
	max: 5,
	keyPrefix: "share",
});
export const healthRateLimiter = _limiterWithBypass({
	windowSec: 60,
	max: 120,
	keyPrefix: "health",
});

export function rateLimitHeaders(remaining: number, retryAfter?: number) {
	const headers: Record<string, string> = {
		"X-RateLimit-Remaining": String(remaining),
	};
	if (retryAfter) {
		headers["Retry-After"] = String(retryAfter);
	}
	return headers;
}

import { APIError } from "better-auth";
import { Elysia } from "elysia";
import {
	accountPurgeFencedResponse,
	isAccountPurgeFenced,
	isAccountPurgeFencedError,
} from "../../lib/account-purge-fence";
import { auth } from "../../lib/auth";

// Rate limiting for auth endpoints (5 attempts per minute per IP)
const authRateLimit = new Map<string, { count: number; resetAt: number }>();
const AUTH_RATE_MAX = 5;
const AUTH_RATE_WINDOW = 60_000;
const FENCE_PREFLIGHT_PATHS = new Set(["/update-user", "/change-email"]);

// Cleanup stale entries every 5 minutes
const authRateLimitCleanup = setInterval(() => {
	const now = Date.now();
	for (const [key, value] of authRateLimit.entries()) {
		if (now > value.resetAt) authRateLimit.delete(key);
	}
}, 300_000);
authRateLimitCleanup.unref?.();

function checkAuthRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = authRateLimit.get(ip);
	if (!entry || now > entry.resetAt) {
		authRateLimit.set(ip, { count: 1, resetAt: now + AUTH_RATE_WINDOW });
		return true;
	}
	if (entry.count >= AUTH_RATE_MAX) return false;
	entry.count++;
	return true;
}

export const authRoutes = new Elysia({ prefix: "/api/auth" }).all(
	"/*",
	async ({ request, set }) => {
		// Rate limit sign-in/sign-up attempts
		const url = new URL(request.url);
		if (
			url.pathname.includes("/sign-in") ||
			url.pathname.includes("/sign-up") ||
			url.pathname.includes("/login")
		) {
			const ip =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"unknown";
			if (!checkAuthRateLimit(ip)) {
				set.status = 429;
				return { error: "Too many login attempts. Try again later." };
			}
		}

		// Delegate all /api/auth/* requests to Better Auth's handler.
		try {
			if (FENCE_PREFLIGHT_PATHS.has(url.pathname.replace("/api/auth", ""))) {
				const session = await auth.api.getSession({ headers: request.headers });
				if (session?.user.id && (await isAccountPurgeFenced(session.user.id))) {
					set.status = 409;
					return accountPurgeFencedResponse();
				}
			}
			return await auth.handler(request);
		} catch (error) {
			if (isAccountPurgeFencedError(error)) {
				set.status = 409;
				return accountPurgeFencedResponse();
			}
			if (error instanceof APIError) {
				const headers = new Headers(error.headers);
				headers.set("content-type", "application/json");
				return new Response(JSON.stringify(error.body), {
					status: error.statusCode,
					headers,
				});
			}
			throw error;
		}
	},
);

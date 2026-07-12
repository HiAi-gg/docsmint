import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { config } from "../../lib/config";

const CSRF_SECRET = config.CSRF_SECRET;
const CSRF_COOKIE = "hiai-csrf";
const CSRF_HEADER = "x-csrf-token";
const CSRF_MAX_AGE = 3600;

function signToken(token: string): string {
	return createHmac("sha256", CSRF_SECRET).update(token).digest("hex");
}

function generateToken(): string {
	const token = randomBytes(32).toString("hex");
	return `${token}.${signToken(token)}`;
}

function verifyToken(token: string): boolean {
	const [value, signature] = token.split(".");
	if (!value || !signature) return false;
	const expected = signToken(value);
	try {
		return timingSafeEqual(
			Buffer.from(signature, "hex"),
			Buffer.from(expected, "hex"),
		);
	} catch {
		return false;
	}
}

function isUnsafeMethod(method: string): boolean {
	return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

function isApiRoute(url: string): boolean {
	if (!url.startsWith("/api/")) return false;
	if (url.startsWith("/api/auth")) return false;
	if (url.startsWith("/api/webhooks")) return false;
	if (url.startsWith("/api/csrf-token")) return false;
	return true;
}

function isMultipart(request: Request): boolean {
	return (
		request.headers.get("content-type")?.includes("multipart/form-data") ===
		true
	);
}

export function isAllowedCsrfOrigin(
	origin: string,
	host: string,
	allowedOrigins: readonly string[],
	nodeEnv: string,
): boolean {
	const originUrl = new URL(origin);
	const normalized = allowedOrigins
		.map((value) => value.trim())
		.filter(Boolean);
	return nodeEnv === "production" && normalized.length === 0
		? originUrl.host === host
		: normalized.includes(originUrl.origin);
}

export const csrfMiddleware = new Elysia()
	.onRequest(({ request, set }) => {
		const url = new URL(request.url);

		if (!isApiRoute(url.pathname)) return;

		const apiKey = request.headers.get("authorization")?.startsWith("Bearer ");
		if (apiKey) return;

		if (!isUnsafeMethod(request.method)) return;
		if (isMultipart(request)) return;

		const origin = request.headers.get("origin");
		const host = request.headers.get("host");
		if (origin && host) {
			try {
				const configuredOrigins =
					config.CORS_ORIGINS?.split(",").filter(Boolean) ?? [];
				const allowedOrigins = configuredOrigins.length
					? configuredOrigins
					: [
							`http://localhost:${config.WEB_PORT}`,
							`http://127.0.0.1:${config.WEB_PORT}`,
						];
				const isAllowed = isAllowedCsrfOrigin(
					origin,
					host,
					allowedOrigins,
					config.NODE_ENV,
				);
				if (!isAllowed) {
					set.status = 403;
					return { error: "CSRF: origin mismatch" };
				}
			} catch {
				set.status = 403;
				return { error: "CSRF: invalid origin" };
			}
		}

		const token = request.headers.get(CSRF_HEADER);
		if (!token || !verifyToken(token)) {
			set.status = 403;
			return { error: "CSRF: invalid or missing token" };
		}
	})
	.get("/api/csrf-token", ({ set }) => {
		const token = generateToken();
		const maxAge = CSRF_MAX_AGE;
		set.headers["Set-Cookie"] =
			`${CSRF_COOKIE}=${token}; Path=/; HttpOnly=false; SameSite=Strict; Max-Age=${maxAge}${config.NODE_ENV === "production" ? "; Secure" : ""}`;
		return { token };
	});

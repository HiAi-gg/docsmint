import { Elysia } from "elysia";
import { auth } from "../../lib/auth";

// Rate limiting for auth endpoints (5 attempts per minute per IP)
const authRateLimit = new Map<string, { count: number; resetAt: number }>();
const AUTH_RATE_MAX = 5;
const AUTH_RATE_WINDOW = 60_000;

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of authRateLimit.entries()) {
    if (now > value.resetAt) authRateLimit.delete(key);
  }
}, 300_000);

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

export const authRoutes = new Elysia({ prefix: "/api/auth" })
  .all("/*", async ({ request, set }) => {
    // Rate limit sign-in/sign-up attempts
    const url = new URL(request.url);
    if (url.pathname.includes("/sign-in") || url.pathname.includes("/sign-up") || url.pathname.includes("/login")) {
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        ?? request.headers.get("x-real-ip")
        ?? "unknown";
      if (!checkAuthRateLimit(ip)) {
        set.status = 429;
        return { error: "Too many login attempts. Try again later." };
      }
    }

    // Delegate all /api/auth/* requests to Better Auth's handler
    return auth.handler(request);
  });

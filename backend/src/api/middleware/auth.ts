import { Elysia } from "elysia";
import { auth } from "../../lib/auth";
import { config } from "../../lib/config";

export const authMiddleware = new Elysia()
  .derive(async ({ request }) => {
    // API key check: if HIAI_DOCS_API_KEY is set and request has matching Bearer token,
    // return a synthetic session (no DB lookup needed)
    const apiKey = config.HIAI_DOCS_API_KEY;
    if (apiKey) {
      const authHeader = request.headers.get("authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        if (token === apiKey) {
          const session = {
            session: {
              id: "api-key-session",
              userId: config.OWNER_ID,
              expiresAt: new Date(Date.now() + 60 * 60 * 24 * 365 * 10), // 10 years
              token: "api-key",
              ipAddress: "",
              userAgent: "",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            user: {
              id: config.OWNER_ID,
              name: "API Key User",
              email: `${config.OWNER_ID}@hiai-docs.local`,
              emailVerified: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
          return { session };
        }
      }
    }

    // Fall through to Better Auth session check
    const session = await auth.api.getSession({
      headers: request.headers,
    });
    return { session };
  })
  .macro({
    auth: {
      async resolve({ session, set }) {
        if (!session) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        return { user: session.user };
      },
    },
  });

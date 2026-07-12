/**
 * Operator/admin metrics endpoint.
 *
 * Exposes the in-process metrics registry to operators (and external
 * agents like hiai-bob / hiai-amigo) so they can observe embedding
 * pipeline health without scraping logs.
 *
 *   GET /api/admin/metrics
 *
 * Auth: API key only. The endpoint is intentionally separate from the
 * Better Auth session flow — metrics are operator infrastructure, not a
 * user-facing API surface. Requests must carry `x-api-key` or
 * `Authorization: Bearer <key>` matching `config.HIAI_DOCS_API_KEY`.
 * Missing key → 401; wrong key →
 * 401 (we don't distinguish to avoid oracle leakage).
 *
 * Rate limiting: shares the `searchRateLimiter` bucket — same operational
 * tier as read-heavy endpoints that external agents may poll.
 */

import { Elysia } from "elysia";
import { logger } from "../../lib/logger";
import {
	getEmbeddingStateInventory,
	getMetrics,
	getPipelineMetrics,
} from "../../lib/metrics";
import { rateLimitHeaders, searchRateLimiter } from "../middleware/rate-limit";
import { verifyAdminKey } from "./admin-auth";

/**
 * Apply the same rate-limit policy used by search/graph endpoints. Returns
 * either `null` (allowed) or a pre-built response object the handler
 * should return immediately.
 */
async function applyRateLimit(
	request: Request,
	set: { status?: number; headers: Record<string, string> },
): Promise<null | { error: string; status?: number }> {
	const ip =
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown";
	const rl = await searchRateLimiter(ip, request);
	if (!rl.allowed) {
		set.status = 429;
		set.headers = rateLimitHeaders(0, rl.retryAfter);
		return { error: "Too many requests" };
	}
	set.headers = rateLimitHeaders(rl.remaining);
	return null;
}

export const metricsRoutes = new Elysia({ prefix: "/api/admin" }).get(
	"/metrics",
	async ({ request, set }) => {
		const rl = await applyRateLimit(request, set as never);
		if (rl) return rl;

		if (!verifyAdminKey(request)) {
			set.status = 401;
			return { error: "Unauthorized" };
		}

		try {
			return {
				metrics: getMetrics({ includeReserved: true }),
				pipelineMetrics: getPipelineMetrics(),
				embeddingStateInventory: getEmbeddingStateInventory(),
				uptime: process.uptime(),
			};
		} catch (err) {
			// Defensive: getMetrics() never throws today, but a future
			// implementation that touches IO could. Log + 500 keeps the
			// endpoint predictable for callers.
			logger.error({ err }, "Metrics snapshot failed");
			set.status = 500;
			return { error: "Metrics unavailable" };
		}
	},
	{
		detail: {
			tags: ["Admin"],
			summary: "Process-local embedding metrics snapshot",
			description:
				"Returns the current counter values and the raw duration histogram samples from the in-process metrics registry. Authenticated via `x-api-key` or `Authorization: Bearer <key>`.",
		},
	},
);

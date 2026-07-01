import type { z } from "zod";
import { envSchema } from "./config-schema";
import { logger } from "./logger";

let config: z.infer<typeof envSchema>;
try {
	config = envSchema.parse(process.env);
} catch (err) {
	logger.error({ err }, "FATAL: Invalid environment configuration");
	process.exit(1);
}

if (config.NODE_ENV !== "production") {
	if (!process.env.CSRF_SECRET) {
		logger.warn(
			"[config] CSRF_SECRET is not set — using insecure dev fallback. " +
				"Set CSRF_SECRET in .env for any non-development environment.",
		);
	}
	if (!process.env.WEBHOOK_SECRET) {
		logger.warn(
			"[config] WEBHOOK_SECRET is not set — using insecure dev fallback. " +
				"Set WEBHOOK_SECRET in .env for any non-development environment.",
		);
	}
}

export { config };

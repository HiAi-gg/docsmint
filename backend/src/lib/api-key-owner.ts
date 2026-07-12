import { users } from "@hiai-docs/db/schema";
import { config } from "./config";
import { db } from "./db";
import { logger } from "./logger";

/** Ensure the synthetic API-key principal satisfies document owner FKs. */
export async function ensureApiKeyOwner(): Promise<void> {
	if (!config.HIAI_DOCS_API_KEY) return;
	await db
		.insert(users)
		.values({
			id: config.OWNER_ID,
			email: `${config.OWNER_ID}@api.hiai-docs.local`,
			name: "hiai-docs API",
			emailVerified: true,
		})
		.onConflictDoNothing({ target: users.id });
	logger.info({ ownerId: config.OWNER_ID }, "API-key owner is ready");
}

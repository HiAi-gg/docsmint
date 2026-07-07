import { Elysia } from "elysia";
import { logger } from "../../lib/logger";
import { verifyWebhookSignature } from "../middleware/webhook-verify";

/**
 * DEPRECATED: MinIO webhook receiver.
 * SeaweedFS does not support MinIO-compatible bucket event notifications.
 * This route is kept as a no-op stub for API compatibility.
 * Will be removed in the next major release.
 */
export const webhookRoutes = new Elysia({ prefix: "/api/webhooks" }).post(
	"/storage",
	async ({ request }) => {
		const rawBody = await request.text();
		const sig = request.headers.get("x-storage-signature");

		if (!verifyWebhookSignature(rawBody, sig)) {
			logger.warn("Invalid storage webhook signature");
			return { error: "Invalid signature" };
		}

		const event = JSON.parse(rawBody) as Record<string, unknown>;
		const records = (event.Records ?? []) as Array<Record<string, unknown>>;

		for (const record of records) {
			const eventName = record.eventName as string;
			const s3 = record.s3 as Record<string, unknown> | undefined;
			const key = (s3?.object as Record<string, unknown>)?.key as string;

			if (!key) continue;

			logger.info(
				{ eventName, key },
				"Storage webhook event (no-op: SeaweedFS)",
			);

			if (eventName === "s3:ObjectRemoved:Delete") {
				// SeaweedFS S3 Gateway does not emit MinIO-compatible bucket
				// notifications. This path is a no-op stub for API compatibility.
				logger.info(
					{ key },
					"Object removal notification ignored — SeaweedFS does not emit bucket notifications",
				);
			}
		}

		return { received: true };
	},
);

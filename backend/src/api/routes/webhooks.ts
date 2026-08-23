import { Elysia } from "elysia";
import { logger } from "../../lib/logger";
import { verifyWebhookSignature } from "../middleware/webhook-verify";

const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

class WebhookBodyTooLargeError extends Error {}

async function readWebhookBody(request: Request): Promise<string> {
	const contentLength = request.headers.get("content-length");
	if (
		contentLength !== null &&
		Number.isFinite(Number(contentLength)) &&
		Number(contentLength) > WEBHOOK_MAX_BODY_BYTES
	) {
		throw new WebhookBodyTooLargeError();
	}
	if (!request.body) return "";

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		bytesRead += value.byteLength;
		if (bytesRead > WEBHOOK_MAX_BODY_BYTES) {
			await reader.cancel();
			throw new WebhookBodyTooLargeError();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * DEPRECATED: MinIO webhook receiver.
 * SeaweedFS does not support MinIO-compatible bucket event notifications.
 * This route is kept as a no-op stub for API compatibility.
 * Will be removed in the next major release.
 */
export const webhookRoutes = new Elysia({ prefix: "/api/webhooks" }).post(
	"/storage",
	async ({ request, set }) => {
		let rawBody: string;
		try {
			rawBody = await readWebhookBody(request);
		} catch (error) {
			if (error instanceof WebhookBodyTooLargeError) {
				set.status = 413;
				return { error: "Webhook body too large (max 1MB)" };
			}
			throw error;
		}
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

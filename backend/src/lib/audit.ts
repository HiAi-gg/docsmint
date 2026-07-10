import { auditLog } from "@hiai-docs/db/schema";
import { withTenant } from "@hiai-docs/db/with-tenant";
import { logger } from "./logger";

export async function recordAuditEvent(params: {
	actorId: string;
	action: string;
	resourceType: string;
	resourceId?: string;
	details?: Record<string, unknown>;
	ipAddress?: string;
	userAgent?: string;
}): Promise<void> {
	try {
		await withTenant({ userId: params.actorId, role: "user" }, async (tx) => {
			await tx.insert(auditLog).values({
				actorId: params.actorId,
				action: params.action,
				resourceType: params.resourceType,
				resourceId: params.resourceId ?? null,
				details: params.details ?? {},
				ipAddress: params.ipAddress ?? null,
				userAgent: params.userAgent ?? null,
			});
		});
	} catch (err) {
		logger.warn({ err }, "Failed to record audit event");
	}
}

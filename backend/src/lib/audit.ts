import { auditLog } from "@hiai-docs/db/schema";
import { withTenant } from "@hiai-docs/db/with-tenant";
import { logger } from "./logger";

export interface AuditEvent {
	actorId: string;
	action: string;
	resourceType: string;
	resourceId?: string;
	details?: Record<string, unknown>;
	ipAddress?: string;
	userAgent?: string;
}

type AuditInsertValues = typeof auditLog.$inferInsert;
interface AuditTransaction {
	insert: (table: typeof auditLog) => {
		values: (values: AuditInsertValues) => Promise<unknown>;
	};
}

interface AuditRecorderDependencies {
	runWithTenant: (
		context: { userId: string; role: "user" },
		operation: (tx: AuditTransaction) => Promise<void>,
	) => Promise<void>;
	warn: (fields: { err: unknown }, message: string) => void;
}

export function createAuditRecorder(dependencies: AuditRecorderDependencies) {
	return async (params: AuditEvent): Promise<void> => {
		try {
			await dependencies.runWithTenant(
				{ userId: params.actorId, role: "user" },
				async (tx) => {
					await tx.insert(auditLog).values({
						actorId: params.actorId,
						action: params.action,
						resourceType: params.resourceType,
						resourceId: params.resourceId ?? null,
						details: params.details ?? {},
						ipAddress: params.ipAddress ?? null,
						userAgent: params.userAgent ?? null,
					});
				},
			);
		} catch (err) {
			dependencies.warn({ err }, "Failed to record audit event");
		}
	};
}

export const recordAuditEvent = createAuditRecorder({
	runWithTenant: (context, operation) =>
		withTenant(context, (tx) => operation(tx as unknown as AuditTransaction)),
	warn: (fields, message) => logger.warn(fields, message),
});

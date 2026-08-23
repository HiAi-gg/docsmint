import { describe, expect, test } from "bun:test";
import { auditLog } from "@hiai-docs/db/schema";
import { createAuditRecorder } from "../lib/audit";

const event = {
	actorId: "00000000-0000-4000-8000-000000000001",
	action: "document.update",
	resourceType: "document",
	resourceId: "00000000-0000-4000-8000-000000000002",
	details: { source: "unit-test" },
	ipAddress: "127.0.0.1",
	userAgent: "DocsMint test",
};

describe("audit", () => {
	test("inserts the complete audit event through the injected tenant runner", async () => {
		let tenantContext: unknown;
		let insertedTable: unknown;
		let insertedValues: unknown;
		const record = createAuditRecorder({
			runWithTenant: async (context, operation) => {
				tenantContext = context;
				await operation({
					insert: (table) => {
						insertedTable = table;
						return {
							values: async (values) => {
								insertedValues = values;
							},
						};
					},
				});
			},
			warn: () => {
				throw new Error("successful inserts must not warn");
			},
		});

		await record(event);

		expect(tenantContext).toEqual({ userId: event.actorId, role: "user" });
		expect(insertedTable).toBe(auditLog);
		expect(insertedValues).toEqual(event);
	});

	test("swallows adapter failures and emits one structured warning", async () => {
		const failure = new Error("database unavailable");
		const warnings: Array<{ fields: unknown; message: string }> = [];
		const record = createAuditRecorder({
			runWithTenant: async () => {
				throw failure;
			},
			warn: (fields, message) => warnings.push({ fields, message }),
		});

		await expect(record(event)).resolves.toBeUndefined();
		expect(warnings).toEqual([
			{ fields: { err: failure }, message: "Failed to record audit event" },
		]);
	});
});

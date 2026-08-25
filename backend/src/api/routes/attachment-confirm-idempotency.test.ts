import { describe, expect, test } from "bun:test";

const routeSource = await Bun.file(
	new URL("./attachments.ts", import.meta.url),
).text();
const migrationSource = await Bun.file(
	new URL(
		"../../../../packages/db/src/migrations/0040_attachment_confirm_idempotency.sql",
		import.meta.url,
	),
).text();

describe("attachment confirm idempotency contract", () => {
	test("returns the committed row when the durable admission was already consumed", () => {
		const existingLookup = routeSource.indexOf("if (!claimed)");
		const headLookup = routeSource.indexOf("new HeadObjectCommand");
		expect(existingLookup).toBeGreaterThan(-1);
		expect(headLookup).toBeGreaterThan(existingLookup);
		expect(routeSource).toContain("eq(attachments.storageKey, key)");
	});

	test("serializes concurrent confirms and returns the winning row", () => {
		expect(routeSource).toContain(
			"pg_advisory_xact_lock(hashtextextended(\u0024{key}, 0))",
		);
		expect(routeSource).toContain("let result = raced");
		expect(routeSource).toContain(
			".onConflictDoNothing({ target: attachments.storageKey })",
		);
		expect(routeSource).toContain(".delete(pendingAttachmentUploads)");
	});

	test("adds only a non-destructive unique index migration", () => {
		expect(migrationSource).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
		expect(migrationSource).not.toContain("DELETE FROM");
	});
});

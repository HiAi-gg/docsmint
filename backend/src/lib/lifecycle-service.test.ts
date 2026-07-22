import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	createPersistentLifecycleRuntime,
	LifecycleLeaseLostError,
	lifecycleTombstoneEmail,
	requireLeaseWrite,
} from "./lifecycle-service";

const context = {
	actorUserId: "018f37c8-6b15-7b9e-8c44-9e4a86cf1161",
	requestId: "request-lifecycle-runtime",
	idempotencyKey: "lifecycle-runtime-gate",
	reason: "account_deletion" as const,
};

test("persistent lifecycle runtime fails closed before any OSS mutation when the host fence rejects", async () => {
	let runtimeCalled = false;
	const lifecycle = createPersistentLifecycleRuntime({
		database: {
			async withActorTransaction() {
				throw new Error("Database must not be reached before the host gate");
			},
		},
		runtime: {
			async verifyPurgeFence() {
				runtimeCalled = true;
			},
			async deleteObjects() {
				runtimeCalled = true;
				return 0;
			},
			async cancelAccountJobs() {
				runtimeCalled = true;
				return 0;
			},
			async clearAccountRedisState() {
				runtimeCalled = true;
				return 0;
			},
			async removeCollaborationState() {
				runtimeCalled = true;
				return 0;
			},
			async removeGraphState() {
				runtimeCalled = true;
				return 0;
			},
		},
		async assertPurgeAllowed() {
			throw new Error("final_owner");
		},
	});

	await expect(lifecycle.purgeUserData(context)).rejects.toThrow("final_owner");
	expect(runtimeCalled).toBe(false);
});

test("lease-fenced writes fail closed when a concurrent worker wins", () => {
	expect(() => requireLeaseWrite([])).toThrow(LifecycleLeaseLostError);
	expect(() =>
		requireLeaseWrite([{ id: "operation-1" }, { id: "operation-2" }]),
	).toThrow(LifecycleLeaseLostError);
	expect(() => requireLeaseWrite([{ id: "operation-1" }])).not.toThrow();
});

test("canonical OSS account lifecycle owns profile resources, auth cleanup, and tombstone ordering", async () => {
	const source = await readFile(
		new URL("./lifecycle-service.ts", import.meta.url),
		"utf8",
	);
	for (const exportDomain of [
		'domain: "account"',
		'domain: "folders"',
		'domain: "tags"',
		'domain: "categories"',
	]) {
		expect(source).toContain(exportDomain);
	}
	const orderedSteps = [
		'"delete_attachment_objects"',
		'"remove_attachment_rows"',
		'"remove_subject_documents"',
		'"remove_auth_sessions"',
		'"remove_auth_accounts"',
		'"tombstone_subject_user"',
		'"write_deletion_audit"',
	];
	for (const [index, step] of orderedSteps.entries()) {
		if (index === 0) continue;
		const previous = orderedSteps[index - 1];
		if (!previous) throw new Error("Missing previous lifecycle step");
		expect(source.indexOf(step)).toBeGreaterThan(source.indexOf(previous));
	}
	expect(source).not.toContain("accessToken: account.accessToken");
	expect(source).not.toContain("refreshToken: account.refreshToken");
	expect(source).not.toContain("password: account.password");
});

test("OSS tombstone matches the cross-runtime durable admission marker", () => {
	const tombstone = lifecycleTombstoneEmail(context.actorUserId);
	expect(tombstone).toMatch(/^deleted-[a-f0-9]{64}@invalid\.local$/);
	expect(tombstone).toBe(lifecycleTombstoneEmail(context.actorUserId));
	expect(tombstone).not.toContain(context.actorUserId);
});

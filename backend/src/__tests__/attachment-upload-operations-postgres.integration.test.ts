import { expect, test } from "bun:test";
import postgres from "postgres";

const ownerUrl = Bun.env.CONTENT_ACCESS_TEST_DATABASE_URL;
const runtimeUrl = Bun.env.DATABASE_URL;

test.skipIf(!ownerUrl || !runtimeUrl)(
	"upload operation RLS and concurrent retry identity under runtime role",
	async () => {
		const owner = postgres(ownerUrl!, { max: 1, onnotice: () => {} });
		const runtime = postgres(runtimeUrl!, { max: 4, onnotice: () => {} });
		const actor = crypto.randomUUID();
		const other = crypto.randomUUID();
		const document = crypto.randomUUID();
		const operation = crypto.randomUUID();
		const workspace = `personal:${actor}`;
		const digest = "a".repeat(64);
		try {
			const [role] =
				await runtime`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
			if (!role) throw new Error("Runtime role missing");
			expect(role.rolsuper).toBe(false);
			expect(role.rolbypassrls).toBe(false);
			await owner`INSERT INTO users (id, email) VALUES (${actor}::uuid, ${actor + "@upload.invalid"}), (${other}::uuid, ${other + "@upload.invalid"})`;
			await owner`INSERT INTO documents (id, owner_id, title, content) VALUES (${document}::uuid, ${actor}::uuid, 'Synthetic upload operation', '')`;
			const attempt = () =>
				runtime.begin(async (tx) => {
					await tx`SELECT set_config('app.current_user_id', ${actor}, true), set_config('app.current_workspace_id', '', true)`;
					await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([workspace, actor, document, "same-upload"])}, 0))`;
					const [existing] =
						await tx`SELECT id FROM attachment_upload_operations WHERE workspace_id = ${workspace} AND actor_user_id = ${actor}::uuid AND document_id = ${document}::uuid AND idempotency_key = 'same-upload'`;
					if (existing) return existing.id;
					await tx`INSERT INTO attachment_upload_operations (id, workspace_id, actor_user_id, document_id, idempotency_key, request_fingerprint, source_sha256, storage_key, expires_at)
        VALUES (${operation}::uuid, ${workspace}, ${actor}::uuid, ${document}::uuid, 'same-upload', ${digest}, ${digest}, ${"synthetic/" + operation}, now() + interval '10 minutes')`;
					return operation;
				});
			expect(await Promise.all([attempt(), attempt(), attempt()])).toEqual([
				operation,
				operation,
				operation,
			]);
			for (const [userId, workspaceId] of [
				[other, ""],
				[actor, crypto.randomUUID()],
			]) {
				const rows = await runtime.begin(async (tx) => {
					await tx`SELECT set_config('app.current_user_id', ${userId!}, true), set_config('app.current_workspace_id', ${workspaceId!}, true)`;
					return tx`SELECT id FROM attachment_upload_operations WHERE id = ${operation}::uuid`;
				});
				expect(rows).toHaveLength(0);
			}
			await expect(
				runtime.begin(async (tx) => {
					await tx`SELECT set_config('app.current_user_id', ${other}, true), set_config('app.current_workspace_id', '', true)`;
					return tx`INSERT INTO attachment_upload_operations (workspace_id, actor_user_id, document_id, idempotency_key, request_fingerprint, source_sha256, storage_key, expires_at)
        VALUES (${workspace}, ${actor}::uuid, ${document}::uuid, 'forged-upload', ${digest}, ${digest}, ${"forged/" + operation}, now() + interval '10 minutes')`;
				}),
			).rejects.toMatchObject({ code: "42501" });
			const [count] =
				await owner`SELECT count(*)::int AS count FROM attachment_upload_operations WHERE document_id = ${document}::uuid`;
			if (!count) throw new Error("Operation count missing");
			expect(count.count).toBe(1);
		} finally {
			await owner`DELETE FROM users WHERE id IN (${actor}::uuid, ${other}::uuid)`;
			await Promise.all([owner.end(), runtime.end()]);
		}
	},
);

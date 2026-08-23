import { describe, expect, it } from "bun:test";
import postgres from "postgres";
import { requireIntegrationUrl } from "./integration-env";

const databaseUrl = requireIntegrationUrl("LIFECYCLE_TEST_DATABASE_URL");

describe("lifecycle operation persistence integration", () => {
	it("enforces idempotency, lease ownership, terminal immutability, and owner RLS as hiai_app", async () => {
		const sql = postgres(databaseUrl, { max: 1 });
		const actorA = crypto.randomUUID();
		const actorB = crypto.randomUUID();
		const actorDeleted = crypto.randomUUID();
		const operationA = crypto.randomUUID();
		const operationB = crypto.randomUUID();
		const deletedOperation = crypto.randomUUID();

		try {
			await sql
				.begin(async (tx) => {
					await tx`INSERT INTO public.users (id, email) VALUES
							(${actorA}::uuid, ${`${actorA}@lifecycle.invalid`}),
							(${actorB}::uuid, ${`${actorB}@lifecycle.invalid`}),
							(${actorDeleted}::uuid, ${`${actorDeleted}@lifecycle.invalid`})`;
					await tx`INSERT INTO public.lifecycle_operations
							(id, actor_user_id, actor_subject_hash, idempotency_key, operation_kind)
							VALUES
							(${operationA}::uuid, ${actorA}::uuid, encode(digest(${actorA}, 'sha256'), 'hex'), 'same-key', 'purge'),
							(${operationB}::uuid, ${actorB}::uuid, encode(digest(${actorB}, 'sha256'), 'hex'), 'same-key', 'purge'),
							(${deletedOperation}::uuid, ${actorDeleted}::uuid, encode(digest(${actorDeleted}, 'sha256'), 'hex'), 'delete-key', 'purge')`;

					let uniqueRejected = false;
					await tx
						.savepoint(async (savepoint) => {
							await savepoint`INSERT INTO public.lifecycle_operations
									(actor_user_id, actor_subject_hash, idempotency_key, operation_kind)
									VALUES (${actorA}::uuid, encode(digest(${actorA}, 'sha256'), 'hex'), 'same-key', 'purge')`;
						})
						.catch(() => {
							uniqueRejected = true;
						});
					expect(uniqueRejected).toBe(true);

					const firstLease = await tx`UPDATE public.lifecycle_operations
							SET status = 'running', lease_owner = 'worker-a',
								lease_expires_at = now() + interval '30 seconds'
							WHERE id = ${operationA}::uuid
								AND status = 'pending'
							RETURNING lease_owner`;
					expect(firstLease).toHaveLength(1);
					const competingLease = await tx`UPDATE public.lifecycle_operations
							SET lease_owner = 'worker-b'
							WHERE id = ${operationA}::uuid
								AND (status IN ('pending', 'retryable') OR lease_expires_at < now())
							RETURNING lease_owner`;
					expect(competingLease).toHaveLength(0);

					await tx`UPDATE public.lifecycle_operations
							SET lease_expires_at = now() - interval '1 second'
							WHERE id = ${operationA}::uuid`;
					const reclaimed = await tx`UPDATE public.lifecycle_operations
							SET lease_owner = 'worker-b', lease_expires_at = now() + interval '30 seconds'
							WHERE id = ${operationA}::uuid AND lease_expires_at < now()
							RETURNING lease_owner`;
					expect(reclaimed[0]?.lease_owner).toBe("worker-b");

					await tx`UPDATE public.lifecycle_operations
							SET status = 'completed', completed_at = now(), lease_owner = NULL
							WHERE id = ${operationA}::uuid`;
					let terminalMutationRejected = false;
					await tx
						.savepoint(async (savepoint) => {
							await savepoint`UPDATE public.lifecycle_operations
									SET safe_error_code = 'should_not_persist'
									WHERE id = ${operationA}::uuid`;
						})
						.catch(() => {
							terminalMutationRejected = true;
						});
					expect(terminalMutationRejected).toBe(true);

					await tx`UPDATE public.lifecycle_operations SET status = 'completed', completed_at = now(), lease_owner = NULL WHERE id = ${deletedOperation}::uuid`;
					const beforeDelete =
						await tx`SELECT actor_subject_hash FROM public.lifecycle_operations WHERE id = ${deletedOperation}::uuid`;
					await tx`DELETE FROM public.users WHERE id = ${actorDeleted}::uuid`;
					const retained =
						await tx`SELECT actor_user_id, actor_subject_hash, status, completed_at FROM public.lifecycle_operations WHERE id = ${deletedOperation}::uuid`;
					expect(retained).toHaveLength(1);
					expect(retained[0]?.actor_user_id).toBeNull();
					expect(retained[0]?.actor_subject_hash).toBe(
						beforeDelete[0]?.actor_subject_hash,
					);
					expect(retained[0]?.status).toBe("completed");
					expect(retained[0]?.completed_at).not.toBeNull();

					await tx.unsafe("SET LOCAL ROLE hiai_app");
					await tx`SELECT set_config('app.current_user_id', ${actorA}, true)`;
					const visible = await tx`SELECT actor_user_id
							FROM public.lifecycle_operations ORDER BY actor_user_id`;
					expect(visible.map((row) => row.actor_user_id)).toEqual([actorA]);
					await tx.unsafe("RESET ROLE");

					throw new Error("ROLLBACK_LIFECYCLE_OPERATION_TEST");
				})
				.catch((error: Error) => {
					if (error.message !== "ROLLBACK_LIFECYCLE_OPERATION_TEST")
						throw error;
				});
		} finally {
			await sql.end();
		}
	});
});

import type { TenantTransaction } from "@hiai-docs/db/with-tenant";
import { sql } from "drizzle-orm";

const DOCUMENT_PIPELINE_LOCK_NAMESPACE = "docsmint:document-pipeline:v1";
const SIGNED_64_BIT_LIMIT = 1n << 63n;
const UNSIGNED_64_BIT_LIMIT = 1n << 64n;

/** Stable, unambiguous identity for every pipeline transaction on one document. */
export function documentPipelineLockIdentity(documentId: string): string {
	return JSON.stringify([DOCUMENT_PIPELINE_LOCK_NAMESPACE, documentId]);
}

/** Map a document identity into PostgreSQL's signed 64-bit advisory lock space. */
export function documentPipelineLockKey(documentId: string): bigint {
	const prefix = new Bun.CryptoHasher("sha256")
		.update(documentPipelineLockIdentity(documentId))
		.digest("hex")
		.slice(0, 16);
	const unsigned = BigInt(`0x${prefix}`);
	return unsigned >= SIGNED_64_BIT_LIMIT
		? unsigned - UNSIGNED_64_BIT_LIMIT
		: unsigned;
}

/** Acquire unique document locks in one deterministic, set-based statement. */
export async function acquireDocumentPipelineLocks(
	tx: TenantTransaction,
	documentIds: readonly string[],
): Promise<void> {
	const lockKeys = [
		...new Set(
			documentIds.map((documentId) => documentPipelineLockKey(documentId)),
		),
	]
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
		.map(String);
	if (lockKeys.length === 0) return;
	const payload = JSON.stringify(lockKeys);
	await tx.execute(sql`
		/* docsmint:document-pipeline-lock */
		SELECT pg_advisory_xact_lock(lock_key)
		FROM (
			SELECT DISTINCT value::bigint AS lock_key
			FROM jsonb_array_elements_text(${payload}::jsonb)
		) AS ordered_locks
		ORDER BY lock_key
	`);
}

/** Acquire the shared protocol for one worker document before any row lock. */
export function acquireDocumentPipelineLock(
	tx: TenantTransaction,
	documentId: string,
): Promise<void> {
	return acquireDocumentPipelineLocks(tx, [documentId]);
}

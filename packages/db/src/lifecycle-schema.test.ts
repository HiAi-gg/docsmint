import { expect, test } from "bun:test";

import { readFile } from "node:fs/promises";

const migrationPath = new URL(
	"./migrations/0036_lifecycle_operations.sql",
	import.meta.url,
);
const journalPath = new URL("./migrations/meta/_journal.json", import.meta.url);

test("lifecycle migration defines durable operation constraints and tenant RLS", async () => {
	const migration = await readFile(migrationPath, "utf8");
	expect(migration).toContain('UNIQUE("actor_user_id", "idempotency_key")');
	expect(migration).toContain("ENUM('export', 'purge')");
	expect(migration).toContain(
		"ENUM('pending', 'running', 'retryable', 'completed', 'rejected')",
	);
	expect(migration).toContain(
		'CREATE INDEX "lifecycle_operations_status_lease_idx"',
	);
	expect(migration).toContain(
		'CREATE INDEX "lifecycle_operations_retryable_idx"',
	);
	expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
	expect(migration).toContain("TO hiai_app");
	expect(migration).toContain("prevent_terminal_lifecycle_operation_mutation");
	expect(migration).toContain("OLD.status IN ('completed', 'rejected')");
	expect(migration).not.toContain('"fence_token" text');
	expect(migration).not.toContain("document_content");
	expect(migration).not.toContain("raw_error");
});

test("restricted sharing remains journaled before additive migrations", async () => {
	const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
		entries: Array<{ idx: number; tag: string }>;
	};
	expect(journal.entries).toContainEqual(
		expect.objectContaining({
			idx: 41,
			tag: "0041_restricted_sharing",
		}),
	);
	expect(journal.entries.at(-1)?.idx).toBeGreaterThanOrEqual(41);
});

test("lifecycle retention preserves redacted operations after account deletion", async () => {
	const migration = await readFile(
		new URL(
			"./migrations/0038_lifecycle_account_deletion_retention.sql",
			import.meta.url,
		),
		"utf8",
	);
	expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
	expect(migration).toContain('"actor_subject_hash" text');
	expect(migration).toContain("ON DELETE SET NULL");
	expect(migration).toContain('ALTER COLUMN "actor_user_id" DROP NOT NULL');
	expect(migration).toContain("actor_subject_hash = OLD.actor_subject_hash");
});

test("document-create idempotency migration uses a workspace-scoped durable operation", async () => {
	const migration = await readFile(
		new URL(
			"./migrations/0037_document_create_idempotency.sql",
			import.meta.url,
		),
		"utf8",
	);
	expect(migration).toContain('CREATE TABLE "document_create_operations"');
	expect(migration).toContain(
		'UNIQUE("workspace_id", "actor_user_id", "idempotency_key")',
	);
	expect(migration).toContain('"document_id" uuid NOT NULL');
	expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
	expect(migration).toContain("TO hiai_app");
});

test("account purge fence globally serializes subjects and limits lifecycle bypasses", async () => {
	const migration = await readFile(
		new URL("./migrations/0042_account_purge_fence.sql", import.meta.url),
		"utf8",
	);
	expect(migration).toContain("SECURITY DEFINER");
	expect(migration).toContain("SET search_path = pg_catalog, public");
	expect(migration).toContain(
		"REVOKE ALL ON FUNCTION public.enforce_account_purge_fence() FROM PUBLIC",
	);
	expect(migration).toContain("public.acquire_account_purge_fence_lock");
	expect(migration).toContain("pg_catalog.pg_advisory_xact_lock");
	expect(migration).not.toContain("FROM public.users AS account");
	expect(migration).toContain("operation.status <> 'rejected'");
	expect(migration).toContain("CONSTRAINT = 'account_purge_fenced'");
	expect(migration).toContain(
		"ALTER TABLE ag_catalog.document_create_operations SET SCHEMA public",
	);
	expect(migration).toContain(
		"CREATE TABLE IF NOT EXISTS public.document_create_operations",
	);
	expect(migration).toContain("REFERENCING NEW TABLE AS new_rows");
	expect(migration).toContain("REFERENCING OLD TABLE AS old_rows");
	expect(migration).toContain("FOR EACH STATEMENT");
	expect(migration).toContain("FOR SHARE");
	expect(migration).toContain("parent_share_link:share_link_id");
	expect(migration).toContain("('audit_log', ARRAY['INSERT','UPDATE','DELETE']");
	expect(migration).toContain("users_account_purge_fence_update");
	expect(migration).toContain("public.lifecycle_cleanup_authorized");
	expect(migration).toContain("pg_catalog.sha256(");
	expect(migration).not.toContain("digest(");
	expect(migration).toContain("AFTER UPDATE ON public.users");
	expect(migration).toContain("ARRAY['INSERT','UPDATE','DELETE']");
	expect(migration).toContain("('documents',");
	expect(migration).toContain("('sessions',");
	expect(migration).toContain(
		"('document_pipeline_runs', ARRAY['INSERT']",
	);
	expect(migration).not.toContain(
		"('document_pipeline_runs', ARRAY['INSERT','UPDATE']",
	);
	expect(migration).not.toContain("AFTER DELETE ON public.users");

	const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
		entries: Array<{ idx: number; tag: string }>;
	};
	expect(journal.entries).toContainEqual(expect.objectContaining({
		idx: 45,
		tag: "0042_account_purge_fence",
	}));
});

test("attachment admission migration durably binds direct uploads to their actor", async () => {
	const migration = await readFile(
		new URL("./migrations/0043_attachment_upload_admission.sql", import.meta.url),
		"utf8",
	);
	expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.pending_attachment_uploads");
	expect(migration).toContain("uploaded_by uuid");
	expect(migration).toContain("token_hash text NOT NULL");
	expect(migration).toContain("expires_at timestamp NOT NULL");
	expect(migration).toContain("FORCE ROW LEVEL SECURITY");
	expect(migration).toContain("pending_attachment_uploads_account_purge_fence");
	expect(migration).toContain("attachments_uploaded_by_fkey");
	expect(migration).toContain("fill_legacy_attachment_uploaded_by");

	const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
		entries: Array<{ idx: number; tag: string }>;
	};
	expect(journal.entries).toContainEqual(expect.objectContaining({
		idx: 46,
		tag: "0043_attachment_upload_admission",
	}));
});

test("attachment cleanup outbox makes object removal recoverable after DB commit", async () => {
	const migration = await readFile(
		new URL("./migrations/0044_attachment_storage_cleanup_outbox.sql", import.meta.url),
		"utf8",
	);
	expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.attachment_storage_cleanup_outbox");
	expect(migration).toContain("storage_key text NOT NULL");
	expect(migration).toContain("not_before timestamp");
	expect(migration).toContain("lease_owner text");
	expect(migration).toContain("lease_expires_at timestamp");
	expect(migration).toContain("FORCE ROW LEVEL SECURITY");
	expect(migration).toContain("attachment_storage_cleanup_outbox_account_purge_fence_insert");
	expect(migration).toContain("pending_attachment_uploads_account_purge_fence_delete");
	expect(migration).toContain(
		"CREATE OR REPLACE FUNCTION public.lifecycle_child_document_owner",
	);
	expect(migration).toContain(
		"REVOKE ALL ON FUNCTION public.lifecycle_child_document_owner(uuid, uuid) FROM PUBLIC",
	);
	expect(migration).toContain("SET search_path = pg_catalog, public");
	expect(migration).toContain("public.lifecycle_cleanup_authorized");

	const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
		entries: Array<{ idx: number; tag: string }>;
	};
	expect(journal.entries.at(-1)).toMatchObject({
		idx: 47,
		tag: "0044_attachment_storage_cleanup_outbox",
	});
});

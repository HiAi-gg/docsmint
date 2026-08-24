import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import * as schema from "./schema";

const migrationUrl = new URL(
	"./migrations/20260824180000_workspace_child_rls_outbox/migration.sql",
	import.meta.url,
);

test("registers a durable metadata re-embed outbox in schema and migrations", async () => {
	expect(schema).toHaveProperty("metadataReembedOutbox");

	const [migration, journalText] = await Promise.all([
		readFile(migrationUrl, "utf8"),
		readFile(
			new URL("./migrations/meta/_journal.json", import.meta.url),
			"utf8",
		),
	]);
	const journal = JSON.parse(journalText) as {
		entries: Array<{ idx: number; tag: string }>;
	};

	expect(journal.entries.at(-1)).toMatchObject({
		idx: 44,
		tag: "20260824180000_workspace_child_rls_outbox/migration",
	});
	expect(migration).toContain(
		"CREATE TABLE IF NOT EXISTS public.metadata_reembed_outbox",
	);
	expect(migration).toContain(
		"ALTER TABLE public.metadata_reembed_outbox FORCE ROW LEVEL SECURITY",
	);
	expect(migration).toContain(
		"GRANT SELECT, INSERT, UPDATE, DELETE ON public.metadata_reembed_outbox TO hiai_app",
	);
});

test("extends the immediately preceding generated migration snapshot", async () => {
	const [previous, current] = await Promise.all([
		Bun.file(
			new URL(
				"./migrations/20260823120000_embedding_context/snapshot.json",
				import.meta.url,
			),
		).json() as Promise<{ id: string }>,
		Bun.file(
			new URL(
				"./migrations/20260824180000_workspace_child_rls_outbox/snapshot.json",
				import.meta.url,
			),
		).json() as Promise<{ prevId: string }>,
	]);
	expect(current.prevId).toBe(previous.id);
});

test("replaces every omitted workspace child policy through its parent", async () => {
	const migration = await readFile(migrationUrl, "utf8");
	for (const table of [
		"document_tags",
		"attachments",
		"versions",
		"document_embeddings",
	] as const) {
		expect(migration).toContain(
			`DROP POLICY IF EXISTS tenant_isolation ON public.${table}`,
		);
		expect(migration).toContain(
			`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
		);
	}
	expect(migration).toContain(
		"parent.workspace_id IS NOT DISTINCT FROM attachments.workspace_id",
	);
	expect(migration).toContain(
		"parent.owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid",
	);
	expect(migration).toContain(
		"tag_parent.workspace_id IS NOT DISTINCT FROM document_tags.workspace_id",
	);
	expect(migration).toContain(
		"pipeline_parent.workspace_id IS NOT DISTINCT FROM document_pipeline_batches.workspace_id",
	);
});

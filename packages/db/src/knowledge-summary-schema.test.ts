import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { documentKnowledgeSummaries } from "./schema";

const migrationUrl = new URL(
	"./migrations/20260816124419_document_knowledge_summaries/migration.sql",
	import.meta.url,
);
const snapshotUrl = new URL(
	"./migrations/20260816124419_document_knowledge_summaries/snapshot.json",
	import.meta.url,
);
const flatMigrationUrl = new URL(
	"./migrations/0042_document_knowledge_summaries.sql",
	import.meta.url,
);
const journalUrl = new URL("./migrations/meta/_journal.json", import.meta.url);

describe("document knowledge summary schema", () => {
	test("keys summaries by document and pipeline generation", () => {
		expect(Object.keys(documentKnowledgeSummaries)).toEqual(
			expect.arrayContaining([
				"document_id",
				"owner_id",
				"workspace_id",
				"generation_id",
				"revision",
				"language",
				"description",
				"keywords",
				"created_at",
				"updated_at",
			]),
		);
		expect(existsSync(migrationUrl)).toBe(true);
		expect(existsSync(snapshotUrl)).toBe(true);
		expect(existsSync(flatMigrationUrl)).toBe(false);
		const journal = readFileSync(journalUrl, "utf8");
		expect(journal).toContain(
			'"tag": "20260816124419_document_knowledge_summaries/migration"',
		);
		expect(journal).not.toContain('"tag": "0042_document_knowledge_summaries"');
		const migration = readFileSync(migrationUrl, "utf8");
		expect(migration).toContain(
			"document_knowledge_summaries_document_generation_idx",
		);
		expect(migration).toContain(
			"document_knowledge_summaries_document_id_documents_id_fk",
		);
		expect(migration).toContain(
			"document_knowledge_summaries_owner_id_users_id_fk",
		);
	});

	test("forces workspace-aware RLS for the runtime role", () => {
		expect(existsSync(migrationUrl)).toBe(true);
		if (!existsSync(migrationUrl)) return;
		const migration = readFileSync(migrationUrl, "utf8");
		expect(migration).toContain(
			"ALTER TABLE public.document_knowledge_summaries FORCE ROW LEVEL SECURITY",
		);
		expect(migration).toContain("FOR ALL TO hiai_app");
		expect(migration).toContain(
			"workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')",
		);
		expect(migration).toContain(
			"owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid",
		);
		expect(migration).toContain(
			"GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_knowledge_summaries TO hiai_app",
		);
	});

	test("ships a valid generated snapshot for the summary table", () => {
		expect(existsSync(snapshotUrl)).toBe(true);
		if (!existsSync(snapshotUrl)) return;
		const snapshot = JSON.parse(readFileSync(snapshotUrl, "utf8"));
		expect(snapshot.version).toBe("7");
		expect(snapshot.dialect).toBe("postgresql");
		expect(
			snapshot.tables["public.document_knowledge_summaries"],
		).toBeDefined();
	});
});

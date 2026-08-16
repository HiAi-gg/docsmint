import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { documentKnowledgeSummaries } from "./schema";

const migration = readFileSync(
	new URL(
		"./migrations/0042_document_knowledge_summaries.sql",
		import.meta.url,
	),
	"utf8",
);

describe("document knowledge summary schema", () => {
	test("keys summaries by document and pipeline generation", () => {
		expect(Object.keys(documentKnowledgeSummaries)).toEqual(
			expect.arrayContaining([
				"documentId",
				"ownerId",
				"workspaceId",
				"generationId",
				"revision",
				"language",
				"description",
				"keywords",
				"createdAt",
				"updatedAt",
			]),
		);
		expect(migration).toContain("UNIQUE (document_id, generation_id)");
	});

	test("forces workspace-aware RLS for the runtime role", () => {
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
});

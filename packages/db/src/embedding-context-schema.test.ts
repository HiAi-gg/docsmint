import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { documentPipelineRuns, documents } from "./schema";

test("embedding context state is represented in documents and pipeline runs", () => {
	expect(documents.embeddingContextHash).toBeDefined();
	expect(documentPipelineRuns.embeddingContextHash).toBeDefined();
	expect(documentPipelineRuns.refreshMode).toBeDefined();
});

test("the embedding context migration is registered in the migration journal", async () => {
	const journal = JSON.parse(
		await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
	) as { entries: Array<{ tag: string }> };

	expect(journal.entries).toContainEqual(
		expect.objectContaining({
			tag: "20260823120000_embedding_context/migration",
		}),
	);
});

test("the embedding context snapshot extends the previous migration snapshot", async () => {
	const previous = JSON.parse(
		await readFile(
			new URL(
				"./migrations/20260816124419_document_knowledge_summaries/snapshot.json",
				import.meta.url,
			),
			"utf8",
		),
	) as { id: string };
	const snapshot = JSON.parse(
		await readFile(
			new URL(
				"./migrations/20260823120000_embedding_context/snapshot.json",
				import.meta.url,
			),
			"utf8",
		),
	) as {
		prevId: string;
		tables: Record<
			string,
			{
				columns: Record<string, unknown>;
				checkConstraints: Record<string, unknown>;
			}
		>;
	};

	expect(snapshot.prevId).toBe(previous.id);
	expect(snapshot.tables["public.documents"]?.columns.embedding_context_hash).toBeDefined();
	expect(
		snapshot.tables["public.document_pipeline_runs"]?.columns.refresh_mode,
	).toBeDefined();
	expect(
		snapshot.tables["public.document_pipeline_runs"]?.checkConstraints
			.document_pipeline_runs_refresh_mode_check,
	).toBeDefined();
});

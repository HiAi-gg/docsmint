/**
 * Re-index all documents by deleting old embeddings and re-enqueuing them
 * for fresh embedding with fixed chunk_text storage.
 *
 * Usage: bun run backend/src/scripts/reindex-embeddings.ts [--dry-run]
 */
import { documentEmbeddings, documents } from "@hiai-docs/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { enqueueEmbedding } from "../lib/embedding-queue";
import { logger } from "../lib/logger";

async function main() {
	const dryRun = process.argv.includes("--dry-run");

	const allDocs = await db
		.select({ id: documents.id, title: documents.title })
		.from(documents);

	logger.info(
		{ count: allDocs.length },
		dryRun ? "DRY RUN: would re-index N documents" : "Starting re-index",
	);

	for (const doc of allDocs) {
		if (!dryRun) {
			// Delete old embeddings (they were all zero-vectors or empty chunk_text)
			await db
				.delete(documentEmbeddings)
				.where(eq(documentEmbeddings.documentId, doc.id));
			// Enqueue for fresh embedding via the worker
			enqueueEmbedding(doc.id);
		}
	}

	logger.info(
		{ count: allDocs.length },
		dryRun
			? "DRY RUN complete (no changes made)"
			: "All documents enqueued for re-embedding",
	);
	process.exit(0);
}

main().catch((err) => {
	logger.error({ err }, "Re-index failed");
	process.exit(1);
});

/**
 * Resumable embedding reindex scheduler.
 *
 * The script only marks/queues work. Embedding workers own staging and
 * atomic activation, so an interrupted scan never destroys the active index.
 */
import { documents } from "@hiai-docs/db/schema";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { embeddingProfileId } from "../embedding/validation";
import { config } from "../lib/config";
import { db } from "../lib/db";
import {
	enqueueEmbedding,
	markStaleEmbeddingProfiles,
} from "../lib/embedding-queue";
import { parseReindexOptions, type ReindexOptions } from "./reindex-options";
import { runResumableReindexScan } from "./reindex-scan";

export async function runReindex(options: ReindexOptions): Promise<void> {
	const model = config.EMBEDDING_MODEL ?? "";
	const models = [model, config.EMBEDDING_FALLBACK_MODEL ?? ""].filter(Boolean);
	const profiles = models.map((name) => embeddingProfileId(name, 1024, "v1"));
	if (profiles.length > 0 && !options.dryRun && !options.all) {
		await markStaleEmbeddingProfiles(profiles);
	}

	await runResumableReindexScan(options, {
		async loadPage({ after, limit, all }) {
			const profileMismatch =
				profiles.length > 0
					? sql`(${documents.embeddingProfile} IS NULL OR ${documents.embeddingProfile} NOT IN (${sql.join(
							profiles.map((profile) => sql`${profile}`),
							sql`, `,
						)}))`
					: sql`false`;
			const conditions = [
				eq(documents.embeddingStatus, "failed"),
				eq(documents.embeddingStatus, "stale"),
				isNull(documents.activeEmbeddingGeneration),
				profileMismatch,
				sql`EXISTS (
				SELECT 1 FROM document_embeddings de
				WHERE de.document_id = ${documents.id}
				  AND (
					de.generation_id IS NULL
					OR de.embedding_profile IS NULL
					OR de.embedding_profile = 'legacy'
					OR de.embedding_dimensions IS NULL
					OR de.embedding_dimensions <> 1024
					OR de.embedding_model IS NULL
					OR de.embedding_model = ''
					OR de.is_valid IS NOT TRUE
					OR de.embedding IS NULL
					OR vector_norm(de.embedding) <= 0
				  )
			)`,
			];
			const eligible = all
				? isNull(documents.deletedAt)
				: and(isNull(documents.deletedAt), or(...conditions));
			const where = after ? and(gt(documents.id, after), eligible) : eligible;
			return db
				.select({ id: documents.id, workspaceId: documents.workspaceId })
				.from(documents)
				.where(where)
				.orderBy(asc(documents.id))
				.limit(limit);
		},
		queue: (row) =>
			enqueueEmbedding(row.id, "reindex", row.workspaceId ?? undefined),
		onProgress: (progress) => console.log(JSON.stringify(progress)),
	});
}

if (import.meta.main) {
	runReindex(parseReindexOptions(process.argv.slice(2)))
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(JSON.stringify({ error: "reindex_failed" }));
			console.error(err);
			process.exit(1);
		});
}

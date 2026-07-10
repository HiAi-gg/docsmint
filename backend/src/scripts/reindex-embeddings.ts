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

interface ReindexOptions {
	after?: string;
	batch: number;
	dryRun: boolean;
}

function optionsFromArgv(argv: string[]): ReindexOptions {
	const after = argv
		.find((arg) => arg.startsWith("--after="))
		?.slice("--after=".length);
	const batchValue = argv
		.find((arg) => arg.startsWith("--batch="))
		?.slice("--batch=".length);
	const batch = Number(batchValue ?? 100);
	return {
		after: after && after.length > 0 ? after : undefined,
		batch: Number.isFinite(batch) && batch > 0 ? Math.floor(batch) : 100,
		dryRun: argv.includes("--dry-run"),
	};
}

export async function runReindex(options: ReindexOptions): Promise<void> {
	const model = config.EMBEDDING_MODEL ?? "";
	const models = [model, config.EMBEDDING_FALLBACK_MODEL ?? ""].filter(Boolean);
	const profiles = models.map((name) => embeddingProfileId(name, 1024, "v1"));
	if (profiles.length > 0 && !options.dryRun) {
		await markStaleEmbeddingProfiles(profiles);
	}

	let cursor = options.after;
	let scanned = 0;
	let queued = 0;
	let skipped = 0;

	while (true) {
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
		const where = cursor
			? and(gt(documents.id, cursor), or(...conditions))
			: or(...conditions);
		const rows = await db
			.select({ id: documents.id })
			.from(documents)
			.where(where)
			.orderBy(asc(documents.id))
			.limit(options.batch);

		if (rows.length === 0) break;
		scanned += rows.length;
		if (options.dryRun) {
			skipped += rows.length;
		} else {
			for (const row of rows) {
				if (await enqueueEmbedding(row.id)) queued += 1;
				else skipped += 1;
			}
		}
		cursor = rows.at(-1)?.id;
		console.log(
			JSON.stringify({
				scanned,
				queued,
				skipped,
				lastDocumentId: cursor ?? null,
			}),
		);
		if (rows.length < options.batch) break;
	}
}

if (import.meta.main) {
	runReindex(optionsFromArgv(process.argv.slice(2)))
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(JSON.stringify({ error: "reindex_failed" }));
			console.error(err);
			process.exit(1);
		});
}

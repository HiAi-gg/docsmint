import {
	categories,
	documentEmbeddings,
	documents,
	documentTags,
	folders,
	tags,
} from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, inArray } from "drizzle-orm";
import { chunkHash } from "../lib/chunk-hash";
import { config } from "../lib/config";
import { contentHash } from "../lib/content-hash";
import { extractEntities } from "../lib/graph/extract-entities";
import { logger } from "../lib/logger";
import { incrementCounter, METRIC_NAMES } from "../lib/metrics";
import { redis } from "../lib/redis";
import { needsChunkRefresh } from "./incremental";
import { type EmbeddingMetadata, embedDocument } from "./index";

const QUEUE_KEY = "hiai-docs:embedding-queue";
const WORKER_TENANT = adminTenantContext(ZERO_UUID);

export function startEmbeddingWorker(): void {
	logger.info("Embedding worker started");

	const processLoop = async (): Promise<void> => {
		while (true) {
			try {
				const result = await redis.brpop(QUEUE_KEY, 1);
				if (!result) continue;
				const documentId = result[1];
				await processDocument(documentId);
			} catch (err) {
				logger.error({ err }, "Embedding worker error");
			}
		}
	};

	processLoop();
}

async function processDocument(documentId: string): Promise<void> {
	logger.info({ documentId }, "Processing embedding for document");
	// Counter sits at the very top of the worker callback so every dequeued
	// document — including ones that early-return because the row is
	// missing or content is empty — counts toward `embedding_docs_total`.
	// This matches the operator-facing definition of "documents processed
	// by the worker" and avoids double-counting on retry.
	incrementCounter(METRIC_NAMES.EMBEDDING_DOCS_TOTAL);

	try {
		const doc = await withTenant(WORKER_TENANT, (tx) =>
			tx.query.documents.findFirst({
				where: eq(documents.id, documentId),
				columns: {
					id: true,
					title: true,
					content: true,
					folderId: true,
					categoryId: true,
				},
			}),
		);

		if (!doc) {
			logger.warn({ documentId }, "Document not found, skipping embedding");
			return;
		}

		const content = doc.content ?? "";
		if (!content && doc.title === "Untitled") {
			logger.debug(
				{ documentId },
				"Document has no content, skipping embedding",
			);
			return;
		}

		// Resolve metadata for the embedding preamble. We fetch folder, tag,
		// and category names in parallel — they're independent and small. If
		// any lookup fails, log and continue with whatever we have; embedding
		// should never block on metadata enrichment.
		const metadata = await loadEmbeddingMetadata(doc).catch((err) => {
			logger.warn(
				{ err, documentId },
				"Failed to load embedding metadata, embedding without preamble",
			);
			return undefined;
		});

		const embeddings = await embedDocument(doc.title, content, metadata);

		if (embeddings.length === 0) {
			logger.warn({ documentId }, "No embeddings produced for document");
			return;
		}

		// Incremental re-embed: fetch existing chunk hashes, decide which
		// chunks changed (hash mismatch), expand to neighbor chunks so the
		// overlap regions stay consistent with their neighbors, then delete
		// + reinsert only the affected slice. Unchanged chunks stay put and
		// keep their original embeddings — full re-embed was O(N) embeddings
		// per document save, this is O(changed + 2·changed).
		const existing = await withTenant(WORKER_TENANT, (tx) =>
			tx
				.select({
					chunkIndex: documentEmbeddings.chunkIndex,
					chunkHash: documentEmbeddings.chunkHash,
					embedding: documentEmbeddings.embedding,
					embeddingModel: documentEmbeddings.embeddingModel,
				})
				.from(documentEmbeddings)
				.where(eq(documentEmbeddings.documentId, documentId)),
		);

		const existingByIndex = new Map(existing.map((e) => [e.chunkIndex, e]));

		// A chunk "changed" when its hash differs from the stored hash at
		// the same index. New chunks have no stored hash yet (treat as
		// changed), chunks missing from the new set (orphan indices) are
		// handled separately below.
		const changedIndices = new Set<number>();
		for (let i = 0; i < embeddings.length; i++) {
			const chunk = embeddings[i];
			if (!chunk) continue;
			const newHash = chunkHash(chunk.chunkText);
			const stored = existingByIndex.get(i);
			if (needsChunkRefresh(stored, newHash, config.EMBEDDING_MODEL ?? "")) {
				changedIndices.add(i);
			}
		}

		// Include the immediate neighbors of each changed chunk so the
		// overlap tail stays semantically consistent with both sides of the
		// boundary. Without this, an unchanged chunk that shares overlap
		// text with a changed chunk would still hold a stale embedding.
		const affectedIndices = new Set<number>();
		for (const idx of changedIndices) {
			affectedIndices.add(idx);
			if (idx > 0) affectedIndices.add(idx - 1);
			if (idx < embeddings.length - 1) affectedIndices.add(idx + 1);
		}

		logger.info(
			{
				documentId,
				totalChunks: embeddings.length,
				changed: changedIndices.size,
				affected: affectedIndices.size,
			},
			"Incremental re-embed",
		);

		await withTenant(WORKER_TENANT, async (tx) => {
			// Orphan cleanup: if the new chunk count is smaller than the
			// stored count, the trailing old chunks point at text that no
			// longer exists. Delete them so they don't leak into search
			// results or inflate the embedding count.
			const orphanIndices = existing
				.map((e) => e.chunkIndex)
				.filter((idx) => idx >= embeddings.length);
			if (orphanIndices.length > 0) {
				await tx
					.delete(documentEmbeddings)
					.where(
						and(
							eq(documentEmbeddings.documentId, documentId),
							inArray(documentEmbeddings.chunkIndex, orphanIndices),
						),
					);
			}

			// Delete affected slices in place. We delete by (documentId,
			// chunkIndex) rather than by a wide WHERE because the
			// unique index makes this O(1) per row.
			for (const idx of affectedIndices) {
				await tx
					.delete(documentEmbeddings)
					.where(
						and(
							eq(documentEmbeddings.documentId, documentId),
							eq(documentEmbeddings.chunkIndex, idx),
						),
					);
			}

			// Reinsert only the affected slices. Skip indices that don't
			// exist in the new chunk set (those are handled by the orphan
			// cleanup above — they were deleted and should not reappear).
			const rows: Array<{
				documentId: string;
				chunkIndex: number;
				chunkText: string;
				chunkHash: string;
				embedding: number[];
				charStart: number;
				charEnd: number;
				embeddingModel: string;
			}> = [];
			for (const idx of affectedIndices) {
				const chunk = embeddings[idx];
				if (!chunk) continue;
				rows.push({
					documentId,
					chunkIndex: idx,
					chunkText: chunk.chunkText,
					chunkHash: chunkHash(chunk.chunkText),
					embedding: chunk.embedding,
					charStart: chunk.charStart,
					charEnd: chunk.charEnd,
					// Record which embedding model produced this vector. Empty string
					// means EMBEDDING_MODEL was not configured when this row was
					// written (semantic search was disabled) - those rows are also
					// candidates for targeted reindex once a model becomes available.
					embeddingModel: config.EMBEDDING_MODEL ?? "",
				});
			}
			if (rows.length > 0) {
				await tx.insert(documentEmbeddings).values(rows);
			}
		});

		// Bump the chunks counter AFTER the transaction commits so the
		// counter reflects chunks that are actually persisted, not chunks
		// that were embedded then lost to a failed insert.
		incrementCounter(METRIC_NAMES.EMBEDDING_CHUNKS_TOTAL);

		// Update content hash so future edits can skip re-embed if content unchanged
		const hash = contentHash(doc.title, content);
		await withTenant(WORKER_TENANT, (tx) =>
			tx
				.update(documents)
				.set({ contentHash: hash })
				.where(eq(documents.id, documentId)),
		);

		// GraphRAG entity extraction. Best-effort — failures are logged
		// inside `extractEntities` and MUST NOT break the embedding
		// pipeline (the document is already queryable via vector search at
		// this point). Runs per-chunk so each chunk contributes its own
		// entity set to the graph.
		if (config.GRAPH_EXTRACT_ENABLED) {
			await runEntityExtraction(embeddings, documentId);
		}

		logger.info(
			{
				documentId,
				chunks: embeddings.length,
				dimensions: embeddings[0]?.embedding.length,
			},
			"All chunk embeddings stored for document",
		);
	} catch (err) {
		logger.error({ err, documentId }, "Failed to process document embedding");
	}
}

/**
 * Resolve the folder/tag/category names associated with a document so the
 * embedding pipeline can prepend them to the chunk text for semantic search.
 *
 * All three lookups are independent and run in parallel:
 *   - folder name:   single LEFT JOIN-style lookup by `documents.folder_id`
 *   - tag names:     grouped query over `document_tags` + `tags` by `document_id`
 *   - category name: single lookup by `documents.category_id`
 *
 * Each query is best-effort: an empty result simply omits that field from the
 * preamble (see `buildMetadataPreamble`). Returns `undefined` when no metadata
 * is available at all so the worker falls back to the legacy behavior.
 */
async function loadEmbeddingMetadata(doc: {
	id: string;
	folderId: string | null;
	categoryId: string | null;
}): Promise<EmbeddingMetadata | undefined> {
	const [folderName, tagNames, categoryName] = await withTenant(
		WORKER_TENANT,
		async (tx) => {
			const tasks: [
				Promise<string | null>,
				Promise<string[]>,
				Promise<string | null>,
			] = [
				doc.folderId
					? tx
							.select({ name: folders.name })
							.from(folders)
							.where(eq(folders.id, doc.folderId))
							.limit(1)
							.then((rows) => rows[0]?.name ?? null)
					: Promise.resolve(null),
				tx
					.select({ name: tags.name })
					.from(documentTags)
					.innerJoin(tags, eq(tags.id, documentTags.tagId))
					.where(eq(documentTags.documentId, doc.id))
					.then((rows) => rows.map((r) => r.name)),
				doc.categoryId
					? tx
							.select({ name: categories.name })
							.from(categories)
							.where(eq(categories.id, doc.categoryId))
							.limit(1)
							.then((rows) => rows[0]?.name ?? null)
					: Promise.resolve(null),
			];
			return Promise.all(tasks);
		},
	);

	const hasAny =
		(folderName && folderName.length > 0) ||
		tagNames.length > 0 ||
		(categoryName && categoryName.length > 0);
	if (!hasAny) return undefined;

	const metadata: EmbeddingMetadata = {};
	if (folderName && folderName.length > 0) metadata.folderName = folderName;
	if (tagNames.length > 0) metadata.tagNames = tagNames;
	if (categoryName && categoryName.length > 0)
		metadata.categoryName = categoryName;
	return metadata;
}

/**
 * Run GraphRAG entity extraction across all chunks of a freshly-embedded
 * document. Sequential: chunks per document are typically few (<10) and
 * serial keeps the AGE connection pool pressure predictable. Each call
 * to `extractEntities` is fully self-contained — it returns `[]` on any
 * failure and never throws, so the embedding pipeline is robust to graph
 * outages.
 *
 * When `changedIndices` is provided, only the chunks at those indices
 * are processed (Phase 5.3 incremental-graph feature). Out-of-range
 * indices are silently filtered out so callers don't need to bounds-check.
 * Omitting `changedIndices` keeps the legacy "process every chunk"
 * behavior — required by tests that exercise the bulk-embed path.
 *
 * Exported so unit tests can drive the function directly without
 * starting the worker's redis BRPOP loop.
 */
export async function runEntityExtraction(
	embeddings: Array<{ chunkText: string; embedding: number[] }>,
	documentId: string,
	changedIndices?: Set<number>,
): Promise<void> {
	for (let i = 0; i < embeddings.length; i++) {
		if (changedIndices && !changedIndices.has(i)) continue;
		const chunk = embeddings[i];
		if (!chunk) continue;
		try {
			await extractEntities(chunk.chunkText, documentId, {
				chunkIndex: i,
				chunkHash: chunkHash(chunk.chunkText),
			});
		} catch (err) {
			// Defense-in-depth: extractEntities already catches its own
			// errors, but if anything ever escapes we still don't want it
			// to bubble up and undo the embedding pipeline work.
			logger.warn(
				{ err, documentId, chunkIndex: i, chunkLen: chunk.chunkText.length },
				"Entity extraction threw — continuing without graph enrichment",
			);
		}
	}
}

import {
	categories,
	documentEmbeddings,
	documents,
	documentTags,
	folders,
	tags,
} from "@hiai-docs/db/schema";
import { eq } from "drizzle-orm";
import { config } from "../lib/config";
import { contentHash } from "../lib/content-hash";
import { db } from "../lib/db";
import { extractEntities } from "../lib/graph/extract-entities";
import { logger } from "../lib/logger";
import { redis } from "../lib/redis";
import { type EmbeddingMetadata, embedDocument } from "./index";

const QUEUE_KEY = "hiai-docs:embedding-queue";

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

	try {
		const doc = await db.query.documents.findFirst({
			where: eq(documents.id, documentId),
			columns: {
				id: true,
				title: true,
				content: true,
				folderId: true,
				categoryId: true,
			},
		});

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

		await db.transaction(async (tx) => {
			await tx
				.delete(documentEmbeddings)
				.where(eq(documentEmbeddings.documentId, documentId));

			const rows = embeddings.map(({ chunkText, embedding }, index) => ({
				documentId,
				chunkIndex: index,
				chunkText,
				embedding,
			}));

			await tx.insert(documentEmbeddings).values(rows);
		});

		// Update content hash so future edits can skip re-embed if content unchanged
		const hash = contentHash(doc.title, content);
		await db
			.update(documents)
			.set({ contentHash: hash })
			.where(eq(documents.id, documentId));

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
	const tasks: [
		Promise<string | null>,
		Promise<string[]>,
		Promise<string | null>,
	] = [
		doc.folderId
			? db
					.select({ name: folders.name })
					.from(folders)
					.where(eq(folders.id, doc.folderId))
					.limit(1)
					.then((rows) => rows[0]?.name ?? null)
			: Promise.resolve(null),
		db
			.select({ name: tags.name })
			.from(documentTags)
			.innerJoin(tags, eq(tags.id, documentTags.tagId))
			.where(eq(documentTags.documentId, doc.id))
			.then((rows) => rows.map((r) => r.name)),
		doc.categoryId
			? db
					.select({ name: categories.name })
					.from(categories)
					.where(eq(categories.id, doc.categoryId))
					.limit(1)
					.then((rows) => rows[0]?.name ?? null)
			: Promise.resolve(null),
	];

	const [folderName, tagNames, categoryName] = await Promise.all(tasks);

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
 */
async function runEntityExtraction(
	embeddings: Array<{ chunkText: string; embedding: number[] }>,
	documentId: string,
): Promise<void> {
	for (const chunk of embeddings) {
		try {
			await extractEntities(chunk.chunkText, documentId);
		} catch (err) {
			// Defense-in-depth: extractEntities already catches its own
			// errors, but if anything ever escapes we still don't want it
			// to bubble up and undo the embedding pipeline work.
			logger.warn(
				{ err, documentId, chunkLen: chunk.chunkText.length },
				"Entity extraction threw — continuing without graph enrichment",
			);
		}
	}
}

/**
 * Redis-based async embedding queue.
 * Enqueues document IDs; a background worker pops them, chunks, embeds, and stores vectors.
 *
 * Usage:
 *   import { enqueueEmbedding, startEmbeddingWorker } from "./lib/embedding-queue";
 *   enqueueEmbedding(documentId);              // non-blocking
 *   startEmbeddingWorker();                    // call once at startup
 */

import { eq } from "drizzle-orm";
import { db } from "./db";
import { documents, documentEmbeddings } from "@hiai-docs/db/schema";
import { redis } from "./redis";
import { logger } from "./logger";
import { embedDocument } from "../embedding";

const QUEUE_KEY = "hiai-docs:embedding-queue";

/**
 * Add a document ID to the embedding queue.
 * Non-blocking — fires and forgets.
 */
export function enqueueEmbedding(documentId: string): void {
  redis.lpush(QUEUE_KEY, documentId).catch((err) => {
    logger.error({ err, documentId }, "Failed to enqueue embedding job");
  });
}

/**
 * Start the background embedding worker.
 * Uses a blocking BRPOP loop — no recursive setTimeout.
 * Call once at application startup.
 */
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

/**
 * Process a single document: fetch content, embed, store all chunk vectors.
 */
async function processDocument(documentId: string): Promise<void> {
  logger.info({ documentId }, "Processing embedding for document");

  try {
    // Fetch document from database
    const doc = await db.query.documents.findFirst({
      where: eq(documents.id, documentId),
      columns: {
        id: true,
        title: true,
        content: true,
      },
    });

    if (!doc) {
      logger.warn({ documentId }, "Document not found, skipping embedding");
      return;
    }

    const content = doc.content ?? "";
    if (!content && doc.title === "Untitled") {
      logger.debug({ documentId }, "Document has no content, skipping embedding");
      return;
    }

    // Embed — returns array of vectors (one per chunk)
    const embeddings = await embedDocument(doc.title, content);

    if (embeddings.length === 0) {
      logger.warn({ documentId }, "No embeddings produced for document");
      return;
    }

    // Delete old embeddings and store new ones in a single transaction
    await db.transaction(async (tx) => {
      await tx
        .delete(documentEmbeddings)
        .where(eq(documentEmbeddings.documentId, documentId));

      const rows = embeddings.map((embedding, index) => ({
        documentId,
        chunkIndex: index,
        chunkText: "", // Chunk text not stored to save space; re-chunk on search if needed
        embedding,
      }));

      await tx.insert(documentEmbeddings).values(rows);
    });

    logger.info(
      { documentId, chunks: embeddings.length, dimensions: embeddings[0]?.length },
      "All chunk embeddings stored for document",
    );
  } catch (err) {
    logger.error({ err, documentId }, "Failed to process document embedding");
  }
}

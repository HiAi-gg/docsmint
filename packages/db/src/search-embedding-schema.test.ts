import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { documentEmbeddings, documents } from "./schema";

describe("search embedding schema", () => {
  test("exports lifecycle and generation columns", () => {
    expect(documents.embeddingStatus.name).toBe("embedding_status");
    expect(documents.activeEmbeddingGeneration.name).toBe("active_embedding_generation");
    expect(documentEmbeddings.generationId.name).toBe("generation_id");
    expect(documentEmbeddings.embeddingDimensions.name).toBe("embedding_dimensions");
    expect(documentEmbeddings.isValid.name).toBe("is_valid");
  });

  test("exports the language-neutral vector", () => {
    expect(documents.searchVectorSimple.name).toBe("search_vector_simple");
  });

  test("bounds generated search vectors for large imported documents", () => {
    const migration = readFileSync(
      new URL("./migrations/0033_bound_document_search_vectors.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("regexp_replace");
    expect(migration).toContain("data:[^[:space:])>]+");
    expect(migration.match(/200000/g)?.length).toBe(2);
    expect(migration).toContain("idx_documents_search_vector_simple");
  });
});

import { describe, expect, test } from "bun:test";
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
});

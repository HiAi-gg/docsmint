/**
 * Text chunking for embedding pipeline.
 * Strategy: split by paragraphs, then merge into ~500 token chunks with 50 token overlap.
 * Token estimation: 1 token ≈ 4 chars (rough heuristic).
 */

const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;

const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN; // 2000
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN; // 200

/**
 * Split text into chunks suitable for embedding.
 * Each chunk is approximately 500 tokens (~2000 characters).
 * Adjacent chunks overlap by ~50 tokens (~200 characters).
 */
export function chunkText(text: string): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  // Split into paragraphs (preserve double-newline boundaries)
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  if (paragraphs.length === 0) {
    return [];
  }

  // If a single paragraph exceeds target, split it further by sentences
  const normalizedParagraphs: string[] = [];
  for (const para of paragraphs) {
    if (para.length > TARGET_CHARS * 1.5) {
      // Split oversized paragraph by sentences
      const sentences = para.match(/[^.!?]+[.!?]+[\s]*/g) || [para];
      normalizedParagraphs.push(...sentences);
    } else {
      normalizedParagraphs.push(para);
    }
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const paragraph of normalizedParagraphs) {
    const candidate = currentChunk
      ? `${currentChunk}\n\n${paragraph}`
      : paragraph;

    if (candidate.length <= TARGET_CHARS) {
      currentChunk = candidate;
    } else {
      // Flush current chunk if non-empty
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
      }
      // Start new chunk with overlap from end of previous chunk
      if (OVERLAP_CHARS > 0 && currentChunk.length > 0) {
        const overlap = currentChunk.slice(-OVERLAP_CHARS);
        currentChunk = `${overlap}\n\n${paragraph}`;
      } else {
        currentChunk = paragraph;
      }
    }
  }

  // Flush remaining chunk
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

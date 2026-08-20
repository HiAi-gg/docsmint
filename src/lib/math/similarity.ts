/**
 * Cosine similarity with zero-vector and NaN protection.
 */
export function safeCosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0.0;
  let dot = 0.0, normA = 0.0, normB = 0.0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom < 1e-9 ? 0.0 : dot / denom;
}

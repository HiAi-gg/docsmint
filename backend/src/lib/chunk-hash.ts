/**
 * Per-chunk content hash for incremental re-embed decisions.
 * SHA-256 of the chunk text (not the full document).
 */
export function chunkHash(chunkText: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(chunkText);
	return hasher.digest("hex");
}

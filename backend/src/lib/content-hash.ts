/**
 * Compute a content hash for smart re-embed decisions.
 * Uses SHA-256 of title + content (not metadata, which always forces re-embed).
 */
export function contentHash(title: string, content: string): string {
	const input = `${title}\n${content}`;
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

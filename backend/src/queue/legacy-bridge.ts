export async function migrateLegacyEmbeddingEntries(
	pop: () => Promise<string | null>,
	enqueue: (documentId: string) => Promise<boolean>,
	limit = 10_000,
): Promise<{ migrated: number; failed: number }> {
	let migrated = 0;
	let failed = 0;
	for (let index = 0; index < limit; index += 1) {
		const raw = await pop();
		if (!raw) break;
		let documentId = raw;
		try {
			const parsed = JSON.parse(raw) as { documentId?: unknown };
			if (typeof parsed.documentId === "string") documentId = parsed.documentId;
		} catch {
			// Legacy v1 entries were raw document IDs.
		}
		if (await enqueue(documentId)) migrated += 1;
		else failed += 1;
	}
	return { migrated, failed };
}

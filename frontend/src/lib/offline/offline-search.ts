import { getOfflineDB } from "#lib/db/index.js";
import type { OfflineIdentity } from "./identity";

export interface SearchResult {
	id: string;
	title: string;
	excerpt: string;
}

/**
 * Search cached documents locally (no network). Matches the query (case
 * insensitive) against the title and content and returns up to 20 hits
 * with a short excerpt.
 */
export async function offlineSearch(
	query: string,
	identity: OfflineIdentity,
): Promise<SearchResult[]> {
	const db = getOfflineDB(identity);
	const docs = await db.documents.toArray();
	const q = query.toLowerCase();
	return docs
		.filter(
			(d) =>
				d.title.toLowerCase().includes(q) ||
				(d.content?.toLowerCase().includes(q) ?? false),
		)
		.map((d) => ({
			id: d.id,
			title: d.title,
			excerpt: d.content?.slice(0, 200) ?? "",
		}))
		.slice(0, 20);
}

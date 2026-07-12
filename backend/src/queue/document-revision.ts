import { contentHash } from "../lib/content-hash";

export function resolveDocumentRevision(
	storedRevision: string | null,
	title: string,
	content: string,
): string {
	return storedRevision ?? contentHash(title, content);
}

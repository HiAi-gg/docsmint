import { getCachedDocuments } from "#lib/offline/cache-documents.js";
import type { PageLoad } from "./$types";

export const ssr = false;
export const load: PageLoad = async () => {
	try {
		return { documents: await getCachedDocuments() };
	} catch {
		return { documents: [] };
	}
};

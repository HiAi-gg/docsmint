import { listCategories } from "$lib/api/categories.js";
import { listFolders } from "$lib/api/folders.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ depends, fetch }) => {
	// Declare a dependency key so `invalidate("app:folders")` from the
	// page component triggers a re-run after mutating actions (delete).
	depends("app:folders");

	const [categories, rootResult] = await Promise.all([
		listCategories(fetch),
		listFolders(null, false, fetch),
	]);

	// `listFolders(null)` returns a single-element array whose first item is
	// a synthetic root. Its `children` are the user's top-level folders.
	const folders = rootResult[0]?.children ?? [];

	return {
		categories,
		folders,
	};
};

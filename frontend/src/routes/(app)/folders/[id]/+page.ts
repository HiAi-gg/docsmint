import { listCategories } from "$lib/api/categories.js";
import { getFolder, getFolderPath } from "$lib/api/folders.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ params, fetch }) => {
	const [folder, breadcrumb, categories] = await Promise.all([
		getFolder(params.id, fetch),
		getFolderPath(params.id, fetch),
		listCategories(fetch),
	]);

	return {
		folder,
		breadcrumb,
		categories,
	};
};

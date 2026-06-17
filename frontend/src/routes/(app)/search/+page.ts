import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ url }) => {
	const q = url.searchParams.get("q") ?? "";
	const folder = url.searchParams.get("folder") ?? undefined;
	const tags =
		url.searchParams.get("tags")?.split(",").filter(Boolean) ?? undefined;
	const dateFrom = url.searchParams.get("dateFrom") ?? undefined;
	const dateTo = url.searchParams.get("dateTo") ?? undefined;
	const page = Math.max(
		1,
		Number.parseInt(url.searchParams.get("page") ?? "1", 10),
	);

	return {
		query: q,
		filters: {
			folder: folder || undefined,
			tags: tags && tags.length > 0 ? tags : undefined,
			dateFrom: dateFrom || undefined,
			dateTo: dateTo || undefined,
		},
		page,
	};
};

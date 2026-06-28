import type { PageLoad } from "./$types";

/**
 * Parse a UUID-shaped string. Returns the value when it looks like a
 * UUID, otherwise `undefined`. Cheap pattern check — the backend re-validates
 * with Zod so a forged URL just becomes 400 from the API.
 */
function parseUuid(raw: string | null): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			trimmed,
		)
	) {
		return undefined;
	}
	return trimmed;
}

export const load: PageLoad = async ({ url }) => {
	const q = url.searchParams.get("q") ?? "";
	const folder = url.searchParams.get("folder") ?? undefined;
	const tags =
		url.searchParams.get("tags")?.split(",").filter(Boolean) ?? undefined;
	const category = parseUuid(url.searchParams.get("category"));
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
			category,
			dateFrom: dateFrom || undefined,
			dateTo: dateTo || undefined,
		},
		page,
	};
};

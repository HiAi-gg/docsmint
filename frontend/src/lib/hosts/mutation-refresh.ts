export type MutationRefreshImpact = {
	documents: boolean;
	folders: boolean;
	tags: boolean;
};

const noImpact: MutationRefreshImpact = {
	documents: false,
	folders: false,
	tags: false,
};

export function mutationRefreshImpact(
	input: RequestInfo | URL,
	init?: RequestInit,
): MutationRefreshImpact {
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return noImpact;

	const rawUrl =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	const pathname = new URL(rawUrl, "http://docsmint.local").pathname;
	if (/\/keys(?:\/|$)/.test(pathname)) return noImpact;

	if (/^\/api\/(?:v1\/)?tags(?:\/|$)/.test(pathname)) {
		return { documents: true, folders: false, tags: true };
	}
	if (/^\/api\/(?:v1\/)?documents\/[^/]+\/tags(?:\/|$)/.test(pathname)) {
		return { documents: true, folders: false, tags: true };
	}
	if (/^\/api\/(?:v1\/)?(?:folders|categories)(?:\/|$)/.test(pathname)) {
		return { documents: true, folders: true, tags: false };
	}
	if (/^\/api\/(?:v1\/)?trash(?:\/|$)/.test(pathname)) {
		return { documents: true, folders: true, tags: false };
	}
	if (/^\/api\/(?:v1\/)?(?:documents|import|imports)(?:\/|$)/.test(pathname)) {
		return { documents: true, folders: true, tags: false };
	}

	return noImpact;
}

export function hasMutationRefreshImpact(
	impact: MutationRefreshImpact,
): boolean {
	return impact.documents || impact.folders || impact.tags;
}

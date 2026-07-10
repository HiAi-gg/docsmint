import { redirect } from "@sveltejs/kit";
import { createDocument, getDocument } from "$lib/api/documents";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch, url }) => {
	if (params.id === "new") {
		const folderId = url.searchParams.get("folder") || undefined;
		const categoryId = url.searchParams.get("category") || undefined;
		let doc: Awaited<ReturnType<typeof createDocument>> | undefined;
		try {
			doc = await createDocument(
				{
					title: "Untitled Document",
					content: "",
					folderId,
					categoryId,
				},
				fetch,
			);
		} catch (err) {
			console.error("Failed to auto-create document in load:", err);
		}

		if (doc) {
			throw redirect(303, `/docs/${doc.id}`);
		}

		// Fallback placeholder when backend is down
		const placeholder: Awaited<ReturnType<typeof getDocument>> = {
			id: "new",
			title: "Untitled Document",
			content: "",
			folderId: folderId || null,
			folderName: "",
			tags: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			excerpt: "",
		};
		return { document: placeholder };
	}

	try {
		const document = await getDocument(params.id, fetch);
		return { document };
	} catch {
		// Fallback when backend unavailable
		return {
			document: {
				id: params.id,
				title: "Untitled Document",
				content: "",
				folderId: null,
				folderName: "",
				tags: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				excerpt: "",
			} as Awaited<ReturnType<typeof getDocument>>,
		};
	}
};

import type { PageLoad } from "./$types";
import { getDocument } from "$lib/api/documents";

export const load: PageLoad = async ({ params }) => {
  try {
    const document = await getDocument(params.id);
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
      },
    };
  }
};

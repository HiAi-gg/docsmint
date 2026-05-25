import { getFolder, getFolderPath } from "$lib/api/folders.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ params }) => {
  const [folder, breadcrumb] = await Promise.all([
    getFolder(params.id),
    getFolderPath(params.id),
  ]);

  return {
    folder,
    breadcrumb,
  };
};

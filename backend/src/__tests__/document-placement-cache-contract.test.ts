import { describe, expect, test } from "bun:test";

const documentSource = await Bun.file(
	new URL("../api/routes/documents.ts", import.meta.url),
).text();
const collaborationSource = await Bun.file(
	new URL("../api/routes/collaboration.ts", import.meta.url),
).text();

const placementPatch = documentSource.slice(
	documentSource.indexOf('.patch("/documents/:id"'),
	documentSource.indexOf('.delete("/documents/:id"'),
);

describe("document placement list-cache contract", () => {
	test("every workspace document-list mutation invalidates all workspace members", () => {
		expect(placementPatch).toContain("folderChanged || categoryChanged");
		expect(placementPatch).toMatch(
			/invalidateDocListCache\(userId,\s*ctx\.workspaceId\)/,
		);
		expect(
			documentSource.match(
				/invalidateDocListCache\((?:userId|ctx\.userId),\s*ctx\.workspaceId\)/g,
			),
		).toHaveLength(6);
		expect(collaborationSource).toMatch(
			/invalidateDocListCache\(access\.userId,\s*access\.ctx\.workspaceId\)/,
		);
	});
});

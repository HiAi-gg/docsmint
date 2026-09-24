import { describe, expect, test } from "bun:test";

const source = await Bun.file(
	new URL("../api/routes/documents.ts", import.meta.url),
).text();

const placementPatch = source.slice(
	source.indexOf('.patch("/documents/:id"'),
	source.indexOf('.delete("/documents/:id"'),
);

describe("document placement list-cache contract", () => {
	test("placement PATCH invalidates every member list in the workspace", () => {
		expect(placementPatch).toContain("folderChanged || categoryChanged");
		expect(placementPatch).toMatch(
			/invalidateDocListCache\(userId,\s*ctx\.workspaceId\)/,
		);
	});
});

import { describe, expect, test } from "bun:test";

const routeSource = (name: string) =>
	Bun.file(
		new URL(`../api/routes/${name}.ts`, import.meta.url).pathname,
	).text();

describe("dependent document route access contracts", () => {
	test("attachments enforce read/edit permissions and owning categories", async () => {
		const source = await routeSource("attachments");
		expect(
			source.match(/authorizeDocument\([\s\S]*?documentId,[\s\S]*?"edit"/g),
		).toHaveLength(3);
		expect(source).toContain('authorizeDocument(request, params.id, "read")');
		expect(source).toContain('canAccessContent(access, "read")');
		expect(source.match(/effectiveDocumentCategoryCondition\(/g)).toHaveLength(
			5,
		);
		expect(source).not.toContain("row.ownerId !== access.userId");
	});

	test("create replay and patch authorize effective category in SQL", async () => {
		const source = await routeSource("documents");
		const replayFences = source.match(
			/const authorized\s*=\s*and\([\s\S]{0,700}?effectiveDocumentCategoryCondition\(/g,
		);
		const patch = source.slice(source.indexOf("const existingRows = await tx"));
		expect(replayFences).toHaveLength(2);
		expect(
			source.match(/documentCreateOperations\.idempotencyKey/g),
		).toHaveLength(2);
		expect(patch).toContain("effectiveDocumentCategoryCondition(");
		expect(source.match(/authorized/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
		expect(source).toContain('error: "Idempotency key is unavailable"');
		expect(source.match(/set\.status = 409/g)?.length).toBeGreaterThanOrEqual(
			2,
		);
	});

	test("collaboration and share authorize inherited workspace documents", async () => {
		const collaboration = await routeSource("collaboration");
		const share = await routeSource("share");
		expect(collaboration).toContain("effectiveDocumentCategoryCondition(");
		expect(share).toContain("effectiveDocumentCategoryCondition(");
		expect(share).toContain("resolveFolderEffectiveCategory(");
		expect(share).not.toContain("eq(categories.ownerId, userId)");
	});

	test("document index status reads and refresh writes use effective category scope", async () => {
		const source = await routeSource("documents");
		const statusStart = source.indexOf('.get("/documents/:id/index-status"');
		const refreshStart = source.indexOf('.post("/documents/:id/index/refresh"');
		const statusRoute = source.slice(statusStart, refreshStart);
		const refreshRoute = source.slice(
			refreshStart,
			source.indexOf('.get("/documents/:id"', refreshStart),
		);
		expect(statusRoute).toContain('canAccessContent(access, "read")');
		expect(statusRoute).toContain("effectiveDocumentCategoryCondition(");
		expect(refreshRoute).toContain('canAccessContent(access, "write")');
		expect(refreshRoute).toContain("effectiveDocumentCategoryCondition(");
	});

	test("versions enforce read for retrieval and edit for snapshots/restores", async () => {
		const source = await routeSource("versions");
		expect(
			source.match(
				/authorizeVersionDocument\([\s\S]*?params\.id,[\s\S]*?"read"/g,
			),
		).toHaveLength(3);
		expect(
			source.match(
				/authorizeVersionDocument\([\s\S]*?params\.id,[\s\S]*?"edit"/g,
			),
		).toHaveLength(2);
		expect(source).toContain("effectiveDocumentCategoryCondition(");
	});

	test("document tag assignment is edit-scoped and category-bounded", async () => {
		const source = await routeSource("tags");
		expect(source.match(/canAccessContent\(access, "edit"\)/g)).toHaveLength(2);
		expect(source.match(/effectiveDocumentCategoryCondition\(/g)).toHaveLength(
			3,
		);
	});

	test("share and visibility mutations require write scope", async () => {
		const share = await routeSource("share");
		const visibility = await routeSource("visibility");
		expect(share).toContain('canAccessContent(access, "write")');
		expect(share).toContain("resolveFolderEffectiveCategory");
		expect(
			visibility.match(/canAccessContent\(access, "write"\)/g),
		).toHaveLength(2);
		expect(
			visibility.match(/effectiveDocumentCategoryCondition\(/g),
		).toHaveLength(2);
	});
});

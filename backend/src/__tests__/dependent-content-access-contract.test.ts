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
		expect(source).toContain("effectiveDocumentCategory(row)");
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
		expect(source).toContain("effectiveDocumentCategory(row)");
	});

	test("document tag assignment is edit-scoped and category-bounded", async () => {
		const source = await routeSource("tags");
		expect(source.match(/canAccessContent\(access, "edit"\)/g)).toHaveLength(2);
		expect(
			source.match(
				/isAuthorizedCategory\(access, effectiveDocumentCategory\(doc\)\)/g,
			),
		).toHaveLength(2);
	});

	test("share and visibility mutations require write scope", async () => {
		const share = await routeSource("share");
		const visibility = await routeSource("visibility");
		expect(share).toContain('canAccessContent(access, "write")');
		expect(share).toContain("resolveFolderEffectiveCategory");
		expect(
			visibility.match(/canAccessContent\(access, "write"\)/g),
		).toHaveLength(2);
		expect(visibility.match(/effectiveDocumentCategory\(doc\)/g)).toHaveLength(
			2,
		);
	});
});

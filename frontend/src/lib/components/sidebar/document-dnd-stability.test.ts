import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/FolderTree.svelte`).text();
const folderNodeSource = await Bun.file(
	`${import.meta.dir}/FolderNode.svelte`,
).text();

describe("document drag-and-drop stability", () => {
	test("uses the finalized document and the release point for header drops", () => {
		expect(source).toContain("const documentId = String(info.id)");
		expect(source).toContain('finishPointerDrag("doc", documentId)');
		expect(source).toContain(
			"pointerDrag.target = pointerDrag.cancelled ? null : headerAtPointer()",
		);
		expect(source).toContain("documentDropCoordinator.zone(");
		expect(source).not.toContain("ondrop=");
		expect(folderNodeSource).not.toContain("ondrop=");
	});

	test("loads subfolders for both a click and a drag expansion", () => {
		expect(folderNodeSource).toContain("if (isExpanded) {");
		expect(folderNodeSource).toContain(
			"if (!subfoldersLoaded && !subfoldersLoading) void loadSubfolders()",
		);
	});

	test("protects the optimistic move from concurrent sidebar refreshes", () => {
		expect(source).toContain("createDocumentPlacementWriter({");
		expect(source).toContain("acknowledge: acknowledgeDocumentPlacement");
	});

	test("uses fast cursor-based detection for every document drop zone", () => {
		expect(source).toContain("const DOCUMENT_FLIP_MS = 80");
		const documentZones = source.match(/type: ["']doc["']/g) ?? [];
		const cursorDetection = source.match(/useCursorForDetection: true/g) ?? [];
		const cursorCentering = source.match(/centreDraggedOnCursor: true/g) ?? [];
		expect(cursorDetection).toHaveLength(documentZones.length);
		expect(cursorCentering).toHaveLength(documentZones.length);
		expect(source).toContain("folderFlipDurationMs={FLIP_MS}");
		expect(source).toContain("documentFlipDurationMs={DOCUMENT_FLIP_MS}");
		expect(folderNodeSource).toContain(
			"flipDurationMs: documentFlipDurationMs",
		);
		expect(folderNodeSource).toContain(
			"animate:flip={{ duration: documentFlipDurationMs }}",
		);
		expect(folderNodeSource).toContain("useCursorForDetection: true");
		expect(folderNodeSource).toContain("centreDraggedOnCursor: true");
	});

	test("keeps folder and category motion on the original timing", () => {
		expect(source).toContain("folderFlipDurationMs={FLIP_MS}");
		expect(folderNodeSource).toContain("flipDurationMs: folderFlipDurationMs");
		expect(folderNodeSource).toContain(
			"animate:flip={{ duration: folderFlipDurationMs }}",
		);
	});
});

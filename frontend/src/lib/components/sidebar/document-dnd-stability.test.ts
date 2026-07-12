import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/FolderTree.svelte`).text();
const folderNodeSource = await Bun.file(
	`${import.meta.dir}/FolderNode.svelte`,
).text();

describe("document drag-and-drop stability", () => {
	test("persists only the document reported by the finalize event", () => {
		expect(source).toContain(
			"const finalizedDocumentId = e.detail.info?.id ?? draggedDocId",
		);
		expect(source).toContain("documentDropCoordinator.zone(");
		expect(source).toContain(
			"const finalizedDocumentId = e.detail.info?.id ?? draggedDocId",
		);
		expect(source).not.toContain("for (const item of zoneItems)");
	});

	test("keeps the dragged id until native header drop has fired", () => {
		expect(source).toContain("window.setTimeout(() => {");
		expect(source).toContain(
			"if (draggedDocId === finalizedDocumentId) draggedDocId = null",
		);
	});

	test("protects the optimistic move from concurrent sidebar refreshes", () => {
		expect(source).toContain("createDocumentPlacementWriter({");
		expect(source).toContain("acknowledge: acknowledgeDocumentPlacement");
	});

	test("uses fast cursor-based detection for every document drop zone", () => {
		expect(source).toContain("const DOCUMENT_FLIP_MS = 80");
		const documentZones = source.match(/type: "doc"/g) ?? [];
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

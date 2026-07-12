import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/FolderTree.svelte`).text();

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
		expect(source).toContain("flipDurationMs={DOCUMENT_FLIP_MS}");
	});
});

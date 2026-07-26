import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	LARGE_MARKDOWN_THRESHOLD,
	shouldDeferMarkdownParsing,
} from "./large-markdown";

const editorSource = readFileSync(
	new URL("./HiAiEditor.svelte", import.meta.url),
	"utf8",
);

describe("large markdown loading", () => {
	test("defers parsing only for genuinely large imported markdown", () => {
		expect(
			shouldDeferMarkdownParsing("x".repeat(LARGE_MARKDOWN_THRESHOLD)),
		).toBe(false);
		expect(
			shouldDeferMarkdownParsing("x".repeat(LARGE_MARKDOWN_THRESHOLD + 1)),
		).toBe(true);
	});

	test("persists the background markdown parse as contentJson", () => {
		expect(editorSource).toContain(
			"onUpdate({ markdown: source, json: parsed })",
		);
	});

	test("starts background parsing only after the editor exists and does not wait for idle time", () => {
		const subscription = editorSource.slice(
			editorSource.indexOf("const unsubscribe = editorStore.subscribe"),
			editorSource.indexOf("// Imported documents may reference attachments"),
		);

		expect(subscription).toContain("scheduleDeferredMarkdownParse(ed)");
		expect(editorSource).toContain("requestAnimationFrame");
		expect(editorSource).not.toContain("requestIdleCallback");
		expect(editorSource).toContain("Preparing large document…");
		expect(editorSource).toContain("aria-busy={deferredContentLoading}");
	});
});

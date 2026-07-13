import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const toolbarSource = readFileSync(
	new URL("./EditorToolbar.svelte", import.meta.url),
	"utf8",
);
const editorSource = readFileSync(
	new URL("./HiAiEditor.svelte", import.meta.url),
	"utf8",
);
const markdownSource = readFileSync(
	new URL("./MarkdownToggle.svelte", import.meta.url),
	"utf8",
);

describe("editor theme presentation", () => {
	test("darkens portable highlight colors without changing their stored values", () => {
		expect(toolbarSource).toContain("rgb(0 0 0 / 62%)");
		expect(toolbarSource).toContain("background-blend-mode: multiply");
		expect(editorSource).toContain(":global(.dark) .editor-content");
		expect(editorSource).toContain("color: #fff");
	});

	test("raw Markdown is page-height, auto-growing, and has no fake resize handle", () => {
		expect(markdownSource).toContain(
			"min-height: max(720px, calc(100vh - 180px))",
		);
		expect(markdownSource).toContain("resize: none");
		expect(markdownSource).toContain("overflow-y: hidden");
		expect(markdownSource).toMatch(
			/textarea\.style\.height = `\$\{textarea\.scrollHeight\}px`/,
		);
		expect(markdownSource).not.toContain("max-height:");
	});
});

// editorExtensions.test.ts — Tests for the textAlign-aware paragraph / heading
// extensions. The node names registered by `@tiptap/starter-kit`'s bundled
// paragraph/heading get overridden in editorExtensions.ts, so the roundtrip
// between JSON and markdown must preserve `textAlign` (otherwise switching to
// the MarkdownToggle view silently drops alignment when the doc reloads from
// the markdown fallback path).
//
// We exercise the behaviour through `@tiptap/markdown`'s `MarkdownManager`
// rather than instantiating a full `Editor` — the editor requires a DOM
// `window` for its default top-node element, which isn't available in the
// bun-test runner (`MarkdownManager` only needs the schema).

import { describe, expect, test } from "bun:test";
import type { JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import {
	editorExtensions,
	TextAlignHeading,
	TextAlignParagraph,
} from "./editorExtensions";

function makeManager(): MarkdownManager {
	// The shared manager + editor instance constructed by the live app is
	// fine, but tests need to inspect the schema independently — build a
	// private one so we don't mutate the shared singleton.
	return new MarkdownManager({ extensions: editorExtensions });
}

describe("Resizable image", () => {
	test("uses TipTap's native aspect-ratio-preserving resize node view", () => {
		const image = editorExtensions.find(
			(extension) => extension.name === "image",
		);
		expect(image).toBeDefined();
		const options = image?.options as { resize?: unknown } | undefined;
		expect(options?.resize).toEqual({
			enabled: true,
			directions: ["top-left", "top-right", "bottom-left", "bottom-right"],
			minWidth: 96,
			minHeight: 54,
			alwaysPreserveAspectRatio: true,
		});
	});
});

describe("TextAlignParagraph", () => {
	test("registers under the `paragraph` node name", () => {
		expect(TextAlignParagraph.name).toBe("paragraph");
	});

	test("StarterKit has `paragraph` / `heading` disabled so the swap-in wins", () => {
		const names = editorExtensions.map((ext) => ext.name);
		const starterKit = editorExtensions.find(
			(ext) => ext.name === "starterKit",
		);
		expect(starterKit).toBeDefined();
		const options = (
			starterKit as unknown as {
				options: Record<string, unknown>;
			}
		).options;
		expect(options.paragraph).toBe(false);
		expect(options.heading).toBe(false);
		expect(names).toContain("paragraph");
		expect(names).toContain("heading");
	});

	test("emits plain markdown for left-aligned paragraphs (no inline HTML)", () => {
		const manager = makeManager();
		const doc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "left" },
					content: [{ type: "text", text: "hello" }],
				},
			],
		};
		const md = manager.serialize(doc);
		expect(md).toContain("hello");
		expect(md).not.toContain("<p");
		expect(md).not.toContain("text-align");
	});

	test("emits inline HTML for centered paragraphs", () => {
		const manager = makeManager();
		const doc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "center" },
					content: [{ type: "text", text: "middle" }],
				},
			],
		};
		const md = manager.serialize(doc);
		expect(md).toContain('<p style="text-align: center">middle</p>');
	});

	test("emits inline HTML for right- and justify-aligned paragraphs", () => {
		const manager = makeManager();
		const rightDoc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "right" },
					content: [{ type: "text", text: "biased" }],
				},
			],
		};
		expect(manager.serialize(rightDoc)).toContain(
			'<p style="text-align: right">biased</p>',
		);
		const justifyDoc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "justify" },
					content: [{ type: "text", text: "spread" }],
				},
			],
		};
		expect(manager.serialize(justifyDoc)).toContain(
			'<p style="text-align: justify">spread</p>',
		);
	});

	test("survives a markdown → JSON → markdown roundtrip for aligned paragraphs", () => {
		const manager = makeManager();
		const doc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "right" },
					content: [{ type: "text", text: "biased" }],
				},
			],
		};
		const md = manager.serialize(doc);
		// A second pass through `serialize` should yield the same HTML
		// form — no alignment should have been lost in the meantime.
		const reDoc = manager.parse(md);
		const reMd = manager.serialize(reDoc);
		expect(reMd).toContain("text-align: right");
		expect(reMd).toContain("biased");
	});
});

describe("TextAlignHeading", () => {
	test("registers under the `heading` node name", () => {
		expect(TextAlignHeading.name).toBe("heading");
	});

	test("emits `# ` markdown for left-aligned headings", () => {
		const manager = makeManager();
		const doc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 1, textAlign: "left" },
					content: [{ type: "text", text: "title" }],
				},
			],
		};
		const md = manager.serialize(doc);
		expect(md).toContain("# title");
		expect(md).not.toContain("<h1");
	});

	test("emits inline HTML for centered headings", () => {
		const manager = makeManager();
		const doc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 2, textAlign: "center" },
					content: [{ type: "text", text: "subtitle" }],
				},
			],
		};
		const md = manager.serialize(doc);
		expect(md).toContain('<h2 style="text-align: center">subtitle</h2>');
	});

	test("survives a markdown → JSON → markdown roundtrip for aligned headings", () => {
		const manager = makeManager();
		const doc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 3, textAlign: "justify" },
					content: [{ type: "text", text: "spread" }],
				},
			],
		};
		const md = manager.serialize(doc);
		const reDoc = manager.parse(md);
		const reMd = manager.serialize(reDoc);
		expect(reMd).toContain("text-align: justify");
		expect(reMd).toContain("spread");
	});
});

describe("textAlign attribute injection", () => {
	test("TextAlign.configure({ types: ['heading', 'paragraph'] }) targets the swapped-in nodes", () => {
		const manager = makeManager();
		// Serializing the doc with a `textAlign` attribute is what exercises
		// the global-attribute injection — if the customized paragraph /
		// heading were not the resolved node type, the rendered markdown
		// would not contain the inline-HTML alignment form.
		const doc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "center" },
					content: [{ type: "text", text: "x" }],
				},
				{
					type: "heading",
					attrs: { level: 1, textAlign: "right" },
					content: [{ type: "text", text: "y" }],
				},
			],
		};
		const md = manager.serialize(doc);
		expect(md).toContain('<p style="text-align: center">x</p>');
		expect(md).toContain('<h1 style="text-align: right">y</h1>');
	});

	test("list rendering still works after the extension swap", () => {
		// Bullet / ordered / task lists continued to render markers after
		// the StarterKit-paragraph / -heading swap. The serializer should
		// emit the normal markdown tokens.
		const manager = makeManager();
		const doc: JSONContent = {
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "one" }],
								},
							],
						},
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "two" }],
								},
							],
						},
					],
				},
				{
					type: "orderedList",
					content: [
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "first" }],
								},
							],
						},
					],
				},
				{
					type: "taskList",
					content: [
						{
							type: "taskItem",
							attrs: { checked: false },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "todo" }],
								},
							],
						},
					],
				},
			],
		};
		const md = manager.serialize(doc);
		expect(md).toContain("- one");
		expect(md).toContain("- two");
		expect(md).toContain("1. first");
		expect(md).toMatch(/\[\s\]\s*todo/);
	});
});

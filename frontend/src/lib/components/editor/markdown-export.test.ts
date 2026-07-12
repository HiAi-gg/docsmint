import { describe, expect, test } from "bun:test";
import { serializeMarkdownExport } from "./markdown-export";

describe("Markdown export", () => {
	test("preserves images, tables, lists, task items, marks, and unknown wrappers", () => {
		const markdown = serializeMarkdownExport(
			{
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{ type: "text", text: "Bold", marks: [{ type: "bold" }] },
						],
					},
					{
						type: "image",
						attrs: { src: "/api/attachments/image-id/raw", alt: "Diagram" },
					},
					{
						type: "table",
						content: [
							{
								type: "tableRow",
								content: [
									{
										type: "tableHeader",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "Name" }],
											},
										],
									},
									{
										type: "tableHeader",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "Value" }],
											},
										],
									},
								],
							},
							{
								type: "tableRow",
								content: [
									{
										type: "tableCell",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "A|B" }],
											},
										],
									},
									{
										type: "tableCell",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "1" }],
											},
										],
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
								attrs: { checked: true },
								content: [
									{
										type: "paragraph",
										content: [{ type: "text", text: "Done" }],
									},
								],
							},
						],
					},
					{
						type: "customWrapper",
						content: [
							{ type: "paragraph", content: [{ type: "text", text: "Kept" }] },
						],
					},
				],
			},
			"fallback",
			{ baseUrl: "http://localhost:50701/docs/id" },
		);

		expect(markdown).toContain("**Bold**");
		expect(markdown).toContain(
			"![Diagram](http://localhost:50701/api/attachments/image-id/raw)",
		);
		expect(markdown).toContain("| Name | Value |");
		expect(markdown).toContain("| A\\|B | 1 |");
		expect(markdown).toContain("- [x] Done");
		expect(markdown).toContain("Kept");
	});

	test("keeps the stored markdown when editor JSON is unavailable", () => {
		expect(serializeMarkdownExport(undefined, "# Existing\n")).toBe(
			"# Existing\n",
		);
	});

	test("preserves resized image dimensions with portable HTML", () => {
		const markdown = serializeMarkdownExport(
			{
				type: "doc",
				content: [
					{
						type: "image",
						attrs: {
							src: "/image.png",
							alt: "Diagram",
							width: 320,
							height: 180,
						},
					},
				],
			},
			"",
			{ baseUrl: "http://localhost:50701/docs/id" },
		);
		expect(markdown.trim()).toBe(
			'<img src="http://localhost:50701/image.png" alt="Diagram" width="320" height="180" />',
		);
	});

	test("does not emit executable URL schemes from document JSON", () => {
		const markdown = serializeMarkdownExport(
			{
				type: "doc",
				content: [
					{ type: "image", attrs: { src: "javascript:alert(1)" } },
					{
						type: "paragraph",
						content: [
							{
								type: "text",
								text: "unsafe",
								marks: [
									{ type: "link", attrs: { href: "javascript:alert(1)" } },
								],
							},
						],
					},
				],
			},
			"",
		);
		expect(markdown).not.toContain("javascript:");
		expect(markdown).toContain("![image](#)");
		expect(markdown).toContain("[unsafe](#)");
	});

	test("preserves a raw imported table when legacy JSON lost the table node", () => {
		const imported =
			"|\n| | | | | ----- | :---: | | **Products** | | Milk - 120 ml | |";
		const markdown = serializeMarkdownExport(
			{
				type: "doc",
				content: [{ type: "paragraph", content: [] }],
			},
			imported,
		);
		expect(markdown).toBe(imported);
	});
});

import { describe, expect, test } from "bun:test";
import {
	renderSharedDocument,
	sharedAttachmentHeaders,
} from "./shared-document";

describe("shared document renderer", () => {
	test("preserves paragraph and heading alignment", () => {
		const html = renderSharedDocument({
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "right" },
					content: [{ type: "text", text: "right" }],
				},
				{
					type: "heading",
					attrs: { level: 2, textAlign: "center" },
					content: [{ type: "text", text: "center" }],
				},
			],
		});
		expect(html).toContain('<p style="text-align: right">right</p>');
		expect(html).toContain('<h2 style="text-align: center">center</h2>');
	});

	test("renders bullet and ordered list items with their content and start", () => {
		const html = renderSharedDocument({
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
									content: [{ type: "text", text: "bullet" }],
								},
							],
						},
					],
				},
				{
					type: "orderedList",
					attrs: { start: 3 },
					content: [
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "third" }],
								},
							],
						},
					],
				},
			],
		});
		expect(html).toContain("<ul><li><p>bullet</p></li></ul>");
		expect(html).toContain('<ol start="3"><li><p>third</p></li></ol>');
	});

	test("flattens invalid imported block nodes inside headings", () => {
		const html = renderSharedDocument({
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 1 },
					content: [
						{ type: "paragraph", content: [{ type: "text", text: "nested " }] },
						{ type: "text", text: "title" },
					],
				},
			],
		});
		expect(html).toBe("<h1>nested title</h1>");
		expect(html).not.toContain("<h1><p>");
	});

	test("defers protected images and sends the share credentials as headers", () => {
		const html = renderSharedDocument({
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "/api/attachments/f06e1f36-134c-43fd-9a76-c8e385c5efeb/raw",
						alt: "linkedin.png",
					},
				},
			],
		});
		expect(html).toContain(
			'data-shared-attachment-src="/api/attachments/f06e1f36-134c-43fd-9a76-c8e385c5efeb/raw"',
		);
		expect(html).not.toContain(' src="/api/attachments/');
		expect(sharedAttachmentHeaders("share-token", "secret")).toEqual({
			"x-share-token": "share-token",
			"x-share-password": "secret",
		});
	});

	test("blocks unsafe link protocols in public HTML", () => {
		const html = renderSharedDocument({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "unsafe",
							marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
						},
					],
				},
			],
		});
		expect(html).toContain('<a href="#"');
		expect(html).not.toContain("javascript:");
	});
});

import { describe, expect, test } from "bun:test";
import {
	hydrateSharedAttachmentImages,
	markMarkdownTaskItems,
	renderSharedDocument,
	sharedAttachmentHeaders,
	waitForSharedDocumentImages,
} from "./shared-document";

describe("PDF task-list HTML normalization", () => {
	test("marks checkbox list items so they do not render a second bullet", () => {
		const html = '<ul><li><input checked type="checkbox"> done</li></ul>';
		const normalized = markMarkdownTaskItems(html);
		expect(normalized).toContain('<li class="task-list-item"><input');
		expect(normalized).not.toContain("<li><input");
	});

	test("renders task content beside its checkbox for print layouts", () => {
		const html = renderSharedDocument({
			type: "doc",
			content: [
				{
					type: "taskList",
					content: [
						{
							type: "taskItem",
							attrs: { checked: true },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "done" }],
								},
							],
						},
					],
				},
			],
		});
		expect(html).toContain(
			'<li data-type="taskItem" data-checked="true"><label><input type="checkbox" disabled checked /></label><div><p>done</p></div></li>',
		);
	});
});

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

	test("preserves resized image dimensions in shared and PDF HTML", () => {
		const html = renderSharedDocument({
			type: "doc",
			content: [
				{
					type: "image",
					attrs: { src: "/image.png", alt: "Diagram", width: 420, height: 236 },
				},
			],
		});
		expect(html).toContain('width="420" height="236"');
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

	test("hydrates only protected attachment placeholders", async () => {
		const images: Array<{
			dataset: { sharedAttachmentSrc?: string };
			src: string;
			removeAttribute(name: string): void;
		}> = [
			{
				dataset: {
					sharedAttachmentSrc:
						"/api/attachments/11111111-1111-1111-1111-111111111111/raw",
				},
				src: "",
				removeAttribute(name: string) {
					if (name === "data-shared-attachment-src") {
						delete this.dataset.sharedAttachmentSrc;
					}
				},
			},
		];
		const root = {
			querySelectorAll: () => images,
		};
		const originalFetch = globalThis.fetch;
		const originalUrl = globalThis.URL;
		globalThis.fetch = (async () =>
			new Response(new Blob(["image"]), {
				status: 200,
			})) as unknown as typeof fetch;
		globalThis.URL = {
			...originalUrl,
			createObjectURL: () => "blob:shared-image",
		} as unknown as typeof URL;

		try {
			const objectUrls = await hydrateSharedAttachmentImages(
				root as unknown as ParentNode,
				"share-token",
			);
			expect(objectUrls).toEqual(["blob:shared-image"]);
			expect(images[0].src).toBe("blob:shared-image");
			expect(images[0].dataset.sharedAttachmentSrc).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
			globalThis.URL = originalUrl;
		}
	});

	test("waits for print images before export", async () => {
		let decoded = 0;
		const root = {
			querySelectorAll: () => [
				{ complete: true },
				{
					complete: false,
					async decode() {
						decoded += 1;
					},
				},
			],
		};

		await waitForSharedDocumentImages(root as unknown as ParentNode);
		expect(decoded).toBe(1);
	});
});

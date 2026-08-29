import { describe, expect, test } from "bun:test";
import {
	emojiGlyphFromImageAttrs,
	removeUnavailableAttachmentImages,
	sanitizeEditorContent,
} from "./editor-content-sanitizer";

describe("editor content sanitizer", () => {
	test("drops relative image sources that would request document routes", () => {
		const result = sanitizeEditorContent({
			type: "doc",
			content: [
				{ type: "image", attrs: { src: "image" } },
				{ type: "image", attrs: { src: "./code-icon" } },
				{ type: "image", attrs: { src: "../analytics-icon" } },
				{
					type: "image",
					attrs: {
						src: "/w/personal-workspace/documents/storage-icon",
					},
				},
				{
					type: "image",
					attrs: {
						src: "/api/attachments/00000000-0000-0000-0000-000000000001/raw",
					},
				},
				{ type: "image", attrs: { src: "https://cdn.example.com/image.png" } },
			],
		});

		expect(result.content).toEqual([
			{
				type: "image",
				attrs: {
					src: "/api/attachments/00000000-0000-0000-0000-000000000001/raw",
				},
			},
			{ type: "image", attrs: { src: "https://cdn.example.com/image.png" } },
		]);
	});

	test("turns Twitter emoji SVGs into Unicode glyphs", () => {
		expect(
			emojiGlyphFromImageAttrs({
				src: "https://abs.twimg.com/emoji/v2/svg/1f916.svg",
				alt: "🤖",
			}),
		).toBe("🤖");
		expect(
			emojiGlyphFromImageAttrs({
				src: "https://abs.twimg.com/emoji/v2/svg/33-20e3.svg",
				alt: "",
			}),
		).toBe("3⃣");
		expect(
			emojiGlyphFromImageAttrs({
				src: "https://pbs.twimg.com/profile_images/photo.jpg",
				alt: "",
			}),
		).toBeNull();
		expect(
			emojiGlyphFromImageAttrs({
				src: "https://example.com/robot.png",
				alt: "🤖",
			}),
		).toBeNull();
		expect(
			emojiGlyphFromImageAttrs({
				src: "https://abs.twimg.com/emoji/v2/svg/1f916.svg",
				alt: "🤖",
				width: 248,
				height: 248,
			}),
		).toBeNull();

		const result = sanitizeEditorContent({
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "https://abs.twimg.com/emoji/v2/svg/1f916.svg",
						alt: "🤖",
					},
				},
				{
					type: "image",
					attrs: {
						src: "https://pbs.twimg.com/profile_images/photo.jpg",
						alt: "",
					},
				},
			],
		});
		expect(result.content).toEqual([
			{ type: "paragraph", content: [{ type: "text", text: "🤖" }] },
			{
				type: "image",
				attrs: {
					src: "https://pbs.twimg.com/profile_images/photo.jpg",
					alt: "",
				},
			},
		]);
	});

	test("lifts block images out of paragraphs without dropping external images", () => {
		const result = sanitizeEditorContent({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Before" },
						{ type: "image", attrs: { src: "https://example.com/image.png" } },
						{ type: "text", text: "After" },
					],
				},
			],
		});

		expect(result).toEqual({
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Before" }] },
				{ type: "image", attrs: { src: "https://example.com/image.png" } },
				{ type: "paragraph", content: [{ type: "text", text: "After" }] },
			],
		});
	});

	test("removes only attachment images whose raw endpoint is unavailable", async () => {
		const source = {
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "/api/attachments/00000000-0000-0000-0000-000000000001/raw",
					},
				},
				{
					type: "image",
					attrs: {
						src: "/api/attachments/00000000-0000-0000-0000-000000000002/raw",
					},
				},
			],
		};
		const result = await removeUnavailableAttachmentImages(
			source,
			async (input) =>
				new Response(null, {
					status: String(input).includes("000000000001") ? 404 : 200,
				}),
		);

		expect(result.removed).toBe(1);
		expect(result.content.content).toHaveLength(1);
	});
});

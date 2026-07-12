import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { Packer } from "docx";
import {
	createDocxImageFetcher,
	createPlainTextDocxBlob,
	normalizeDocxDocumentJson,
} from "./docx-export";
import { customAsyncNodes, customSerializerAsync } from "./docx-serializer";
import { editorExtensions } from "./editorExtensions";

const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("createDocxImageFetcher", () => {
	test("fetches protected same-origin attachments with the share headers and caches bytes", async () => {
		const calls: Array<[string, RequestInit | undefined]> = [];
		const fetchImpl = async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			calls.push([String(input), init]);
			return new Response(Uint8Array.from([1, 2, 3]), {
				status: 200,
				headers: {
					"content-type": "image/png",
					"content-length": "3",
				},
			});
		};
		const fetcher = createDocxImageFetcher({
			headers: { "x-share-token": "share-token" },
			fetchImpl,
		});

		expect(await fetcher.getImageType("/api/attachments/1/raw")).toBe("png");
		expect(await fetcher.getImageBuffer("/api/attachments/1/raw")).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("http://localhost/api/attachments/1/raw");
		expect(calls[0]?.[1]).toMatchObject({
			credentials: "include",
			headers: { "x-share-token": "share-token" },
		});
	});

	test("does not forward share credentials to external image hosts", async () => {
		let request: RequestInit | undefined;
		const fetchImpl = async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			request = init;
			return new Response(Uint8Array.from([1]), {
				status: 200,
				headers: { "content-type": "image/jpeg" },
			});
		};
		const fetcher = createDocxImageFetcher({
			headers: { "x-share-token": "must-not-leak" },
			fetchImpl,
		});

		expect(
			await fetcher.getImageType("https://images.example.test/photo"),
		).toBe("jpg");
		expect(request).toMatchObject({ credentials: "omit" });
		expect(request?.headers).toBeUndefined();
	});

	test("routes document remote images through the authenticated same-origin bridge", async () => {
		let requestUrl = "";
		let request: RequestInit | undefined;
		const fetcher = createDocxImageFetcher({
			documentId: "doc-1",
			headers: { "x-share-token": "share-token" },
			fetchImpl: async (input, init) => {
				requestUrl = String(input);
				request = init;
				return new Response(Uint8Array.from([1]), {
					headers: { "content-type": "image/png" },
				});
			},
		});

		await fetcher.getImageBuffer("https://images.example.test/photo.png");
		expect(requestUrl).toContain("/api/attachments/remote-image?");
		expect(requestUrl).toContain("documentId=doc-1");
		expect(requestUrl).toContain(
			encodeURIComponent("https://images.example.test/photo.png"),
		);
		expect(request).toMatchObject({
			credentials: "include",
			headers: { "x-share-token": "share-token" },
		});
	});

	test("decodes inline image data without a network request", async () => {
		let called = false;
		const fetcher = createDocxImageFetcher({
			fetchImpl: async () => {
				called = true;
				throw new Error("network should not be used");
			},
		});
		const src = `data:image/png;base64,${ONE_PIXEL_PNG}`;

		expect(await fetcher.getImageType(src)).toBe("png");
		expect((await fetcher.getImageBuffer(src)).byteLength).toBeGreaterThan(20);
		expect(called).toBe(false);
	});

	test("rejects oversized image responses before export", async () => {
		const fetcher = createDocxImageFetcher({
			maxBytes: 2,
			fetchImpl: async () =>
				new Response(Uint8Array.from([1, 2, 3]), {
					status: 200,
					headers: {
						"content-type": "image/png",
						"content-length": "3",
					},
				}),
		});

		await expect(
			fetcher.getImageBuffer("/api/attachments/1/raw"),
		).rejects.toThrow("size limit");
	});
});

describe("DOCX document compatibility", () => {
	test("async serializer accepts an unnormalized task list node", async () => {
		expect(customAsyncNodes.taskList).toBeTypeOf("function");
		const schema = getSchema(editorExtensions);
		const docNode = Node.fromJSON(schema, {
			type: "doc",
			content: [
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
		});
		const wordDoc = await customSerializerAsync.serializeAsync(docNode, {
			sections: [{ properties: {} }],
		} as Parameters<typeof customSerializerAsync.serializeAsync>[1]);
		const bytes = new Uint8Array(
			await (await Packer.toBlob(wordDoc)).arrayBuffer(),
		);
		expect(String.fromCharCode(...bytes.slice(0, 2))).toBe("PK");
	});

	test("converts task lists into supported bullet lists", () => {
		const normalized = normalizeDocxDocumentJson({
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

		expect(normalized.content[0]?.type).toBe("bulletList");
		expect(normalized.content[0]?.content?.[0]?.type).toBe("listItem");
		expect(normalized.content[0]?.content?.[0]?.attrs).toBeUndefined();
	});

	test("plain-text fallback is a valid ZIP-based DOCX", async () => {
		const blob = await createPlainTextDocxBlob("Title", "Line one\nLine two");
		const bytes = new Uint8Array(await blob.arrayBuffer());
		expect(String.fromCharCode(...bytes.slice(0, 2))).toBe("PK");
		expect(blob.type).toContain("wordprocessingml.document");
	});

	test("serializes normalized task lists and embeds inline images", async () => {
		const schema = getSchema(editorExtensions);
		const json = normalizeDocxDocumentJson({
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
									content: [{ type: "text", text: "with image" }],
								},
							],
						},
					],
				},
				{
					type: "paragraph",
					content: [
						{
							type: "image",
							attrs: { src: `data:image/png;base64,${ONE_PIXEL_PNG}` },
						},
					],
				},
			],
		});
		const docNode = Node.fromJSON(schema, json);
		const fetcher = createDocxImageFetcher();
		const wordDoc = await customSerializerAsync.serializeAsync(docNode, {
			getImageBuffer: fetcher.getImageBuffer,
			getImageType: fetcher.getImageType,
			sections: [{ properties: {} }],
		} as Parameters<typeof customSerializerAsync.serializeAsync>[1]);
		const blob = await Packer.toBlob(wordDoc);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const zipText = new TextDecoder().decode(bytes);
		expect(String.fromCharCode(...bytes.slice(0, 2))).toBe("PK");
		expect(zipText).toMatch(/word\/media\/[^/]+\.png/);
	});
});

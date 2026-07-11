import { describe, expect, test } from "bun:test";
import {
	createDocxImageFetcher,
	createPlainTextDocxBlob,
	normalizeDocxDocumentJson,
} from "./docx-export";

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
});

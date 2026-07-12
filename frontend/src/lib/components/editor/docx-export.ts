import { Document, Packer, Paragraph, TextRun } from "docx";

const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type DocxImageType = "jpg" | "png" | "gif" | "bmp";

type DocxFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface DocxImageFetcherOptions {
	headers?: HeadersInit;
	documentId?: string;
	maxBytes?: number;
	fetchImpl?: DocxFetch;
}

export interface DocxImageFetcher {
	getImageBuffer: (src: string) => Promise<Uint8Array>;
	getImageType: (src: string) => Promise<DocxImageType>;
}

interface ResolvedImage {
	buffer: Uint8Array;
	type: DocxImageType;
}

type ProseMirrorJsonNode = {
	type?: string;
	attrs?: Record<string, unknown>;
	content?: ProseMirrorJsonNode[];
	[key: string]: unknown;
};

/** Convert editor-only task nodes to structures supported by prosemirror-docx. */
export function normalizeDocxDocumentJson<T extends object>(document: T): T {
	const normalizeNode = (node: ProseMirrorJsonNode): ProseMirrorJsonNode => {
		const normalizedType =
			node.type === "taskList"
				? "bulletList"
				: node.type === "taskItem"
					? "listItem"
					: node.type;
		const normalized: ProseMirrorJsonNode = {
			...node,
			...(normalizedType ? { type: normalizedType } : {}),
			...(node.content
				? { content: node.content.map((child) => normalizeNode(child)) }
				: {}),
		};
		if (node.type === "taskItem") delete normalized.attrs;
		return normalized;
	};

	return normalizeNode(document as ProseMirrorJsonNode) as T;
}

/** Always produce a valid DOCX if the rich serializer rejects an unknown node. */
export async function createPlainTextDocxBlob(
	title: string,
	content: string,
): Promise<Blob> {
	const document = new Document({
		sections: [
			{
				children: [
					new Paragraph({
						children: [new TextRun({ text: title, bold: true })],
					}),
					...content.split(/\r?\n/).map((line) => new Paragraph(line)),
				],
			},
		],
	});
	return Packer.toBlob(document);
}

const MIME_TO_TYPE: Record<string, DocxImageType> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/bmp": "bmp",
};

function browserOrigin(): string {
	if (typeof window !== "undefined" && window.location?.origin) {
		return window.location.origin;
	}
	return "http://localhost";
}

function typeFromSource(src: string): DocxImageType | undefined {
	const extension = src.split(/[?#]/, 1)[0].split(".").at(-1)?.toLowerCase();
	if (extension === "jpeg" || extension === "jpg") return "jpg";
	if (extension === "png") return "png";
	if (extension === "gif") return "gif";
	if (extension === "bmp") return "bmp";
	return undefined;
}

function typeFromMime(
	mime: string | null | undefined,
): DocxImageType | undefined {
	return MIME_TO_TYPE[(mime ?? "").split(";", 1)[0].trim().toLowerCase()];
}

function decodeDataUrl(src: string): ResolvedImage | undefined {
	const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(src);
	if (!match) return undefined;
	const type = typeFromMime(match[1]);
	if (!type)
		throw new Error("DOCX export supports only JPEG, PNG, GIF, and BMP images");
	const payload = match[3] ?? "";
	let buffer: Uint8Array;
	if (match[2]) {
		const binary = atob(payload);
		buffer = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} else {
		buffer = new TextEncoder().encode(decodeURIComponent(payload));
	}
	return { buffer, type };
}

/**
 * Build the image callbacks consumed by `DocxSerializerAsync`.
 *
 * Attachment URLs are fetched with the current browser session. Share pages
 * pass a share-token header through `headers`; it is only applied to same-
 * origin requests, so a public document cannot accidentally forward its
 * token to an external image host.
 */
export function createDocxImageFetcher(
	options: DocxImageFetcherOptions = {},
): DocxImageFetcher {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
	const cache = new Map<string, Promise<ResolvedImage>>();

	const resolve = (src: string): Promise<ResolvedImage> => {
		const cached = cache.get(src);
		if (cached) return cached;

		const pending = (async () => {
			const inline = decodeDataUrl(src);
			if (inline) {
				if (inline.buffer.byteLength > maxBytes) {
					throw new Error("Image exceeds the DOCX export size limit");
				}
				return inline;
			}

			const url = new URL(src, browserOrigin());
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error("DOCX export cannot fetch this image URL");
			}
			const sameOrigin = url.origin === browserOrigin();
			const requestUrl =
				!sameOrigin && options.documentId
					? new URL(
							`/api/attachments/remote-image?documentId=${encodeURIComponent(options.documentId)}&url=${encodeURIComponent(url.href)}`,
							browserOrigin(),
						)
					: url;
			const proxied = requestUrl !== url;
			const requestHeaders =
				sameOrigin || proxied ? options.headers : undefined;
			const response = await fetchImpl(requestUrl.href, {
				credentials: sameOrigin || proxied ? "include" : "omit",
				...(requestHeaders ? { headers: requestHeaders } : {}),
			});
			if (!response.ok) {
				throw new Error(`Image request failed with status ${response.status}`);
			}
			const declaredLength = Number(response.headers.get("content-length"));
			if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
				throw new Error("Image exceeds the DOCX export size limit");
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > maxBytes) {
				throw new Error("Image exceeds the DOCX export size limit");
			}
			const type =
				typeFromMime(response.headers.get("content-type")) ??
				typeFromSource(src);
			if (!type) {
				throw new Error("DOCX export could not determine the image type");
			}
			return { buffer: bytes, type };
		})();

		cache.set(src, pending);
		return pending;
	};

	return {
		getImageBuffer: async (src) => (await resolve(src)).buffer,
		getImageType: async (src) => (await resolve(src)).type,
	};
}

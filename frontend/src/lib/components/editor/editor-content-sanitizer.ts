const ATTACHMENT_RAW_URL = /^\/api\/attachments\/[0-9a-f-]+\/raw$/i;
const EMOJI_IMAGE_HOST =
	/(?:abs\.twimg\.com\/emoji\/|twemoji\.maxcdn\.com\/|(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\/(?:ajax\/libs\/)?twemoji)/i;
const EMOJI_SVG_CODEPOINTS =
	/\/(?:emoji\/v2\/svg|twemoji\/[\d.]+\/(?:svg|72x72))\/([0-9a-f][0-9a-f-]*)\.svg(?:[?#].*)?$/i;
/** Matches the editor image-resize floor; larger explicit sizes stay photos. */
const EMOJI_IMAGE_MAX_PX = 96;

type EditorNode = {
	type?: string;
	attrs?: Record<string, unknown>;
	content?: EditorNode[];
	text?: string;
	[key: string]: unknown;
};

function isEmojiGrapheme(segment: string): boolean {
	return (
		/^[\d#*]\uFE0F?\u20E3$/u.test(segment) ||
		/^\p{Extended_Pictographic}/u.test(segment)
	);
}

function isEmojiOnlyText(value: string): boolean {
	if (!value) return false;
	try {
		const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
		let count = 0;
		for (const { segment } of segmenter.segment(value)) {
			if (!isEmojiGrapheme(segment)) return false;
			count += 1;
		}
		return count > 0;
	} catch {
		return /^(?:\p{Extended_Pictographic}|\d\uFE0F?\u20E3)+$/u.test(value);
	}
}

function glyphFromEmojiSrc(src: string): string | null {
	const match = src.match(EMOJI_SVG_CODEPOINTS);
	if (!match?.[1] || !/(?:\/emoji\/|\/twemoji\/)/i.test(src)) return null;
	try {
		return match[1]
			.split("-")
			.map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
			.join("");
	} catch {
		return null;
	}
}

/**
 * Twitter / Twemoji paste the glyph as an SVG image. Share CSS then stretches
 * those viewBox-only SVGs to the full column. Return the Unicode glyph instead
 * unless the operator explicitly resized the node into a photo.
 */
export function emojiGlyphFromImageAttrs(
	attrs?: Record<string, unknown> | null,
): string | null {
	if (!attrs) return null;
	const src = typeof attrs.src === "string" ? attrs.src.trim() : "";
	const alt = typeof attrs.alt === "string" ? attrs.alt.trim() : "";
	const width = Number(attrs.width);
	const height = Number(attrs.height);
	const looksLikePhoto =
		Number.isFinite(width) &&
		width >= EMOJI_IMAGE_MAX_PX &&
		Number.isFinite(height) &&
		height >= EMOJI_IMAGE_MAX_PX;
	if (looksLikePhoto) return null;
	const fromSrc = glyphFromEmojiSrc(src);
	if (!EMOJI_IMAGE_HOST.test(src) && fromSrc === null) return null;
	const fromAlt = isEmojiOnlyText(alt) ? alt : null;
	return fromAlt ?? fromSrc;
}

function isAttachmentImage(node: EditorNode): boolean {
	return (
		node.type === "image" &&
		typeof node.attrs?.src === "string" &&
		ATTACHMENT_RAW_URL.test(node.attrs.src)
	);
}

export function isSafeEditorImageSource(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const src = value.trim();
	return (
		ATTACHMENT_RAW_URL.test(src) ||
		/^https?:\/\//i.test(src) ||
		/^blob:/i.test(src) ||
		/^data:image\//i.test(src)
	);
}

function isLoadableImage(node: EditorNode): boolean {
	if (node.type !== "image") return true;
	return isSafeEditorImageSource(node.attrs?.src);
}

function emojiParagraph(glyph: string): EditorNode {
	return { type: "paragraph", content: [{ type: "text", text: glyph }] };
}

function sanitizeNode(node: EditorNode): EditorNode[] {
	const emojiGlyph = emojiGlyphFromImageAttrs(node.attrs);
	if (node.type === "image" && emojiGlyph) return [emojiParagraph(emojiGlyph)];
	if (!isLoadableImage(node)) return [];
	if (!node.content) return [node];
	const children = node.content.flatMap((child) => sanitizeNode(child));
	if (node.type === "paragraph") {
		// The editor's image extension is block-level. Preserve imported or
		// externally hosted images by lifting them out of malformed paragraphs,
		// splitting surrounding inline content into valid paragraph siblings.
		const normalized: EditorNode[] = [];
		let inline: EditorNode[] = [];
		const flushInline = () => {
			if (inline.length === 0) return;
			normalized.push({ ...node, content: inline });
			inline = [];
		};
		for (const child of children) {
			if (child.type === "image" || child.type === "paragraph") {
				flushInline();
				normalized.push(child);
			} else {
				inline.push(child);
			}
		}
		flushInline();
		return normalized.length > 0 ? normalized : [{ ...node, content: [] }];
	}
	return [{ ...node, content: children }];
}

export function sanitizeEditorContent(value: object): EditorNode {
	const result = sanitizeNode(value as EditorNode);
	return result[0] ?? { type: "doc", content: [{ type: "paragraph" }] };
}

export async function removeUnavailableAttachmentImages(
	value: object,
	fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<{ content: EditorNode; removed: number }> {
	const root = sanitizeEditorContent(value) as EditorNode;
	const urls = new Set<string>();
	const collect = (node: EditorNode) => {
		if (isAttachmentImage(node)) urls.add(node.attrs?.src as string);
		for (const child of node.content ?? []) collect(child);
	};
	collect(root);
	const unavailable = new Set<string>();
	await Promise.all(
		Array.from(urls, async (url) => {
			try {
				const response = await fetchImpl(url, { credentials: "include" });
				if (!response.ok) unavailable.add(url);
			} catch {
				unavailable.add(url);
			}
		}),
	);
	let removed = 0;
	const remove = (node: EditorNode): EditorNode | null => {
		if (isAttachmentImage(node) && unavailable.has(node.attrs?.src as string)) {
			removed += 1;
			return null;
		}
		if (!node.content) return node;
		return {
			...node,
			content: node.content
				.map(remove)
				.filter((child): child is EditorNode => child !== null),
		};
	};
	return { content: remove(root) ?? { type: "doc", content: [] }, removed };
}

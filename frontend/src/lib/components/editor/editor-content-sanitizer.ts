const ATTACHMENT_RAW_URL = /^\/api\/attachments\/[0-9a-f-]+\/raw$/i;

type EditorNode = {
	type?: string;
	attrs?: Record<string, unknown>;
	content?: EditorNode[];
	text?: string;
	[key: string]: unknown;
};

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

function sanitizeNode(node: EditorNode): EditorNode[] {
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
			if (child.type === "image") {
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

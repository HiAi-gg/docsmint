export type ProseMirrorNode = {
	type: string;
	text?: string;
	content?: ProseMirrorNode[];
	attrs?: Record<string, unknown>;
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

export type ProseMirrorDoc = ProseMirrorNode & {
	content?: ProseMirrorNode[];
};

const ATTACHMENT_PATH = /^\/api\/attachments\/[0-9a-f-]+\/raw$/i;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function wrapMark(
	mark: { type: string; attrs?: Record<string, unknown> },
	html: string,
): string {
	switch (mark.type) {
		case "bold":
			return `<strong>${html}</strong>`;
		case "italic":
			return `<em>${html}</em>`;
		case "strike":
		case "strikethrough":
			return `<s>${html}</s>`;
		case "underline":
			return `<u>${html}</u>`;
		case "code":
			return `<code>${html}</code>`;
		case "link": {
			const rawHref = (mark.attrs?.href as string) ?? "#";
			const href = safeLinkHref(rawHref);
			return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
		}
		case "highlight": {
			const color = (mark.attrs?.color as string) ?? "#fde68a";
			return `<mark style="background-color: ${escapeHtml(color)}">${html}</mark>`;
		}
		default:
			return html;
	}
}

function safeLinkHref(href: string): string {
	if (href.startsWith("#") || href.startsWith("/") || href.startsWith("./")) {
		return href;
	}
	try {
		const url = new URL(href);
		return SAFE_LINK_PROTOCOLS.has(url.protocol) ? href : "#";
	} catch {
		return "#";
	}
}

function alignStyle(attrs?: Record<string, unknown>): string {
	const align = attrs?.textAlign;
	if (
		align !== "left" &&
		align !== "center" &&
		align !== "right" &&
		align !== "justify"
	) {
		return "";
	}
	return ` style="text-align: ${align}"`;
}

/**
 * Render descendants as inline content. Older imported documents can contain
 * a paragraph inside a heading. That is invalid ProseMirror/HTML, so emitting
 * it verbatim makes browsers restructure the document unpredictably. Flatten
 * block wrappers in inline-only parents while preserving their text/marks.
 */
function renderInline(node: ProseMirrorNode): string {
	if (node.type === "text") {
		let html = escapeHtml(node.text ?? "");
		for (const mark of node.marks ?? []) html = wrapMark(mark, html);
		return html;
	}
	return (node.content ?? []).map(renderInline).join("");
}

export function renderSharedDocument(doc: ProseMirrorDoc): string {
	const renderNode = (node: ProseMirrorNode): string => {
		if (node.type === "text") return renderInline(node);

		const align = alignStyle(node.attrs);
		const inner = (node.content ?? []).map(renderNode).join("");
		switch (node.type) {
			case "paragraph":
				return `<p${align}>${inner}</p>`;
			case "heading": {
				const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
				return `<h${level}${align}>${(node.content ?? []).map(renderInline).join("")}</h${level}>`;
			}
			case "bulletList":
				return `<ul${align}>${inner}</ul>`;
			case "orderedList": {
				const rawStart = Number(node.attrs?.start ?? 1);
				const start =
					Number.isSafeInteger(rawStart) && rawStart > 1
						? ` start="${rawStart}"`
						: "";
				return `<ol${start}${align}>${inner}</ol>`;
			}
			case "listItem":
				return `<li${align}>${inner}</li>`;
			case "taskList":
				return `<ul data-type="taskList">${inner}</ul>`;
			case "taskItem": {
				const checked =
					node.attrs?.checked === true || node.attrs?.checked === "true";
				return `<li data-type="taskItem"${checked ? ' data-checked="true"' : ""}><label><input type="checkbox" disabled${checked ? " checked" : ""} /></label><div>${inner}</div></li>`;
			}
			case "blockquote":
				return `<blockquote${align}>${inner}</blockquote>`;
			case "table":
				return `<table><tbody>${inner}</tbody></table>`;
			case "tableRow":
				return `<tr>${inner}</tr>`;
			case "tableHeader":
				return `<th${align}>${inner}</th>`;
			case "tableCell":
				return `<td${align}>${inner}</td>`;
			case "codeBlock": {
				const lang = (node.attrs?.language as string) ?? "";
				return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${inner}</code></pre>`;
			}
			case "horizontalRule":
				return "<hr />";
			case "hardBreak":
				return "<br />";
			case "image": {
				const src = (node.attrs?.src as string) ?? "";
				const alt = (node.attrs?.alt as string) ?? "";
				if (ATTACHMENT_PATH.test(src)) {
					return `<img data-shared-attachment-src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
				}
				return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
			}
			default:
				return inner;
		}
	};

	return (doc.content ?? []).map(renderNode).join("");
}

export function sharedAttachmentHeaders(
	token: string,
	password = "",
): HeadersInit {
	return {
		"x-share-token": token,
		...(password ? { "x-share-password": password } : {}),
	};
}

/** Replace protected attachment placeholders with authenticated blob URLs. */
export async function hydrateSharedAttachmentImages(
	root: ParentNode,
	token: string,
	password = "",
): Promise<string[]> {
	const objectUrls: string[] = [];
	const images = root.querySelectorAll<HTMLImageElement>(
		"img[data-shared-attachment-src]",
	);
	await Promise.all(
		Array.from(images, async (image) => {
			const src = image.dataset.sharedAttachmentSrc;
			if (!src) return;
			try {
				const response = await fetch(src, {
					headers: sharedAttachmentHeaders(token, password),
				});
				if (!response.ok) {
					image.dataset.sharedAttachmentError = String(response.status);
					return;
				}
				const objectUrl = URL.createObjectURL(await response.blob());
				objectUrls.push(objectUrl);
				image.src = objectUrl;
				image.removeAttribute("data-shared-attachment-src");
			} catch {
				image.dataset.sharedAttachmentError = "network";
			}
		}),
	);
	return objectUrls;
}

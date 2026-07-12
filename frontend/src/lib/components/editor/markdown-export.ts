import type { JSONContent } from "@tiptap/core";

export interface MarkdownExportOptions {
	baseUrl?: string;
}

function children(node: JSONContent): JSONContent[] {
	return Array.isArray(node.content) ? node.content : [];
}

function escapeInline(value: string): string {
	return value.replace(/([\\`*_{}[\]<>])/g, "\\$1");
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeTableCell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/\r?\n+/g, "<br>")
		.trim();
}

function destination(src: string, baseUrl?: string): string {
	let resolved = src;
	const explicitProtocol = src
		.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]
		?.toLowerCase();
	if (
		explicitProtocol &&
		!["http", "https", "mailto", "tel", "data", "blob"].includes(
			explicitProtocol,
		)
	) {
		return "#";
	}
	if (
		explicitProtocol === "data" &&
		!src.toLowerCase().startsWith("data:image/")
	) {
		return "#";
	}
	if (baseUrl && !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(src)) {
		try {
			resolved = new URL(src, baseUrl).href;
		} catch {
			resolved = src;
		}
	}
	return /[\s()]/.test(resolved)
		? `<${resolved.replace(/>/g, "%3E")}>`
		: resolved;
}

function renderMarks(
	text: string,
	marks: JSONContent["marks"],
	baseUrl?: string,
) {
	let value = text;
	for (const mark of marks ?? []) {
		switch (mark.type) {
			case "code":
				value = `\`${value.replace(/`/g, "\\`")}\``;
				break;
			case "bold":
				value = `**${value}**`;
				break;
			case "italic":
				value = `*${value}*`;
				break;
			case "strike":
				value = `~~${value}~~`;
				break;
			case "highlight":
				value = `<mark>${value}</mark>`;
				break;
			case "link": {
				const href =
					typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
				if (href) value = `[${value}](${destination(href, baseUrl)})`;
				break;
			}
		}
	}
	return value;
}

function renderInline(
	node: JSONContent,
	options: MarkdownExportOptions,
): string {
	if (node.type === "text") {
		return renderMarks(
			escapeInline(node.text ?? ""),
			node.marks,
			options.baseUrl,
		);
	}
	if (node.type === "hardBreak") return "  \n";
	if (node.type === "image") {
		const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
		if (!src) return "";
		const alt = escapeInline(
			typeof node.attrs?.alt === "string" ? node.attrs.alt : "image",
		);
		const title =
			typeof node.attrs?.title === "string" && node.attrs.title
				? ` "${node.attrs.title.replace(/"/g, '\\"')}"`
				: "";
		const width = Number(node.attrs?.width);
		const height = Number(node.attrs?.height);
		if (
			(Number.isFinite(width) && width > 0) ||
			(Number.isFinite(height) && height > 0)
		) {
			const dimensions = `${Number.isFinite(width) && width > 0 ? ` width="${Math.round(width)}"` : ""}${Number.isFinite(height) && height > 0 ? ` height="${Math.round(height)}"` : ""}`;
			const markdownDestination = destination(src, options.baseUrl);
			const htmlSource =
				markdownDestination.startsWith("<") && markdownDestination.endsWith(">")
					? markdownDestination.slice(1, -1)
					: markdownDestination;
			return `<img src="${escapeHtmlAttribute(htmlSource)}" alt="${escapeHtmlAttribute(typeof node.attrs?.alt === "string" ? node.attrs.alt : "image")}"${dimensions} />`;
		}
		return `![${alt}](${destination(src, options.baseUrl)}${title})`;
	}
	return children(node)
		.map((child) => renderInline(child, options))
		.join("");
}

function renderListItem(
	node: JSONContent,
	options: MarkdownExportOptions,
	prefix: string,
): string {
	const body = children(node)
		.map((child) => renderBlock(child, options).trim())
		.filter(Boolean)
		.join("\n\n");
	const lines = body.split("\n");
	return lines
		.map((line, index) => (index === 0 ? `${prefix}${line}` : `  ${line}`))
		.join("\n");
}

function cellText(node: JSONContent, options: MarkdownExportOptions): string {
	return escapeTableCell(
		children(node)
			.map((child) =>
				child.type === "paragraph"
					? children(child)
							.map((part) => renderInline(part, options))
							.join("")
					: renderBlock(child, options).trim(),
			)
			.join("<br>"),
	);
}

function renderTable(
	node: JSONContent,
	options: MarkdownExportOptions,
): string {
	const rows = children(node).filter((row) => row.type === "tableRow");
	if (rows.length === 0) return "";
	const values = rows.map((row) =>
		children(row).map((cell) => cellText(cell, options)),
	);
	const width = Math.max(1, ...values.map((row) => row.length));
	const normalize = (row: string[]) => [
		...row,
		...Array(Math.max(0, width - row.length)).fill(""),
	];
	const header = normalize(values[0]);
	const body = values.slice(1).map(normalize);
	return [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map((row) => `| ${row.join(" | ")} |`),
	].join("\n");
}

function renderBlock(
	node: JSONContent,
	options: MarkdownExportOptions,
): string {
	switch (node.type) {
		case "doc":
			return children(node)
				.map((child) => renderBlock(child, options).trimEnd())
				.filter(Boolean)
				.join("\n\n");
		case "paragraph": {
			const inner = children(node)
				.map((child) => renderInline(child, options))
				.join("");
			const align = node.attrs?.textAlign;
			return ["center", "right", "justify"].includes(
				typeof align === "string" ? align : "",
			)
				? `<p style="text-align: ${align}">${inner}</p>`
				: inner;
		}
		case "heading": {
			const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
			const inner = children(node)
				.map((child) => renderInline(child, options))
				.join("");
			return `${"#".repeat(level)} ${inner}`;
		}
		case "image":
			return renderInline(node, options);
		case "blockquote":
			return children(node)
				.map((child) => renderBlock(child, options))
				.join("\n\n")
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
		case "codeBlock": {
			const language =
				typeof node.attrs?.language === "string" ? node.attrs.language : "";
			const text = children(node)
				.map((child) => child.text ?? "")
				.join("");
			return `\`\`\`${language}\n${text}\n\`\`\``;
		}
		case "horizontalRule":
			return "---";
		case "bulletList":
			return children(node)
				.map((item) => renderListItem(item, options, "- "))
				.join("\n");
		case "orderedList": {
			const start = Number(node.attrs?.start) || 1;
			return children(node)
				.map((item, index) =>
					renderListItem(item, options, `${start + index}. `),
				)
				.join("\n");
		}
		case "taskList":
			return children(node)
				.map((item) =>
					renderListItem(
						item,
						options,
						`- [${item.attrs?.checked ? "x" : " "}] `,
					),
				)
				.join("\n");
		case "listItem":
		case "taskItem":
			return children(node)
				.map((child) => renderBlock(child, options))
				.join("\n");
		case "table":
			return renderTable(node, options);
		default:
			return children(node)
				.map((child) => renderBlock(child, options))
				.join("\n");
	}
}

function containsNodeType(node: JSONContent, type: string): boolean {
	if (node.type === type) return true;
	return children(node).some((child) => containsNodeType(child, type));
}

function shouldPreserveStoredMarkdown(
	json: JSONContent,
	fallbackMarkdown: string,
): boolean {
	// Older imports may contain a raw/malformed GFM table or image in the
	// Markdown column that the historical Markdown -> ProseMirror parser could
	// not represent. Exporting only JSON would silently delete that source data.
	// Prefer the stored source whenever it contains a structural construct that
	// is absent from JSON; this is lossless and lets users repair imperfect
	// imported Markdown outside the editor.
	const sourceHasTable = /\|\s*:?-{3,}:?\s*\|/.test(fallbackMarkdown);
	const sourceHasImage = /!\[[^\]]*\]\([^\n)]+\)/.test(fallbackMarkdown);
	return (
		(sourceHasTable && !containsNodeType(json, "table")) ||
		(sourceHasImage && !containsNodeType(json, "image"))
	);
}

/** Serialize authoritative editor JSON without falling back to lossy plain text. */
export function serializeMarkdownExport(
	contentJson: object | null | undefined,
	fallbackMarkdown: string,
	options: MarkdownExportOptions = {},
): string {
	if (!contentJson || typeof contentJson !== "object") return fallbackMarkdown;
	const json = contentJson as JSONContent;
	if (shouldPreserveStoredMarkdown(json, fallbackMarkdown)) {
		return fallbackMarkdown;
	}
	const rendered = renderBlock(json, options).trimEnd();
	return rendered ? `${rendered}\n` : fallbackMarkdown;
}

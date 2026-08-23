import { sanitizeEditorContent } from "./editor-content-sanitizer";
import { markdownToJson } from "./markdown";
import { type ProseMirrorDoc, renderSharedDocument } from "./shared-document";

export interface PrintableDocumentInput {
	title: string;
	contentJson?: object | null;
	markdown?: string;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function canonicalEditorJson(input: PrintableDocumentInput): object {
	if (input.contentJson && typeof input.contentJson === "object") {
		return input.contentJson;
	}
	if (input.markdown) {
		try {
			return markdownToJson(input.markdown);
		} catch {
			return {
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: input.markdown }],
					},
				],
			};
		}
	}
	return { type: "doc", content: [] };
}

export function renderPrintableDocumentContent(
	input: Omit<PrintableDocumentInput, "title">,
): string {
	const content = sanitizeEditorContent(
		canonicalEditorJson({ title: "", ...input }),
	) as ProseMirrorDoc;
	return renderSharedDocument(content);
}

const PRINT_STYLES = `
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #000; padding: 2cm; }
h1 { font-size: 28px; font-weight: bold; margin-bottom: 20px; }
h2 { font-size: 22px; font-weight: bold; margin-top: 24px; margin-bottom: 12px; }
h3 { font-size: 18px; font-weight: 600; margin-top: 20px; margin-bottom: 8px; }
p { margin: 0 0 12px; }
ul, ol { padding-left: 20px; margin-bottom: 12px; }
li { margin-bottom: 4px; }
ul[data-type="taskList"] { list-style: none; padding-left: 0; }
ul[data-type="taskList"] li { list-style: none; display: flex; align-items: flex-start; gap: 8px; }
ul[data-type="taskList"] li > label { display: flex; align-items: flex-start; flex: 0 0 auto; padding-top: 0.25em; }
ul[data-type="taskList"] li > div { flex: 1 1 auto; min-width: 0; }
ul[data-type="taskList"] li > div > p { margin: 0 0 12px; }
blockquote { border-left: 3px solid #ccc; padding-left: 12px; margin: 12px 0; color: #666; font-style: italic; }
pre { background: #f4f4f4; border: 1px solid #ddd; padding: 12px; border-radius: 4px; overflow-x: auto; font-family: monospace; }
code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-family: monospace; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
th { background-color: #f4f4f4; }
img { max-width: 100%; height: auto; }
@media print { body { padding: 0; } }
`;

export function createPrintableDocumentHtml(
	input: PrintableDocumentInput,
): string {
	const title = escapeHtml(input.title || "Untitled Document");
	const content = renderPrintableDocumentContent(input);
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${PRINT_STYLES}</style></head><body><h1>${title}</h1>${content}</body></html>`;
}

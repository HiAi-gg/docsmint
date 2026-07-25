import { generateJSON } from "@tiptap/html/server";
import { marked } from "marked";
import { editorExtensions } from "./editor-schema";
import { logger } from "./logger";

/**
 * TipTap extension set used by the editor on the frontend
 * (see frontend/src/lib/components/editor/HiAiEditor.svelte).
 * Mirrored here so imported `.md`/`.txt` files produce
 * ProseMirror JSON the editor renders with full formatting.
 *
 * Excludes extensions that have no markdown equivalent or that need
 * runtime resources the backend does not load (Collaboration, CodeBlockLowlight).
 */

/**
 * Convert raw markdown text to TipTap/ProseMirror JSON that the editor
 * accepts as `contentJson`. Returns `null` for empty input or on failure
 * so the import handler can fall back to storing the raw text only.
 */
export async function markdownToDocJson(
	markdown: string,
): Promise<unknown | null> {
	if (!markdown.trim()) return null;
	try {
		const html = await marked.parse(markdown, { async: true });
		return generateJSON(html, editorExtensions);
	} catch (err) {
		logger.error({ err }, "markdownToDocJson failed");
		return null;
	}
}

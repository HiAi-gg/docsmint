import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { generateJSON } from "@tiptap/html/server";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import { logger } from "./logger";

/**
 * TipTap extension set used by the editor on the frontend
 * (see frontend/src/lib/components/editor/HiAiEditor.svelte).
 * Mirrored here so imported `.md`/`.txt`/`.markdown` files produce
 * ProseMirror JSON the editor renders with full formatting.
 *
 * Excludes extensions that have no markdown equivalent or that need
 * runtime resources the backend does not load (Collaboration, CodeBlockLowlight).
 */
const editorExtensions = [
	StarterKit.configure({
		heading: { levels: [1, 2, 3] },
		codeBlock: false,
		link: false,
	}),
	Link.configure({ openOnClick: false }),
	Image.configure({ inline: false, allowBase64: false }),
	Highlight.configure({ multicolor: true }),
];

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

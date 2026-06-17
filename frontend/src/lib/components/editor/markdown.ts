// markdown.ts — Browser-side markdown ↔ TipTap JSON helpers.
//
// MarkdownToggle edits raw markdown. The server stores both the markdown
// and the equivalent ProseMirror JSON (`contentTipex`); the JSON is what the
// wysiwyg editor uses when the user switches back. We can't just save the
// markdown string — the JSON field has to be kept in sync, otherwise the
// next visit to the wysiwyg mode would show stale content until the user
// touches the editor.
//
// `@tiptap/markdown` ships a `MarkdownManager` that knows how to parse
// markdown against the same set of TipTap extensions used by the editor.
// We instantiate one with the shared `editorExtensions` list and call
// `.parse()` for every keystroke. The instance is lazily created on first
// use to keep the module side-effect-free in SSR contexts (MarkdownToggle
// is only mounted in the browser, but Vite's build still evaluates this
// file's imports).

import type { JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { editorExtensions } from "./editorExtensions";

let managerSingleton: MarkdownManager | null = null;

function getManager(): MarkdownManager {
	if (managerSingleton) return managerSingleton;
	managerSingleton = new MarkdownManager({ extensions: editorExtensions });
	return managerSingleton;
}

/**
 * Parse a markdown string into a ProseMirror document matching the
 * HiAiEditor schema. Returns `{ type: "doc", content: [...] }`.
 *
 * Browser-only: relies on `window.DOMParser` inside `generateJSON`.
 */
export function markdownToJson(markdown: string): JSONContent {
	return getManager().parse(markdown);
}

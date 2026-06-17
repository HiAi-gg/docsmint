// editorExtensions.ts — Shared TipTap extension list.
//
// Both the live HiAiEditor and the markdown→JSON helper (used by
// MarkdownToggle) need the same set of node/mark extensions so the parsed
// ProseMirror JSON round-trips cleanly with the editor's schema. Keeping the
// list here avoids drift between the two consumers.
//
// The collaboration extensions are deliberately excluded — the parser runs
// in the browser on user-typed markdown and has no Yjs document to attach
// to. The HiAiEditor pushes those on top at runtime when a `collaboration`
// prop is supplied.

import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

export const editorExtensions = [
	StarterKit.configure({
		heading: { levels: [1, 2, 3] },
		codeBlock: false,
		link: false,
	}),
	Markdown.configure({}),
	Link.configure({
		openOnClick: false,
		HTMLAttributes: { class: "doc-link" },
	}),
	Image.configure({
		inline: false,
		allowBase64: false,
		HTMLAttributes: { class: "doc-image" },
	}),
	Highlight.configure({ multicolor: true }),
	CodeBlockLowlight.configure({ lowlight }),
	TextAlign.configure({ types: ["heading", "paragraph"] }),
	// Tables: TableKit bundles Table + TableRow + TableHeader + TableCell.
	// `resizable` lets users drag column widths; the toolbar inserts tables
	// with a header row via `insertTable`.
	TableKit.configure({ table: { resizable: true } }),
	// Task lists: a checkbox list. `nested` allows task items to contain
	// nested task lists.
	TaskList,
	TaskItem.configure({ nested: true }),
];

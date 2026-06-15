// editorExtensions.ts — Shared TipTap extension list.
//
// Both the live TipexEditor and the markdown→JSON helper (used by
// MarkdownToggle) need the same set of node/mark extensions so the parsed
// ProseMirror JSON round-trips cleanly with the editor's schema. Keeping the
// list here avoids drift between the two consumers.
//
// The collaboration extensions are deliberately excluded — the parser runs
// in the browser on user-typed markdown and has no Yjs document to attach
// to. The TipexEditor pushes those on top at runtime when a `collaboration`
// prop is supplied.

import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
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
];

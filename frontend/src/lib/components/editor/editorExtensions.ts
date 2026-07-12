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

import { mergeAttributes, Node, textblockTypeInputRule } from "@tiptap/core";
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

// Sentinel string emitted by the upstream Paragraph extension so that two or
// more consecutive empty paragraphs survive the markdown round-trip without
// being collapsed into one. Reused by our custom paragraph below.
const EMPTY_PARAGRAPH_MARKDOWN = "&nbsp;";
const NBSP_CHAR = "\u00A0";

// Whitelist of text alignments the editor + share view support. Anything
// outside this set is dropped on roundtrip to avoid injecting attacker-
// controlled strings into the HTML we ultimately render (the share view
// escapes, but the markdown view uses `{@html}` and trusts the textarea).
const TEXT_ALIGNMENTS = ["left", "center", "right", "justify"] as const;

// Custom paragraph node that preserves `textAlign` during markdown
// serialization. The default `@tiptap/extension-paragraph` ships as part of
// `StarterKit`; its `renderMarkdown` only emits the inline content, so the
// `textAlign` attribute added by `@tiptap/extension-text-align` is silently
// dropped whenever a user switches to MarkdownToggle or the document is
// loaded from the markdown fallback path. We swap the default out for this
// one (via `StarterKit.configure({ paragraph: false })` below) and emit
// inline HTML whenever alignment is set so the document roundtrips.
//
// We deliberately keep the schema identical to the upstream paragraph
// (same `name`, `group`, `content`, `attrs`, commands, input rules) so the
// `TextAlign.configure({ types: ["heading", "paragraph"] })` global-attribute
// injection continues to work — TipTap identifies target nodes by name.
const TextAlignParagraph = Node.create({
	name: "paragraph",
	priority: 1000,
	addOptions() {
		return {
			HTMLAttributes: {},
		};
	},
	group: "block",
	content: "inline*",
	parseHTML() {
		return [{ tag: "p" }];
	},
	renderHTML({ HTMLAttributes }) {
		return [
			"p",
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
			0,
		];
	},
	parseMarkdown: (token, helpers) => {
		const tokens = token.tokens || [];
		// A single bare image inside a paragraph token must be lifted to a
		// block image — same behaviour as the upstream extension.
		if (tokens.length === 1 && tokens[0].type === "image") {
			return helpers.parseChildren([tokens[0]]);
		}
		const content = helpers.parseInline(tokens);
		const hasExplicitEmptyParagraphMarker =
			tokens.length === 1 &&
			tokens[0].type === "text" &&
			(tokens[0].raw === EMPTY_PARAGRAPH_MARKDOWN ||
				tokens[0].text === EMPTY_PARAGRAPH_MARKDOWN ||
				tokens[0].raw === NBSP_CHAR ||
				tokens[0].text === NBSP_CHAR);
		if (
			hasExplicitEmptyParagraphMarker &&
			content.length === 1 &&
			content[0].type === "text" &&
			(content[0].text === EMPTY_PARAGRAPH_MARKDOWN ||
				content[0].text === NBSP_CHAR)
		) {
			return helpers.createNode("paragraph", undefined, []);
		}
		return helpers.createNode("paragraph", undefined, content);
	},
	renderMarkdown: (node, h, ctx) => {
		if (!node) return "";
		const content = Array.isArray(node.content) ? node.content : [];
		const align = (node.attrs?.textAlign as string | undefined) ?? "";
		const normalizedAlign = TEXT_ALIGNMENTS.includes(
			align as (typeof TEXT_ALIGNMENTS)[number],
		)
			? align
			: "";
		// When alignment is set (and not the default `left`/unset), emit
		// inline HTML so the roundtrip preserves the attribute. `left`
		// matches the editor's default, so skip — emitting the HTML form
		// would force the user to keep two equivalent markdown flavours in
		// sync for no benefit.
		if (normalizedAlign && normalizedAlign !== "left") {
			const inner = content.length === 0 ? "" : h.renderChildren(content);
			return `<p style="text-align: ${normalizedAlign}">${inner}</p>`;
		}
		if (content.length === 0) {
			const previousContent = Array.isArray(ctx?.previousNode?.content)
				? ctx.previousNode.content
				: [];
			const previousNodeIsEmptyParagraph =
				ctx?.previousNode?.type === "paragraph" && previousContent.length === 0;
			return previousNodeIsEmptyParagraph ? EMPTY_PARAGRAPH_MARKDOWN : "";
		}
		return h.renderChildren(content);
	},
	addCommands() {
		return {
			setParagraph:
				() =>
				({ commands }) => {
					return commands.setNode(this.name);
				},
		};
	},
	addKeyboardShortcuts() {
		return {
			"Mod-Alt-0": () => this.editor.commands.setParagraph(),
		};
	},
});

// Custom heading node that mirrors the upstream behaviour but preserves
// `textAlign` in the serialized markdown. Same swap-in pattern as
// TextAlignParagraph: disable StarterKit's default heading via
// `StarterKit.configure({ heading: false })` and register this in its
// place. The node keeps the same `name` and `level` attribute so that
// `TextAlign.configure({ types: ["heading", "paragraph"] })` continues to
// target it, the editor toolbar's `toggleHeading({ level })` chain still
// resolves, and the `Mod-Alt-1..6` shortcuts + `# ` input rules keep
// working unchanged.
const HEADING_DEFAULT_LEVELS = [1, 2, 3] as const;
// Mirrors `@tiptap/extension-heading`'s `Level` union so the inferred
// command signature matches what the rest of the editor (toolbar,
// TextAlign, the underlying schema) expects. Clamped at runtime to
// `this.options.levels` — anything outside falls back to the lowest
// configured level instead of being treated as invalid.
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const TextAlignHeading = Node.create({
	name: "heading",
	addOptions() {
		return {
			levels: [...HEADING_DEFAULT_LEVELS],
			HTMLAttributes: {},
		};
	},
	content: "inline*",
	group: "block",
	defining: true,
	addAttributes() {
		return {
			level: {
				default: 1,
				rendered: false,
			},
		};
	},
	parseHTML() {
		return this.options.levels.map((level: HeadingLevel) => ({
			tag: `h${level}`,
			attrs: { level },
		}));
	},
	renderHTML({ node, HTMLAttributes }) {
		const levels = this.options.levels as readonly number[];
		const hasLevel = levels.includes(node.attrs.level);
		const level = (hasLevel ? node.attrs.level : levels[0]) as HeadingLevel;
		return [
			`h${level}`,
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
			0,
		];
	},
	parseMarkdown: (token, helpers) => {
		return helpers.createNode(
			"heading",
			{ level: token.depth || 1 },
			helpers.parseInline(token.tokens || []),
		);
	},
	renderMarkdown: (node, h) => {
		const attrs = node.attrs ?? {};
		const rawLevel = attrs.level;
		const numericLevel =
			typeof rawLevel === "number"
				? rawLevel
				: typeof rawLevel === "string"
					? parseInt(rawLevel, 10)
					: 1;
		// Clamp to the markdown heading-level range [1..6]. Anything else is
		// treated as H1 — the schema's `addAttributes()` already defaults the
		// `level` attr to 1, so this is just a defence in depth against data
		// the markdown serializer never sees in practice.
		const level = (
			numericLevel >= 1 && numericLevel <= 6 ? Math.floor(numericLevel) : 1
		) as HeadingLevel;
		const headingChars = "#".repeat(level);
		const content = Array.isArray(node.content) ? node.content : [];
		const inner = h.renderChildren(content);
		const align = (attrs.textAlign as string | undefined) ?? "";
		const normalizedAlign = TEXT_ALIGNMENTS.includes(
			align as (typeof TEXT_ALIGNMENTS)[number],
		)
			? align
			: "";
		if (normalizedAlign && normalizedAlign !== "left") {
			return `<h${level} style="text-align: ${normalizedAlign}">${inner}</h${level}>`;
		}
		return `${headingChars} ${inner}`;
	},
	addCommands() {
		return {
			setHeading:
				(attributes: { level: HeadingLevel }) =>
				({ commands }) => {
					if (
						!(this.options.levels as readonly number[]).includes(
							attributes.level,
						)
					) {
						return false;
					}
					return commands.setNode(this.name, attributes);
				},
			toggleHeading:
				(attributes: { level: HeadingLevel }) =>
				({ commands }) => {
					if (
						!(this.options.levels as readonly number[]).includes(
							attributes.level,
						)
					) {
						return false;
					}
					return commands.toggleNode(this.name, "paragraph", attributes);
				},
		};
	},
	addKeyboardShortcuts() {
		const shortcuts: Record<string, () => boolean> = {};
		for (const level of this.options.levels as readonly number[]) {
			shortcuts[`Mod-Alt-${level}`] = () =>
				this.editor.commands.toggleHeading({ level: level as HeadingLevel });
		}
		return shortcuts;
	},
	addInputRules() {
		const levels = this.options.levels as readonly number[];
		const min = Math.min(...levels);
		return levels.map((level) =>
			textblockTypeInputRule({
				find: new RegExp(`^(#{${min},${level}})\\s$`),
				type: this.type,
				getAttributes: { level },
			}),
		);
	},
});

export const editorExtensions = [
	// Disable the bundled paragraph + heading so our textAlign-aware
	// versions below can claim the same node names without conflicting.
	// `codeBlock: false` and `link: false` were already disabled because
	// `CodeBlockLowlight` and the configured `Link` extension below take
	// over those slots.
	StarterKit.configure({
		heading: false,
		paragraph: false,
		codeBlock: false,
		link: false,
	}),
	Markdown.configure({}),
	TextAlignParagraph,
	TextAlignHeading,
	Link.configure({
		openOnClick: false,
		HTMLAttributes: { class: "doc-link" },
	}),
	Image.configure({
		inline: false,
		allowBase64: false,
		HTMLAttributes: { class: "doc-image" },
		resize: {
			enabled: true,
			directions: ["top-left", "top-right", "bottom-left", "bottom-right"],
			minWidth: 96,
			minHeight: 54,
			alwaysPreserveAspectRatio: true,
		},
	}),
	Highlight.configure({ multicolor: true }),
	CodeBlockLowlight.configure({ lowlight }),
	// Targeting `heading` and `paragraph` by name continues to work because
	// our custom TextAlignHeading / TextAlignParagraph register under
	// those exact names; the global attribute injection reads them off
	// the resolved schema, not off the upstream extensions.
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

export { TextAlignHeading, TextAlignParagraph };

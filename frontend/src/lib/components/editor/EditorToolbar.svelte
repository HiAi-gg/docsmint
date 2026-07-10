<!-- EditorToolbar.svelte — Formatting toolbar for TipTap editor -->
<script lang="ts">
import type { Editor } from "@tiptap/core";
// biome-ignore lint/style/useImportType: Bold is used as a value in the Svelte template
import {
	AlignCenter,
	AlignJustify,
	AlignLeft,
	AlignRight,
	Bold,
	Camera,
	Check,
	ChevronDown,
	Code2,
	Copy,
	GripHorizontal,
	Heading1,
	Heading2,
	Heading3,
	Highlighter,
	Image as ImageIcon,
	Italic,
	Link as LinkIcon,
	List,
	ListChecks,
	ListOrdered,
	Loader2,
	Minus,
	Quote,
	Redo,
	Smile,
	Table as TableIcon,
	Type,
	Underline,
	Undo,
	X,
} from "lucide-svelte";
import type { Snippet } from "svelte";
import {
	isFileSizeAllowed,
	isImageFile,
	uploadAttachment,
} from "$lib/api/attachments";
import * as m from "$lib/paraglide/messages.js";
import { copyToClipboard } from "$lib/utils/clipboard";
import CreateSnapshotDialog from "../CreateSnapshotDialog.svelte";
import LinkDialog from "./LinkDialog.svelte";

const {
	editor = null,
	documentId = "",
	toolbarExtensions = null,
}: {
	editor?: Editor | null;
	documentId?: string;
	/**
	 * Optional snippet rendered in the toolbar between the built-in tools and
	 * the actions divider. Use this to inject custom buttons/menus (e.g. an AI
	 * menu) from an external project without modifying this file.
	 *
	 * @example
	 * ```svelte
	 * <EditorToolbar {editor} {documentId}>
	 *   {#snippet toolbarExtensions({ editor })}
	 *     <MyAiButton {editor} />
	 *   {/snippet}
	 * </EditorToolbar>
	 * ```
	 */
	toolbarExtensions?: Snippet<[{ editor: Editor | null }]> | null;
} = $props();

interface ToolbarAction {
	icon: typeof Bold;
	label: string;
	// Lookup key into the `activeStates` record so the template can
	// read a fresh boolean without calling `editor.isActive(...)` itself
	// (which would skip Svelte's reactive graph).
	key: string;
	onClick: () => void;
}

// 8 preset highlight colors, keyed to the swatches shown in the popover.
const HIGHLIGHT_COLORS = [
	{ name: m.editor_highlight_yellow(), value: "#fde68a" },
	{ name: m.editor_highlight_orange(), value: "#fed7aa" },
	{ name: m.editor_highlight_red(), value: "#fecaca" },
	{ name: m.editor_highlight_green(), value: "#bbf7d0" },
	{ name: m.editor_highlight_blue(), value: "#bfdbfe" },
	{ name: m.editor_highlight_purple(), value: "#e9d5ff" },
	{ name: m.editor_highlight_pink(), value: "#fbcfe8" },
	{ name: m.editor_highlight_gray(), value: "#e5e7eb" },
] as const;

type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]["value"];

// Curated list of 20 common emojis shown in the picker popover. Kept short
// and useful (faces, gestures, common objects) instead of an exhaustive
// catalog — the native OS emoji picker is still one click away on most
// platforms.
const EMOJIS = [
	"😀",
	"😂",
	"😍",
	"🤔",
	"😎",
	"😢",
	"😡",
	"🥳",
	"👍",
	"👏",
	"🙏",
	"🔥",
	"⭐",
	"✅",
	"❌",
	"❤️",
	"🎉",
	"💡",
	"📌",
	"🚀",
] as const;

type TextAlignValue = "left" | "center" | "right" | "justify";

// Dropdown open flags + popover roots (one per dropdown).
let linkDialogOpen = $state(false);
let highlightPickerOpen = $state(false);
let highlightPickerRoot = $state<HTMLDivElement | null>(null);
let emojiPickerOpen = $state(false);
let emojiPickerRoot = $state<HTMLDivElement | null>(null);
let tablePickerOpen = $state(false);
let tablePickerRoot = $state<HTMLDivElement | null>(null);
// Hovered cell extent in the table size-picker grid (1-based; 0 = none).
let tableHoverRows = $state(0);
let tableHoverCols = $state(0);
let headingDropdownOpen = $state(false);
let headingDropdownRoot = $state<HTMLDivElement | null>(null);
let listDropdownOpen = $state(false);
let listDropdownRoot = $state<HTMLDivElement | null>(null);
let alignDropdownOpen = $state(false);
let alignDropdownRoot = $state<HTMLDivElement | null>(null);
let copyConfirmation = $state(false);
let snapshotDialogOpen = $state(false);

// Popover direction states
let headingOpenUp = $state(false);
let listOpenUp = $state(false);
let alignOpenUp = $state(false);
let highlightOpenUp = $state(false);
let emojiOpenUp = $state(false);
let tableOpenUp = $state(false);

function checkOpenUp(element: HTMLElement | null): boolean {
	if (!element) return false;
	const rect = element.getBoundingClientRect();
	return rect.top > window.innerHeight / 2;
}

// TipTap mutates its internal state during transactions but doesn't bump
// Svelte's reactive graph, so template calls to `editor.isActive(...)` would
// only re-evaluate when something *else* in the script changes. We track a
// monotonic revision counter on selection/mark changes and read it from
// deriveds/template expressions so the toolbar re-renders in sync with the
// editor.
let editorRevision = $state(0);
const readEditorRevision = $derived(editorRevision);

$effect(() => {
	if (!editor) return;
	const bump = () => {
		editorRevision++;
	};
	editor.on("selectionUpdate", bump);
	editor.on("transaction", bump);
	return () => {
		editor.off("selectionUpdate", bump);
		editor.off("transaction", bump);
	};
});

// Active-state snapshot for the current selection. Recomputed whenever
// the editor fires `selectionUpdate`/`transaction` so the toolbar
// buttons track the caret (or programmatic changes) without a manual
// rerender. Plain boolean — `class:active` and `aria-pressed` only
// care about true/false.
type ActiveStates = Partial<Record<string, boolean>>;
const activeStates = $derived.by<ActiveStates>(() => {
	// Read `readEditorRevision` for its reactive dependency, not its
	// value. Each key in the returned record corresponds to a toolbar
	// action's name, so the template can look up the right state in O(1).
	void readEditorRevision;
	if (!editor) return {};
	return {
		bold: editor.isActive("bold"),
		italic: editor.isActive("italic"),
		underline: editor.isActive("underline"),
		heading1: editor.isActive("heading", { level: 1 }),
		heading2: editor.isActive("heading", { level: 2 }),
		heading3: editor.isActive("heading", { level: 3 }),
		bulletList: editor.isActive("bulletList"),
		orderedList: editor.isActive("orderedList"),
		taskList: editor.isActive("taskList"),
		blockquote: editor.isActive("blockquote"),
		codeBlock: editor.isActive("codeBlock"),
		link: editor.isActive("link"),
		highlight: editor.isActive("highlight"),
		alignLeft: editor.isActive({ textAlign: "left" }),
		alignCenter: editor.isActive({ textAlign: "center" }),
		alignRight: editor.isActive({ textAlign: "right" }),
		alignJustify: editor.isActive({ textAlign: "justify" }),
	};
});

// Resolve the current heading level (1/2/3) or null if the selection is in
// a paragraph. Used to drive the Heading dropdown trigger label and icon.
const activeHeadingLevel = $derived.by<1 | 2 | 3 | null>(() => {
	void readEditorRevision;
	if (!editor) return null;
	if (editor.isActive("heading", { level: 1 })) return 1;
	if (editor.isActive("heading", { level: 2 })) return 2;
	if (editor.isActive("heading", { level: 3 })) return 3;
	return null;
});

// Resolve the current text alignment. Defaults to "left" because that's
// the editor's default for new content.
const activeAlignment = $derived.by<TextAlignValue>(() => {
	void readEditorRevision;
	if (!editor) return "left";
	if (editor.isActive({ textAlign: "center" })) return "center";
	if (editor.isActive({ textAlign: "right" })) return "right";
	if (editor.isActive({ textAlign: "justify" })) return "justify";
	return "left";
});

// Resolve the active highlight color from the current selection, if any.
const activeHighlightColor = $derived.by<HighlightColor | null>(() => {
	if (!editor) return null;
	// Re-run when the editor publishes a selection/transaction so the swatch
	// and the `.active` class on the highlight button track the caret.
	void readEditorRevision;
	if (!editor.isActive("highlight")) return null;
	const attrs = editor.getAttributes("highlight");
	const color = (attrs.color ?? "") as string;
	const match = HIGHLIGHT_COLORS.find((c) => c.value === color);
	return (match?.value as HighlightColor) ?? null;
});

function isDisabled(): boolean {
	if (!editor) return true;
	return !editor.isEditable;
}

function toggleHighlightPicker() {
	highlightPickerOpen = !highlightPickerOpen;
	if (highlightPickerOpen) {
		highlightOpenUp = checkOpenUp(highlightPickerRoot);
	}
}

function applyHighlight(color: HighlightColor) {
	if (!editor) return;
	editor.chain().focus().toggleHighlight({ color }).run();
	highlightPickerOpen = false;
}

function clearHighlight() {
	if (!editor) return;
	editor.chain().focus().unsetHighlight().run();
	highlightPickerOpen = false;
}

function toggleEmojiPicker() {
	emojiPickerOpen = !emojiPickerOpen;
	if (emojiPickerOpen) {
		emojiOpenUp = checkOpenUp(emojiPickerRoot);
	}
}

function insertEmoji(emoji: string) {
	if (!editor) return;
	editor.chain().focus().insertContent(emoji).run();
	emojiPickerOpen = false;
}

// Table size-picker: an 8×8 grid where the user hovers to choose how many
// rows/columns and clicks to insert the table (with a header row).
const TABLE_GRID_MAX = 8;

function toggleTablePicker() {
	tablePickerOpen = !tablePickerOpen;
	tableHoverRows = 0;
	tableHoverCols = 0;
	if (tablePickerOpen) {
		tableOpenUp = checkOpenUp(tablePickerRoot);
	}
}

function insertTable(rows: number, cols: number) {
	if (!editor) return;
	editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
	tablePickerOpen = false;
}

function toggleHeadingDropdown() {
	headingDropdownOpen = !headingDropdownOpen;
	if (headingDropdownOpen) {
		headingOpenUp = checkOpenUp(headingDropdownRoot);
	}
}

function applyHeading(level: 1 | 2 | 3 | null) {
	if (!editor) return;
	if (level === null) {
		editor.chain().focus().setParagraph().run();
	} else {
		editor.chain().focus().toggleHeading({ level }).run();
	}
	headingDropdownOpen = false;
}

function toggleListDropdown() {
	listDropdownOpen = !listDropdownOpen;
	if (listDropdownOpen) {
		listOpenUp = checkOpenUp(listDropdownRoot);
	}
}

function applyList(kind: "bullet" | "ordered" | "task") {
	if (!editor) return;
	const commands = editor.commands as Record<
		string,
		(...args: unknown[]) => boolean
	>;
	if (kind === "bullet") {
		if (typeof editor.commands.toggleBulletList === "function") {
			editor.chain().focus().toggleBulletList().run();
		} else {
			editor
				.chain()
				.focus()
				.command(() => commands.toggleList?.("bulletList", "listItem") ?? false)
				.run();
		}
	} else if (kind === "ordered") {
		if (typeof editor.commands.toggleOrderedList === "function") {
			editor.chain().focus().toggleOrderedList().run();
		} else {
			editor
				.chain()
				.focus()
				.command(
					() => commands.toggleList?.("orderedList", "listItem") ?? false,
				)
				.run();
		}
	} else {
		if (typeof editor.commands.toggleTaskList === "function") {
			editor.chain().focus().toggleTaskList().run();
		} else {
			editor
				.chain()
				.focus()
				.command(() => commands.toggleList?.("taskList", "taskItem") ?? false)
				.run();
		}
	}
	listDropdownOpen = false;
}

function toggleBlockquote() {
	if (!editor) return;
	editor.chain().focus().toggleBlockquote().run();
}

function insertHorizontalRule() {
	if (!editor) return;
	editor.chain().focus().setHorizontalRule().run();
}

function toggleAlignDropdown() {
	alignDropdownOpen = !alignDropdownOpen;
	if (alignDropdownOpen) {
		alignOpenUp = checkOpenUp(alignDropdownRoot);
	}
}

function applyAlignment(value: TextAlignValue) {
	if (!editor) return;
	const chain = editor.chain().focus();
	const commands = editor.commands as Record<
		string,
		(...args: unknown[]) => boolean
	>;
	if (
		value === "left" &&
		typeof (chain as { unsetTextAlign: () => unknown }).unsetTextAlign ===
			"function"
	) {
		chain.unsetTextAlign().run();
		alignDropdownOpen = false;
		return;
	}
	if (
		typeof (chain as { setTextAlign: (value: TextAlignValue) => unknown })
			.setTextAlign === "function"
	) {
		chain.setTextAlign(value).run();
	} else if (typeof commands.setTextAlign === "function") {
		commands.setTextAlign(value);
	}
	alignDropdownOpen = false;
}

function undo() {
	if (!editor) return;
	editor.chain().focus().undo().run();
}

function redo() {
	if (!editor) return;
	editor.chain().focus().redo().run();
}

// Copy the editor's current markdown (falling back to plain text when the
// Markdown extension's getMarkdown() helper is not available, e.g. while a
// collaboration doc is mounted without the markdown plugin). The Copy
// button shows a brief "Copied" confirmation next to the icon for ~1.5s.
async function copyContent() {
	if (!editor) return;
	const ed = editor as Editor & { getMarkdown?: () => string };
	const content = ed.getMarkdown ? ed.getMarkdown() : editor.getText();
	try {
		await copyToClipboard(content);
		copyConfirmation = true;
		setTimeout(() => {
			copyConfirmation = false;
		}, 1500);
	} catch (_err) {
		// Clipboard API can throw if the page is not focused or the
		// permission was denied; swallow — the user can retry or copy
		// manually from the document body.
	}
}

// --- Image upload state ---
let imageFileInput = $state<HTMLInputElement | null>(null);
let imageUploading = $state(false);
let imageError = $state<string | null>(null);

function formatMegabytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function triggerImageUpload() {
	if (imageUploading) return;
	imageError = null;
	imageFileInput?.click();
}

async function handleImageSelected(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	// Always reset the input so the same file can be re-selected.
	input.value = "";
	if (!file || !editor) return;

	if (!isImageFile(file)) {
		imageError = m.attachment_types_hint();
		return;
	}
	if (!isFileSizeAllowed(file)) {
		imageError = m.attachment_file_too_large({
			size: formatMegabytes(file.size),
		});
		return;
	}
	if (!documentId) {
		imageError = m.error_generic();
		return;
	}

	imageUploading = true;
	imageError = null;
	try {
		const attachment = await uploadAttachment(documentId, file);
		editor
			.chain()
			.focus()
			.setImage({ src: attachment.url, alt: attachment.filename })
			.run();
	} catch (_err) {
		imageError = m.error_server();
	} finally {
		imageUploading = false;
	}
}

// Close all popovers/dropdowns when clicking outside their root element.
// Each popover shares the same outside-pointer + Escape dismissal logic;
// the only difference is which open flag and root element they read.
$effect(() => {
	if (
		!highlightPickerOpen &&
		!emojiPickerOpen &&
		!tablePickerOpen &&
		!headingDropdownOpen &&
		!listDropdownOpen &&
		!alignDropdownOpen
	) {
		return;
	}
	function onDocPointer(e: PointerEvent) {
		const target = e.target as Node | null;
		if (!target) return;
		if (highlightPickerOpen) {
			const root = highlightPickerRoot;
			if (root && !root.contains(target)) {
				highlightPickerOpen = false;
			}
		}
		if (emojiPickerOpen) {
			const root = emojiPickerRoot;
			if (root && !root.contains(target)) {
				emojiPickerOpen = false;
			}
		}
		if (tablePickerOpen) {
			const root = tablePickerRoot;
			if (root && !root.contains(target)) {
				tablePickerOpen = false;
			}
		}
		if (headingDropdownOpen) {
			const root = headingDropdownRoot;
			if (root && !root.contains(target)) {
				headingDropdownOpen = false;
			}
		}
		if (listDropdownOpen) {
			const root = listDropdownRoot;
			if (root && !root.contains(target)) {
				listDropdownOpen = false;
			}
		}
		if (alignDropdownOpen) {
			const root = alignDropdownRoot;
			if (root && !root.contains(target)) {
				alignDropdownOpen = false;
			}
		}
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			highlightPickerOpen = false;
			emojiPickerOpen = false;
			tablePickerOpen = false;
			headingDropdownOpen = false;
			listDropdownOpen = false;
			alignDropdownOpen = false;
		}
	}
	document.addEventListener("pointerdown", onDocPointer);
	document.addEventListener("keydown", onKey);
	return () => {
		document.removeEventListener("pointerdown", onDocPointer);
		document.removeEventListener("keydown", onKey);
	};
});

let isScrolled = $state(false);
let isFloatingExpanded = $state(false);

let isDragging = $state(false);
let dragOffsetX = $state(0);
let dragOffsetY = $state(0);
let floatingX = $state<number | null>(null);
let floatingY = $state<number | null>(null);

function startDrag(e: PointerEvent) {
	if (!isScrolled) return;
	const target = e.target as HTMLElement;
	if (
		target.closest("button") ||
		target.closest("select") ||
		target.closest("input") ||
		target.closest(".dropdown-popover") ||
		target.closest(".highlight-popover") ||
		target.closest(".emoji-popover") ||
		target.closest(".table-popover")
	) {
		return;
	}
	isDragging = true;
	target.setPointerCapture(e.pointerId);
	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	dragOffsetX = e.clientX - rect.left;
	dragOffsetY = e.clientY - rect.top;
}

function onDrag(e: PointerEvent) {
	if (!isDragging) return;
	floatingX = e.clientX - dragOffsetX;
	floatingY = e.clientY - dragOffsetY;
}

function stopDrag(e: PointerEvent) {
	if (!isDragging) return;
	isDragging = false;
	try {
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
	} catch (_) {}
}

$effect(() => {
	if (typeof document === "undefined") return;
	function handleScroll(e: Event) {
		const target = e.target as HTMLElement;
		if (
			target &&
			(target.id === "main-content" ||
				target.tagName === "MAIN" ||
				target === document.documentElement)
		) {
			isScrolled = target.scrollTop > 150;
			if (!isScrolled) {
				floatingX = null;
				floatingY = null;
			}
		}
	}
	document.addEventListener("scroll", handleScroll, {
		capture: true,
		passive: true,
	});
	return () => {
		document.removeEventListener("scroll", handleScroll, { capture: true });
	};
});
</script>

{#snippet undoRedoSnippet()}
	<button
		class="toolbar-btn"
		disabled={isDisabled()}
		onclick={undo}
		title={m.editor_toolbar_undo()}
		aria-label={m.editor_toolbar_undo()}
		type="button"
	>
		<Undo size={16} />
	</button>
	<button
		class="toolbar-btn"
		disabled={isDisabled()}
		onclick={redo}
		title={m.editor_toolbar_redo()}
		aria-label={m.editor_toolbar_redo()}
		type="button"
	>
		<Redo size={16} />
	</button>
	<div class="toolbar-divider" aria-hidden="true"></div>
{/snippet}

{#snippet basicFormatSnippet()}
	<button
		class="toolbar-btn"
		class:active={activeStates.bold ?? false}
		disabled={isDisabled()}
		onclick={() => editor?.chain().focus().toggleBold().run()}
		title={m.editor_toolbar_bold()}
		aria-label={m.editor_toolbar_bold()}
		aria-pressed={activeStates.bold ?? false}
		type="button"
	>
		<Bold size={16} />
	</button>
	<button
		class="toolbar-btn"
		class:active={activeStates.italic ?? false}
		disabled={isDisabled()}
		onclick={() => editor?.chain().focus().toggleItalic().run()}
		title={m.editor_toolbar_italic()}
		aria-label={m.editor_toolbar_italic()}
		aria-pressed={activeStates.italic ?? false}
		type="button"
	>
		<Italic size={16} />
	</button>
	<button
		class="toolbar-btn"
		class:active={activeStates.underline ?? false}
		disabled={isDisabled()}
		onclick={() => editor?.chain().focus().toggleUnderline().run()}
		title={m.editor_toolbar_underline()}
		aria-label={m.editor_toolbar_underline()}
		aria-pressed={activeStates.underline ?? false}
		type="button"
	>
		<Underline size={16} />
	</button>
	<div class="toolbar-divider" aria-hidden="true"></div>
{/snippet}

{#snippet headingDropdown()}
	<div class="dropdown" bind:this={headingDropdownRoot}>
		<button
			class="toolbar-btn dropdown-trigger"
			class:active={activeHeadingLevel !== null}
			disabled={isDisabled()}
			onclick={toggleHeadingDropdown}
			title={m.editor_toolbar_heading()}
			aria-label={m.editor_toolbar_heading()}
			aria-haspopup="true"
			aria-expanded={headingDropdownOpen}
			type="button"
		>
			{#if activeHeadingLevel !== null}
				<Heading1 size={16} />
			{:else}
				<Type size={16} />
			{/if}
			<ChevronDown size={14} class="dropdown-chevron" />
		</button>

		{#if headingDropdownOpen}
			<div class="dropdown-popover" class:open-up={headingOpenUp} role="menu" aria-label={m.editor_toolbar_heading()}>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeHeadingLevel === null}
					role="menuitem"
					onclick={() => applyHeading(null)}
				>
					<Type size={16} />
					<span>{m.editor_toolbar_paragraph()}</span>
				</button>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeHeadingLevel === 1}
					role="menuitem"
					onclick={() => applyHeading(1)}
				>
					<Heading1 size={16} />
					<span>{m.editor_toolbar_heading_1()}</span>
				</button>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeHeadingLevel === 2}
					role="menuitem"
					onclick={() => applyHeading(2)}
				>
					<Heading2 size={16} />
					<span>{m.editor_toolbar_heading_2()}</span>
				</button>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeHeadingLevel === 3}
					role="menuitem"
					onclick={() => applyHeading(3)}
				>
					<Heading3 size={16} />
					<span>{m.editor_toolbar_heading_3()}</span>
				</button>
			</div>
		{/if}
	</div>
	<div class="toolbar-divider" aria-hidden="true"></div>
{/snippet}

{#snippet listDropdown()}
	<div class="dropdown" bind:this={listDropdownRoot}>
		<button
			class="toolbar-btn dropdown-trigger"
			class:active={(activeStates.bulletList ?? false) || (activeStates.orderedList ?? false)}
			disabled={isDisabled()}
			onclick={toggleListDropdown}
			title={m.editor_toolbar_list()}
			aria-label={m.editor_toolbar_list()}
			aria-haspopup="true"
			aria-expanded={listDropdownOpen}
			type="button"
		>
			<List size={16} />
			<ChevronDown size={14} class="dropdown-chevron" />
		</button>

		{#if listDropdownOpen}
			<div class="dropdown-popover" class:open-up={listOpenUp} role="menu" aria-label={m.editor_toolbar_list()}>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeStates.bulletList ?? false}
					role="menuitem"
					onclick={() => applyList("bullet")}
				>
					<List size={16} />
					<span>{m.editor_toolbar_bullet_list()}</span>
				</button>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeStates.orderedList ?? false}
					role="menuitem"
					onclick={() => applyList("ordered")}
				>
					<ListOrdered size={16} />
					<span>{m.editor_toolbar_ordered_list()}</span>
				</button>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeStates.taskList ?? false}
					role="menuitem"
					onclick={() => applyList("task")}
				>
					<ListChecks size={16} />
					<span>Task list</span>
				</button>
			</div>
		{/if}
	</div>
	<div class="toolbar-divider" aria-hidden="true"></div>
{/snippet}

{#snippet alignDropdown()}
	<div class="dropdown" bind:this={alignDropdownRoot}>
		<button
			class="toolbar-btn dropdown-trigger"
			class:active={activeAlignment !== "left"}
			disabled={isDisabled()}
			onclick={toggleAlignDropdown}
			title={m.editor_toolbar_align()}
			aria-label={m.editor_toolbar_align()}
			aria-haspopup="true"
			aria-expanded={alignDropdownOpen}
			type="button"
		>
			{#if activeAlignment === "center"}
				<AlignCenter size={16} />
			{:else if activeAlignment === "right"}
				<AlignRight size={16} />
			{:else if activeAlignment === "justify"}
				<AlignJustify size={16} />
			{:else}
				<AlignLeft size={16} />
			{/if}
			<ChevronDown size={14} class="dropdown-chevron" />
		</button>

		{#if alignDropdownOpen}
			<div class="dropdown-popover" class:open-up={alignOpenUp} role="menu" aria-label={m.editor_toolbar_align()}>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeAlignment === "left"}
					role="menuitem"
					onclick={() => applyAlignment("left")}
				>
					<AlignLeft size={16} />
					<span>{m.editor_toolbar_align_left()}</span>
				</button>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeAlignment === "center"}
					role="menuitem"
					onclick={() => applyAlignment("center")}
				>
					<AlignCenter size={16} />
					<span>{m.editor_toolbar_align_center()}</span>
				</button>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeAlignment === "right"}
					role="menuitem"
					onclick={() => applyAlignment("right")}
				>
					<AlignRight size={16} />
					<span>{m.editor_toolbar_align_right()}</span>
				</button>
				<button
					type="button"
					class="dropdown-item"
					class:selected={activeAlignment === "justify"}
					role="menuitem"
					onclick={() => applyAlignment("justify")}
				>
					<AlignJustify size={16} />
					<span>{m.editor_toolbar_align_justify()}</span>
				</button>
			</div>
		{/if}
	</div>
	<div class="toolbar-divider" aria-hidden="true"></div>
{/snippet}

{#snippet blockFormatSnippet()}
	<button
		class="toolbar-btn"
		class:active={activeStates.codeBlock ?? false}
		disabled={isDisabled()}
		onclick={() => editor?.chain().focus().toggleCodeBlock().run()}
		title={m.editor_toolbar_code_block()}
		aria-label={m.editor_toolbar_code_block()}
		aria-pressed={activeStates.codeBlock ?? false}
		type="button"
	>
		<Code2 size={16} />
	</button>
	<button
		class="toolbar-btn"
		class:active={activeStates.blockquote ?? false}
		disabled={isDisabled()}
		onclick={toggleBlockquote}
		title="Quote"
		aria-label="Quote"
		aria-pressed={activeStates.blockquote ?? false}
		type="button"
	>
		<Quote size={16} />
	</button>
	<button
		class="toolbar-btn"
		disabled={isDisabled()}
		onclick={insertHorizontalRule}
		title={m.editor_toolbar_horizontal_rule()}
		aria-label={m.editor_toolbar_horizontal_rule()}
		type="button"
	>
		<Minus size={16} />
	</button>
	<div class="toolbar-divider" aria-hidden="true"></div>
{/snippet}

{#snippet linkBtn()}
	<button
		class="toolbar-btn"
		class:active={activeStates.link ?? false}
		disabled={isDisabled()}
		onclick={() => (linkDialogOpen = true)}
		title={m.editor_toolbar_link()}
		aria-label={m.editor_toolbar_link()}
		aria-pressed={activeStates.link ?? false}
		type="button"
	>
		<LinkIcon size={16} />
	</button>
{/snippet}

{#snippet highlightPicker()}
	<div class="highlight-picker" bind:this={highlightPickerRoot}>
		<button
			class="toolbar-btn highlight-btn"
			class:active={activeStates.highlight ?? false}
			disabled={isDisabled()}
			onclick={toggleHighlightPicker}
			title={m.editor_toolbar_highlight()}
			aria-label={m.editor_toolbar_highlight()}
			aria-pressed={activeStates.highlight ?? false}
			aria-haspopup="true"
			aria-expanded={highlightPickerOpen}
			type="button"
		>
			<Highlighter size={16} />
			<span
				class="highlight-dot"
				class:visible={activeHighlightColor !== null}
				style:background-color={activeHighlightColor ?? "transparent"}
				aria-hidden="true"
			></span>
		</button>

		{#if highlightPickerOpen}
			<div class="highlight-popover" class:open-up={highlightOpenUp} role="menu" aria-label={m.editor_toolbar_highlight()}>
				<div class="highlight-swatch-grid">
					{#each HIGHLIGHT_COLORS as color (color.value)}
						<button
							type="button"
							class="highlight-swatch"
							class:selected={activeHighlightColor === color.value}
							style:background-color={color.value}
							title={color.name}
							aria-label={color.name}
							role="menuitem"
							onclick={() => applyHighlight(color.value)}
						></button>
					{/each}
				</div>
				{#if activeHighlightColor !== null}
					<button
						type="button"
						class="highlight-clear"
						role="menuitem"
						onclick={clearHighlight}
					>
						{m.action_cancel()}
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet emojiPicker()}
	<div class="emoji-picker" bind:this={emojiPickerRoot}>
		<button
			class="toolbar-btn"
			disabled={isDisabled()}
			onclick={toggleEmojiPicker}
			title={m.editor_toolbar_emoji()}
			aria-label={m.editor_toolbar_emoji()}
			aria-haspopup="true"
			aria-expanded={emojiPickerOpen}
			type="button"
		>
			<Smile size={16} />
		</button>

		{#if emojiPickerOpen}
			<div class="emoji-popover" class:open-up={emojiOpenUp} role="menu" aria-label={m.editor_toolbar_emoji()}>
				<div class="emoji-grid">
					{#each EMOJIS as emoji (emoji)}
						<button
							type="button"
							class="emoji-button"
							role="menuitem"
							onclick={() => insertEmoji(emoji)}
							aria-label={emoji}
						>
							{emoji}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet tablePicker()}
	<div class="table-picker" bind:this={tablePickerRoot}>
		<button
			class="toolbar-btn"
			disabled={isDisabled()}
			onclick={toggleTablePicker}
			title="Insert table"
			aria-label="Insert table"
			aria-haspopup="true"
			aria-expanded={tablePickerOpen}
			type="button"
		>
			<TableIcon size={16} />
		</button>

		{#if tablePickerOpen}
			<div class="table-popover" class:open-up={tableOpenUp} role="menu" aria-label="Insert table">
				<div class="table-grid" role="presentation">
					{#each Array(TABLE_GRID_MAX) as _, r}
						{#each Array(TABLE_GRID_MAX) as _, c}
							<button
								type="button"
								class="table-cell"
								class:active={r < tableHoverRows && c < tableHoverCols}
								onmouseenter={() => {
									tableHoverRows = r + 1;
									tableHoverCols = c + 1;
								}}
								onfocus={() => {
									tableHoverRows = r + 1;
									tableHoverCols = c + 1;
								}}
								onclick={() => insertTable(r + 1, c + 1)}
								aria-label={`${r + 1} × ${c + 1}`}
							></button>
						{/each}
					{/each}
				</div>
				<div class="table-grid-label">
					{tableHoverRows > 0
						? `${tableHoverRows} × ${tableHoverCols}`
						: "Insert table"}
				</div>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet imageBtn()}
	<button
		class="toolbar-btn image-btn"
		class:uploading={imageUploading}
		disabled={isDisabled() || imageUploading}
		onclick={triggerImageUpload}
		title={imageError ?? m.editor_toolbar_image()}
		aria-label={m.editor_toolbar_image()}
		type="button"
	>
		{#if imageUploading}
			<Loader2 size={16} class="animate-spin" />
		{:else}
			<ImageIcon size={16} />
		{/if}
	</button>
{/snippet}

{#snippet actionsSnippet()}
	<button
		class="toolbar-btn snapshot-btn"
		disabled={isDisabled() || !documentId}
		onclick={() => (snapshotDialogOpen = true)}
		title={m.version_create_snapshot()}
		aria-label={m.version_create_snapshot()}
		type="button"
	>
		<Camera size={16} />
	</button>

	<button
		class="toolbar-btn copy-btn"
		class:copied={copyConfirmation}
		disabled={isDisabled()}
		onclick={copyContent}
		title={copyConfirmation ? m.editor_toolbar_copied() : m.editor_toolbar_copy()}
		aria-label={m.editor_toolbar_copy()}
		type="button"
	>
		{#if copyConfirmation}
			<Check size={16} />
		{:else}
			<Copy size={16} />
		{/if}
	</button>
{/snippet}

{#if editor}
	{#if isScrolled && !isFloatingExpanded}
		<button
			type="button"
			class="floating-fab fixed bottom-24 right-6 z-50 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 hover:scale-105 active:scale-95 transition-all duration-200"
			onclick={() => { isFloatingExpanded = true; }}
			title="Formatting Toolbar"
		>
			<Type size={20} />
		</button>
	{:else}
		<div
			class="toolbar"
			class:floating-bar={isScrolled}
			class:cursor-grab={isScrolled && !isDragging}
			class:cursor-grabbing={isScrolled && isDragging}
			style={isScrolled && floatingX !== null && floatingY !== null ? `position: fixed; left: ${floatingX}px; top: ${floatingY}px; bottom: auto; transform: none; touch-action: none;` : ""}
			onpointerdown={startDrag}
			onpointermove={onDrag}
			onpointerup={stopDrag}
			role="toolbar"
			tabindex="0"
			aria-label={m.editor_toolbar_text_formatting()}
		>
			{#if isScrolled}
				<!-- Floating two-row layout -->
				<div class="flex flex-col gap-1.5 w-full max-w-full">
					<!-- Row 1: Drag handle + Core formatting + Dropdowns + Close X -->
					<div class="flex items-center gap-1.5 w-full">
						<div class="flex items-center gap-1 text-muted-foreground mr-1" title="Drag to re-position">
							<GripHorizontal size={14} class="select-none pointer-events-none cursor-grab" />
						</div>
						
						{@render undoRedoSnippet()}
						{@render basicFormatSnippet()}
						{@render headingDropdown()}
						{@render listDropdown()}
						{@render alignDropdown()}
						
						<div class="flex-1"></div>
						
						<button
							type="button"
							class="toolbar-btn text-destructive hover:bg-destructive/10 ml-auto"
							onclick={() => { isFloatingExpanded = false; }}
							title="Close Toolbar"
						>
							<X size={16} />
						</button>
					</div>
					
					<!-- Row 2: Block formatting + Popovers/insert tools + Actions -->
					<div class="flex items-center gap-1.5 w-full pl-6">
						{@render blockFormatSnippet()}
						{@render linkBtn()}
						{@render highlightPicker()}
						{@render emojiPicker()}
						{@render tablePicker()}
						{@render imageBtn()}
						
						{#if toolbarExtensions}
							<div class="toolbar-divider" aria-hidden="true"></div>
							<!-- Extension zone: custom buttons from external projects -->
							{@render toolbarExtensions({ editor })}
						{/if}
						
						<div class="toolbar-divider" aria-hidden="true"></div>
						
						{@render actionsSnippet()}
					</div>
				</div>
			{:else}
				<!-- Normal single-row layout -->
				{@render undoRedoSnippet()}
				{@render basicFormatSnippet()}
				{@render headingDropdown()}
				{@render listDropdown()}
				{@render alignDropdown()}
				{@render blockFormatSnippet()}
				{@render linkBtn()}
				{@render highlightPicker()}
				{@render emojiPicker()}
				{@render tablePicker()}
				{@render imageBtn()}
				{#if toolbarExtensions}
					<div class="toolbar-divider" aria-hidden="true"></div>
					<!-- Extension zone: custom buttons from external projects -->
					{@render toolbarExtensions({ editor })}
				{/if}
				<div class="toolbar-divider" aria-hidden="true"></div>
				{@render actionsSnippet()}
			{/if}
		</div>
	{/if}

	{#if imageError}
		<div class="image-error" role="alert">
			<span>{imageError}</span>
			<button
				type="button"
				class="image-error-dismiss"
				onclick={() => (imageError = null)}
				aria-label={m.error_dismiss()}
			>
				&times;
			</button>
		</div>
	{/if}

	<input
		bind:this={imageFileInput}
		type="file"
		accept="image/*"
		class="visually-hidden-file-input"
		onchange={handleImageSelected}
	/>

	<LinkDialog bind:open={linkDialogOpen} {editor} />

	{#if documentId}
		<CreateSnapshotDialog bind:open={snapshotDialogOpen} {documentId} />
	{/if}
{/if}

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 1px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--border);
		background: var(--card);
		flex-wrap: wrap;
		position: sticky;
		top: 0;
		z-index: 40;
	}

	.toolbar-divider {
		width: 1px;
		height: 18px;
		background: var(--border);
		margin: 0 2px;
	}

	.toolbar-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 34px;
		min-height: 34px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.toolbar-btn:hover:not(:disabled) {
		background: var(--accent);
		color: var(--accent-foreground);
	}

	.toolbar-btn.active {
		background: var(--primary);
		color: var(--primary-foreground);
	}

	.toolbar-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* Dropdown trigger (heading / list / align) — keeps the trigger aligned
	   with regular toolbar buttons but adds a small chevron to signal that
	   a menu will open. */
	.dropdown {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.dropdown-trigger {
		gap: 2px;
		padding: 0 6px;
	}


	:global(.dropdown-chevron) {
		opacity: 0.6;
	}

	.dropdown-popover {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 50;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px;
		background: var(--popover);
		color: var(--popover-foreground);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
		min-width: 180px;
	}

	.dropdown-item {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px;
		min-height: 32px;
		font-size: 0.875rem;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--popover-foreground);
		cursor: pointer;
		text-align: left;
		transition: background 0.1s ease;
	}

	.dropdown-item:hover {
		background: var(--accent);
		color: var(--accent-foreground);
	}

	.dropdown-item.selected {
		background: color-mix(in srgb, var(--primary) 18%, transparent);
		color: var(--foreground);
	}

	/* Highlight popover trigger button + indicator */
	.highlight-picker {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.highlight-btn {
		position: relative;
	}

	.highlight-dot {
		position: absolute;
		bottom: 6px;
		right: 6px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		border: 1px solid var(--border);
		opacity: 0;
		transform: scale(0.6);
		transition: opacity 0.15s ease, transform 0.15s ease;
		pointer-events: none;
	}

	.highlight-dot.visible {
		opacity: 1;
		transform: scale(1);
	}

	/* Popover panel */
	.highlight-popover {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 50;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		background: var(--popover);
		color: var(--popover-foreground);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
		min-width: 180px;
	}

	.highlight-swatch-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
	}

	.highlight-swatch {
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: 1px solid var(--border);
		cursor: pointer;
		padding: 0;
		transition: transform 0.1s ease, box-shadow 0.1s ease;
	}

	.highlight-swatch:hover {
		transform: scale(1.08);
		box-shadow: 0 0 0 2px var(--ring);
	}

	.highlight-swatch.selected {
		box-shadow: 0 0 0 2px var(--ring);
	}

	.highlight-clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 4px 8px;
		font-size: 0.75rem;
		color: var(--muted-foreground);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
	}

	.highlight-clear:hover {
		background: var(--accent);
		color: var(--accent-foreground);
	}

	/* Hidden file input (still keyboard-focusable for screen readers, but visually hidden) */
	.visually-hidden-file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* Image upload button — uses the same base as .toolbar-btn but needs
	   a small visual cue while uploading so users know it's working. */
	.image-btn.uploading {
		color: var(--ring);
	}

	.image-btn:disabled:not(.uploading) {
		opacity: 0.4;
		cursor: not-allowed;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	.image-btn :global(.animate-spin) {
		animation: spin 1s linear infinite;
	}

	/* Inline error banner shown under the toolbar when an upload fails or
	   the file is rejected by client-side validation. */
	.image-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 12px;
		font-size: 12px;
		background: color-mix(in srgb, var(--destructive) 10%, transparent);
		color: var(--destructive);
		border-bottom: 1px solid color-mix(in srgb, var(--destructive) 20%, transparent);
	}

	.image-error-dismiss {
		background: none;
		border: none;
		color: var(--destructive);
		cursor: pointer;
		font-size: 16px;
		line-height: 1;
		padding: 0 4px;
	}

	/* Emoji picker — same popover pattern as the highlight picker, but the
	   grid cells render an emoji glyph instead of a color swatch. */
	.emoji-picker {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.emoji-popover {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 70;
		padding: 8px;
		background: var(--popover);
		color: var(--popover-foreground);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
		min-width: 220px;
	}

	.emoji-grid {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 4px;
	}

	.emoji-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		font-size: 1.25rem;
		line-height: 1;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		cursor: pointer;
		padding: 0;
		transition: background 0.1s ease, transform 0.1s ease;
	}

	.emoji-button:hover {
		background: var(--accent);
		transform: scale(1.08);
	}

	.emoji-button:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 1px;
	}

	/* Table size-picker — hover the grid to choose rows × columns. */
	.table-picker {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.table-popover {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 70;
		padding: 8px;
		background: var(--popover);
		color: var(--popover-foreground);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
	}

	.table-grid {
		display: grid;
		grid-template-columns: repeat(8, 18px);
		grid-auto-rows: 18px;
		gap: 3px;
	}

	.table-cell {
		width: 18px;
		height: 18px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: var(--background);
		cursor: pointer;
		transition: background 0.08s ease, border-color 0.08s ease;
	}

	.table-cell:hover {
		border-color: var(--primary);
	}

	.table-cell.active {
		background: color-mix(in srgb, var(--primary) 35%, transparent);
		border-color: var(--primary);
	}

	.table-grid-label {
		margin-top: 8px;
		text-align: center;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	/* Copy button — turn the icon green briefly when the clipboard write
	   succeeded so users get a clear visual confirmation. */
	.copy-btn.copied {
		color: var(--primary);
	}

	/* Snapshot button — uses the same base as .toolbar-btn. No special
	   hover/active state beyond the shared rule, but kept as its own
	   class for future visual tweaks (e.g. a brief pulse on success). */
	   .snapshot-btn {
		color: var(--muted-foreground);
	}

	.toolbar.floating-bar {
		position: fixed;
		top: auto;
		bottom: 24px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
		background: color-mix(in srgb, var(--background) 95%, transparent);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 10px 14px;
		box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.15), 0 0 0 1px var(--border);
		animation: floatUp 0.2s ease-out;
		width: max-content;
		max-width: 90vw;
		overflow: visible;
	}

	.dropdown-popover.open-up,
	.highlight-popover.open-up,
	.emoji-popover.open-up,
	.table-popover.open-up {
		top: auto;
		bottom: calc(100% + 6px);
	}

	@keyframes floatUp {
		from {
			opacity: 0;
			transform: translate(-50%, 20px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, 0);
		}
	}
</style>

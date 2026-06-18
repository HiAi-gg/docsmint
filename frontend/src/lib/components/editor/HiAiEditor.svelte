<script lang="ts">
import type { JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { onDestroy, onMount } from "svelte";
import { createEditor, type Editor, EditorContent } from "svelte-tiptap";
import type { CollaborationSession } from "$lib/collaboration";
import * as m from "$lib/paraglide/messages.js";
import EditorToolbar from "./EditorToolbar.svelte";
import { editorExtensions } from "./editorExtensions";
import { markdownToJson } from "./markdown";

export type EditorOutput = { markdown: string; json: object };

const {
	content = "",
	contentJson,
	placeholder = m.doc_content_placeholder(),
	onUpdate = (_output: EditorOutput) => {},
	editable = true,
	collaboration = null,
	documentId = "",
}: {
	content?: string;
	contentJson?: object;
	placeholder?: string;
	onUpdate?: (output: EditorOutput) => void;
	editable?: boolean;
	collaboration?: CollaborationSession | null;
	documentId?: string;
} = $props();

let editorStore: ReturnType<typeof createEditor> | null = null;
let editor = $state<Editor | null>(null);
let ready = $state(false);
let suppressNextUpdate = false;
let internalUpdate = false;

/**
 * Resolve the initial editor content. Prefer the persisted ProseMirror JSON
 * when it is present. When it is missing but the markdown source is
 * non-empty, parse the markdown into JSON in the browser so the wysiwyg
 * view shows formatted content rather than the raw markdown source. An
 * older version of the project did this server-side via
 * `backend/src/lib/markdown-to-doc.ts`, but the markdown→JSON helper here
 * uses the same TipTap extension set as the editor itself, so the result
 * round-trips through `setContent` without node-mismatch errors. If the
 * parsed JSON does not match the editor schema on some edge case, the
 * `try/catch` falls back to rendering the raw markdown string — better
 * than showing nothing.
 */
function resolveInitialContent(): string | JSONContent {
	if (contentJson) return contentJson as JSONContent;
	if (content && content.trim().length > 0) {
		try {
			return markdownToJson(content);
		} catch (err) {
			console.warn(
				"HiAiEditor: markdownToJson failed, falling back to raw markdown",
				err,
			);
			return content;
		}
	}
	return content;
}

onMount(() => {
	const extensions = [...editorExtensions];

	if (collaboration?.doc) {
		extensions.push(
			Collaboration.configure({
				document: collaboration.doc,
			}) as unknown as (typeof extensions)[number],
			CollaborationCursor.configure({
				provider: collaboration.provider,
				user: {
					name: m.editor_anonymous(),
					color: `#${Math.floor(Math.random() * 16777215)
						.toString(16)
						.padStart(6, "0")}`,
				},
			}) as unknown as (typeof extensions)[number],
		);
	}

	editorStore = createEditor({
		extensions,
		content: collaboration?.doc ? undefined : resolveInitialContent(),
		editable,
		editorProps: {
			attributes: {
				"aria-label": m.editor_content_label(),
				"aria-multiline": "true",
				role: "textbox",
				class: "tiptap-editor",
			},
		},
		onUpdate: ({ editor: ed }) => {
			if (suppressNextUpdate) {
				suppressNextUpdate = false;
				return;
			}
			if (!collaboration) {
				// The Markdown extension augments the editor with a `getMarkdown()`
				// method at onBeforeCreate time (see @tiptap/markdown Extension.ts).
				// The `markdown` storage is `{ manager }`, not a `getMarkdown`
				// function, so reading it as one always returned undefined and the
				// fallback path produced plain text.
				const getMarkdown = (ed as { getMarkdown?: () => string }).getMarkdown;
				// Guard the markdown serialization: a node type the markdown
				// serializer doesn't recognize (e.g. tables on some versions)
				// must not throw and abort the save — fall back to plain text.
				let markdown: string;
				try {
					markdown = getMarkdown ? getMarkdown.call(ed) : ed.getText();
				} catch (err) {
					console.warn("HiAiEditor: getMarkdown failed, using plain text", err);
					markdown = ed.getText();
				}
				const json = ed.getJSON() as object;
				internalUpdate = true;
				onUpdate({ markdown, json });
			}
		},
	});

	const unsubscribe = editorStore.subscribe((ed) => {
		editor = ed;
		if (ed && !ready) {
			ready = true;
		}
	});

	return () => unsubscribe();
});

let prevContent = $state("");
$effect(() => {
	if (!editor || collaboration?.doc) return;
	// Prefer the persisted ProseMirror JSON when available — the markdown
	// view keeps it in sync on every keystroke, so we avoid re-parsing
	// the markdown back into JSON on every mount. When the JSON is
	// missing but the markdown source is present, parse the markdown
	// client-side so the wysiwyg view still shows formatted content for
	// documents that were saved via the regular (non-TipTap) save path.
	const hasDocJson = contentJson != null;
	const nextSource: string | JSONContent = hasDocJson
		? (contentJson as JSONContent)
		: content && content.trim().length > 0
			? markdownToJson(content)
			: content;
	const nextSerialized = hasDocJson ? JSON.stringify(contentJson) : content;
	if (internalUpdate) {
		internalUpdate = false;
		prevContent = nextSerialized;
		return;
	}
	if (nextSerialized !== prevContent) {
		prevContent = nextSerialized;
		suppressNextUpdate = true;
		editor.commands.setContent(nextSource, { emitUpdate: false });
	}
});

onDestroy(() => {
	editor?.destroy?.();
});

/**
 * Intercept clicks on `.doc-link` elements rendered by the editor.
 *
 * TipTap's `Link` extension is configured with `openOnClick: false`, so it
 * does not handle link clicks itself. Without an explicit handler, the
 * browser would follow the anchor's `href` and SvelteKit's link routing
 * would rewrite `https://example.com` to the local `/s/example.com` share
 * URL, breaking the link.
 *
 * We delegate from the wrapper so the listener is installed once per
 * mount rather than once per link node, and we only act on left-clicks
 * without modifier keys so middle-click / cmd-click / right-click still
 * behave natively (open in new tab, context menu, etc.).
 */
function handleWrapperClick(event: MouseEvent) {
	if (event.defaultPrevented) return;
	if (event.button !== 0) return;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

	const target = event.target as Element | null;
	const anchor = target?.closest("a.doc-link") as HTMLAnchorElement | null;
	if (!anchor) return;

	const href = anchor.getAttribute("href");
	if (!href) return;

	// External URLs (http/https/mailto/etc.) must open in a new tab.
	// We treat anything else as an internal route the app should handle.
	if (/^(https?:|mailto:|tel:)/i.test(href)) {
		event.preventDefault();
		window.open(href, "_blank", "noopener,noreferrer");
		return;
	}

	// Internal links (e.g. `/docs/:id`): let the browser follow the href.
	// SvelteKit's link interception will pick it up and call `goto()` for us.
}
</script>

<div class="editor-wrapper" onclick={handleWrapperClick} role="presentation">
  {#if ready && editor}
    <EditorToolbar {editor} {documentId} />
    <div class="editor-content">
      <EditorContent {editor} />
    </div>
  {:else}
    <div class="editor-skeleton">
      <div class="skeleton-toolbar">
        {#each Array(10) as _}
          <div class="skeleton-icon"></div>
        {/each}
      </div>
      <div class="skeleton-body">
        <div class="skeleton-bar" style="width: 60%"></div>
        <div class="skeleton-bar" style="width: 90%"></div>
        <div class="skeleton-bar" style="width: 75%"></div>
        <div class="skeleton-bar" style="width: 85%"></div>
        <div class="skeleton-bar" style="width: 40%"></div>
      </div>
    </div>
  {/if}
</div>

<style>
  .editor-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .editor-content {
    flex: 1;
    padding: 24px;
    overflow-y: auto;
  }

  .editor-content :global(.tiptap) {
    outline: none;
    min-height: 300px;
    font-size: 16px;
    line-height: 1.7;
    color: var(--foreground);
  }

  .editor-content :global(.tiptap:focus-visible) {
    outline: none;
  }

  .editor-content :global(.tiptap p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    float: left;
    color: var(--muted-foreground);
    pointer-events: none;
    height: 0;
  }

  .editor-content :global(.tiptap h1) {
    font-size: 2rem;
    font-weight: 800;
    margin: 1.5rem 0 0.75rem;
    letter-spacing: -0.025em;
  }

  .editor-content :global(.tiptap h2) {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 1.25rem 0 0.5rem;
    letter-spacing: -0.02em;
  }

  .editor-content :global(.tiptap h3) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 1rem 0 0.5rem;
  }

  .editor-content :global(.tiptap p) {
    margin: 0.5rem 0;
  }

  .editor-content :global(.tiptap ul) {
    padding-left: 1.5rem;
    margin: 0.5rem 0;
    list-style-type: disc;
  }

  .editor-content :global(.tiptap ol) {
    padding-left: 1.5rem;
    margin: 0.5rem 0;
    list-style-type: decimal;
  }

  .editor-content :global(.tiptap li) {
    margin: 0.25rem 0;
    display: list-item;
  }

  /* Task lists — checkbox list. Override the default disc bullet and lay
     each item out as [checkbox] [content]. */
  .editor-content :global(.tiptap ul[data-type="taskList"]) {
    list-style: none;
    padding-left: 0.25rem;
  }

  .editor-content :global(.tiptap ul[data-type="taskList"] li) {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .editor-content :global(.tiptap ul[data-type="taskList"] li > label) {
    margin-top: 0.2rem;
    user-select: none;
  }

  .editor-content :global(.tiptap ul[data-type="taskList"] li > div) {
    flex: 1 1 auto;
    min-width: 0;
  }

  .editor-content :global(.tiptap ul[data-type="taskList"] input[type="checkbox"]) {
    accent-color: var(--primary);
    cursor: pointer;
  }

  .editor-content :global(.tiptap blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 1rem;
    margin: 0.75rem 0;
    color: var(--muted-foreground);
    font-style: italic;
  }

  .editor-content :global(.tiptap code) {
    background: var(--muted);
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    font-size: 0.875rem;
    font-family: "Fira Code", "Consolas", monospace;
  }

  .editor-content :global(.tiptap pre) {
    background: var(--card);
    color: var(--card-foreground);
    padding: 1rem;
    border-radius: 8px;
    font-family: "Fira Code", "Consolas", monospace;
    font-size: 0.875rem;
    line-height: 1.6;
    overflow-x: auto;
    margin: 0.75rem 0;
  }

  .editor-content :global(.tiptap pre code) {
    background: transparent;
    padding: 0;
    border-radius: 0;
    font-size: inherit;
    color: inherit;
  }

  /* lowlight syntax highlighting (theme-aware via CSS variables) */
  .editor-content :global(.tiptap pre .hljs-keyword) {
    color: var(--hljs-keyword);
  }
  .editor-content :global(.tiptap pre .hljs-string) {
    color: var(--hljs-string);
  }
  .editor-content :global(.tiptap pre .hljs-number) {
    color: var(--hljs-number);
  }
  .editor-content :global(.tiptap pre .hljs-function) {
    color: var(--hljs-function);
  }
  .editor-content :global(.tiptap pre .hljs-title) {
    color: var(--hljs-title);
  }
  .editor-content :global(.tiptap pre .hljs-comment) {
    color: var(--hljs-comment);
    font-style: italic;
  }
  .editor-content :global(.tiptap pre .hljs-built_in) {
    color: var(--hljs-built_in);
  }
  .editor-content :global(.tiptap pre .hljs-type) {
    color: var(--hljs-type);
  }
  .editor-content :global(.tiptap pre .hljs-attr) {
    color: var(--hljs-attr);
  }
  .editor-content :global(.tiptap pre .hljs-variable) {
    color: var(--hljs-variable);
  }
  .editor-content :global(.tiptap pre .hljs-literal) {
    color: var(--hljs-literal);
  }

  .editor-content :global(.tiptap hr) {
    border: none;
    border-top: 2px solid var(--border);
    margin: 1.5rem 0;
  }

  /* Tables */
  .editor-content :global(.tiptap table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.75rem 0;
    table-layout: fixed;
    overflow: hidden;
  }

  .editor-content :global(.tiptap th),
  .editor-content :global(.tiptap td) {
    border: 1px solid var(--border);
    padding: 0.4rem 0.6rem;
    vertical-align: top;
    text-align: left;
    min-width: 3rem;
  }

  .editor-content :global(.tiptap th) {
    background: var(--muted);
    font-weight: 600;
  }

  /* Active cell selection highlight (TipTap CellSelection) */
  .editor-content :global(.tiptap .selectedCell::after) {
    content: "";
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--primary) 16%, transparent);
    pointer-events: none;
  }

  .editor-content :global(.tiptap td),
  .editor-content :global(.tiptap th) {
    position: relative;
  }

  /* Column resize handle */
  .editor-content :global(.tiptap .column-resize-handle) {
    position: absolute;
    right: -2px;
    top: 0;
    bottom: 0;
    width: 4px;
    background: var(--primary);
    cursor: col-resize;
  }

  .editor-content :global(.tiptap .doc-link) {
    color: var(--primary);
    text-decoration: underline;
    cursor: pointer;
  }

  .editor-content :global(.tiptap mark) {
    /* Inline `style="background-color: ..."` set by TipTap (multicolor mode)
       wins via specificity; this is the fallback for marks without a color. */
    background-color: var(--highlight-default, #fde68a);
    border-radius: 2px;
    padding: 0 2px;
  }

  /* Skeleton loading state */
  .editor-skeleton {
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  .skeleton-toolbar {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }

  .skeleton-icon {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    background: var(--muted);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .skeleton-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 24px;
  }

  .skeleton-bar {
    height: 16px;
    border-radius: 4px;
    background: var(--muted);
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
</style>

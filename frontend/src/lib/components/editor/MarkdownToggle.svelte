<!-- MarkdownToggle.svelte — Raw Markdown editing view -->
<script lang="ts">
import { Check, Copy } from "lucide-svelte";
import * as m from "$lib/paraglide/messages.js";
import type { EditorOutput } from "./HiAiEditor.svelte";
import { markdownToJson } from "./markdown";

const {
	content = "",
	onUpdate = (_output: EditorOutput) => {},
}: {
	content?: string;
	onUpdate?: (output: EditorOutput) => void;
} = $props();

let textarea = $state<HTMLTextAreaElement | null>(null);
let copied = $state(false);

function resizeTextarea() {
	if (!textarea) return;
	textarea.style.height = "auto";
	textarea.style.height = `${Math.max(textarea.scrollHeight, 500)}px`;
}

$effect(() => {
	// Re-measure after the bound value and DOM have settled, including when a
	// long document is opened directly in raw Markdown mode.
	content;
	if (typeof window !== "undefined") queueMicrotask(resizeTextarea);
});

// Persist + parse the new markdown into a ProseMirror doc so the
// `contentJson` field stays in sync. Without this the wysiwyg editor
// would show stale content the next time the user switches modes.
// Parsing happens synchronously on every keystroke — the underlying
// `marked` tokenizer is fast and `generateJSON` is cheap for the
// document sizes we expect in the editor.
function emitUpdate(markdown: string) {
	const json = markdownToJson(markdown);
	onUpdate({ markdown, json });
}

function handleInput(e: Event) {
	const target = e.target as HTMLTextAreaElement;
	resizeTextarea();
	emitUpdate(target.value);
}

function copyToClipboard() {
	if (!content) return;
	navigator.clipboard.writeText(content).then(() => {
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	});
}
</script>

<div class="markdown-toggle">
	<button
		type="button"
		class="copy-btn"
		onclick={copyToClipboard}
		aria-label="Copy markdown"
		title="Copy markdown content"
	>
		{#if copied}
			<Check size={14} class="text-emerald-500" />
			<span>Copied!</span>
		{:else}
			<Copy size={14} />
			<span>Copy Raw</span>
		{/if}
	</button>

	<textarea
		bind:this={textarea}
		value={content}
		oninput={handleInput}
		onkeydown={(e: KeyboardEvent) => { if (e.key === "Tab") { e.preventDefault(); const target = e.target as HTMLTextAreaElement; const start = target.selectionStart; const end = target.selectionEnd; target.value = `${target.value.substring(0, start)}\t${target.value.substring(end)}`; target.selectionStart = target.selectionEnd = start + 1; emitUpdate(target.value); } }}
		class="markdown-textarea"
		spellcheck="false"
		placeholder={m.editor_markdown_placeholder()}
		aria-label={m.editor_markdown_label()}
	></textarea>
</div>

<style>
	.markdown-toggle {
		position: relative;
		flex: 1;
		display: flex;
		flex-direction: column;
		width: 100%;
		min-height: 100%;
	}

	.copy-btn {
		position: absolute;
		top: 12px;
		right: 24px;
		z-index: 10;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		font-size: 12px;
		font-weight: 500;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--card) 85%, transparent);
		color: var(--muted-foreground);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		cursor: pointer;
		transition: all 0.2s ease;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
	}

	.copy-btn:hover {
		background: var(--accent);
		color: var(--accent-foreground);
		border-color: var(--accent);
	}

	.copy-btn:active {
		transform: scale(0.96);
	}

	.markdown-textarea {
		flex: 1;
		width: 100%;
		height: auto;
		min-height: 500px;
		max-height: calc(100vh - 220px);
		padding: 56px 24px 24px 24px;
		border: none;
		outline: none;
		resize: vertical;
		overflow-y: auto;
		font-family: 'Fira Code', 'Consolas', 'Courier New', monospace;
		font-size: 14px;
		line-height: 1.7;
		color: var(--foreground);
		background: var(--muted);
		tab-size: 4;
		border-radius: 8px;
		transition: background 0.15s ease;
	}

	.markdown-textarea::placeholder {
		color: var(--muted-foreground);
	}

	.markdown-textarea:focus {
		background: var(--background);
	}
</style>

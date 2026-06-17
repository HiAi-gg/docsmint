<!-- MarkdownToggle.svelte — Raw Markdown editing view -->
<script lang="ts">
import * as m from "$lib/paraglide/messages.js";
import { markdownToJson } from "./markdown";
import type { EditorOutput } from "./HiAiEditor.svelte";

const {
	content = "",
	onUpdate = (_output: EditorOutput) => {},
}: {
	content?: string;
	onUpdate?: (output: EditorOutput) => void;
} = $props();

let textarea = $state<HTMLTextAreaElement | null>(null);

// Persist + parse the new markdown into a ProseMirror doc so the
// `contentTipex` field stays in sync. Without this the wysiwyg editor
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
	emitUpdate(target.value);
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Tab") {
		e.preventDefault();
		const target = e.target as HTMLTextAreaElement;
		const start = target.selectionStart;
		const end = target.selectionEnd;
		target.value = `${target.value.substring(0, start)}\t${target.value.substring(end)}`;
		target.selectionStart = target.selectionEnd = start + 1;
		emitUpdate(target.value);
	}
}
</script>

<div class="markdown-toggle">
	<textarea
		bind:this={textarea}
		value={content}
		oninput={handleInput}
		onkeydown={handleKeydown}
		class="markdown-textarea"
		spellcheck="false"
		placeholder={m.editor_markdown_placeholder()}
		aria-label={m.editor_markdown_label()}
	></textarea>
</div>

<style>
	.markdown-toggle {
		flex: 1;
		display: flex;
	}

	.markdown-textarea {
		flex: 1;
		width: 100%;
		min-height: 400px;
		padding: 24px;
		border: none;
		outline: none;
		resize: none;
		font-family: 'Fira Code', 'Consolas', 'Courier New', monospace;
		font-size: 14px;
		line-height: 1.7;
		color: var(--foreground);
		background: var(--muted);
		tab-size: 4;
	}

	.markdown-textarea::placeholder {
		color: var(--muted-foreground);
	}

	.markdown-textarea:focus {
		background: var(--background);
	}
</style>

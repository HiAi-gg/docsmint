<!-- MarkdownToggle.svelte — Raw Markdown editing view -->
<script lang="ts">
	import * as m from "$lib/paraglide/messages.js";

	let {
		content = '',
		onUpdate = (_md: string) => {}
	}: {
		content?: string;
		onUpdate?: (markdown: string) => void;
	} = $props();

	let textarea = $state<HTMLTextAreaElement | null>(null);

	function handleInput(e: Event) {
		const target = e.target as HTMLTextAreaElement;
		onUpdate(target.value);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Tab') {
			e.preventDefault();
			const target = e.target as HTMLTextAreaElement;
			const start = target.selectionStart;
			const end = target.selectionEnd;
			target.value = target.value.substring(0, start) + '\t' + target.value.substring(end);
			target.selectionStart = target.selectionEnd = start + 1;
			onUpdate(target.value);
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

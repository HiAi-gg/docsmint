<!-- LinkDialog.svelte — Modal dialog to set/edit a link on the active Tiptap selection -->
<script lang="ts">
import { Button } from "@hiai-gg/hiai-ui/components/ui/button";
import {
	Dialog,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@hiai-gg/hiai-ui/components/ui/dialog";
import { Input } from "@hiai-gg/hiai-ui/components/ui/input";
import type { Editor } from "@tiptap/core";
import * as m from "$lib/paraglide/messages.js";

let {
	open = $bindable(false),
	editor = null,
}: {
	open?: boolean;
	editor?: Editor | null;
} = $props();

let url = $state("");
let inputEl = $state<HTMLInputElement | null>(null);

// Reset the input field with the existing link href (if any) whenever
// the dialog opens. Using $effect to react to `open` changes.
$effect(() => {
	if (open && editor) {
		const previousUrl = editor.getAttributes("link").href ?? "";
		url = previousUrl;
		// Defer focus to next tick so the input is mounted.
		queueMicrotask(() => inputEl?.focus());
	}
});

function close() {
	open = false;
}

function handleCancel() {
	close();
}

function handleApply() {
	if (!editor) {
		close();
		return;
	}
	const trimmed = url.trim();
	if (trimmed === "") {
		editor.chain().focus().extendMarkRange("link").unsetLink().run();
	} else {
		// Bare domains like "google.com" would otherwise be treated as a
		// relative path and routed internally (e.g. /s/google.com). Prepend
		// https:// unless the value already has a scheme, anchor, or path.
		const normalized = /^(https?:\/\/|mailto:|tel:|\/|#)/i.test(trimmed)
			? trimmed
			: `https://${trimmed}`;

		const { from, to } = editor.state.selection;
		if (from === to) {
			// No text selected: `setLink` would add a mark with nothing to
			// apply it to, so nothing visible would be saved. Insert the URL
			// itself as the link text instead.
			editor
				.chain()
				.focus()
				.insertContent({
					type: "text",
					text: normalized,
					marks: [{ type: "link", attrs: { href: normalized } }],
				})
				.run();
		} else {
			editor
				.chain()
				.focus()
				.extendMarkRange("link")
				.setLink({ href: normalized })
				.run();
		}
	}
	close();
}
</script>

<Dialog bind:open>
	<DialogHeader>
		<DialogTitle>{m.editor_toolbar_link()}</DialogTitle>
	</DialogHeader>
	<div class="link-dialog-body">
		<label for="link-url" class="link-dialog-label">
			{m.editor_enter_url()}
		</label>
		<Input
			id="link-url"
			bind:ref={inputEl}
			bind:value={url}
			type="url"
			placeholder="https://example.com"
			onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); handleApply(); } }}
		/>
	</div>
	<DialogFooter>
		<Button variant="outline" type="button" onclick={handleCancel}>
			{m.action_cancel()}
		</Button>
		<Button type="button" onclick={handleApply}>
			{m.action_save()}
		</Button>
	</DialogFooter>
</Dialog>

<style>
	.link-dialog-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 0 1rem 0;
	}

	.link-dialog-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--foreground);
	}
</style>

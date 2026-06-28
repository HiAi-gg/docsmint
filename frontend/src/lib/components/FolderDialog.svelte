<!-- FolderDialog.svelte — Modal dialog for creating and renaming folders. -->
<script lang="ts">
import { Loader2 } from "lucide-svelte";
import { Button } from "$lib/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as m from "$lib/paraglide/messages.js";

let {
	open = $bindable(false),
	mode,
	folder,
	onSave,
	onClose,
}: {
	open: boolean;
	mode: "create" | "edit";
	folder?: { id: string; name: string } | null;
	onSave?: (name: string) => Promise<void> | void;
	onClose?: () => void;
} = $props();

let name = $state("");
let error = $state<string | null>(null);
let busy = $state(false);

$effect(() => {
	if (!open) return;
	name = folder?.name ?? "";
	error = null;
});

const trimmedName = $derived(name.trim());
const title = $derived(mode === "edit" ? m.folders_rename() : m.folders_new());
const submitLabel = $derived(
	mode === "edit" ? m.action_save() : m.action_create(),
);

async function handleSubmit(e?: Event) {
	e?.preventDefault();
	if (busy) return;

	if (trimmedName.length === 0) {
		error = "Folder name is required";
		return;
	}
	if (!onSave) {
		close();
		return;
	}
	busy = true;
	try {
		await onSave(trimmedName);
		close();
	} catch (err) {
		console.error("FolderDialog: save failed", err);
		error = err instanceof Error ? err.message : m.error_generic();
	} finally {
		busy = false;
	}
}

function close() {
	if (busy) return;
	open = false;
	onClose?.();
}
</script>

<Dialog bind:open onOpenChange={(next) => { if (!next) close(); }}>
	<DialogHeader>
		<DialogTitle>{title}</DialogTitle>
		<DialogDescription>
			{mode === "edit" ? m.folders_rename() : m.doc_new_folder_name()}
		</DialogDescription>
	</DialogHeader>

	<form onsubmit={handleSubmit} class="space-y-4">
		<div class="space-y-2">
			<Label for="folder-dialog-name">{m.doc_new_folder_name()}</Label>
			<Input
				id="folder-dialog-name"
				name="name"
				type="text"
				bind:value={name}
				placeholder={m.doc_new_folder_name()}
				maxlength={255}
				required
				disabled={busy}
				aria-invalid={error ? "true" : undefined}
				aria-describedby={error ? "folder-dialog-name-error" : undefined}
				autocomplete="off"
			/>
			{#if error}
				<p id="folder-dialog-name-error" class="text-xs text-destructive" role="alert">{error}</p>
			{/if}
		</div>
	</form>

	<DialogFooter>
		<Button variant="outline" type="button" onclick={close} disabled={busy}>
			{m.action_cancel()}
		</Button>
		<Button
			type="submit"
			onclick={handleSubmit}
			disabled={busy || trimmedName.length === 0}
		>
			{#if busy}
				<Loader2 class="mr-1 size-4 animate-spin" />
			{/if}
			{submitLabel}
		</Button>
	</DialogFooter>
</Dialog>

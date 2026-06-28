<!-- CategoryDialog.svelte — Modal dialog for creating, renaming, and
     deleting categories. Used by the sidebar FolderTree to manage
     category CRUD without leaving the docs panel.

     Modes:
       - "create": empty name input, calls `onSave(name)`.
       - "edit":   pre-filled name input, calls `onSave(name)`.
       - "delete": confirmation copy + destructive confirm button,
                   calls `onDelete()`.

     The component is fully controlled — the parent owns `open` and the
     selection (via `category`). Submit/Cancel callbacks are passed as
     props (no internal store). Keyboard:
       - Enter submits the create/edit form.
       - Escape closes (handled by the underlying Dialog). -->
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

type Mode = "create" | "edit" | "delete";

let {
	open = $bindable(false),
	mode,
	category,
	onSave,
	onDelete,
	onClose,
}: {
	open: boolean;
	mode: Mode;
	category?: { id: string; name: string };
	onSave?: (name: string) => Promise<void> | void;
	onDelete?: () => Promise<void> | void;
	onClose?: () => void;
} = $props();

// Local form state. Kept in sync with the inbound `category` so that
// switching from "create" → "edit" (or selecting a different category)
// repopulates the input.
let name = $state("");
let error = $state<string | null>(null);
let busy = $state(false);

$effect(() => {
	// Only reset the input when the dialog actually opens — we don't
	// want to clobber the user's in-progress text while typing.
	if (!open) return;
	name = category?.name ?? "";
	error = null;
});

const trimmedName = $derived(name.trim());
const isDeleteMode = $derived(mode === "delete");
const title = $derived(
	isDeleteMode
		? m.categories_delete_title()
		: mode === "edit"
			? m.categories_edit_title()
			: m.categories_create_title(),
);
const submitLabel = $derived(
	isDeleteMode
		? m.action_delete()
		: mode === "edit"
			? m.action_save()
			: m.action_create(),
);

async function handleSubmit(e?: Event) {
	e?.preventDefault();
	if (busy) return;
	if (isDeleteMode) {
		if (!onDelete) {
			close();
			return;
		}
		busy = true;
		try {
			await onDelete();
			close();
		} catch (err) {
			console.error("CategoryDialog: delete failed", err);
			error = err instanceof Error ? err.message : m.categories_delete_error();
		} finally {
			busy = false;
		}
		return;
	}

	if (trimmedName.length === 0) {
		error = "Name is required";
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
		console.error("CategoryDialog: save failed", err);
		error =
			err instanceof Error
				? err.message
				: mode === "edit"
					? m.categories_update_error()
					: m.categories_create_error();
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
		{#if isDeleteMode}
			<DialogDescription>
				{m.categories_delete_description()}
			</DialogDescription>
		{:else}
			<DialogDescription>
				{m.categories_name_placeholder()}
			</DialogDescription>
		{/if}
	</DialogHeader>

	{#if !isDeleteMode}
		<form onsubmit={handleSubmit} class="space-y-4">
			<div class="space-y-2">
				<Label for="category-dialog-name">{m.categories_name_placeholder()}</Label>
				<Input
					id="category-dialog-name"
					name="name"
					type="text"
					bind:value={name}
					placeholder={m.categories_name_placeholder()}
					maxlength={255}
					required
					disabled={busy}
					aria-invalid={error ? "true" : undefined}
					aria-describedby={error ? "category-dialog-name-error" : undefined}
					autocomplete="off"
				/>
				{#if error}
					<p id="category-dialog-name-error" class="text-xs text-destructive" role="alert">{error}</p>
				{/if}
			</div>
		</form>
	{:else if error}
		<p class="text-xs text-destructive" role="alert">{error}</p>
	{/if}

	<DialogFooter>
		<Button variant="outline" type="button" onclick={close} disabled={busy}>
			{m.action_cancel()}
		</Button>
		<Button
			type={isDeleteMode ? "button" : "submit"}
			variant={isDeleteMode ? "destructive" : "default"}
			onclick={isDeleteMode ? handleSubmit : handleSubmit}
			disabled={busy || (!isDeleteMode && trimmedName.length === 0)}
		>
			{#if busy}
				<Loader2 class="mr-1 size-4 animate-spin" />
			{/if}
			{submitLabel}
		</Button>
	</DialogFooter>
</Dialog>
<!-- FolderDialog.svelte — Modal dialog for creating and renaming folders. -->
<script lang="ts">
import { Button } from "@hiai-gg/hiai-ui/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@hiai-gg/hiai-ui/components/ui/dialog";
import { Input } from "@hiai-gg/hiai-ui/components/ui/input";
import { Label } from "@hiai-gg/hiai-ui/components/ui/label";
import { CheckCircle2, Loader2 } from "lucide-svelte";
import * as m from "$lib/paraglide/messages.js";

let {
	open = $bindable(false),
	mode,
	folder,
	onSave,
	onClose,
	closeOnSave = true,
}: {
	open: boolean;
	mode: "create" | "edit";
	folder?: { id: string; name: string } | null;
	onSave?: (name: string) => Promise<unknown> | unknown;
	onClose?: () => void;
	closeOnSave?: boolean;
} = $props();

let name = $state("");
let error = $state<string | null>(null);
let busy = $state(false);
let createdFolderName = $state<string | null>(null);

$effect(() => {
	if (!open) return;
	name = folder?.name ?? "";
	error = null;
	createdFolderName = null;
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
		const savedFolder = await onSave(trimmedName);
		if (closeOnSave) {
			close(true);
		} else {
			createdFolderName =
				typeof savedFolder === "object" &&
				savedFolder !== null &&
				"name" in savedFolder &&
				typeof savedFolder.name === "string"
					? savedFolder.name
					: trimmedName;
		}
	} catch (err) {
		console.error("FolderDialog: save failed", err);
		error = err instanceof Error ? err.message : m.error_generic();
	} finally {
		busy = false;
	}
}

function createAnother() {
	createdFolderName = null;
	name = "";
	error = null;
}

function close(force = false) {
	if (busy && !force) return;
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

	{#if createdFolderName}
		<div
			class="space-y-3 rounded-lg border border-primary/30 bg-primary/10 p-4"
			role="status"
			aria-live="polite"
		>
			<div class="flex items-start gap-3">
				<CheckCircle2 class="mt-0.5 size-5 shrink-0 text-primary" />
				<div>
					<p class="text-sm font-medium text-foreground">Folder created</p>
					<p class="text-sm text-muted-foreground">
						{createdFolderName} is ready to use.
					</p>
				</div>
			</div>
		</div>
	{:else}
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
	{/if}

	<DialogFooter>
		{#if createdFolderName}
			<Button variant="outline" type="button" onclick={createAnother}>
				Create another
			</Button>
		{:else}
			<Button variant="outline" type="button" onclick={() => close()} disabled={busy}>
				{m.action_cancel()}
			</Button>
		{/if}
		<Button
			type="submit"
			onclick={createdFolderName ? () => close() : handleSubmit}
			disabled={busy || (!createdFolderName && trimmedName.length === 0)}
		>
			{#if busy}
				<Loader2 class="mr-1 size-4 animate-spin" />
			{/if}
			{createdFolderName ? "Done" : submitLabel}
		</Button>
	</DialogFooter>
</Dialog>

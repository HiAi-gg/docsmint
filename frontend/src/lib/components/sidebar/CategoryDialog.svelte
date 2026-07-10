<!-- CategoryDialog.svelte — Modal dialog for creating, renaming, and
     deleting categories. Used by the sidebar FolderTree to manage
     category CRUD without leaving the docs panel.

     Modes:
       - "create": empty name input, calls `onSave({ ... })`.
       - "edit":   pre-filled name input, calls `onSave({ ... })`.
       - "delete": confirmation copy + destructive confirm button,
                   calls `onDelete()`.

     The component is fully controlled — the parent owns `open` and the
     selection (via `category`). Submit/Cancel callbacks are passed as
     props (no internal store). Keyboard:
       - Enter submits the create/edit form.
       - Escape closes (handled by the underlying Dialog). -->
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
import { Loader2 } from "lucide-svelte";
import * as m from "$lib/paraglide/messages.js";

type Mode = "create" | "edit" | "delete";
type ApiMode = "unavailable" | "general" | "category";

type CategoryAccessState = {
	apiMode?: string | null;
	apiPermissionRead?: boolean | null;
	apiPermissionEdit?: boolean | null;
	apiPermissionWrite?: boolean | null;
};

type SavePayload = {
	name: string;
	apiMode: "unavailable" | "global" | "category";
	apiPermissionRead: boolean;
	apiPermissionEdit: boolean;
	apiPermissionWrite: boolean;
};

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
	category?: { id: string; name: string } & CategoryAccessState;
	onSave?: (payload: SavePayload) => Promise<void> | void;
	onDelete?: () => Promise<void> | void;
	onClose?: () => void;
} = $props();

// Local form state. Kept in sync with the inbound `category` so that
// switching from "create" → "edit" (or selecting a different category)
// repopulates the input.
let name = $state("");
let error = $state<string | null>(null);
let busy = $state(false);
let apiMode = $state<ApiMode>("unavailable");
let apiPermissionRead = $state(false);
let apiPermissionEdit = $state(false);
let apiPermissionWrite = $state(false);

$effect(() => {
	// Only reset the input when the dialog actually opens — we don't
	// want to clobber the user's in-progress text while typing.
	if (!open) return;
	name = category?.name ?? "";
	apiMode =
		category?.apiMode === "category"
			? "category"
			: category?.apiMode === "global" || category?.apiMode === "general"
				? "general"
				: "unavailable";
	apiPermissionRead = Boolean(category?.apiPermissionRead);
	apiPermissionEdit = Boolean(category?.apiPermissionEdit);
	apiPermissionWrite = Boolean(category?.apiPermissionWrite);
	if (apiMode === "unavailable") {
		apiPermissionRead = false;
		apiPermissionEdit = false;
		apiPermissionWrite = false;
	}
	error = null;
});

const trimmedName = $derived(name.trim());
const isDeleteMode = $derived(mode === "delete");
const hasAnyPermission = $derived(
	apiPermissionRead || apiPermissionEdit || apiPermissionWrite,
);
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

function normalizeApiMode(
	value: ApiMode,
): "unavailable" | "global" | "category" {
	if (value === "category") return "category";
	if (value === "general") return "global";
	return "unavailable";
}

function applyPermissionPreset(
	preset: "read" | "write" | "read-write" | "read-edit-write",
) {
	if (preset === "read") {
		apiPermissionRead = true;
		apiPermissionEdit = false;
		apiPermissionWrite = false;
		return;
	}
	if (preset === "write") {
		apiPermissionRead = false;
		apiPermissionEdit = false;
		apiPermissionWrite = true;
		return;
	}
	if (preset === "read-write") {
		apiPermissionRead = true;
		apiPermissionEdit = false;
		apiPermissionWrite = true;
		return;
	}
	apiPermissionRead = true;
	apiPermissionEdit = true;
	apiPermissionWrite = true;
}

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
	if (apiMode !== "unavailable" && !hasAnyPermission) {
		error = "Select at least one permission";
		return;
	}
	if (!onSave) {
		close();
		return;
	}
	busy = true;
	try {
		await onSave({
			name: trimmedName,
			apiMode: normalizeApiMode(apiMode),
			apiPermissionRead: apiMode === "unavailable" ? false : apiPermissionRead,
			apiPermissionEdit: apiMode === "unavailable" ? false : apiPermissionEdit,
			apiPermissionWrite:
				apiMode === "unavailable" ? false : apiPermissionWrite,
		});
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

			<div class="space-y-2">
				<Label for="category-dialog-api-mode">API access</Label>
				<select
					id="category-dialog-api-mode"
					name="apiMode"
					bind:value={apiMode}
					disabled={busy}
					class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					<option value="unavailable">Unavailable</option>
					<option value="general">General</option>
					<option value="category">Category API</option>
				</select>
			</div>

			{#if apiMode !== "unavailable"}
				<div class="space-y-3 rounded-md border border-border/70 bg-muted/30 p-3">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<Label class="text-sm">Permissions</Label>
						<div class="flex flex-wrap gap-2">
							<Button type="button" variant="outline" size="sm" onclick={() => applyPermissionPreset("read-write")}>
								Read / Write
							</Button>
							<Button type="button" variant="outline" size="sm" onclick={() => applyPermissionPreset("read-edit-write")}>
								Read / Edit / Write
							</Button>
						</div>
					</div>
					<div class="grid gap-2 sm:grid-cols-3">
						<label class="flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-2 text-sm">
							<input bind:checked={apiPermissionRead} disabled={busy} type="checkbox" class="size-4 rounded border-input" />
							<span>Read</span>
						</label>
						<label class="flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-2 text-sm">
							<input bind:checked={apiPermissionEdit} disabled={busy} type="checkbox" class="size-4 rounded border-input" />
							<span>Edit</span>
						</label>
						<label class="flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-2 text-sm">
							<input bind:checked={apiPermissionWrite} disabled={busy} type="checkbox" class="size-4 rounded border-input" />
							<span>Write</span>
						</label>
					</div>
				</div>
			{/if}
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

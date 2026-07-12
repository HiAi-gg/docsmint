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
import SelectRoot from "@hiai-gg/hiai-ui/components/ui/select/select.svelte";
import SelectContent from "@hiai-gg/hiai-ui/components/ui/select/select-content.svelte";
import SelectItem from "@hiai-gg/hiai-ui/components/ui/select/select-item.svelte";
import SelectTrigger from "@hiai-gg/hiai-ui/components/ui/select/select-trigger.svelte";
import SelectValue from "@hiai-gg/hiai-ui/components/ui/select/select-value.svelte";
import { CheckCircle2, Copy, Loader2 } from "lucide-svelte";
import {
	type ApiKeySummary,
	apiKeyClipboardValue,
	categoryIdFromScopes,
	createCategoryApiKey,
	listApiKeys,
	revealCategoryApiKey,
	revokeApiKey,
} from "$lib/api/api-keys";
import * as m from "$lib/paraglide/messages.js";
import { categoryDialogErrorMessage } from "./category-dialog-feedback.js";

type Mode = "create" | "edit" | "delete";
type ApiMode = "unavailable" | "global" | "category";

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

const Select = {
	Root: SelectRoot,
	Content: SelectContent,
	Item: SelectItem,
	Trigger: SelectTrigger,
	Value: SelectValue,
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
	onSave?: (
		payload: SavePayload,
	) =>
		| Promise<{ id: string; name: string } | undefined>
		| { id: string; name: string }
		| undefined;
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
let categoryKeys = $state<ApiKeySummary[]>([]);
let issuedKeys = $state<Record<string, string>>({});
let latestIssuedId = $state<string | null>(null);
let keyBusy = $state(false);
let createdCategoryName = $state<string | null>(null);
let createdCategoryKey = $state<string | null>(null);
let deletedCategoryName = $state<string | null>(null);
const latestIssuedKey = $derived(
	latestIssuedId ? issuedKeys[latestIssuedId] : undefined,
);

async function refreshCategoryKeys(categoryId: string) {
	const result = await listApiKeys();
	categoryKeys = result.keys.filter(
		(key) => categoryIdFromScopes(key.scopes) === categoryId,
	);
}

async function issueCategoryKey() {
	if (!category?.id) return;
	keyBusy = true;
	try {
		const issued = await createCategoryApiKey(category.id);
		issuedKeys = { ...issuedKeys, [issued.id]: issued.key };
		latestIssuedId = issued.id;
		await refreshCategoryKeys(category.id);
	} catch (err) {
		error =
			err instanceof Error ? err.message : "Failed to create category API key";
	} finally {
		keyBusy = false;
	}
}

async function revokeCategoryKey(id: string) {
	if (!category?.id) return;
	keyBusy = true;
	try {
		await revokeApiKey(id);
		const { [id]: _revoked, ...remainingIssuedKeys } = issuedKeys;
		issuedKeys = remainingIssuedKeys;
		if (latestIssuedId === id) latestIssuedId = null;
		await refreshCategoryKeys(category.id);
	} finally {
		keyBusy = false;
	}
}

async function copyCategoryKey(key: ApiKeySummary) {
	const rawKey = issuedKeys[key.id] ?? (await revealCategoryApiKey(key.id));
	await navigator.clipboard.writeText(apiKeyClipboardValue(key, rawKey));
}

$effect(() => {
	// Only reset the input when the dialog actually opens — we don't
	// want to clobber the user's in-progress text while typing.
	if (!open) return;
	name = category?.name ?? "";
	const initialApiMode: ApiMode =
		category?.apiMode === "category"
			? "category"
			: category?.apiMode === "global" || category?.apiMode === "general"
				? "global"
				: "unavailable";
	apiMode = initialApiMode;
	apiPermissionRead = Boolean(category?.apiPermissionRead);
	apiPermissionEdit = Boolean(category?.apiPermissionEdit);
	apiPermissionWrite = Boolean(category?.apiPermissionWrite);
	// Use the non-reactive initial value here. Reading `apiMode` after
	// assigning it made this effect subscribe to the editable form state,
	// so every selection immediately reran the reset and appeared not to
	// persist.
	if (initialApiMode === "unavailable") {
		apiPermissionRead = false;
		apiPermissionEdit = false;
		apiPermissionWrite = false;
	}
	issuedKeys = {};
	latestIssuedId = null;
	categoryKeys = [];
	createdCategoryName = null;
	createdCategoryKey = null;
	deletedCategoryName = null;
	if (mode === "edit" && category?.id) void refreshCategoryKeys(category.id);
	error = null;
});

const trimmedName = $derived(name.trim());
const isDeleteMode = $derived(mode === "delete");
const hasAnyPermission = $derived(
	apiPermissionRead || apiPermissionEdit || apiPermissionWrite,
);
const title = $derived(
	deletedCategoryName
		? m.categories_delete_success()
		: isDeleteMode
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
	if (value === "global") return "global";
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
			deletedCategoryName = category?.name ?? "Category";
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
	error = null;
	busy = true;
	try {
		const savedCategory = await onSave({
			name: trimmedName,
			apiMode: normalizeApiMode(apiMode),
			apiPermissionRead: apiMode === "unavailable" ? false : apiPermissionRead,
			apiPermissionEdit: apiMode === "unavailable" ? false : apiPermissionEdit,
			apiPermissionWrite:
				apiMode === "unavailable" ? false : apiPermissionWrite,
		});
		if (mode === "create" && savedCategory) {
			createdCategoryName = savedCategory.name;
			if (apiMode === "category") {
				try {
					const issued = await createCategoryApiKey(savedCategory.id);
					createdCategoryKey = issued.key;
				} catch (keyError) {
					error = `Category created, but its API key could not be created: ${categoryDialogErrorMessage(keyError, "Unknown error")}`;
				}
			}
			return;
		}
		close();
	} catch (err) {
		console.error("CategoryDialog: save failed", err);
		error = categoryDialogErrorMessage(
			err,
			mode === "edit"
				? m.categories_update_error()
				: m.categories_create_error(),
		);
	} finally {
		busy = false;
	}
}

function close() {
	if (busy) return;
	open = false;
	onClose?.();
}

function handleDialogOpenChange(next: boolean) {
	// Dialog bindings are updated before this callback runs. Keep the modal
	// open while a delete/save request is in flight so errors and success
	// feedback cannot be lost to Escape or a backdrop click.
	if (!next && busy) {
		open = true;
		return;
	}
	if (!next) close();
}
</script>

<Dialog bind:open onOpenChange={handleDialogOpenChange}>
	<DialogHeader>
		<DialogTitle>{title}</DialogTitle>
		{#if deletedCategoryName}
			<DialogDescription>
				<span class="font-medium text-foreground">“{deletedCategoryName}”</span>
				{m.categories_delete_success_description()}
			</DialogDescription>
		{:else if isDeleteMode}
			<DialogDescription>
				Delete <span class="font-medium text-foreground">“{category?.name ?? "Category"}”</span>?
				{m.categories_delete_description()}
			</DialogDescription>
		{:else}
			<DialogDescription>
				{m.categories_name_placeholder()}
			</DialogDescription>
		{/if}
	</DialogHeader>

	{#if deletedCategoryName}
		<div class="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/10 p-4" role="status" aria-live="polite">
			<CheckCircle2 class="mt-0.5 size-5 shrink-0 text-primary" />
			<div>
				<p class="text-sm font-medium text-foreground">{m.categories_delete_success()}</p>
				<p class="text-sm text-muted-foreground">
					<span class="font-medium text-foreground">“{deletedCategoryName}”</span>
					{m.categories_delete_success_description()}
				</p>
			</div>
		</div>
	{:else if createdCategoryName}
		<div class="space-y-3 rounded-lg border border-primary/30 bg-primary/10 p-4" role="status" aria-live="polite">
			<div class="flex items-start gap-3">
				<CheckCircle2 class="mt-0.5 size-5 shrink-0 text-primary" />
				<div>
					<p class="text-sm font-medium text-foreground">Category created</p>
					<p class="text-sm text-muted-foreground">{createdCategoryName} is ready to use.</p>
				</div>
			</div>
			{#if createdCategoryKey}
				<div class="rounded-md border border-primary/20 bg-background/80 p-3">
					<p class="text-xs font-medium text-foreground">Copy the API key now. It remains available in Settings → API.</p>
					<code class="mt-2 block break-all rounded bg-muted p-2 text-xs text-foreground">{createdCategoryKey}</code>
					<Button type="button" size="sm" variant="outline" class="mt-2" onclick={() => navigator.clipboard.writeText(createdCategoryKey ?? "")}>
						<Copy class="mr-1 size-3.5" /> Copy API key
					</Button>
				</div>
			{/if}
			{#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}
		</div>
	{:else if !isDeleteMode}
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
				<Select.Root
					type="single"
					value={apiMode}
					disabled={busy}
					onValueChange={(value: string) => {
						if (value === "unavailable" || value === "global" || value === "category") {
							apiMode = value;
						}
					}}
				>
					<Select.Trigger id="category-dialog-api-mode" class="h-10 w-full">
						<Select.Value placeholder="Select API access">
							{apiMode === "unavailable" ? "Unavailable" : apiMode === "global" ? "Global" : "Category API"}
						</Select.Value>
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="unavailable">Unavailable</Select.Item>
						<Select.Item value="global">Global</Select.Item>
						<Select.Item value="category">Category API</Select.Item>
					</Select.Content>
				</Select.Root>
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

			{#if mode === "edit" && apiMode === "category" && category?.id}
				<div class="space-y-3 rounded-md border border-border/70 p-3">
					<div class="flex items-center justify-between gap-2">
						<div><Label>Category API keys</Label><p class="text-xs text-muted-foreground">Keys inherit the saved permissions above.</p></div>
						<Button type="button" size="sm" onclick={issueCategoryKey} disabled={busy || keyBusy || category.apiMode !== "category"}>Create key</Button>
					</div>
					{#if category.apiMode !== "category"}
						<p class="text-xs text-muted-foreground">Save Category API access first, then reopen settings to issue a key.</p>
					{/if}
					{#if latestIssuedKey}
						<div class="rounded-lg border border-primary/30 bg-primary/10 p-3 text-primary">
							<p class="text-xs font-medium">Copy now — this raw key is shown once.</p>
							<code class="mt-1 block break-all rounded bg-background/80 p-2 text-xs text-foreground">{latestIssuedKey}</code>
							<Button type="button" size="sm" variant="outline" class="mt-2" onclick={() => navigator.clipboard.writeText(latestIssuedKey)}>Copy key</Button>
						</div>
					{/if}
					<div class="max-h-48 space-y-2 overflow-y-auto pr-1">
						{#each categoryKeys as key (key.id)}
							<div class="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-xs">
								<span>{key.name} · {key.prefix}…</span>
								<div class="flex shrink-0 gap-2">
									<Button type="button" size="sm" variant="outline" onclick={() => copyCategoryKey(key)} disabled={!key.recoverable && !issuedKeys[key.id]}>{key.recoverable || issuedKeys[key.id] ? "Copy key" : "Rotate to enable copy"}</Button>
									<Button type="button" size="sm" variant="destructive" onclick={() => revokeCategoryKey(key.id)} disabled={keyBusy}>Revoke</Button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</form>
	{:else if error}
		<p class="text-xs text-destructive" role="alert">{error}</p>
	{/if}

	<DialogFooter>
		{#if !createdCategoryName && !deletedCategoryName}
			<Button variant="outline" type="button" onclick={close} disabled={busy}>
				{m.action_cancel()}
			</Button>
		{/if}
		<Button
			type={isDeleteMode ? "button" : "submit"}
			variant={isDeleteMode ? "destructive" : "default"}
			onclick={createdCategoryName || deletedCategoryName ? close : handleSubmit}
			disabled={busy || (!isDeleteMode && !createdCategoryName && !deletedCategoryName && trimmedName.length === 0)}
		>
			{#if busy}
				<Loader2 class="mr-1 size-4 animate-spin" />
			{/if}
			{createdCategoryName || deletedCategoryName ? "Done" : submitLabel}
		</Button>
	</DialogFooter>
</Dialog>

<script lang="ts">
import { Button } from "$lib/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "$lib/components/ui/dialog";
import { Label } from "$lib/components/ui/label";
import SelectRoot from "$lib/components/ui/select/select.svelte";
import SelectContent from "$lib/components/ui/select/select-content.svelte";
import SelectItem from "$lib/components/ui/select/select-item.svelte";
import SelectTrigger from "$lib/components/ui/select/select-trigger.svelte";
import SelectValue from "$lib/components/ui/select/select-value.svelte";

const Select = {
	Root: SelectRoot,
	Content: SelectContent,
	Item: SelectItem,
	Trigger: SelectTrigger,
	Value: SelectValue,
};

import { ChevronDown, Loader2 } from "lucide-svelte";
import { type Category, listCategories } from "$lib/api/categories";
import { listFolders } from "$lib/api/folders";
import * as m from "$lib/paraglide/messages.js";
import { refreshFolders } from "$lib/stores/subfolders-refresh-store.svelte.js";
import type { Folder } from "$lib/types.js";
import FolderTreeSelector from "./FolderTreeSelector.svelte";

let {
	open = $bindable(false),
	documentId,
	initialTitle = "",
	initialParentId = null,
	initialCategoryId = null,
	onSave,
	onClose,
}: {
	open: boolean;
	documentId: string;
	initialTitle: string;
	initialParentId?: string | null;
	initialCategoryId?: string | null;
	onSave?: (
		newTitle: string,
		parentId: string | null,
		categoryId: string | null,
	) => Promise<void> | void;
	onClose?: () => void;
} = $props();

let folders = $state<Folder[]>([]);
let categories = $state<Category[]>([]);
let loading = $state(false);
let busy = $state(false);
let error = $state<string | null>(null);

let newTitle = $state("");
let selectedParentId = $state<string | null>(null);
let selectedCategoryId = $state<string | undefined>(undefined);

$effect(() => {
	if (!open) return;
	newTitle = initialTitle ? `${initialTitle} (Copy)` : "Untitled (Copy)";
	selectedParentId = initialParentId;
	selectedCategoryId = initialCategoryId || "null";
	error = null;
	void loadOptions();
});

async function loadOptions() {
	loading = true;
	try {
		const [cats, folderResult] = await Promise.all([
			listCategories(),
			listFolders(null, true),
		]);
		categories = cats;
		folders = folderResult;
	} catch (err) {
		console.error("Failed to load SaveAsDialog options", err);
		error = "Failed to load folders or categories";
	} finally {
		loading = false;
	}
}

async function handleSubmit(e?: Event) {
	e?.preventDefault();
	if (!newTitle.trim()) {
		error = "Title cannot be empty";
		return;
	}
	if (busy) return;
	busy = true;
	try {
		if (onSave) {
			const targetParentId =
				selectedParentId === "" || selectedParentId === "null"
					? null
					: selectedParentId;
			const targetCategoryId =
				selectedCategoryId === "" ||
				selectedCategoryId === "null" ||
				selectedCategoryId === undefined
					? null
					: selectedCategoryId;
			await onSave(newTitle.trim(), targetParentId, targetCategoryId);
		}
		refreshFolders();
		open = false;
	} catch (err) {
		console.error("Failed to duplicate item", err);
		error = err instanceof Error ? err.message : "Failed to duplicate item";
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
		<DialogTitle>Save as Copy</DialogTitle>
		<DialogDescription>
			Create a copy of this document with a new title, folder, and category.
		</DialogDescription>
	</DialogHeader>

	{#if loading}
		<div class="flex items-center justify-center py-6">
			<Loader2 class="size-6 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<form onsubmit={handleSubmit} class="space-y-4 py-2">
			{#if error}
				<p class="text-sm text-destructive" role="alert">{error}</p>
			{/if}

			<div class="space-y-2">
				<Label for="save-as-title">New Title</Label>
				<input
					id="save-as-title"
					type="text"
					bind:value={newTitle}
					placeholder="Enter new document title"
					required
					class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				/>
			</div>

			<div class="space-y-2">
				<Label>Parent Folder</Label>
				<FolderTreeSelector
					folders={folders}
					bind:selectedId={selectedParentId}
				/>
			</div>

			<div class="space-y-2">
				<Label for="save-as-category">Category</Label>
				<Select.Root
					type="single"
					bind:value={selectedCategoryId}
				>
					<Select.Trigger class="w-full text-foreground flex items-center justify-between bg-background border border-input px-3 py-2 text-sm rounded-md shadow-sm">
						<Select.Value placeholder="Select a category...">
							{selectedCategoryId && selectedCategoryId !== "null" ? (categories.find(c => c.id === selectedCategoryId)?.name ?? "Uncategorized") : "Uncategorized"}
						</Select.Value>
						<ChevronDown class="size-4 opacity-50" />
					</Select.Trigger>
					<Select.Content class="w-[var(--bits-select-trigger-width)]">
						<Select.Item value="null">Uncategorized</Select.Item>
						{#each categories as category (category.id)}
							<Select.Item value={category.id}>{category.name}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
		</form>
	{/if}

	<DialogFooter class="mt-4">
		<Button variant="outline" type="button" onclick={close} disabled={busy}>
			{m.action_cancel()}
		</Button>
		<Button
			type="button"
			onclick={handleSubmit}
			disabled={busy || loading}
		>
			{#if busy}
				<Loader2 class="mr-1 size-4 animate-spin" />
			{/if}
			{m.action_save()}
		</Button>
	</DialogFooter>
</Dialog>

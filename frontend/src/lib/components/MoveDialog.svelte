<script lang="ts">
import { Loader2 } from "lucide-svelte";
import { type Category, listCategories } from "$lib/api/categories";
import { listFolders } from "$lib/api/folders";
import { Button } from "$lib/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "$lib/components/ui/dialog";
import { Label } from "$lib/components/ui/label";
import * as m from "$lib/paraglide/messages.js";
import {
	bumpSubfoldersRefresh,
	refreshFolders,
} from "$lib/stores/subfolders-refresh-store.svelte.js";
import type { Folder } from "$lib/types.js";
import FolderTreeSelector from "./FolderTreeSelector.svelte";

let {
	open = $bindable(false),
	itemId,
	itemType,
	initialParentId = null,
	initialCategoryId = null,
	onSave,
	onClose,
}: {
	open: boolean;
	itemId: string;
	itemType: "document" | "folder";
	initialParentId?: string | null;
	initialCategoryId?: string | null;
	onSave?: (
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

let selectedParentId = $state<string | null>(null);
let selectedCategoryId = $state<string | null>(null);

$effect(() => {
	if (!open) return;
	selectedParentId = initialParentId;
	selectedCategoryId = initialCategoryId;
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
		console.error("Failed to load MoveDialog options", err);
		error = "Failed to load folders or categories";
	} finally {
		loading = false;
	}
}

// Compute descendants to block cycle if itemType is "folder"
const blockedFolderIds = $derived.by(() => {
	const blocked = new Set<string>();
	if (itemType !== "folder") return blocked;
	blocked.add(itemId);
	let changed = true;
	while (changed) {
		changed = false;
		for (const f of folders) {
			const pid = f.parentId ?? null;
			if (pid && blocked.has(pid) && !blocked.has(f.id)) {
				blocked.add(f.id);
				changed = true;
			}
		}
	}
	return blocked;
});

async function handleSubmit(e?: Event) {
	e?.preventDefault();
	if (busy) return;
	busy = true;
	try {
		if (onSave) {
			const targetParentId =
				selectedParentId === "" || selectedParentId === "null"
					? null
					: selectedParentId;
			const targetCategoryId =
				selectedCategoryId === "" || selectedCategoryId === "null"
					? null
					: selectedCategoryId;
			await onSave(targetParentId, targetCategoryId);
		}
		if (initialParentId) {
			bumpSubfoldersRefresh(initialParentId);
		}
		if (
			selectedParentId &&
			selectedParentId !== "" &&
			selectedParentId !== "null"
		) {
			bumpSubfoldersRefresh(selectedParentId);
		}
		refreshFolders();
		open = false;
	} catch (err) {
		console.error("Failed to move item", err);
		error = err instanceof Error ? err.message : "Failed to move item";
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
		<DialogTitle>{itemType === "folder" ? m.folders_move() : m.doc_move_to_folder()}</DialogTitle>
		<DialogDescription>
			Choose a new parent folder and/or category for this {itemType}.
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
				<Label>Parent Folder</Label>
				<FolderTreeSelector
					folders={folders}
					bind:selectedId={selectedParentId}
					blockedIds={blockedFolderIds}
				/>
			</div>

			<div class="space-y-2">
				<Label for="move-dialog-category">Category</Label>
				<select
					id="move-dialog-category"
					bind:value={selectedCategoryId}
					class="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					<option value="">Uncategorized</option>
					{#each categories as category (category.id)}
						<option value={category.id}>{category.name}</option>
					{/each}
				</select>
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

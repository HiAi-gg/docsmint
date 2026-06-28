<script lang="ts">
import { Badge } from "@hiai-gg/hiai-ui/components/ui/badge";
import { Button } from "@hiai-gg/hiai-ui/components/ui/button";
import { FolderOpen, FolderPlus, Plus } from "lucide-svelte";
import { goto, invalidate, invalidateAll } from "$app/navigation";
import type { Category } from "$lib/api/categories";
import { apiFetch } from "$lib/api/client";
import FolderCard from "$lib/components/FolderCard.svelte";
import FolderDialog from "$lib/components/FolderDialog.svelte";
import { ConfirmDialog } from "$lib/components/ui/confirm-dialog";
import * as m from "$lib/paraglide/messages.js";
import type { Folder } from "$lib/types.js";

const { data } = $props();

const UNCATEGORIZED_KEY = "__uncategorized__";

let showDeleteDialog = $state(false);
let deleteTargetId = $state<string | null>(null);
let deleteBusy = $state(false);

let showFolderDialog = $state(false);
let folderDialogMode = $state<"create" | "edit">("create");
let folderDialogTarget = $state<{ id: string; name: string } | null>(null);

// Build `{ category, folders }` sections. Folders with a known `categoryId`
// land in their category's bucket; everything else (no categoryId, or a
// categoryId that no longer exists) lands in the Uncategorized group, which
// is always rendered last.
const sections = $derived.by(() => {
	const categories = data.categories;
	const folders = data.folders;
	const byCategory = new Map<string, Folder[]>();
	for (const cat of categories) byCategory.set(cat.id, []);
	const uncategorized: Folder[] = [];
	for (const folder of folders) {
		if (folder.categoryId && byCategory.has(folder.categoryId)) {
			byCategory.get(folder.categoryId)?.push(folder);
		} else {
			uncategorized.push(folder);
		}
	}
	const items: Array<{
		key: string;
		category: Category | null;
		folders: Folder[];
	}> = [];
	for (const cat of categories) {
		items.push({
			key: cat.id,
			category: cat,
			folders: byCategory.get(cat.id) ?? [],
		});
	}
	items.push({
		key: UNCATEGORIZED_KEY,
		category: null,
		folders: uncategorized,
	});
	return items;
});

const visibleSections = $derived(sections.filter((s) => s.folders.length > 0));

const isEmpty = $derived(data.folders.length === 0);

function handleNewFolder() {
	folderDialogMode = "create";
	folderDialogTarget = null;
	showFolderDialog = true;
}

function handleRenameFolder(id: string) {
	const folder = data.folders.find((f) => f.id === id);
	if (!folder) return;
	folderDialogMode = "edit";
	folderDialogTarget = { id: folder.id, name: folder.name };
	showFolderDialog = true;
}

async function saveFolder(name: string) {
	if (folderDialogMode === "create") {
		await apiFetch("/api/folders", {
			method: "POST",
			body: JSON.stringify({ name, parentId: null }),
		});
	} else if (folderDialogMode === "edit" && folderDialogTarget) {
		await apiFetch<Folder>(`/api/folders/${folderDialogTarget.id}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
	}
	await invalidate("app:folders");
	await invalidateAll();
}

function handleDeleteFolder(id: string) {
	deleteTargetId = id;
	showDeleteDialog = true;
}

function cancelDeleteFolder() {
	showDeleteDialog = false;
	deleteTargetId = null;
}

async function confirmDeleteFolder() {
	const id = deleteTargetId;
	if (!id || deleteBusy) return;
	deleteBusy = true;
	try {
		await apiFetch(`/api/folders/${id}`, { method: "DELETE" });
		showDeleteDialog = false;
		deleteTargetId = null;
		// Re-run the page load so the deleted folder disappears from the grid.
		await invalidate("app:folders");
	} catch (e) {
		console.error("Failed to delete folder", e);
	} finally {
		deleteBusy = false;
	}
}
</script>

<svelte:head>
  <title>{m.folders_title()}</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-4 py-8">
  <!-- Header -->
  <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <FolderOpen class="size-7 shrink-0 text-primary" />
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{m.folders_title()}</h1>
        <p class="text-sm text-muted-foreground">{m.folders_subtitle()}</p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" onclick={() => goto("/docs/new")}>
        <Plus class="size-3.5" />
        {m.dashboard_new_document()}
      </Button>
      <Button size="sm" onclick={handleNewFolder}>
        <FolderPlus class="size-3.5" />
        {m.folders_new()}
      </Button>
    </div>
  </div>

  {#if isEmpty}
    <!-- Empty state -->
    <div class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
      <div class="mb-4 rounded-full bg-muted p-4">
        <FolderOpen class="size-8 text-muted-foreground" />
      </div>
      <h2 class="mb-1 text-lg font-semibold">{m.folders_empty()}</h2>
      <p class="mb-4 text-sm text-muted-foreground">
        {m.folders_empty_description()}
      </p>
      <Button onclick={handleNewFolder}>
        <FolderPlus class="size-4" />
        {m.folders_new()}
      </Button>
    </div>
  {:else}
    <!-- All Folders overview -->
    <section class="mb-10">
      <h2 class="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {m.search_filter_all()}
        <Badge variant="secondary" class="ml-1.5 text-[10px]">{data.folders.length}</Badge>
      </h2>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {#each data.folders as folder (folder.id)}
          <FolderCard
            {folder}
            onDelete={handleDeleteFolder}
            onRename={handleRenameFolder}
          />
        {/each}
      </div>
    </section>

    <!-- By Category -->
    {#each visibleSections as section (section.key)}
      <section id="category-{section.key}" class="mb-8">
        <h2 class="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {section.category ? section.category.name : m.sidebar_uncategorized()}
          <Badge variant="secondary" class="ml-1.5 text-[10px]">{section.folders.length}</Badge>
        </h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each section.folders as folder (folder.id)}
            <FolderCard
              {folder}
              onDelete={handleDeleteFolder}
              onRename={handleRenameFolder}
            />
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<ConfirmDialog
  bind:open={showDeleteDialog}
  title={m.folders_delete_title()}
  description={m.folders_delete_description()}
  confirmLabel={m.action_delete()}
  cancelLabel={m.action_cancel()}
  variant="destructive"
  busy={deleteBusy}
  onConfirm={confirmDeleteFolder}
  onCancel={cancelDeleteFolder}
/>

<FolderDialog
  bind:open={showFolderDialog}
  mode={folderDialogMode}
  folder={folderDialogTarget}
  onSave={saveFolder}
/>

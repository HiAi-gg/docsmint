<script lang="ts">
import { Badge } from "@hiai-gg/hiai-ui/components/ui/badge";
import { Button } from "@hiai-gg/hiai-ui/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@hiai-gg/hiai-ui/components/ui/dropdown-menu";
import {
	ArrowLeft,
	ArrowUpDown,
	ChevronRight,
	Clock,
	File,
	FileText,
	FolderOpen,
	FolderPlus,
	Plus,
	Share2,
	SortAsc,
} from "lucide-svelte";
import { goto, invalidateAll } from "$app/navigation";
import { apiFetch } from "$lib/api/client";
import DocumentCard from "$lib/components/DocumentCard.svelte";
import FolderCard from "$lib/components/FolderCard.svelte";
import FolderDialog from "$lib/components/FolderDialog.svelte";
import ShareDialog from "$lib/components/ShareDialog.svelte";
import { ConfirmDialog } from "$lib/components/ui/confirm-dialog";
import * as m from "$lib/paraglide/messages.js";
import type { Document, Folder, SortOption } from "$lib/types.js";

const { data } = $props();

let sortBy = $state<SortOption>("updated");
let editingName = $state(false);
let editName = $state("");
let showDeleteDialog = $state(false);
let deleteTargetId = $state<string | null>(null);
let deleteBusy = $state(false);
let showShareDialog = $state(false);

let showFolderDialog = $state(false);
let folderDialogMode = $state<"create" | "edit">("create");
let folderDialogTarget = $state<{ id: string; name: string } | null>(null);

/** Category assigned to this folder, looked up from `data.categories`. */
const folderCategory = $derived(
	data.folder.categoryId
		? (data.categories.find((c) => c.id === data.folder.categoryId) ?? null)
		: null,
);

/** Sort documents by the selected option. */
const sortedDocuments = $derived.by(() => {
	const docs = [...data.folder.documents];
	switch (sortBy) {
		case "name":
			return docs.sort((a, b) => a.title.localeCompare(b.title));
		case "created":
			return docs.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			);
		default:
			return docs.sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			);
	}
});

/** Sort subfolders by name. */
const sortedSubfolders = $derived(
	[...data.folder.children].sort((a, b) => a.name.localeCompare(b.name)),
);

const isEmpty = $derived(
	sortedSubfolders.length === 0 && sortedDocuments.length === 0,
);

function startRename() {
	editName = data.folder.name;
	editingName = true;
}

function cancelRename() {
	editingName = false;
	editName = "";
}

function submitRename() {
	if (editName.trim() && editName.trim() !== data.folder.name) {
		// In production, call updateFolder(data.folder.id, { name: editName.trim() })
		data.folder.name = editName.trim();
	}
	editingName = false;
}

function handleRenameKeydown(e: KeyboardEvent) {
	if (e.key === "Enter") submitRename();
	if (e.key === "Escape") cancelRename();
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
		data.folder.children = data.folder.children.filter(
			(c: Folder) => c.id !== id,
		);
		showDeleteDialog = false;
		deleteTargetId = null;
	} catch (e: unknown) {
		console.error("Failed to delete folder", e);
	} finally {
		deleteBusy = false;
	}
}

function handleRenameFolder(id: string) {
	const folder = data.folder.children.find((c: Folder) => c.id === id);
	if (!folder) return;
	folderDialogMode = "edit";
	folderDialogTarget = { id: folder.id, name: folder.name };
	showFolderDialog = true;
}

async function saveFolder(name: string) {
	if (folderDialogMode === "create") {
		await apiFetch("/api/folders", {
			method: "POST",
			body: JSON.stringify({ name, parentId: data.folder.id }),
		});
	} else if (folderDialogMode === "edit" && folderDialogTarget) {
		const id = folderDialogTarget.id;
		const updated = await apiFetch<Folder>(`/api/folders/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
		const target = data.folder.children.find((c: Folder) => c.id === id);
		if (target) {
			target.name = updated.name;
			target.updatedAt = updated.updatedAt;
		}
	}
	await invalidateAll();
}

async function handleDeleteDocument(id: string) {
	if (!confirm(`${m.action_delete()}?`)) return;
	try {
		await apiFetch(`/api/documents/${id}`, { method: "DELETE" });
		await invalidateAll();
	} catch (e: unknown) {
		console.error("Failed to delete document", e);
	}
}

async function handleDuplicateDocument(id: string) {
	try {
		await apiFetch<Document>(`/api/documents/${id}/duplicate`, {
			method: "POST",
		});
		await invalidateAll();
	} catch (e: unknown) {
		console.error("Failed to duplicate document", e);
	}
}

function handleNewSubfolder() {
	folderDialogMode = "create";
	folderDialogTarget = null;
	showFolderDialog = true;
}

function getSortLabel(option: SortOption): string {
	switch (option) {
		case "name":
			return m.sort_name();
		case "updated":
			return m.sort_date_modified();
		case "created":
			return m.sort_date_created();
	}
}
</script>

<svelte:head>
  <title>{m.folder_page_title({ name: data.folder.name })}</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-4 py-8">
  <!-- Header -->
  <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <Button
        variant="ghost"
        size="icon"
        class="size-8 shrink-0"
        onclick={() => {
          const parentId = data.folder.parentId;
          if (parentId) {
            goto(`/folders/${parentId}`);
          } else {
            goto("/folders");
          }
        }}
        title={m.action_back()}
      >
        <ArrowLeft class="size-4" />
      </Button>
      <FolderOpen class="size-7 shrink-0 text-primary" />
      {#if editingName}
        <input
          type="text"
          bind:value={editName}
          onblur={submitRename}
          onkeydown={handleRenameKeydown}
          class="rounded-md border border-input bg-transparent px-2 py-1 text-2xl font-semibold tracking-tight focus:outline-none focus:ring-1 focus:ring-ring"
        />
      {:else}
        <button
          class="cursor-pointer text-left text-2xl font-semibold tracking-tight transition-colors hover:text-primary"
          onclick={startRename}
          onkeydown={(e: KeyboardEvent) => e.key === "Enter" && startRename()}
          title={m.folder_click_to_rename()}
        >
          {data.folder.name}
        </button>
      {/if}
      {#if folderCategory}
        <Badge variant="secondary">{folderCategory.name}</Badge>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      <!-- Sort dropdown -->
      <DropdownMenu>
        <DropdownMenuTrigger
          class="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowUpDown class="size-3.5" />
          {getSortLabel(sortBy)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onclick={() => (sortBy = "updated")}>
            <Clock class="size-4" />
            {m.sort_date_modified()}
          </DropdownMenuItem>
          <DropdownMenuItem onclick={() => (sortBy = "created")}>
            <File class="size-4" />
            {m.sort_date_created()}
          </DropdownMenuItem>
          <DropdownMenuItem onclick={() => (sortBy = "name")}>
            <SortAsc class="size-4" />
            {m.sort_name()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- Share Folder -->
      <Button variant="outline" size="sm" onclick={() => (showShareDialog = true)}>
        <Share2 class="size-3.5" />
        {m.doc_share()}
      </Button>

      <!-- New Subfolder -->
      <Button variant="outline" size="sm" onclick={handleNewSubfolder}>
        <FolderPlus class="size-3.5" />
        {m.folder_new_subfolder()}
      </Button>

      <!-- New Document -->
      <Button size="sm" onclick={() => goto(`/docs/new?folder=${data.folder.id}`)}>
        <Plus class="size-3.5" />
        {m.dashboard_new_document()}
      </Button>
    </div>
  </div>

  {#if isEmpty}
    <!-- Empty state -->
    <div class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
      <div class="mb-4 rounded-full bg-muted p-4">
        <FileText class="size-8 text-muted-foreground" />
      </div>
      <h2 class="mb-1 text-lg font-semibold">{m.folder_empty_title()}</h2>
      <p class="mb-4 text-sm text-muted-foreground">
        {m.folder_empty_description()}
      </p>
      <div class="flex gap-2">
        <Button onclick={() => goto(`/docs/new?folder=${data.folder.id}`)}>
          <FileText class="size-4" />
          {m.dashboard_new_document()}
        </Button>
        <Button variant="outline" onclick={handleNewSubfolder}>
          <FolderPlus class="size-4" />
          {m.folder_new_subfolder()}
        </Button>
      </div>
    </div>
  {:else}
    <!-- Subfolders section -->
    {#if sortedSubfolders.length > 0}
      <section class="mb-8">
        <h2 class="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {m.nav_folders()}
          <Badge variant="secondary" class="ml-1.5 text-[10px]">{sortedSubfolders.length}</Badge>
        </h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each sortedSubfolders as folder (folder.id)}
            <FolderCard
              {folder}
              onDelete={handleDeleteFolder}
              onRename={handleRenameFolder}
            />
          {/each}
        </div>
      </section>
    {/if}

    <!-- Documents section -->
    {#if sortedDocuments.length > 0}
      <section>
        <h2 class="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {m.nav_documents()}
          <Badge variant="secondary" class="ml-1.5 text-[10px]">{sortedDocuments.length}</Badge>
        </h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each sortedDocuments as doc (doc.id)}
            <DocumentCard
              document={doc}
              onDelete={handleDeleteDocument}
              onDuplicate={handleDuplicateDocument}
            />
          {/each}
        </div>
      </section>
    {/if}
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

<ShareDialog
  bind:open={showShareDialog}
  folderId={data.folder.id}
  folderName={data.folder.name}
/>

<FolderDialog
  bind:open={showFolderDialog}
  mode={folderDialogMode}
  folder={folderDialogTarget}
  onSave={saveFolder}
/>

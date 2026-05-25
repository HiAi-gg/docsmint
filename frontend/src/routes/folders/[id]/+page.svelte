<script lang="ts">
  import { goto } from "$app/navigation";
  import DocumentCard from "$lib/components/DocumentCard.svelte";
  import FolderCard from "$lib/components/FolderCard.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import {
    ChevronRight,
    FileText,
    FolderPlus,
    Plus,
    ArrowUpDown,
    FolderOpen,
    File,
    Clock,
    SortAsc,
  } from "lucide-svelte";
  import * as m from "$lib/paraglide/messages.js";
  import type { SortOption, Document, Folder } from "$lib/types.js";

  let { data } = $props();

  let sortBy = $state<SortOption>("updated");
  let editingName = $state(false);
  let editName = $state("");

  /** Sort documents by the selected option. */
  let sortedDocuments = $derived.by(() => {
    const docs = [...data.folder.documents];
    switch (sortBy) {
      case "name":
        return docs.sort((a, b) => a.title.localeCompare(b.title));
      case "created":
        return docs.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      case "updated":
      default:
        return docs.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
    }
  });

  /** Sort subfolders by name. */
  let sortedSubfolders = $derived(
    [...data.folder.children].sort((a, b) => a.name.localeCompare(b.name)),
  );

  let isEmpty = $derived(
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
    // In production, call deleteFolder(id) then navigate
    console.log("Delete folder:", id);
  }

  function handleRenameFolder(id: string) {
    // In production, show rename dialog
    console.log("Rename folder:", id);
  }

  function handleDeleteDocument(id: string) {
    // In production, call deleteDocument(id) then refresh
    console.log("Delete document:", id);
    data.folder.documents = data.folder.documents.filter((d: Document) => d.id !== id);
  }

  function handleDuplicateDocument(id: string) {
    // In production, call duplicateDocument(id) then refresh
    console.log("Duplicate document:", id);
  }

  function getSortLabel(option: SortOption): string {
    switch (option) {
      case "name": return m.sort_name();
      case "updated": return m.sort_date_modified();
      case "created": return m.sort_date_created();
    }
  }
</script>

<svelte:head>
  <title>{m.folder_page_title({ name: data.folder.name })}</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-4 py-8">
  <!-- Breadcrumb -->
  <nav class="mb-4 flex items-center gap-1 text-sm text-muted-foreground" aria-label={m.aria_breadcrumb()}>
    {#each data.breadcrumb as crumb, i (crumb.id)}
      {#if i > 0}
        <ChevronRight class="size-3.5 shrink-0" />
      {/if}
      {#if i === data.breadcrumb.length - 1}
        <span class="font-medium text-foreground">{crumb.name}</span>
      {:else}
        <a href="/folders/{crumb.id}" class="transition-colors hover:text-foreground">
          {crumb.name}
        </a>
      {/if}
    {/each}
  </nav>

  <!-- Header -->
  <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-3">
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

      <!-- New Subfolder -->
      <Button variant="outline" size="sm" onclick={() => goto(`/folders/new?parent=${data.folder.id}`)}>
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
        <Button variant="outline" onclick={() => goto(`/folders/new?parent=${data.folder.id}`)}>
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

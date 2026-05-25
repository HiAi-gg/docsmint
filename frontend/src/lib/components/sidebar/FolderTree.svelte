<script lang="ts">
  import { onMount } from "svelte";
  import { Folder, ChevronRight, Plus } from "lucide-svelte";
  import { cn } from "$lib/utils";
  import { listFolders } from "$lib/api/folders";
  import * as m from "$lib/paraglide/messages.js";

  interface FolderItem {
    id: string;
    name: string;
    children?: FolderItem[];
    open?: boolean;
  }

  let activeId = $state<string | null>(null);
  let folders = $state<FolderItem[]>([]);

  onMount(async () => {
    try {
      const result = await listFolders(null);
      if (result.length > 0 && result[0].children) {
        folders = result[0].children as FolderItem[];
      }
    } catch (err) {
      console.error("Failed to load folders:", err);
    }
  });

  function toggle(folder: FolderItem) {
    folder.open = !folder.open;
  }
</script>

<div class="space-y-1">
  <h3 class="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{m.sidebar_folders()}</h3>
  {#each folders as folder (folder.id)}
    <div>
      <button
        onclick={() => { activeId = folder.id; if (folder.children?.length) toggle(folder); }}
        class={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
          activeId === folder.id && "bg-accent text-accent-foreground font-medium"
        )}
      >
        {#if folder.children?.length}
          <ChevronRight class={cn("size-3.5 shrink-0 transition-transform", folder.open && "rotate-90")} />
        {:else}
          <span class="w-3.5"></span>
        {/if}
        <Folder class="size-4 shrink-0 text-muted-foreground" />
        <span class="truncate">{folder.name}</span>
      </button>
      {#if folder.open && folder.children?.length}
        <div class="ml-4 border-l border-border pl-1">
          {#each folder.children as child (child.id)}
            <button
              onclick={() => { activeId = child.id; }}
              class={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                activeId === child.id && "bg-accent text-accent-foreground font-medium"
              )}
            >
              <span class="w-3.5"></span>
              <Folder class="size-4 shrink-0 text-muted-foreground" />
              <span class="truncate">{child.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  <button class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
    <Plus class="size-3.5" />
    <span>{m.folders_new()}</span>
  </button>
</div>

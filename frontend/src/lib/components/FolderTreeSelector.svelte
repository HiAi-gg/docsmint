<script lang="ts">
import { ChevronRight, Folder, FolderOpen } from "lucide-svelte";
import type { Folder as FolderType } from "$lib/types.js";

let {
	folders,
	selectedId = $bindable(null),
	blockedIds = new Set<string>(),
	onSelect,
}: {
	folders: FolderType[];
	selectedId: string | null;
	blockedIds?: Set<string>;
	onSelect?: (id: string | null) => void;
} = $props();

let expandedFolderIds = $state(new Set<string>());

// Auto-expand ancestors of the selected folder when it changes
$effect(() => {
	if (selectedId) {
		let currentId: string | null = selectedId;
		let changed = false;
		while (currentId) {
			const folder = folders.find((f) => f.id === currentId);
			if (folder?.parentId) {
				if (!expandedFolderIds.has(folder.parentId)) {
					expandedFolderIds.add(folder.parentId);
					changed = true;
				}
				currentId = folder.parentId;
			} else {
				break;
			}
		}
		if (changed) {
			expandedFolderIds = new Set(expandedFolderIds);
		}
	}
});

function toggleExpand(folderId: string, event: MouseEvent) {
	event.stopPropagation();
	if (expandedFolderIds.has(folderId)) {
		expandedFolderIds.delete(folderId);
	} else {
		expandedFolderIds.add(folderId);
	}
	expandedFolderIds = new Set(expandedFolderIds);
}

// Build hierarchical folder tree list based on expansion state
const hierarchicalFolders = $derived.by(() => {
	const byParent = new Map<string | null, FolderType[]>();
	for (const f of folders) {
		const pId = f.parentId ?? null;
		if (!byParent.has(pId)) {
			byParent.set(pId, []);
		}
		byParent.get(pId)?.push(f);
	}
	for (const [_, list] of byParent.entries()) {
		list.sort((a, b) => a.name.localeCompare(b.name));
	}

	const result: Array<{
		folder: FolderType;
		depth: number;
		hasChildren: boolean;
	}> = [];
	function traverse(parentId: string | null, depth: number) {
		const children = byParent.get(parentId) ?? [];
		for (const child of children) {
			const hasChildren = byParent.has(child.id);
			result.push({ folder: child, depth, hasChildren });
			if (expandedFolderIds.has(child.id)) {
				traverse(child.id, depth + 1);
			}
		}
	}
	traverse(null, 0);
	return result;
});
</script>

<div class="max-h-60 overflow-y-auto rounded-md border border-input bg-card p-1">
  <!-- Root option -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="flex cursor-pointer items-center justify-between rounded px-3 py-1.5 text-sm transition-colors hover:bg-accent {selectedId === '' || selectedId === null ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'}"
    onclick={() => { selectedId = null; onSelect?.(null); }}
  >
    <span class="flex items-center gap-2">
      <FolderOpen class="size-4 shrink-0 text-muted-foreground" />
      No folder (Root)
    </span>
  </div>

  <div class="h-px bg-border my-1"></div>

  {#if hierarchicalFolders.length === 0}
    <div class="py-6 text-center text-xs text-muted-foreground">
      No folders available
    </div>
  {:else}
    {#each hierarchicalFolders as { folder, depth, hasChildren } (folder.id)}
      {@const isSelected = selectedId === folder.id}
      {@const isBlocked = blockedIds.has(folder.id)}
      {@const isExpanded = expandedFolderIds.has(folder.id)}

      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex items-center justify-between rounded py-1 transition-colors hover:bg-accent/50 {isSelected ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'} {isBlocked ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}"
        style="padding-left: {depth * 16 + 8}px;"
        onclick={() => { if (!isBlocked) { selectedId = folder.id; onSelect?.(folder.id); } }}
      >
        <span class="flex items-center gap-1.5 min-w-0">
          <!-- Chevron button -->
          {#if hasChildren}
            <button
              type="button"
              onclick={(e) => toggleExpand(folder.id, e)}
              class="flex size-5 items-center justify-center rounded hover:bg-accent text-muted-foreground transition-transform {isExpanded ? 'rotate-90' : ''}"
            >
              <ChevronRight class="size-3.5" />
            </button>
          {:else}
            <span class="size-5"></span>
          {/if}
          <Folder class="size-4 shrink-0 text-muted-foreground" />
          <span class="truncate text-sm">{folder.name}</span>
        </span>
      </div>
    {/each}
  {/if}
</div>

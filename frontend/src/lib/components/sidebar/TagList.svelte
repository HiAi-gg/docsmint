<!-- TagList.svelte — Sidebar list of tags with filter toggle, create, edit, delete. -->
<script lang="ts">
import { Loader2, MoreVertical, Plus } from "lucide-svelte";
import { onMount } from "svelte";
import { listTags, deleteTag, type Tag } from "$lib/api/tags";
import TagCreateDialog from "$lib/components/TagCreateDialog.svelte";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "$lib/components/ui/dropdown-menu";
import { ConfirmDialog } from "$lib/components/ui/confirm-dialog";
import { cn } from "$lib/utils";
import * as m from "$lib/paraglide/messages.js";

let tags = $state<Tag[]>([]);
let activeId = $state<string | null>(null);
let loadError = $state<string | null>(null);
let showCreateDialog = $state(false);
let editTarget = $state<Tag | null>(null);
let showDeleteDialog = $state(false);
let deleteTarget = $state<Tag | null>(null);
let busy = $state(false);

async function refresh() {
	try {
		tags = await listTags();
	} catch (e) {
		console.error("TagList: failed to load tags", e);
		loadError = m.tags_load_error();
	}
}

onMount(() => {
	void refresh();
});

function handleCreated(created: Tag) {
	// Optimistically add the new tag to the list so the user sees it
	// appear immediately. The next listTags() roundtrip will reconcile.
	tags = [...tags, created];
	void refresh();
}

function handleUpdated(updated: Tag) {
	tags = tags.map((t) => (t.id === updated.id ? updated : t));
}

function startEdit(t: Tag) {
	editTarget = t;
	showCreateDialog = true;
}

function handleDialogClose() {
	// Clear the edit target whenever the dialog is dismissed so the next
	// open defaults back to create mode.
	editTarget = null;
}

function startDelete(t: Tag) {
	deleteTarget = t;
	showDeleteDialog = true;
}

function cancelDelete() {
	showDeleteDialog = false;
	deleteTarget = null;
}

async function confirmDelete() {
	const t = deleteTarget;
	if (!t || busy) return;
	busy = true;
	try {
		await deleteTag(t.id);
		tags = tags.filter((tag) => tag.id !== t.id);
		if (activeId === t.id) activeId = null;
		showDeleteDialog = false;
		deleteTarget = null;
	} catch (e) {
		console.error("TagList: deleteTag failed", e);
		loadError = m.error_generic();
	} finally {
		busy = false;
	}
}
</script>

<div class="space-y-1">
  <h3 class="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
    {m.doc_tags()}
  </h3>
  {#if loadError}
    <p class="px-2 text-xs text-destructive">{loadError}</p>
  {/if}
  <div class="flex flex-wrap gap-1 px-2">
    {#each tags as tag (tag.id)}
      <div
        class={cn(
          "group/tag relative inline-flex items-center rounded-full transition-colors",
          activeId === tag.id
            ? "bg-primary text-primary-foreground"
            : "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        )}
      >
        <button
          type="button"
          onclick={() => { activeId = activeId === tag.id ? null : tag.id; }}
          class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
          aria-pressed={activeId === tag.id}
        >
          <span
            class="size-2.5 shrink-0 rounded-full"
            style="background-color: {tag.color || '#888888'}"
          ></span>
          {tag.name}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class={cn(
                  "mr-0.5 inline-flex size-5 items-center justify-center rounded-full opacity-0 transition-opacity hover:bg-black/10 focus-visible:opacity-100 focus-visible:outline-none group-hover/tag:opacity-100",
                  activeId === tag.id && "opacity-100",
                )}
                aria-label={m.editor_more_options()}
                title={m.editor_more_options()}
                disabled={busy}
              >
                {#if busy}
                  <Loader2 class="size-3 animate-spin" />
                {:else}
                  <MoreVertical class="size-3" />
                {/if}
              </button>
            {/snippet}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => startEdit(tag)}>
              {m.action_edit()}
            </DropdownMenuItem>
            <DropdownMenuItem
              class="text-destructive focus:text-destructive"
              onSelect={() => startDelete(tag)}
            >
              {m.action_delete()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    {/each}
    <button
      type="button"
      onclick={() => { editTarget = null; showCreateDialog = true; }}
      class="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground"
      aria-label={m.tags_new()}
    >
      <Plus class="size-3" />
      {m.tags_add()}
    </button>
  </div>
</div>

<TagCreateDialog
  bind:open={showCreateDialog}
  mode={editTarget ? "edit" : "create"}
  tag={editTarget}
  onCreated={handleCreated}
  onUpdated={handleUpdated}
  onClose={handleDialogClose}
/>

<ConfirmDialog
  bind:open={showDeleteDialog}
  title={m.tags_delete_title()}
  description={m.tags_delete_description()}
  confirmLabel={m.action_delete()}
  variant="destructive"
  busy={busy}
  onConfirm={confirmDelete}
  onCancel={cancelDelete}
/>

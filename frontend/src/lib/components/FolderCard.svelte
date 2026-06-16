<script lang="ts">
import {
	Folder,
	FolderInput,
	MoreVertical,
	Pencil,
	Trash2,
} from "lucide-svelte";
import { goto } from "$app/navigation";
import { Card, CardContent } from "$lib/components/ui/card/index.js";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "$lib/components/ui/dropdown-menu/index.js";
import * as m from "$lib/paraglide/messages.js";
import type { Folder as FolderType } from "$lib/types.js";
import { formatRelativeTime } from "$lib/utils.js";

const {
	folder,
	onDelete,
	onRename,
}: {
	folder: FolderType;
	onDelete?: (id: string) => void;
	onRename?: (id: string) => void;
} = $props();

function navigateToFolder() {
	goto(`/folders/${folder.id}`);
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		navigateToFolder();
	}
}
</script>

<Card
  class="group cursor-pointer transition-shadow duration-200 hover:shadow-md"
  onclick={navigateToFolder}
  onkeydown={handleKeydown}
  role="button"
  tabindex={0}
>
  <CardContent class="flex items-center gap-3 p-4">
    <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
      <Folder class="size-5 text-primary" />
    </div>
    <div class="min-w-0 flex-1">
      <h3 class="truncate text-sm font-medium">{folder.name}</h3>
      <p class="text-xs text-muted-foreground">
        {folder.documentCount} {folder.documentCount === 1 ? m.folders_document() : m.folders_documents()} &middot; {formatRelativeTime(folder.updatedAt)}
      </p>
    </div>
    <DropdownMenu>
      <DropdownMenuTrigger
        class="inline-flex size-8 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
        onclick={(e: MouseEvent) => e.stopPropagation()}
      >
        <MoreVertical class="size-4" />
        <span class="sr-only">{m.doc_open_menu()}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onclick={() => goto(`/folders/${folder.id}`)}>
          <Folder class="size-4" />
          {m.doc_open()}
        </DropdownMenuItem>
        <DropdownMenuItem onclick={(e: Event) => { e.stopPropagation(); onRename?.(folder.id); }}>
          <Pencil class="size-4" />
          {m.folders_rename()}
        </DropdownMenuItem>
        <DropdownMenuItem onclick={(e: Event) => e.stopPropagation()}>
          <FolderInput class="size-4" />
          {m.folders_move()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          class="text-destructive"
          onclick={(e: Event) => { e.stopPropagation(); onDelete?.(folder.id); }}
        >
          <Trash2 class="size-4" />
          {m.action_delete()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </CardContent>
</Card>

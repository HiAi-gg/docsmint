<script lang="ts">
import { goto } from "$app/navigation";
import {
	ArrowUpRight,
	Check,
	Copy,
	FileText,
	Files,
	FolderInput,
	MoreVertical,
	Trash2,
} from "lucide-svelte";
import * as m from "$lib/paraglide/messages.js";
import type { Document } from "$lib/types.js";
import { cn, formatRelativeTime } from "$lib/utils.js";
import { copyToClipboard } from "$lib/utils/clipboard.js";
import { stripMarkdown } from "$lib/utils/strip-markdown";
import {
	Card,
	CardContent,
	CardHeader,
} from "$lib/components/ui/card/index.js";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "$lib/components/ui/dropdown-menu/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";

const {
	document: doc,
	onDelete,
	onDuplicate,
}: {
	document: Document;
	onDelete?: (id: string) => void;
	onDuplicate?: (id: string) => void;
} = $props();

function navigateToDoc() {
	goto(`/docs/${doc.id}`);
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		navigateToDoc();
	}
}

let linkCopied = $state(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function handleCopyLink(e: Event) {
	e.stopPropagation();
	if (typeof window === "undefined") return;
	const url = `${window.location.origin}/docs/${doc.id}`;
	const ok = await copyToClipboard(url);
	if (!ok) return;
	linkCopied = true;
	if (copyTimer) clearTimeout(copyTimer);
	copyTimer = setTimeout(() => {
		linkCopied = false;
		copyTimer = null;
	}, 2000);
}

const preview = $derived(stripMarkdown(doc.excerpt || doc.content || "").slice(0, 100));
</script>

<Card
  class="group cursor-pointer transition-shadow duration-200 hover:shadow-md"
  onclick={navigateToDoc}
  onkeydown={handleKeydown}
  role="button"
  tabindex={0}
>
  <CardHeader class="flex-row items-start justify-between space-y-0 pb-2">
    <div class="flex items-center gap-2 text-muted-foreground">
      <FileText class="size-4 shrink-0" />
      <span class="text-xs">{m.doc_updated({ time: formatRelativeTime(doc.updatedAt) })}</span>
    </div>
    <DropdownMenu>
      <DropdownMenuTrigger
        class="inline-flex size-8 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
        onclick={(e: MouseEvent) => e.stopPropagation()}
      >
        <MoreVertical class="size-4" />
        <span class="sr-only">{m.doc_open_menu()}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onclick={() => goto(`/docs/${doc.id}`)}>
          <ArrowUpRight class="size-4" />
          {m.doc_open()}
        </DropdownMenuItem>
        <DropdownMenuItem onclick={handleCopyLink}>
          {#if linkCopied}
            <Check class="size-4" />
            {m.share_copied()}
          {:else}
            <Copy class="size-4" />
            {m.action_copy_link()}
          {/if}
        </DropdownMenuItem>
        <DropdownMenuItem onclick={(e: Event) => { e.stopPropagation(); onDuplicate?.(doc.id); }}>
          <Files class="size-4" />
          {m.doc_duplicate()}
        </DropdownMenuItem>
        <DropdownMenuItem onclick={(e: Event) => e.stopPropagation()}>
          <FolderInput class="size-4" />
          {m.doc_move_to_folder()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          class="text-destructive"
          onclick={(e: Event) => { e.stopPropagation(); onDelete?.(doc.id); }}
        >
          <Trash2 class="size-4" />
          {m.action_delete()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </CardHeader>
  <CardContent>
    <h3 class="mb-1 truncate text-sm font-medium leading-snug">{doc.title}</h3>
    {#if preview}
      <p class="mb-3 line-clamp-2 text-xs text-muted-foreground">{preview}</p>
    {/if}
    {#if doc.tags.length > 0}
      <div class="flex flex-wrap gap-1">
        {#each doc.tags.slice(0, 3) as tag (tag)}
          <Badge variant="secondary" class="text-[10px]">{tag}</Badge>
        {/each}
        {#if doc.tags.length > 3}
          <Badge variant="outline" class="text-[10px]">+{doc.tags.length - 3}</Badge>
        {/if}
      </div>
    {/if}
  </CardContent>
</Card>

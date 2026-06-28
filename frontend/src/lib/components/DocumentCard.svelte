<script lang="ts">
import { Badge } from "@hiai-gg/hiai-ui/components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
} from "@hiai-gg/hiai-ui/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@hiai-gg/hiai-ui/components/ui/dropdown-menu";
import {
	ArrowUpRight,
	Check,
	Copy,
	Files,
	FileText,
	FolderInput,
	Loader2,
	MoreVertical,
	Trash2,
} from "lucide-svelte";
import { goto, invalidateAll } from "$app/navigation";
import { getDocument, updateDocument } from "$lib/api/documents";
import MoveDialog from "$lib/components/MoveDialog.svelte";
import * as m from "$lib/paraglide/messages.js";
import type { Document } from "$lib/types.js";
import { copyToClipboard } from "$lib/utils/clipboard.js";
import { stripMarkdown } from "$lib/utils/strip-markdown";
import { cn, formatRelativeTime } from "$lib/utils.js";

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

let showMoveDialog = $state(false);

async function handleMove(parentId: string | null, categoryId: string | null) {
	await updateDocument(doc.id, { folderId: parentId, categoryId });
	await invalidateAll();
}

let contentCopied = $state(false);
let contentCopying = $state(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function handleCopyContent(e: Event) {
	e.stopPropagation();
	if (typeof window === "undefined") return;
	// Copy the document's full markdown source. The list endpoint returns
	// `content` truncated to 200 chars at the SQL level, so we fetch the
	// single-document endpoint first to get the complete text. If the
	// fetch fails we fall back to the card payload (excerpt, then
	// truncated content) so the menu item still does something.
	let text = "";
	contentCopying = true;
	try {
		const full = await getDocument(doc.id);
		text = full.content ?? "";
	} catch (err) {
		console.error("DocumentCard: failed to fetch full document for copy", err);
		text = doc.excerpt || doc.content || "";
	} finally {
		contentCopying = false;
	}
	if (!text) return;
	const ok = await copyToClipboard(text);
	if (!ok) return;
	contentCopied = true;
	if (copyTimer) clearTimeout(copyTimer);
	copyTimer = setTimeout(() => {
		contentCopied = false;
		copyTimer = null;
	}, 2000);
}

const preview = $derived(
	stripMarkdown(doc.excerpt || doc.content || "").slice(0, 100),
);
</script>

<Card
  class="group cursor-pointer transition-shadow duration-200 hover:shadow-md"
  onclick={navigateToDoc}
  onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigateToDoc(); } }}
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
        <DropdownMenuItem onclick={handleCopyContent} disabled={contentCopying}>
          {#if contentCopying}
            <Loader2 class="size-4 animate-spin" />
            {m.action_copy_content()}
          {:else if contentCopied}
            <Check class="size-4" />
            {m.share_copied()}
          {:else}
            <Copy class="size-4" />
            {m.action_copy_content()}
          {/if}
        </DropdownMenuItem>
        <DropdownMenuItem onclick={(e: Event) => { e.stopPropagation(); onDuplicate?.(doc.id); }}>
          <Files class="size-4" />
          {m.doc_duplicate()}
        </DropdownMenuItem>
        <DropdownMenuItem onclick={(e: Event) => { e.stopPropagation(); showMoveDialog = true; }}>
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

<MoveDialog
  bind:open={showMoveDialog}
  itemId={doc.id}
  itemType="document"
  initialParentId={doc.folderId}
  initialCategoryId={doc.categoryId}
  onSave={handleMove}
/>

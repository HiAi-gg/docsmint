<script lang="ts">
import { onMount, onDestroy } from "svelte";
import { Check, Copy, FileText } from "lucide-svelte";
import { type Document, listDocuments } from "$lib/api/documents";
import * as m from "$lib/paraglide/messages.js";
import { cn } from "$lib/utils.js";
import { copyToClipboard } from "$lib/utils/clipboard.js";

let recentDocs = $state<Document[]>([]);
let activeId = $state<string | null>(null);
let loadError = $state<string | null>(null);
let copiedDocId = $state<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

onMount(async () => {
	try {
		const res = await listDocuments({ limit: 5 });
		recentDocs = res.items;
	} catch (e) {
		console.error("RecentDocs: failed to load recent documents", e);
		loadError = "Failed to load recent documents";
	}
});

onDestroy(() => {
	if (copyTimer) {
		clearTimeout(copyTimer);
		copyTimer = null;
	}
});

async function handleCopyLink(e: MouseEvent, docId: string) {
	e.preventDefault();
	e.stopPropagation();
	if (typeof window === "undefined") return;
	const url = `${window.location.origin}/docs/${docId}`;
	const ok = await copyToClipboard(url);
	if (!ok) return;
	copiedDocId = docId;
	if (copyTimer) clearTimeout(copyTimer);
	copyTimer = setTimeout(() => {
		copiedDocId = null;
		copyTimer = null;
	}, 2000);
}
</script>

<div class="space-y-1">
  <h3 class="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{m.sidebar_recent()}</h3>
  {#if loadError}
    <p class="px-2 text-xs text-destructive">{loadError}</p>
  {/if}
  {#each recentDocs as doc (doc.id)}
    <div class="group/doc flex items-center gap-1">
      <a
        href={`/docs/${doc.id}`}
        onclick={() => { activeId = doc.id; }}
        class={cn(
          "flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
          activeId === doc.id && "bg-accent text-accent-foreground"
        )}
      >
        <FileText class="size-4 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <p class="truncate">{doc.title}</p>
          <p class="text-xs text-muted-foreground">{doc.updatedAt}</p>
        </div>
      </a>
      <button
        type="button"
        class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover/doc:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {copiedDocId === doc.id ? 'opacity-100' : ''}"
        aria-label={m.action_copy_link()}
        title={m.action_copy_link()}
        onclick={(e: MouseEvent) => void handleCopyLink(e, doc.id)}
      >
        {#if copiedDocId === doc.id}
          <Check class="size-3.5" />
        {:else}
          <Copy class="size-3.5" />
        {/if}
      </button>
    </div>
  {/each}
</div>

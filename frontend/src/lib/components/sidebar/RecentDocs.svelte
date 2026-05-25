<script lang="ts">
  import { onMount } from "svelte";
  import { FileText } from "lucide-svelte";
  import { cn } from "$lib/utils";
  import { listDocuments, type Document } from "$lib/api/documents";
  import * as m from "$lib/paraglide/messages.js";

  let recentDocs = $state<Document[]>([]);
  let activeId = $state<string | null>(null);

  onMount(async () => {
    try {
      const res = await listDocuments({ limit: 5 });
      recentDocs = res.items;
    } catch (err) {
      console.error("Failed to load recent documents:", err);
    }
  });
</script>

<div class="space-y-1">
  <h3 class="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{m.sidebar_recent()}</h3>
  {#each recentDocs as doc (doc.id)}
    <a
      href={`/docs/${doc.id}`}
      onclick={() => { activeId = doc.id; }}
      class={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
        activeId === doc.id && "bg-accent text-accent-foreground"
      )}
    >
      <FileText class="size-4 shrink-0 text-muted-foreground" />
      <div class="min-w-0 flex-1">
        <p class="truncate">{doc.title}</p>
        <p class="text-xs text-muted-foreground">{doc.updatedAt}</p>
      </div>
    </a>
  {/each}
</div>

<script lang="ts">
  import { onMount } from "svelte";
  import { Plus } from "lucide-svelte";
  import { cn } from "$lib/utils";
  import { listTags, type Tag } from "$lib/api/tags";
  import * as m from "$lib/paraglide/messages.js";

  let tags = $state<Tag[]>([]);
  let activeId = $state<string | null>(null);

  onMount(async () => {
    try {
      tags = await listTags();
    } catch (err) {
      console.error("Failed to load tags:", err);
    }
  });
</script>

<div class="space-y-1">
  <h3 class="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{m.doc_tags()}</h3>
  <div class="flex flex-wrap gap-1 px-2">
    {#each tags as tag (tag.id)}
      <button
        onclick={() => { activeId = activeId === tag.id ? null : tag.id; }}
        class={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors",
          activeId === tag.id
            ? "bg-primary text-primary-foreground"
            : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
        )}
      >
        <span class={cn("size-2 rounded-full", tag.color)}></span>
        {tag.name}
      </button>
    {/each}
    <button class="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground">
      <Plus class="size-3" />
      {m.tags_add()}
    </button>
  </div>
</div>

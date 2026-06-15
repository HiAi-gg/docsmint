<script lang="ts">
import { goto } from "$app/navigation";
import { Search } from "lucide-svelte";
import * as m from "$lib/paraglide/messages.js";
import { cn } from "$lib/utils.js";

const { class: className }: { class?: string } = $props();
let query = $state("");

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && query.trim()) {
		goto(`/search?q=${encodeURIComponent(query.trim())}`);
	}
}
</script>

<div class={cn("relative", className)}>
  <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
  <input
    type="text"
    bind:value={query}
    onkeydown={handleKeydown}
    placeholder={m.search_placeholder()}
    class="flex h-9 w-full rounded-md border border-input bg-transparent pl-9 pr-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
  />
</div>

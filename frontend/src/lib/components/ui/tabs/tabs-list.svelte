<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

const {
	class: className,
	children,
}: {
	class?: string;
	children?: Snippet;
} = $props();
</script>

<div
  class={cn(
    "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
    className
  )}
  role="tablist"
>
  {#if children}
    {@render children()}
  {/if}
</div>

<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

const {
	value,
	selected = false,
	class: className,
	children,
	onclick,
}: {
	value: string;
	selected?: boolean;
	class?: string;
	children?: Snippet;
	onclick?: (value: string) => void;
} = $props();

function handleClick() {
	onclick?.(value);
}
</script>

<button
  type="button"
  role="tab"
  aria-selected={selected}
  data-state={selected ? "active" : "inactive"}
  class={cn(
    "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
    selected
      ? "bg-primary text-primary-foreground shadow"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    className
  )}
  onclick={handleClick}
>
  {#if children}
    {@render children()}
  {/if}
</button>

<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

const {
	value: tabValue,
	currentValue,
	class: className,
	children,
}: {
	value: string;
	currentValue: string;
	class?: string;
	children?: Snippet;
} = $props();
</script>

{#if currentValue === tabValue}
  <div
    class={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    role="tabpanel"
  >
    {#if children}
      {@render children()}
    {/if}
  </div>
{/if}

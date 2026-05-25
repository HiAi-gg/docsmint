<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";

  let {
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
    {@render children?.()}
  </div>
{/if}

<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";

  let {
    value = $bindable(""),
    class: className,
    children,
  }: {
    value?: string;
    class?: string;
    children?: Snippet;
  } = $props();

  function selectTab(tabValue: string) {
    value = tabValue;
  }
</script>

<div class={cn("w-full", className)} data-tabs-value={value}>
  {@render children?.()}
</div>

<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";

  let {
    value,
    class: className,
    children,
    onclick,
  }: {
    value: string;
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
  class={cn(
    "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
    className
  )}
  onclick={handleClick}
>
  {@render children?.()}
</button>

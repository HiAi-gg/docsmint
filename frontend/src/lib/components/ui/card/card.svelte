<script lang="ts">
  import type { CardProps } from "./card.svelte.js";
  import { cn } from "$lib/utils.js";

  let { ref = $bindable(null), class: className, children, ...restProps }: CardProps = $props();
</script>

<div bind:this={ref} class={cn("rounded-xl border border-border bg-card text-card-foreground shadow-sm", className)} {...restProps}>
  {@render children?.()}
</div>

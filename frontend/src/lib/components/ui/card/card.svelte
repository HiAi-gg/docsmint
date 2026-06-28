<script lang="ts">
import { cn } from "$lib/utils";
import type { CardProps } from "./card.svelte.js";

let {
	ref = $bindable(null),
	class: className,
	children,
	...restProps
}: CardProps = $props();
</script>

<div bind:this={ref} class={cn("rounded-xl border border-border bg-card text-card-foreground shadow-sm", className)} {...restProps}>
  {#if children}
    {@render children()}
  {/if}
</div>

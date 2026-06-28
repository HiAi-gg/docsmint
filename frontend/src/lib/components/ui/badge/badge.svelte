<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils";
import { type BadgeVariant, badgeVariants } from "./index.js";

let {
	ref = $bindable(null),
	class: className,
	variant = "default",
	children,
	...restProps
}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
	variant?: BadgeVariant;
} = $props();
</script>

<div bind:this={ref} class={cn(badgeVariants({ variant }), className)} {...restProps}>
  {#if children}
    {@render children()}
  {/if}
</div>

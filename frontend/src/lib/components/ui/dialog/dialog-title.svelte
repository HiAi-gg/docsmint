<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";
import { cn } from "$lib/utils";

const {
	class: className,
	children,
	...restProps
}: HTMLAttributes<HTMLHeadingElement> = $props();
</script>

<h2 class={cn("text-lg font-semibold leading-none tracking-tight", className)} {...restProps}>
  {#if children}
    {@render children()}
  {/if}
</h2>

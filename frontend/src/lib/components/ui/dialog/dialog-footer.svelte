<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";
import { cn } from "$lib/utils";

const {
	class: className,
	children,
	...restProps
}: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div class={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...restProps}>
  {#if children}
    {@render children()}
  {/if}
</div>

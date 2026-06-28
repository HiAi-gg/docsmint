<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";
import { cn } from "$lib/utils";

const {
	class: className,
	children,
	...restProps
}: HTMLAttributes<HTMLParagraphElement> = $props();
</script>

<p class={cn("text-sm text-muted-foreground", className)} {...restProps}>
  {#if children}
    {@render children()}
  {/if}
</p>

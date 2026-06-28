<script lang="ts">
import type { HTMLLabelAttributes } from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils";

let {
	ref = $bindable(null),
	class: className,
	children,
	...restProps
}: WithElementRef<HTMLLabelAttributes> = $props();
</script>

<label
  bind:this={ref}
  class={cn(
    "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
    className
  )}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</label>

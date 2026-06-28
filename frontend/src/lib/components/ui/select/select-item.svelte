<script lang="ts">
// biome-ignore lint/style/useImportType: SelectPrimitive is used as a value in the Svelte template
import { Select as SelectPrimitive } from "bits-ui";
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

let {
	ref = $bindable(null),
	class: className,
	children,
	...restProps
}: Omit<SelectPrimitive.ItemProps, "children"> & {
	children?: Snippet;
} = $props();
</script>

<SelectPrimitive.Item
  bind:ref
  class={cn(
    "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 pr-8 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
    className
  )}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</SelectPrimitive.Item>

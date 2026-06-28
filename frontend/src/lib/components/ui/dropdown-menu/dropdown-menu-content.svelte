<script lang="ts">
// biome-ignore lint/style/useImportType: DropdownMenuPrimitive is used as a value in the Svelte template
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import { cn } from "$lib/utils";

let {
	ref = $bindable(null),
	class: className,
	sideOffset = 4,
	children,
	...restProps
}: DropdownMenuPrimitive.ContentProps = $props();
</script>

<DropdownMenuPrimitive.Content
  bind:ref
  {sideOffset}
  class={cn(
    "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
    className
  )}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</DropdownMenuPrimitive.Content>

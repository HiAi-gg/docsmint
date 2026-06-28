<script lang="ts">
// biome-ignore lint/style/useImportType: DropdownMenuPrimitive is used as a value in the Svelte template
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import { cn } from "$lib/utils";

let {
	ref = $bindable(null),
	class: className,
	...restProps
}: DropdownMenuPrimitive.SeparatorProps = $props();
</script>

<DropdownMenuPrimitive.Separator
  bind:ref
  class={cn("-mx-1 my-1 h-px bg-muted", className)}
  {...restProps}
/>

<script lang="ts">
import type { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import type { Snippet } from "svelte";

const {
	children,
	...restProps
}: DropdownMenuPrimitive.RootProps & { children?: Snippet } = $props();
</script>

<DropdownMenuPrimitive.Root {...restProps}>
  {@render children?.()}
</DropdownMenuPrimitive.Root>

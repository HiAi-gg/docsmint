<script lang="ts">
// biome-ignore lint/style/useImportType: DropdownMenuPrimitive is used as a value in the Svelte template
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import type { Snippet } from "svelte";

const {
	children,
	...restProps
}: DropdownMenuPrimitive.RootProps & { children?: Snippet } = $props();
</script>

<DropdownMenuPrimitive.Root {...restProps}>
  {#if children}
    {@render children()}
  {/if}
</DropdownMenuPrimitive.Root>

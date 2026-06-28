<script lang="ts">
// biome-ignore lint/style/useImportType: SelectPrimitive is used as a value in the Svelte template
import { Select as SelectPrimitive } from "bits-ui";
import type { Snippet } from "svelte";

let {
	value = $bindable(),
	children,
	...restProps
}: SelectPrimitive.RootProps & { children?: Snippet } = $props();
</script>

<SelectPrimitive.Root {...restProps} bind:value={value as any}>
  {#if children}
    {@render children()}
  {/if}
</SelectPrimitive.Root>

<script lang="ts">
// biome-ignore lint/style/useImportType: SelectPrimitive is used as a value in the Svelte template
import { Select as SelectPrimitive } from "bits-ui";
import type { Snippet } from "svelte";

let {
	children,
	...restProps
}: Omit<SelectPrimitive.ValueProps, "children"> & { children?: Snippet } =
	$props();
</script>

{#if children}
  <SelectPrimitive.Value {...restProps}>
    {@render children()}
  </SelectPrimitive.Value>
{:else}
  <SelectPrimitive.Value {...restProps} />
{/if}

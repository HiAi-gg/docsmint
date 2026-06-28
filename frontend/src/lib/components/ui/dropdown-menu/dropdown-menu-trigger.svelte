<script lang="ts">
// biome-ignore lint/style/useImportType: DropdownMenuPrimitive is used as a value in the Svelte template
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

let {
	ref = $bindable(null),
	child,
	children,
	...restProps
}: DropdownMenuPrimitive.TriggerProps & {
	child?: import("svelte").Snippet<[{ props: Record<string, unknown> }]>;
} = $props();
</script>

{#if child}
  {#snippet renderChild(snippetProps: { props: Record<string, unknown> })}
    {@render child?.(snippetProps)}
  {/snippet}
  <DropdownMenuPrimitive.Trigger bind:ref {...restProps} child={renderChild}>
  </DropdownMenuPrimitive.Trigger>
{:else}
  <DropdownMenuPrimitive.Trigger bind:ref {...restProps}>
    {#if children}
      {@render children()}
    {/if}
  </DropdownMenuPrimitive.Trigger>
{/if}

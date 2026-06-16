<script lang="ts">
import type { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

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
  <DropdownMenuPrimitive.Trigger bind:ref {...restProps}>
    {#snippet child(snippetProps: { props: Record<string, unknown> })}
      {@render child?.(snippetProps)}
    {/snippet}
  </DropdownMenuPrimitive.Trigger>
{:else}
  <DropdownMenuPrimitive.Trigger bind:ref {...restProps}>
    {@render children?.()}
  </DropdownMenuPrimitive.Trigger>
{/if}

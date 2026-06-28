<script lang="ts">
// biome-ignore lint/style/useImportType: SelectPrimitive is used as a value in the Svelte template
import { Select as SelectPrimitive } from "bits-ui";
import { cn } from "$lib/utils";

let {
	ref = $bindable(null),
	class: className,
	child,
	children,
	...restProps
}: SelectPrimitive.TriggerProps & {
	child?: import("svelte").Snippet<[{ props: Record<string, unknown> }]>;
} = $props();
</script>

{#if child}
  {#snippet renderChild(snippetProps: { props: Record<string, unknown> })}
    {@render child?.(snippetProps)}
  {/snippet}
  <SelectPrimitive.Trigger bind:ref {...restProps} child={renderChild} class={cn(
    "flex h-9 items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
    className
  )}>
  </SelectPrimitive.Trigger>
{:else}
  <SelectPrimitive.Trigger bind:ref {...restProps} class={cn(
    "flex h-9 items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
    className
  )}>
    {#if children}
      {@render children()}
    {/if}
  </SelectPrimitive.Trigger>
{/if}

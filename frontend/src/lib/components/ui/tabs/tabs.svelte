<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

let {
	value = $bindable(""),
	class: className,
	children,
}: {
	value?: string;
	class?: string;
	children?: Snippet;
} = $props();

function selectTab(tabValue: string) {
	value = tabValue;
}
</script>

<div class={cn("w-full", className)} data-tabs-value={value}>
  {#if children}
    {@render children()}
  {/if}
</div>
